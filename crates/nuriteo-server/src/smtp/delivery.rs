use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time;
use zeroize::Zeroizing;

use crate::notification::{EmailSendFailure, EmailSender, PreparedEmail, SmtpAcceptance};

use super::preflight::{read_reply, send_command, supports_plain_auth, tls_connector};
use super::{SmtpConfig, SmtpFailureClass, SmtpPreflightError, SmtpSecurity};

#[derive(Clone)]
pub struct SmtpConfigHandle {
    config: Arc<RwLock<Arc<SmtpConfig>>>,
}

impl SmtpConfigHandle {
    #[must_use]
    pub fn new(config: Arc<SmtpConfig>) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
        }
    }

    #[must_use]
    pub fn current(&self) -> Arc<SmtpConfig> {
        self.config
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn replace(&self, config: Arc<SmtpConfig>) {
        *self
            .config
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = config;
    }
}

impl From<Arc<SmtpConfig>> for SmtpConfigHandle {
    fn from(config: Arc<SmtpConfig>) -> Self {
        Self::new(config)
    }
}

impl std::fmt::Debug for SmtpConfigHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SmtpConfigHandle")
            .field("config", &self.current())
            .finish()
    }
}

trait SmtpIo: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite> SmtpIo for T {}
type SmtpStream = Pin<Box<dyn SmtpIo + Send>>;

#[derive(Clone)]
pub struct SmtpEmailSender {
    config: SmtpConfigHandle,
}

impl SmtpEmailSender {
    #[must_use]
    pub fn new(config: impl Into<SmtpConfigHandle>) -> Self {
        Self {
            config: config.into(),
        }
    }

    async fn deliver(
        &self,
        recipient: &str,
        email: &PreparedEmail,
    ) -> Result<SmtpAcceptance, EmailSendFailure> {
        validate_recipient(recipient)?;
        let config = self.config.current();
        let data_started = Arc::new(AtomicBool::new(false));
        let result = time::timeout(
            config.preflight_timeout(),
            deliver_inner(&config, recipient, email, Arc::clone(&data_started)),
        )
        .await;
        match result {
            Ok(result) => result,
            Err(_) if data_started.load(Ordering::Acquire) => Err(EmailSendFailure::ambiguous()),
            Err(_) => Err(EmailSendFailure::transient(None)),
        }
    }
}

impl EmailSender for SmtpEmailSender {
    fn timeout(&self) -> std::time::Duration {
        self.config.current().preflight_timeout()
    }

    fn send<'a>(
        &'a self,
        recipient: &'a str,
        email: &'a PreparedEmail,
    ) -> Pin<Box<dyn Future<Output = Result<SmtpAcceptance, EmailSendFailure>> + Send + 'a>> {
        Box::pin(self.deliver(recipient, email))
    }
}

impl std::fmt::Debug for SmtpEmailSender {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SmtpEmailSender")
            .field("config", &self.config)
            .finish()
    }
}

async fn deliver_inner(
    config: &SmtpConfig,
    recipient: &str,
    email: &PreparedEmail,
    data_started: Arc<AtomicBool>,
) -> Result<SmtpAcceptance, EmailSendFailure> {
    let mut stream = connect(config).await?;
    authenticate(&mut stream, config).await?;
    command(
        &mut stream,
        format!("MAIL FROM:<{}>\r\n", config.from_address()).as_bytes(),
        &[250],
    )
    .await?;
    command(
        &mut stream,
        format!("RCPT TO:<{recipient}>\r\n").as_bytes(),
        &[250, 251],
    )
    .await?;
    command(&mut stream, b"DATA\r\n", &[354]).await?;

    let message = render_message(config, recipient, email)?;
    data_started.store(true, Ordering::Release);
    stream
        .get_mut()
        .write_all(&message)
        .await
        .map_err(|_| EmailSendFailure::ambiguous())?;
    stream
        .get_mut()
        .flush()
        .await
        .map_err(|_| EmailSendFailure::ambiguous())?;
    let reply = read_reply(&mut stream)
        .await
        .map_err(|_| EmailSendFailure::ambiguous())?;
    let acceptance = SmtpAcceptance::new(classify_reply(reply.code, &[250])?)?;
    let _ = send_command(stream.get_mut(), b"QUIT\r\n").await;
    Ok(acceptance)
}

async fn connect(config: &SmtpConfig) -> Result<BufReader<SmtpStream>, EmailSendFailure> {
    let tcp = TcpStream::connect((config.host(), config.port()))
        .await
        .map_err(|_| EmailSendFailure::transient(None))?;
    tcp.set_nodelay(true)
        .map_err(|_| EmailSendFailure::transient(None))?;
    let connector = tls_connector(config).map_err(map_preflight_error)?;
    let name = ServerName::try_from(config.host().to_owned())
        .map_err(|_| EmailSendFailure::permanent(None))?;
    let stream: SmtpStream = match config.security() {
        SmtpSecurity::ImplicitTls => Box::pin(
            connector
                .connect(name, tcp)
                .await
                .map_err(classify_tls_error)?,
        ),
        SmtpSecurity::StartTls => {
            let mut plain = BufReader::new(tcp);
            expect(&mut plain, &[220]).await?;
            send_command(plain.get_mut(), b"EHLO nuriteo.invalid\r\n")
                .await
                .map_err(map_preflight_error)?;
            let hello = read_reply(&mut plain).await.map_err(map_preflight_error)?;
            classify_reply(hello.code, &[250])?;
            if !hello
                .lines
                .iter()
                .any(|line| line.eq_ignore_ascii_case("STARTTLS"))
            {
                return Err(EmailSendFailure::permanent(None));
            }
            send_command(plain.get_mut(), b"STARTTLS\r\n")
                .await
                .map_err(map_preflight_error)?;
            expect(&mut plain, &[220]).await?;
            Box::pin(
                connector
                    .connect(name, plain.into_inner())
                    .await
                    .map_err(classify_tls_error)?,
            )
        }
    };
    let mut stream = BufReader::new(stream);
    if config.security() == SmtpSecurity::ImplicitTls {
        expect(&mut stream, &[220]).await?;
    }
    Ok(stream)
}

async fn authenticate(
    stream: &mut BufReader<SmtpStream>,
    config: &SmtpConfig,
) -> Result<(), EmailSendFailure> {
    send_command(stream.get_mut(), b"EHLO nuriteo.invalid\r\n")
        .await
        .map_err(map_preflight_error)?;
    let hello = read_reply(stream).await.map_err(map_preflight_error)?;
    classify_reply(hello.code, &[250])?;
    let Some(credentials) = config.credentials() else {
        return Ok(());
    };
    if !supports_plain_auth(&hello.lines) {
        return Err(EmailSendFailure::permanent(None));
    }
    let mut payload = Zeroizing::new(Vec::with_capacity(
        credentials.username().expose_secret().len()
            + credentials.password().expose_secret().len()
            + 2,
    ));
    payload.push(0);
    payload.extend_from_slice(credentials.username().expose_secret().as_bytes());
    payload.push(0);
    payload.extend_from_slice(credentials.password().expose_secret().as_bytes());
    let encoded = Zeroizing::new(STANDARD.encode(&*payload));
    let mut command_bytes = Zeroizing::new(Vec::with_capacity(encoded.len() + 14));
    command_bytes.extend_from_slice(b"AUTH PLAIN ");
    command_bytes.extend_from_slice(encoded.as_bytes());
    command_bytes.extend_from_slice(b"\r\n");
    command(stream, &command_bytes, &[235]).await
}

async fn command(
    stream: &mut BufReader<SmtpStream>,
    bytes: &[u8],
    accepted: &[u16],
) -> Result<(), EmailSendFailure> {
    send_command(stream.get_mut(), bytes)
        .await
        .map_err(map_preflight_error)?;
    expect(stream, accepted).await
}

async fn expect<S>(stream: &mut BufReader<S>, accepted: &[u16]) -> Result<(), EmailSendFailure>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let reply = read_reply(stream).await.map_err(map_preflight_error)?;
    classify_reply(reply.code, accepted).map(|_| ())
}

fn classify_reply(code: u16, accepted: &[u16]) -> Result<u16, EmailSendFailure> {
    if accepted.contains(&code) {
        return Ok(code);
    }
    if (400..500).contains(&code) {
        Err(EmailSendFailure::transient(Some(code)))
    } else if (500..600).contains(&code) {
        Err(EmailSendFailure::permanent(Some(code)))
    } else {
        Err(EmailSendFailure::permanent(None))
    }
}

fn render_message(
    config: &SmtpConfig,
    recipient: &str,
    email: &PreparedEmail,
) -> Result<Zeroizing<Vec<u8>>, EmailSendFailure> {
    validate_mailbox(config.from_address())?;
    let display_name = encode_header(config.from_name());
    let subject = encode_header(email.subject());
    let encoded_body = Zeroizing::new(STANDARD.encode(email.body().as_bytes()));
    let mut message = Zeroizing::new(Vec::with_capacity(encoded_body.len() + 512));
    message.extend_from_slice(
        format!(
            "From: {} <{}>\r\nTo: <{}>\r\nSubject: {}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
            display_name,
            config.from_address(),
            recipient,
            subject
        )
        .as_bytes(),
    );
    for chunk in encoded_body.as_bytes().chunks(76) {
        message.extend_from_slice(chunk);
        message.extend_from_slice(b"\r\n");
    }
    message.extend_from_slice(b".\r\n");
    Ok(message)
}

fn validate_recipient(recipient: &str) -> Result<(), EmailSendFailure> {
    validate_mailbox(recipient)
}

fn validate_mailbox(mailbox: &str) -> Result<(), EmailSendFailure> {
    if mailbox.len() > 320
        || !mailbox.is_ascii()
        || mailbox.trim() != mailbox
        || mailbox.matches('@').count() != 1
        || mailbox.contains(['\r', '\n', '<', '>'])
    {
        Err(EmailSendFailure::permanent(None))
    } else {
        Ok(())
    }
}

fn encode_header(value: &str) -> String {
    const MAX_ENCODED_WORD_INPUT: usize = 45;
    let mut words = Vec::new();
    let mut chunk = String::new();
    for character in value.chars() {
        if !chunk.is_empty() && chunk.len() + character.len_utf8() > MAX_ENCODED_WORD_INPUT {
            words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(chunk.as_bytes())));
            chunk.clear();
        }
        chunk.push(character);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(chunk.as_bytes())));
    }
    words.join("\r\n ")
}

fn map_preflight_error(error: SmtpPreflightError) -> EmailSendFailure {
    match error.class() {
        SmtpFailureClass::Retryable => EmailSendFailure::transient(error.smtp_code()),
        SmtpFailureClass::Permanent => EmailSendFailure::permanent(error.smtp_code()),
    }
}

fn classify_tls_error(error: io::Error) -> EmailSendFailure {
    if error.kind() == io::ErrorKind::InvalidData {
        EmailSendFailure::permanent(None)
    } else {
        EmailSendFailure::transient(None)
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::time::Duration;

    use crate::config::{Environment, FileReader};

    use super::*;

    #[derive(Clone)]
    struct TestEnvironment(Vec<(OsString, OsString)>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }

    struct NoFiles;

    impl FileReader for NoFiles {
        fn read(&self, _: &std::path::Path, _: usize) -> Result<Vec<u8>, std::io::Error> {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not configured",
            ))
        }
    }

    fn smtp_config(port: u16, timeout_ms: u64) -> Arc<SmtpConfig> {
        let values = [
            ("NURITEO_SMTP_HOST", "smtp.example.test".to_owned()),
            ("NURITEO_SMTP_PORT", port.to_string()),
            ("NURITEO_SMTP_SECURITY", "starttls".to_owned()),
            ("NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS", timeout_ms.to_string()),
        ];
        let environment = TestEnvironment(
            values
                .into_iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value)))
                .collect(),
        );
        Arc::new(SmtpConfig::load(&environment, &NoFiles).unwrap().unwrap())
    }

    #[test]
    fn reply_and_header_classification_is_safe() {
        let encoded = encode_header("제목 \"quoted\"");
        assert!(encoded.is_ascii());
        assert!(!encoded.contains('"'));
        assert!(encoded.starts_with("=?UTF-8?B?"));
        assert!(encoded.ends_with("?="));
        let folded = encode_header(&"긴제목".repeat(40));
        assert!(folded.lines().all(|line| line.trim().len() <= 75));
        assert!(validate_recipient("사용자@example.test").is_err());
        assert!(validate_recipient("safe@example.test\r\nBcc:x@example.test").is_err());
        assert!(validate_recipient("<safe@example.test>").is_err());
        assert!(validate_recipient("safe@example.test").is_ok());
        assert_eq!(
            classify_reply(421, &[250]),
            Err(EmailSendFailure::transient(Some(421)))
        );
        assert_eq!(
            classify_reply(550, &[250]),
            Err(EmailSendFailure::permanent(Some(550)))
        );
    }

    #[test]
    fn sender_reads_reloaded_configuration_for_each_attempt() {
        let handle = SmtpConfigHandle::new(smtp_config(2525, 900));
        let sender = SmtpEmailSender::new(handle.clone());
        assert_eq!(handle.current().port(), 2525);
        assert_eq!(EmailSender::timeout(&sender), Duration::from_millis(900));

        handle.replace(smtp_config(465, 1_700));

        assert_eq!(handle.current().port(), 465);
        assert_eq!(EmailSender::timeout(&sender), Duration::from_millis(1_700));
    }
}
