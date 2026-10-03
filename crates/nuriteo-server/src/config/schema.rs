/// Operational metadata for one environment input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigField {
    pub name: &'static str,
    pub value_type: &'static str,
    pub default_value: Option<&'static str>,
    pub secret: bool,
    pub reloadable: bool,
    pub validation: &'static str,
}

pub(super) const STRICT: &str = "NURITEO_CONFIG_STRICT";
pub(super) const LISTEN_ADDR: &str = "NURITEO_LISTEN_ADDR";
pub(super) const LOG_FORMAT: &str = "NURITEO_LOG_FORMAT";
pub(super) const LOG_LEVEL: &str = "NURITEO_LOG_LEVEL";
pub(super) const EXTERNAL_URL: &str = "NURITEO_EXTERNAL_URL";
pub(super) const PREVIEW_BASE_DOMAIN: &str = "NURITEO_PREVIEW_BASE_DOMAIN";
pub(super) const DATABASE_URL: &str = "NURITEO_DATABASE_URL";
pub(super) const DATABASE_URL_FILE: &str = "NURITEO_DATABASE_URL_FILE";
pub(super) const S3_ENDPOINT: &str = "NURITEO_S3_ENDPOINT";
pub(super) const S3_REGION: &str = "NURITEO_S3_REGION";
pub(super) const S3_BUCKET: &str = "NURITEO_S3_BUCKET";
pub(super) const S3_PATH_STYLE: &str = "NURITEO_S3_PATH_STYLE";
pub(super) const S3_ACCESS_KEY_ID: &str = "NURITEO_S3_ACCESS_KEY_ID";
pub(super) const S3_ACCESS_KEY_ID_FILE: &str = "NURITEO_S3_ACCESS_KEY_ID_FILE";
pub(super) const S3_SECRET_ACCESS_KEY: &str = "NURITEO_S3_SECRET_ACCESS_KEY";
pub(super) const S3_SECRET_ACCESS_KEY_FILE: &str = "NURITEO_S3_SECRET_ACCESS_KEY_FILE";
pub(super) const MASTER_KEY_FILE: &str = "NURITEO_MASTER_KEY_FILE";
pub(super) const SESSION_KEY_FILE: &str = "NURITEO_SESSION_KEY_FILE";

const fn field(
    name: &'static str,
    value_type: &'static str,
    default_value: Option<&'static str>,
    secret: bool,
    validation: &'static str,
) -> ConfigField {
    ConfigField {
        name,
        value_type,
        default_value,
        secret,
        reloadable: false,
        validation,
    }
}

/// The M0 configuration registry used for typo detection and deployment mapping.
pub const CONFIG_FIELDS: &[ConfigField] = &[
    field(STRICT, "boolean", Some("true"), false, "true or false"),
    field(
        LISTEN_ADDR,
        "socket address",
        Some("0.0.0.0:8080"),
        false,
        "IP address and port",
    ),
    field(LOG_FORMAT, "enum", Some("json"), false, "text or json"),
    field(
        LOG_LEVEL,
        "enum",
        Some("info"),
        false,
        "error, warn, info, or debug",
    ),
    field(
        EXTERNAL_URL,
        "URL",
        None,
        false,
        "HTTPS origin; HTTP only for loopback development",
    ),
    field(
        PREVIEW_BASE_DOMAIN,
        "DNS domain",
        None,
        false,
        "domain without scheme, port, or wildcard",
    ),
    field(
        DATABASE_URL,
        "PostgreSQL URL",
        None,
        true,
        "postgres/postgresql URL with host, user, and database",
    ),
    field(
        DATABASE_URL_FILE,
        "secret file path",
        None,
        true,
        "readable non-empty UTF-8 file; exclusive with NURITEO_DATABASE_URL",
    ),
    field(S3_ENDPOINT, "URL", None, false, "HTTP or HTTPS URL"),
    field(
        S3_REGION,
        "string",
        None,
        false,
        "1-63 safe identifier characters",
    ),
    field(S3_BUCKET, "string", None, false, "valid S3 bucket name"),
    field(
        S3_PATH_STYLE,
        "boolean",
        Some("false"),
        false,
        "true or false",
    ),
    field(
        S3_ACCESS_KEY_ID,
        "string",
        None,
        true,
        "non-empty credential",
    ),
    field(
        S3_ACCESS_KEY_ID_FILE,
        "secret file path",
        None,
        true,
        "readable non-empty UTF-8 file; exclusive with direct value",
    ),
    field(
        S3_SECRET_ACCESS_KEY,
        "string",
        None,
        true,
        "non-empty credential",
    ),
    field(
        S3_SECRET_ACCESS_KEY_FILE,
        "secret file path",
        None,
        true,
        "readable non-empty UTF-8 file; exclusive with direct value",
    ),
    field(
        MASTER_KEY_FILE,
        "secret file path",
        None,
        true,
        "readable UTF-8 file containing at least 32 bytes",
    ),
    field(
        SESSION_KEY_FILE,
        "secret file path",
        None,
        true,
        "readable UTF-8 file containing a distinct value of at least 32 bytes",
    ),
];
