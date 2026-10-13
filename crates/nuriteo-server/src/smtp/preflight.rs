use std::fmt;
use std::io;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rustls::RootCertStore;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time;
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use super::{SmtpBootstrapConfig, SmtpConfig, SmtpSecurity};

const MAX_REPLY_BYTES: usize = 16 * 1024;
const MAX_REPLY_LINES: usize = 64;
const MAX_REPLY_LINE_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpFailureClass {
    Retryable,
    Permanent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpFailureCategory {
    Timeout,
    Connection,
    Trust,
    Protocol,
    Authentication,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmtpPreflightError {
    class: SmtpFailureClass,
    category: SmtpFailureCategory,
    smtp_code: Option<u16>,
}

impl SmtpPreflightError {
    #[must_use]
    pub const fn class(self) -> SmtpFailureClass {
        self.class
    }

    #[must_use]
    pub const fn category(self) -> SmtpFailureCategory {
        self.category
    }

    #[must_use]
    pub const fn smtp_code(self) -> Option<u16> {
        self.smtp_code
    }

    const fn retryable(category: SmtpFailureCategory) -> Self {
        Self {
            class: SmtpFailureClass::Retryable,
            category,
            smtp_code: None,
        }
    }

    const fn permanent(category: SmtpFailureCategory) -> Self {
        Self {
            class: SmtpFailureClass::Permanent,
            category,
            smtp_code: None,
        }
    }

    fn response(code: u16, authentication: bool) -> Self {
        let class = if (400..500).contains(&code) {
            SmtpFailureClass::Retryable
        } else {
            SmtpFailureClass::Permanent
        };
        let category = if authentication {
            SmtpFailureCategory::Authentication
        } else {
            SmtpFailureCategory::Rejected
        };
        Self {
            class,
            category,
            smtp_code: Some(code),
        }
    }
}

impl fmt::Display for SmtpPreflightError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.category {
            SmtpFailureCategory::Timeout => "SMTP preflight timed out",
            SmtpFailureCategory::Connection => "SMTP connection is unavailable",
            SmtpFailureCategory::Trust => "SMTP TLS verification failed",
            SmtpFailureCategory::Protocol => "SMTP protocol preflight failed",
            SmtpFailureCategory::Authentication => "SMTP authentication was rejected",
            SmtpFailureCategory::Rejected => "SMTP server rejected the preflight",
        })
    }
}

impl std::error::Error for SmtpPreflightError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmtpPreflightReport {
    pub tls_verified: bool,
    pub starttls_verified: bool,
    pub authenticated: bool,
}

pub(crate) async fn preflight(
    config: &SmtpConfig,
) -> Result<SmtpPreflightReport, SmtpPreflightError> {
    time::timeout(config.preflight_timeout(), preflight_inner(config))
        .await
        .map_err(|_| SmtpPreflightError::retryable(SmtpFailureCategory::Timeout))?
}

/// Standalone deployment-file compatibility preflight. This boundary cannot
/// create a delivery sender and therefore cannot bypass DB-authoritative runtime
/// resolution after INT-001 adoption.
pub async fn preflight_bootstrap(
    config: &SmtpBootstrapConfig,
) -> Result<SmtpPreflightReport, SmtpPreflightError> {
    preflight(config.as_config()).await
}

async fn preflight_inner(config: &SmtpConfig) -> Result<SmtpPreflightReport, SmtpPreflightError> {
    let tcp = TcpStream::connect((config.host(), config.port()))
        .await
        .map_err(|_| SmtpPreflightError::retryable(SmtpFailureCategory::Connection))?;
    tcp.set_nodelay(true)
        .map_err(|_| SmtpPreflightError::retryable(SmtpFailureCategory::Connection))?;
    let connector = tls_connector(config)?;
    let server_name = ServerName::try_from(config.host().to_owned())
        .map_err(|_| SmtpPreflightError::permanent(SmtpFailureCategory::Trust))?;

    match config.security() {
        SmtpSecurity::ImplicitTls => {
            let stream = connector
                .connect(server_name, tcp)
                .await
                .map_err(classify_tls_error)?;
            smtp_session(BufReader::new(stream), config, false).await
        }
        SmtpSecurity::StartTls => {
            let mut plain = BufReader::new(tcp);
            expect_reply(&mut plain, 220, false).await?;
            send_command(plain.get_mut(), b"EHLO nuriteo.invalid\r\n").await?;
            let hello = read_reply(&mut plain).await?;
            ensure_success(hello.code, 250, false)?;
            if !hello
                .lines
                .iter()
                .any(|line| line.eq_ignore_ascii_case("STARTTLS"))
            {
                return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Trust));
            }
            send_command(plain.get_mut(), b"STARTTLS\r\n").await?;
            expect_reply(&mut plain, 220, false).await?;
            let stream = connector
                .connect(server_name, plain.into_inner())
                .await
                .map_err(classify_tls_error)?;
            smtp_session(BufReader::new(stream), config, true).await
        }
    }
}

async fn smtp_session<S>(
    mut stream: BufReader<S>,
    config: &SmtpConfig,
    greeting_already_read: bool,
) -> Result<SmtpPreflightReport, SmtpPreflightError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if !greeting_already_read {
        expect_reply(&mut stream, 220, false).await?;
    }
    send_command(stream.get_mut(), b"EHLO nuriteo.invalid\r\n").await?;
    let hello = read_reply(&mut stream).await?;
    ensure_success(hello.code, 250, false)?;

    let authenticated = if let Some(credentials) = config.credentials() {
        if !supports_plain_auth(&hello.lines) {
            return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol));
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
        let mut command = Zeroizing::new(Vec::with_capacity(encoded.len() + 14));
        command.extend_from_slice(b"AUTH PLAIN ");
        command.extend_from_slice(encoded.as_bytes());
        command.extend_from_slice(b"\r\n");
        send_command(stream.get_mut(), &command).await?;
        expect_reply(&mut stream, 235, true).await?;
        true
    } else {
        false
    };

    send_command(stream.get_mut(), b"QUIT\r\n").await?;
    let _ = expect_reply(&mut stream, 221, false).await;
    Ok(SmtpPreflightReport {
        tls_verified: true,
        starttls_verified: config.security() == SmtpSecurity::StartTls,
        authenticated,
    })
}

pub(crate) fn supports_plain_auth(lines: &[String]) -> bool {
    lines.iter().any(|line| {
        let upper = line.to_ascii_uppercase();
        let capabilities = upper
            .strip_prefix("AUTH ")
            .or_else(|| upper.strip_prefix("AUTH="));
        capabilities.is_some_and(|mechanisms| {
            mechanisms
                .split_ascii_whitespace()
                .any(|mechanism| mechanism == "PLAIN")
        })
    })
}

pub(crate) fn tls_connector(config: &SmtpConfig) -> Result<TlsConnector, SmtpPreflightError> {
    let native = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    let (accepted, _) = roots.add_parsable_certificates(native.certs);
    for certificate in config.tls_trust().certificates() {
        roots
            .add(certificate)
            .map_err(|_| SmtpPreflightError::permanent(SmtpFailureCategory::Trust))?;
    }
    if accepted == 0 && roots.is_empty() {
        return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Trust));
    }
    let client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| SmtpPreflightError::permanent(SmtpFailureCategory::Trust))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(client)))
}

fn classify_tls_error(error: io::Error) -> SmtpPreflightError {
    if error.kind() == io::ErrorKind::InvalidData {
        SmtpPreflightError::permanent(SmtpFailureCategory::Trust)
    } else {
        SmtpPreflightError::retryable(SmtpFailureCategory::Connection)
    }
}

pub(crate) async fn send_command(
    stream: &mut (impl AsyncWrite + Unpin),
    command: &[u8],
) -> Result<(), SmtpPreflightError> {
    stream
        .write_all(command)
        .await
        .map_err(|_| SmtpPreflightError::retryable(SmtpFailureCategory::Connection))?;
    stream
        .flush()
        .await
        .map_err(|_| SmtpPreflightError::retryable(SmtpFailureCategory::Connection))
}

async fn expect_reply<S>(
    stream: &mut BufReader<S>,
    expected: u16,
    authentication: bool,
) -> Result<(), SmtpPreflightError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let response = read_reply(stream).await?;
    ensure_success(response.code, expected, authentication)
}

fn ensure_success(
    actual: u16,
    expected: u16,
    authentication: bool,
) -> Result<(), SmtpPreflightError> {
    if actual == expected {
        Ok(())
    } else if (400..600).contains(&actual) {
        Err(SmtpPreflightError::response(actual, authentication))
    } else {
        Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol))
    }
}

#[derive(Debug)]
pub(crate) struct SmtpReply {
    pub(crate) code: u16,
    pub(crate) lines: Vec<String>,
}

pub(crate) async fn read_reply<S>(
    stream: &mut BufReader<S>,
) -> Result<SmtpReply, SmtpPreflightError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut bytes_read = 0_usize;
    let mut expected_code = None;
    let mut lines = Vec::new();
    for _ in 0..MAX_REPLY_LINES {
        let remaining = MAX_REPLY_BYTES.saturating_sub(bytes_read);
        let line = read_bounded_reply_line(stream, remaining).await?;
        bytes_read += line.len();
        if line.len() < 5 || !line.ends_with(b"\r\n") {
            return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol));
        }
        let code = std::str::from_utf8(&line[..3])
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| (200..600).contains(value))
            .ok_or_else(|| SmtpPreflightError::permanent(SmtpFailureCategory::Protocol))?;
        if expected_code
            .replace(code)
            .is_some_and(|expected| expected != code)
        {
            return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol));
        }
        let separator = line[3];
        if !matches!(separator, b'-' | b' ') {
            return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol));
        }
        let text = std::str::from_utf8(&line[4..line.len() - 2])
            .map_err(|_| SmtpPreflightError::permanent(SmtpFailureCategory::Protocol))?;
        lines.push(text.to_owned());
        if separator == b' ' {
            return Ok(SmtpReply { code, lines });
        }
    }
    Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol))
}

async fn read_bounded_reply_line<S>(
    stream: &mut BufReader<S>,
    remaining_reply_bytes: usize,
) -> Result<Vec<u8>, SmtpPreflightError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let line_budget = remaining_reply_bytes.min(MAX_REPLY_LINE_BYTES);
    if line_budget == 0 {
        return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol));
    }
    let mut line = Vec::with_capacity(line_budget.min(512));
    loop {
        let available = stream
            .fill_buf()
            .await
            .map_err(|_| SmtpPreflightError::retryable(SmtpFailureCategory::Connection))?;
        if available.is_empty() {
            return Err(SmtpPreflightError::retryable(
                SmtpFailureCategory::Connection,
            ));
        }
        let chunk_length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(chunk_length) > line_budget {
            return Err(SmtpPreflightError::permanent(SmtpFailureCategory::Protocol));
        }
        let complete = available[chunk_length - 1] == b'\n';
        line.extend_from_slice(&available[..chunk_length]);
        stream.consume(chunk_length);
        if complete {
            return Ok(line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smtp_status_classification_is_stable() {
        for (code, expected) in [
            (421, SmtpFailureClass::Retryable),
            (450, SmtpFailureClass::Retryable),
            (535, SmtpFailureClass::Permanent),
            (550, SmtpFailureClass::Permanent),
        ] {
            let error = SmtpPreflightError::response(code, code == 535);
            assert_eq!(error.class(), expected);
            assert_eq!(error.smtp_code(), Some(code));
            assert!(!error.to_string().contains(&code.to_string()));
        }
    }

    #[test]
    fn authentication_is_sent_only_when_plain_is_advertised() {
        assert!(supports_plain_auth(&["AUTH PLAIN LOGIN".to_owned()]));
        assert!(supports_plain_auth(&["auth=plain".to_owned()]));
        assert!(!supports_plain_auth(&["AUTH LOGIN".to_owned()]));
        assert!(!supports_plain_auth(&["SIZE 1024".to_owned()]));
    }

    #[tokio::test]
    async fn reply_parser_is_bounded_and_rejects_mixed_codes() {
        let stream = tokio::io::duplex(20_000);
        let (mut writer, reader) = stream;
        writer
            .write_all(b"250-first\r\n251 final\r\n")
            .await
            .unwrap();
        drop(writer);
        let error = read_reply(&mut BufReader::new(reader)).await.unwrap_err();
        assert_eq!(error.category(), SmtpFailureCategory::Protocol);
    }

    #[tokio::test]
    async fn reply_parser_rejects_a_newline_free_line_at_the_hard_limit() {
        let (mut writer, reader) = tokio::io::duplex(MAX_REPLY_LINE_BYTES + 32);
        writer
            .write_all(&vec![b'x'; MAX_REPLY_LINE_BYTES + 1])
            .await
            .unwrap();
        let error = read_reply(&mut BufReader::new(reader)).await.unwrap_err();
        assert_eq!(error.class(), SmtpFailureClass::Permanent);
        assert_eq!(error.category(), SmtpFailureCategory::Protocol);
    }
}
