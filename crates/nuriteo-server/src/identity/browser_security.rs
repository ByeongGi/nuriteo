use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use subtle::ConstantTimeEq;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc2822;
use url::{Host, Url};

use super::{SessionToken, Timestamp};

const PRODUCTION_SESSION_COOKIE: &str = "__Host-nuriteo_session";
const PRODUCTION_CSRF_COOKIE: &str = "__Host-nuriteo_csrf";
const DEVELOPMENT_SESSION_COOKIE: &str = "nuriteo_dev_session";
const DEVELOPMENT_CSRF_COOKIE: &str = "nuriteo_dev_csrf";
const CSRF_HEADER_NAME: &str = "X-CSRF-Token";
const CSRF_PREFIX: &str = "nrt_csrf_";
const CSRF_BYTES: usize = 32;
const CSRF_ENCODED_BYTES: usize = 43;
const CSRF_WIRE_BYTES: usize = CSRF_PREFIX.len() + CSRF_ENCODED_BYTES;

const MAX_COOKIE_HEADER_BYTES: usize = 8 * 1024;
const MAX_COOKIE_COUNT: usize = 64;
const MAX_COOKIE_NAME_BYTES: usize = 64;
const MAX_COOKIE_VALUE_BYTES: usize = 512;
const MAX_ORIGIN_BYTES: usize = 2 * 1024;
const MAX_SET_COOKIE_BYTES: usize = 1024;
const MAX_COOKIE_LIFETIME_SECONDS: i64 = 90 * 24 * 60 * 60;
const EXPIRED_HTTP_DATE: &str = "Thu, 01 Jan 1970 00:00:00 GMT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserMethod {
    Get,
    Head,
    Options,
    Post,
    Put,
    Patch,
    Delete,
}

impl BrowserMethod {
    const fn is_safe(self) -> bool {
        matches!(self, Self::Get | Self::Head | Self::Options)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BrowserRequestHeaders<'a> {
    pub method: BrowserMethod,
    pub origins: &'a [&'a str],
    pub cookie_headers: &'a [&'a str],
    pub csrf_headers: &'a [&'a str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CookieMode {
    ProductionHttps,
    LoopbackDevelopment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCookieBoundary {
    canonical_origin: String,
    mode: CookieMode,
}

impl BrowserCookieBoundary {
    pub fn new(external_url: &Url) -> Result<Self, BrowserCookieError> {
        validate_external_url(external_url)?;
        let mode = if external_url.scheme() == "https" {
            CookieMode::ProductionHttps
        } else {
            CookieMode::LoopbackDevelopment
        };
        Ok(Self {
            canonical_origin: external_url.origin().ascii_serialization(),
            mode,
        })
    }

    #[must_use]
    pub const fn csrf_header_name(&self) -> &'static str {
        CSRF_HEADER_NAME
    }

    pub fn issue(
        &self,
        session_token: &SessionToken,
        lifetime: CookieLifetime,
    ) -> Result<IssuedBrowserCookies, BrowserCookieError> {
        let csrf_token = CsrfToken::generate()?;
        let session = self.set_cookie(
            self.session_cookie_name(),
            session_token.expose(),
            lifetime,
            true,
        )?;
        let csrf = self.set_cookie(
            self.csrf_cookie_name(),
            csrf_token.expose(),
            lifetime,
            false,
        )?;
        Ok(IssuedBrowserCookies { session, csrf })
    }

    pub fn deletion(&self) -> Result<IssuedBrowserCookies, BrowserCookieError> {
        let session = self.deletion_cookie(self.session_cookie_name(), true)?;
        let csrf = self.deletion_cookie(self.csrf_cookie_name(), false)?;
        Ok(IssuedBrowserCookies { session, csrf })
    }

    pub fn validate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<ValidatedBrowserSession, BrowserCookieError> {
        let cookies = ParsedAuthenticationCookies::parse(
            request.cookie_headers,
            self.session_cookie_name(),
            self.csrf_cookie_name(),
        )?;
        let session = cookies
            .session
            .ok_or(BrowserCookieError::MissingSessionCookie)?;
        let session =
            SessionToken::parse(session).map_err(|_| BrowserCookieError::InvalidSessionCookie)?;

        if !request.method.is_safe() {
            self.validate_origin(request.origins)?;
            let cookie_csrf = cookies.csrf.ok_or(BrowserCookieError::MissingCsrf)?;
            let header_csrf = single_csrf_header(request.csrf_headers)?;
            let cookie_csrf =
                CsrfToken::parse(cookie_csrf).map_err(|_| BrowserCookieError::InvalidCsrf)?;
            let header_csrf = CsrfToken::parse(header_csrf.to_owned())
                .map_err(|_| BrowserCookieError::InvalidCsrf)?;
            if !cookie_csrf.constant_time_matches(&header_csrf) {
                return Err(BrowserCookieError::CsrfMismatch);
            }
        }

        Ok(ValidatedBrowserSession { session })
    }

    /// Parses an optional Session on a safe callback request. Missing is
    /// allowed, while duplicate or malformed authentication cookies remain a
    /// hard failure so account-switch protection cannot be bypassed.
    pub(crate) fn validate_optional_safe_session(
        &self,
        cookie_headers: &[&str],
    ) -> Result<Option<SessionToken>, BrowserCookieError> {
        let cookies = ParsedAuthenticationCookies::parse(
            cookie_headers,
            self.session_cookie_name(),
            self.csrf_cookie_name(),
        )?;
        cookies
            .session
            .map(SessionToken::parse)
            .transpose()
            .map_err(|_| BrowserCookieError::InvalidSessionCookie)
    }

    fn validate_origin(&self, origins: &[&str]) -> Result<(), BrowserCookieError> {
        let [origin] = origins else {
            return Err(if origins.is_empty() {
                BrowserCookieError::MissingOrigin
            } else {
                BrowserCookieError::DuplicateOrigin
            });
        };
        if origin.is_empty()
            || origin.len() > MAX_ORIGIN_BYTES
            || *origin == "null"
            || *origin != self.canonical_origin
        {
            return Err(BrowserCookieError::InvalidOrigin);
        }
        Ok(())
    }

    /// Validates an unsafe browser request that does not yet have a Session,
    /// such as local login. This keeps the exact canonical Origin contract in
    /// the same boundary as cookie-authenticated mutation validation.
    pub(crate) fn validate_unauthenticated_origin(
        &self,
        origins: &[&str],
    ) -> Result<(), BrowserCookieError> {
        self.validate_origin(origins)
    }

    const fn session_cookie_name(&self) -> &'static str {
        match self.mode {
            CookieMode::ProductionHttps => PRODUCTION_SESSION_COOKIE,
            CookieMode::LoopbackDevelopment => DEVELOPMENT_SESSION_COOKIE,
        }
    }

    const fn csrf_cookie_name(&self) -> &'static str {
        match self.mode {
            CookieMode::ProductionHttps => PRODUCTION_CSRF_COOKIE,
            CookieMode::LoopbackDevelopment => DEVELOPMENT_CSRF_COOKIE,
        }
    }

    fn set_cookie(
        &self,
        name: &str,
        value: &str,
        lifetime: CookieLifetime,
        http_only: bool,
    ) -> Result<SetCookieHeader, BrowserCookieError> {
        let expires = format_http_date(lifetime.expires_at)?;
        let secure = if matches!(self.mode, CookieMode::ProductionHttps) {
            "; Secure"
        } else {
            ""
        };
        let http_only = if http_only { "; HttpOnly" } else { "" };
        SetCookieHeader::new(format!(
            "{name}={value}; Path=/; Max-Age={}; Expires={expires}{secure}{http_only}; SameSite=Lax",
            lifetime.max_age_seconds
        ))
    }

    fn deletion_cookie(
        &self,
        name: &str,
        http_only: bool,
    ) -> Result<SetCookieHeader, BrowserCookieError> {
        let secure = if matches!(self.mode, CookieMode::ProductionHttps) {
            "; Secure"
        } else {
            ""
        };
        let http_only = if http_only { "; HttpOnly" } else { "" };
        SetCookieHeader::new(format!(
            "{name}=; Path=/; Max-Age=0; Expires={EXPIRED_HTTP_DATE}{secure}{http_only}; SameSite=Lax"
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CookieLifetime {
    expires_at: OffsetDateTime,
    max_age_seconds: i64,
}

impl CookieLifetime {
    pub fn new(now: Timestamp, absolute_expires_at: Timestamp) -> Result<Self, BrowserCookieError> {
        let now = now.into_datetime();
        let expires_at = absolute_expires_at.into_datetime();
        let max_age_seconds = (expires_at - now).whole_seconds();
        if !(1..=MAX_COOKIE_LIFETIME_SECONDS).contains(&max_age_seconds) {
            return Err(BrowserCookieError::InvalidLifetime);
        }
        Ok(Self {
            expires_at,
            max_age_seconds,
        })
    }

    #[must_use]
    pub const fn max_age_seconds(self) -> i64 {
        self.max_age_seconds
    }
}

pub struct SetCookieHeader(String);

impl SetCookieHeader {
    fn new(value: String) -> Result<Self, BrowserCookieError> {
        if value.len() > MAX_SET_COOKIE_BYTES || value.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(BrowserCookieError::InvalidSetCookie);
        }
        Ok(Self(value))
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "AUTH-001 consumes this narrow in-crate response adapter boundary"
    )]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SetCookieHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SetCookieHeader([REDACTED])")
    }
}

impl fmt::Display for SetCookieHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

pub struct IssuedBrowserCookies {
    session: SetCookieHeader,
    csrf: SetCookieHeader,
}

impl IssuedBrowserCookies {
    #[must_use]
    pub const fn session(&self) -> &SetCookieHeader {
        &self.session
    }

    #[must_use]
    pub const fn csrf(&self) -> &SetCookieHeader {
        &self.csrf
    }

    #[must_use]
    pub fn into_headers(self) -> (SetCookieHeader, SetCookieHeader) {
        (self.session, self.csrf)
    }
}

impl fmt::Debug for IssuedBrowserCookies {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedBrowserCookies")
            .field("session", &"[REDACTED]")
            .field("csrf", &"[REDACTED]")
            .finish()
    }
}

#[derive(PartialEq, Eq)]
pub struct ValidatedBrowserSession {
    session: SessionToken,
}

impl ValidatedBrowserSession {
    #[must_use]
    pub fn into_session_token(self) -> SessionToken {
        self.session
    }
}

impl fmt::Debug for ValidatedBrowserSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ValidatedBrowserSession([REDACTED])")
    }
}

struct CsrfToken(String);

impl CsrfToken {
    fn generate() -> Result<Self, BrowserCookieError> {
        let mut bytes = [0_u8; CSRF_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| BrowserCookieError::EntropyUnavailable)?;
        Self::parse(format!("{CSRF_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
    }

    fn parse(value: String) -> Result<Self, BrowserCookieError> {
        decode_csrf(&value)?;
        Ok(Self(value))
    }

    fn constant_time_matches(&self, other: &Self) -> bool {
        let left = decode_csrf(&self.0);
        let right = decode_csrf(&other.0);
        match (left, right) {
            (Ok(left), Ok(right)) => bool::from(left.ct_eq(&right)),
            _ => false,
        }
    }

    fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CsrfToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CsrfToken([REDACTED])")
    }
}

impl fmt::Display for CsrfToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

struct ParsedAuthenticationCookies {
    session: Option<String>,
    csrf: Option<String>,
}

impl ParsedAuthenticationCookies {
    fn parse(
        headers: &[&str],
        session_name: &str,
        csrf_name: &str,
    ) -> Result<Self, BrowserCookieError> {
        let total = headers.iter().try_fold(0_usize, |total, header| {
            total.checked_add(header.len()).ok_or(())
        });
        if total.is_err() || total.is_ok_and(|total| total > MAX_COOKIE_HEADER_BYTES) {
            return Err(BrowserCookieError::CookieHeadersTooLarge);
        }

        let mut count = 0_usize;
        let mut session = None;
        let mut csrf = None;
        for header in headers {
            if header.is_empty() {
                return Err(BrowserCookieError::MalformedCookie);
            }
            for pair in header.split(';') {
                count = count
                    .checked_add(1)
                    .ok_or(BrowserCookieError::TooManyCookies)?;
                if count > MAX_COOKIE_COUNT {
                    return Err(BrowserCookieError::TooManyCookies);
                }
                let pair = pair.trim_matches([' ', '\t']);
                let (name, value) = pair
                    .split_once('=')
                    .ok_or(BrowserCookieError::MalformedCookie)?;
                if name.is_empty()
                    || name.len() > MAX_COOKIE_NAME_BYTES
                    || !name.bytes().all(is_http_token_byte)
                    || value.len() > MAX_COOKIE_VALUE_BYTES
                    || !value.bytes().all(is_cookie_value_byte)
                {
                    return Err(BrowserCookieError::MalformedCookie);
                }
                if name == session_name {
                    if session.replace(value.to_owned()).is_some() {
                        return Err(BrowserCookieError::DuplicateSessionCookie);
                    }
                } else if name == csrf_name && csrf.replace(value.to_owned()).is_some() {
                    return Err(BrowserCookieError::DuplicateCsrfCookie);
                }
            }
        }
        Ok(Self { session, csrf })
    }
}

fn validate_external_url(url: &Url) -> Result<(), BrowserCookieError> {
    if url.cannot_be_a_base()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err(BrowserCookieError::InvalidExternalUrl);
    }
    match (url.scheme(), url.host()) {
        ("https", Some(_)) => Ok(()),
        ("http", Some(host)) if host_is_loopback(&host) => Ok(()),
        ("http", Some(_)) => Err(BrowserCookieError::InsecureExternalUrl),
        _ => Err(BrowserCookieError::InvalidExternalUrl),
    }
}

fn host_is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

fn single_csrf_header<'a>(headers: &'a [&str]) -> Result<&'a str, BrowserCookieError> {
    let [header] = headers else {
        return Err(if headers.is_empty() {
            BrowserCookieError::MissingCsrf
        } else {
            BrowserCookieError::DuplicateCsrfHeader
        });
    };
    if header.len() != CSRF_WIRE_BYTES {
        return Err(BrowserCookieError::InvalidCsrf);
    }
    Ok(header)
}

fn decode_csrf(value: &str) -> Result<[u8; CSRF_BYTES], BrowserCookieError> {
    if value.len() != CSRF_WIRE_BYTES || !value.starts_with(CSRF_PREFIX) {
        return Err(BrowserCookieError::InvalidCsrf);
    }
    let encoded = &value[CSRF_PREFIX.len()..];
    if encoded.len() != CSRF_ENCODED_BYTES
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrowserCookieError::InvalidCsrf);
    }
    let mut decoded = [0_u8; CSRF_BYTES];
    let written = URL_SAFE_NO_PAD
        .decode_slice(encoded, &mut decoded)
        .map_err(|_| BrowserCookieError::InvalidCsrf)?;
    if written != CSRF_BYTES {
        return Err(BrowserCookieError::InvalidCsrf);
    }
    Ok(decoded)
}

fn format_http_date(value: OffsetDateTime) -> Result<String, BrowserCookieError> {
    let formatted = value
        .to_offset(time::UtcOffset::UTC)
        .format(&Rfc2822)
        .map_err(|_| BrowserCookieError::InvalidLifetime)?;
    let Some(prefix) = formatted.strip_suffix("+0000") else {
        return Err(BrowserCookieError::InvalidLifetime);
    };
    Ok(format!("{prefix}GMT"))
}

fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn is_cookie_value_byte(byte: u8) -> bool {
    matches!(byte, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserCookieError {
    InvalidExternalUrl,
    InsecureExternalUrl,
    InvalidLifetime,
    InvalidSetCookie,
    EntropyUnavailable,
    CookieHeadersTooLarge,
    TooManyCookies,
    MalformedCookie,
    DuplicateSessionCookie,
    DuplicateCsrfCookie,
    MissingSessionCookie,
    InvalidSessionCookie,
    MissingOrigin,
    DuplicateOrigin,
    InvalidOrigin,
    MissingCsrf,
    DuplicateCsrfHeader,
    InvalidCsrf,
    CsrfMismatch,
}

impl fmt::Display for BrowserCookieError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidExternalUrl => "external URL is invalid for browser sessions",
            Self::InsecureExternalUrl => "browser sessions require HTTPS outside loopback",
            Self::InvalidLifetime => "browser session lifetime is invalid",
            Self::InvalidSetCookie => "browser session cookie could not be created",
            Self::EntropyUnavailable => "CSRF credential generation failed",
            Self::CookieHeadersTooLarge => "cookie headers exceed the size limit",
            Self::TooManyCookies => "cookie count exceeds the limit",
            Self::MalformedCookie => "cookie header is malformed",
            Self::DuplicateSessionCookie => "session cookie is duplicated",
            Self::DuplicateCsrfCookie => "CSRF cookie is duplicated",
            Self::MissingSessionCookie => "session cookie is missing",
            Self::InvalidSessionCookie => "session cookie is invalid",
            Self::MissingOrigin => "origin header is missing",
            Self::DuplicateOrigin => "origin header is duplicated",
            Self::InvalidOrigin => "origin is not allowed",
            Self::MissingCsrf => "CSRF credential is missing",
            Self::DuplicateCsrfHeader => "CSRF header is duplicated",
            Self::InvalidCsrf => "CSRF credential is invalid",
            Self::CsrfMismatch => "CSRF credentials do not match",
        })
    }
}

impl std::error::Error for BrowserCookieError {}

#[cfg(test)]
mod tests;
