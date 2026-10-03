use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

use url::{Host, Url};

use super::{ConfigError, LogFormat, LogLevel};

pub(super) fn socket_addr(name: &'static str, value: &str) -> Result<SocketAddr, ConfigError> {
    value
        .parse()
        .map_err(|_| ConfigError::invalid(name, "must be an IP address and port"))
}

pub(super) fn log_format(name: &'static str, value: &str) -> Result<LogFormat, ConfigError> {
    match value.to_ascii_lowercase().as_str() {
        "text" => Ok(LogFormat::Text),
        "json" => Ok(LogFormat::Json),
        _ => Err(ConfigError::invalid(name, "must be one of: text, json")),
    }
}

pub(super) fn log_level(name: &'static str, value: &str) -> Result<LogLevel, ConfigError> {
    match value.to_ascii_lowercase().as_str() {
        "error" => Ok(LogLevel::Error),
        "warn" => Ok(LogLevel::Warn),
        "info" => Ok(LogLevel::Info),
        "debug" => Ok(LogLevel::Debug),
        _ => Err(ConfigError::invalid(
            name,
            "must be one of: error, warn, info, debug",
        )),
    }
}

pub(super) fn boolean(name: &'static str, value: &str) -> Result<bool, ConfigError> {
    match value.to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(ConfigError::invalid(name, "must be true or false")),
    }
}

pub(super) fn external_url(name: &'static str, value: &str) -> Result<Url, ConfigError> {
    let url = absolute_url(name, value)?;
    let host = url
        .host()
        .ok_or_else(|| ConfigError::invalid(name, "must include a host"))?;

    if url.scheme() != "https" && !(url.scheme() == "http" && host_is_loopback(&host)) {
        return Err(ConfigError::invalid(
            name,
            "must use https except for a loopback development URL",
        ));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(ConfigError::invalid(
            name,
            "must be an origin without a path, query, or fragment",
        ));
    }

    Ok(url)
}

pub(super) fn endpoint_url(name: &'static str, value: &str) -> Result<Url, ConfigError> {
    let url = absolute_url(name, value)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ConfigError::invalid(name, "must use http or https"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ConfigError::invalid(
            name,
            "must not include a query or fragment",
        ));
    }
    Ok(url)
}

pub(super) fn database_url(name: &'static str, value: &str) -> Result<(), ConfigError> {
    let url = Url::parse(value).map_err(|_| ConfigError::invalid(name, "must be a valid URL"))?;
    if url.cannot_be_a_base() {
        return Err(ConfigError::invalid(name, "must be an absolute URL"));
    }
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(ConfigError::invalid(
            name,
            "must use postgres or postgresql",
        ));
    }
    if url.host().is_none() {
        return Err(ConfigError::invalid(name, "must include a database host"));
    }
    if url.username().is_empty() {
        return Err(ConfigError::invalid(name, "must include a database user"));
    }
    if url.path().trim_matches('/').is_empty() {
        return Err(ConfigError::invalid(name, "must include a database name"));
    }
    if url.fragment().is_some() {
        return Err(ConfigError::invalid(name, "must not include a fragment"));
    }
    Ok(())
}

fn absolute_url(name: &'static str, value: &str) -> Result<Url, ConfigError> {
    let url = Url::parse(value).map_err(|_| ConfigError::invalid(name, "must be a valid URL"))?;
    if url.cannot_be_a_base() || url.username() != "" || url.password().is_some() {
        return Err(ConfigError::invalid(
            name,
            "must be an absolute URL without credentials",
        ));
    }
    Ok(url)
}

fn host_is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

pub(super) fn preview_domain(name: &'static str, value: &str) -> Result<String, ConfigError> {
    let value = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if value.is_empty()
        || value.len() > 253
        || value.contains(['/', ':', '*'])
        || IpAddr::from_str(&value).is_ok()
        || !value.split('.').all(valid_dns_label)
    {
        return Err(ConfigError::invalid(
            name,
            "must be a valid DNS domain without a wildcard",
        ));
    }
    Ok(value)
}

fn valid_dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(super) fn region(name: &'static str, value: &str) -> Result<String, ConfigError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 63
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ConfigError::invalid(
            name,
            "must be a non-empty region identifier",
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn bucket(name: &'static str, value: &str) -> Result<String, ConfigError> {
    let value = value.trim();
    let valid = (3..=63).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !value.contains("..")
        && IpAddr::from_str(value).is_err();
    if !valid {
        return Err(ConfigError::invalid(name, "must be a valid S3 bucket name"));
    }
    Ok(value.to_owned())
}
