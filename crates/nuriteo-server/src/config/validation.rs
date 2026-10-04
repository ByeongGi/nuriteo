use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::time::Duration;

use url::{Host, Url};

use super::{ConfigError, LogFormat, LogLevel};

pub(super) fn socket_addr(name: &'static str, value: &str) -> Result<SocketAddr, ConfigError> {
    let address: SocketAddr = value
        .parse()
        .map_err(|_| ConfigError::invalid(name, "must be an IP address and port"))?;
    if address.port() == 0 {
        return Err(ConfigError::invalid(name, "must use a non-zero port"));
    }
    Ok(address)
}

pub(super) fn drain_timeout(name: &'static str, value: &str) -> Result<Duration, ConfigError> {
    let milliseconds: u64 = value
        .parse()
        .map_err(|_| ConfigError::invalid(name, "must be an integer number of milliseconds"))?;
    if !(1_000..=300_000).contains(&milliseconds) {
        return Err(ConfigError::invalid(
            name,
            "must be between 1000 and 300000 milliseconds",
        ));
    }
    Ok(Duration::from_millis(milliseconds))
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

pub(super) fn bounded_u64(
    name: &'static str,
    value: &str,
    minimum: u64,
    maximum: u64,
) -> Result<u64, ConfigError> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| ConfigError::invalid(name, "must be an integer"))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(ConfigError::invalid(name, "is outside the supported range"));
    }
    Ok(parsed)
}

pub(super) fn external_url(name: &'static str, value: &str) -> Result<Url, ConfigError> {
    let url = Url::parse(value).map_err(|_| ConfigError::invalid(name, "must be a valid URL"))?;
    if url.cannot_be_a_base() || !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::invalid(
            name,
            "must be an absolute URL without credentials",
        ));
    }
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

fn host_is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

pub(super) fn preview_domain(name: &'static str, value: &str) -> Result<String, ConfigError> {
    let normalized = value.to_ascii_lowercase();
    if normalized != value
        || value.is_empty()
        || value.len() > 253
        || value.ends_with('.')
        || value.contains(['/', ':', '*'])
        || IpAddr::from_str(value).is_ok()
        || !value.contains('.')
        || !value.split('.').all(valid_dns_label)
    {
        return Err(ConfigError::invalid(
            name,
            "must be a lowercase ASCII DNS domain without a wildcard",
        ));
    }
    Ok(normalized)
}

fn valid_dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
