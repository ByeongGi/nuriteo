use std::ffi::OsString;
use std::time::Duration;

use reqwest::redirect::Policy;
use url::{Host, Url};

use crate::config::Environment;

use super::HealthcheckResponse;

const HEALTHCHECK_URL: &str = "NURITEO_HEALTHCHECK_URL";
const HEALTHCHECK_TIMEOUT_MS: &str = "NURITEO_HEALTHCHECK_TIMEOUT_MS";
const DEFAULT_URL: &str = "http://127.0.0.1:8080/health/ready";
const DEFAULT_TIMEOUT_MS: u64 = 2_000;
const MAX_RESPONSE_BYTES: u64 = 1_024;

pub(crate) async fn run_http_healthcheck(environment: &impl Environment) -> bool {
    let Ok(config) = HealthcheckClientConfig::load(environment.entries()) else {
        return false;
    };
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(config.timeout)
        .timeout(config.timeout)
        .build()
    else {
        return false;
    };
    let Ok(mut response) = client.get(config.url).send().await else {
        return false;
    };
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return false;
    }
    let mut body = Vec::with_capacity(MAX_RESPONSE_BYTES as usize);
    loop {
        let Ok(chunk) = response.chunk().await else {
            return false;
        };
        let Some(chunk) = chunk else {
            break;
        };
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES as usize {
            return false;
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<HealthcheckResponse>(&body).is_ok_and(|body| body.is_ready())
}

struct HealthcheckClientConfig {
    url: Url,
    timeout: Duration,
}

impl HealthcheckClientConfig {
    fn load(entries: Vec<(OsString, OsString)>) -> Result<Self, ()> {
        let mut url = None;
        let mut timeout = None;
        for (name, value) in entries {
            if name == HEALTHCHECK_URL {
                if url.is_some() {
                    return Err(());
                }
                url = Some(value.into_string().map_err(|_| ())?);
            } else if name == HEALTHCHECK_TIMEOUT_MS {
                if timeout.is_some() {
                    return Err(());
                }
                timeout = Some(value.into_string().map_err(|_| ())?);
            }
        }
        let url = parse_url(url.as_deref().unwrap_or(DEFAULT_URL))?;
        let timeout_ms = timeout
            .as_deref()
            .map(str::parse::<u64>)
            .transpose()
            .map_err(|_| ())?
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        if !(100..=10_000).contains(&timeout_ms) {
            return Err(());
        }
        Ok(Self {
            url,
            timeout: Duration::from_millis(timeout_ms),
        })
    }
}

fn parse_url(value: &str) -> Result<Url, ()> {
    let url = Url::parse(value).map_err(|_| ())?;
    let host = url.host().ok_or(())?;
    let secure_or_loopback = url.scheme() == "https"
        || (url.scheme() == "http"
            && match host {
                Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
                Host::Ipv4(address) => address.is_loopback(),
                Host::Ipv6(address) => address.is_loopback(),
            });
    if !secure_or_loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/health/ready"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt;

    use super::*;

    struct TestEnvironment(Vec<(OsString, OsString)>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }

    #[test]
    fn target_is_fixed_to_safe_readiness_urls_and_bounded_timeouts() {
        for (url, valid) in [
            ("http://127.0.0.1:8080/health/ready", true),
            ("http://localhost:8080/health/ready", true),
            ("https://internal.example/health/ready", true),
            ("http://internal.example/health/ready", false),
            ("https://user:secret@internal.example/health/ready", false),
            ("https://internal.example/health/live", false),
            ("https://internal.example/health/ready?token=secret", false),
        ] {
            let environment = TestEnvironment(vec![
                (HEALTHCHECK_URL.into(), url.into()),
                (HEALTHCHECK_TIMEOUT_MS.into(), "2000".into()),
            ]);
            assert_eq!(
                HealthcheckClientConfig::load(environment.entries()).is_ok(),
                valid
            );
        }
        for timeout in ["0", "99", "10001", "secret"] {
            let environment =
                TestEnvironment(vec![(HEALTHCHECK_TIMEOUT_MS.into(), timeout.into())]);
            assert!(HealthcheckClientConfig::load(environment.entries()).is_err());
        }
    }

    #[tokio::test]
    async fn rejects_chunked_oversized_and_extended_responses() {
        let oversized = vec![b'x'; MAX_RESPONSE_BYTES as usize + 1];
        let oversized_url = serve_once(chunked_response(&oversized)).await;
        let environment = environment_for(oversized_url);
        assert!(!run_http_healthcheck(&environment).await);

        let extended = br#"{"status":"ready","diagnostic":"secret"}"#;
        let extended_url = serve_once(fixed_response(extended)).await;
        let environment = environment_for(extended_url);
        assert!(!run_http_healthcheck(&environment).await);
    }

    fn environment_for(url: String) -> TestEnvironment {
        TestEnvironment(vec![
            (HEALTHCHECK_URL.into(), url.into()),
            (HEALTHCHECK_TIMEOUT_MS.into(), "1000".into()),
        ])
    }

    async fn serve_once(response: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(&response).await.unwrap();
        });
        format!("http://{address}/health/ready")
    }

    fn fixed_response(body: &[u8]) -> Vec<u8> {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        [head.as_bytes(), body].concat()
    }

    fn chunked_response(body: &[u8]) -> Vec<u8> {
        let head = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
        let chunk_size = format!("{:x}\r\n", body.len());
        [head, chunk_size.as_bytes(), body, b"\r\n0\r\n\r\n"].concat()
    }
}
