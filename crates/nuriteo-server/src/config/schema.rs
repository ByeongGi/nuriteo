/// Deployment metadata for one startup configuration field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigField {
    pub environment: &'static str,
    pub file_key: Option<&'static str>,
    pub value_type: &'static str,
    pub default_value: Option<&'static str>,
    pub secret: bool,
    pub reloadable: bool,
    pub validation: &'static str,
    pub compose_mapping: &'static str,
    pub helm_mapping: &'static str,
}

pub(super) const CONFIG_FILE: &str = "NURITEO_CONFIG_FILE";
pub(super) const STRICT: &str = "NURITEO_CONFIG_STRICT";
pub(super) const LISTEN_ADDR: &str = "NURITEO_HTTP_LISTEN_ADDR";
pub(super) const SHUTDOWN_DRAIN_TIMEOUT_MS: &str = "NURITEO_SHUTDOWN_DRAIN_TIMEOUT_MS";
pub(super) const LOG_FORMAT: &str = "NURITEO_LOG_FORMAT";
pub(super) const LOG_LEVEL: &str = "NURITEO_LOG_LEVEL";
pub(super) const EXTERNAL_URL: &str = "NURITEO_EXTERNAL_URL";
pub(super) const PREVIEW_BASE_DOMAIN: &str = "NURITEO_PREVIEW_BASE_DOMAIN";

const fn field(
    environment: &'static str,
    file_key: Option<&'static str>,
    value_type: &'static str,
    default_value: Option<&'static str>,
    validation: &'static str,
    helm_mapping: &'static str,
) -> ConfigField {
    ConfigField {
        environment,
        file_key,
        value_type,
        default_value,
        secret: false,
        reloadable: false,
        validation,
        compose_mapping: environment,
        helm_mapping,
    }
}

const fn secret_field(environment: &'static str, validation: &'static str) -> ConfigField {
    ConfigField {
        environment,
        file_key: None,
        value_type: "secret",
        default_value: None,
        secret: true,
        reloadable: false,
        validation,
        compose_mapping: environment,
        helm_mapping: "objectStorage.credentials",
    }
}

/// The M0 registry used for typo detection and deployment documentation.
pub const CONFIG_FIELDS: &[ConfigField] = &[
    field(
        CONFIG_FILE,
        None,
        "path",
        None,
        "readable UTF-8 TOML file no larger than 64 KiB",
        "server.config.existingFile",
    ),
    field(
        STRICT,
        Some("config.strict_environment"),
        "boolean",
        Some("true"),
        "true or false",
        "server.config.strictEnvironment",
    ),
    field(
        LISTEN_ADDR,
        Some("server.listen_address"),
        "socket address",
        Some("127.0.0.1:8080"),
        "literal IP address and non-zero port",
        "server.listenAddress",
    ),
    field(
        SHUTDOWN_DRAIN_TIMEOUT_MS,
        Some("server.shutdown_drain_timeout_ms"),
        "milliseconds",
        Some("30000"),
        "integer from 1000 through 300000",
        "server.shutdownDrainTimeoutMs",
    ),
    field(
        LOG_FORMAT,
        Some("logging.format"),
        "enum",
        Some("json"),
        "text or json",
        "observability.logFormat",
    ),
    field(
        LOG_LEVEL,
        Some("logging.level"),
        "enum",
        Some("info"),
        "error, warn, info, or debug",
        "observability.logLevel",
    ),
    field(
        EXTERNAL_URL,
        Some("public.external_url"),
        "URL",
        None,
        "root HTTPS origin; HTTP only for loopback development",
        "global.externalUrl",
    ),
    field(
        PREVIEW_BASE_DOMAIN,
        Some("public.preview_base_domain"),
        "DNS domain",
        None,
        "optional ASCII domain without scheme, port, wildcard, or trailing dot",
        "preview.baseDomain",
    ),
    field(
        "NURITEO_S3_ENDPOINT",
        None,
        "URL",
        None,
        "root HTTPS origin; HTTP only for loopback development",
        "objectStorage.endpoint",
    ),
    field(
        "NURITEO_S3_REGION",
        None,
        "string",
        None,
        "1-63 character provider region identifier",
        "objectStorage.region",
    ),
    field(
        "NURITEO_S3_BUCKET",
        None,
        "string",
        None,
        "DNS-compatible S3 bucket name",
        "objectStorage.bucket",
    ),
    field(
        "NURITEO_S3_ADDRESSING_STYLE",
        None,
        "enum",
        None,
        "path or virtual-hosted",
        "objectStorage.addressingStyle",
    ),
    field(
        "NURITEO_S3_CREDENTIAL_PROVIDER",
        None,
        "enum",
        None,
        "static, workload, or default; no implicit fallback",
        "objectStorage.credentials.provider",
    ),
    secret_field(
        "NURITEO_S3_ACCESS_KEY_ID",
        "static provider credential; exclusive with _FILE",
    ),
    secret_field(
        "NURITEO_S3_ACCESS_KEY_ID_FILE",
        "bounded mounted secret file; exclusive with direct value",
    ),
    secret_field(
        "NURITEO_S3_SECRET_ACCESS_KEY",
        "static provider credential; exclusive with _FILE",
    ),
    secret_field(
        "NURITEO_S3_SECRET_ACCESS_KEY_FILE",
        "bounded mounted secret file; exclusive with direct value",
    ),
    secret_field(
        "NURITEO_S3_SESSION_TOKEN",
        "optional static provider credential; exclusive with _FILE",
    ),
    secret_field(
        "NURITEO_S3_SESSION_TOKEN_FILE",
        "bounded mounted secret file; exclusive with direct value",
    ),
    field(
        "NURITEO_INSTANCE_CA_FILE",
        None,
        "path",
        None,
        "bounded PEM bundle containing CA certificates only",
        "global.trust.instanceCa.existingFile",
    ),
    field(
        "NURITEO_S3_CA_FILE",
        None,
        "path",
        None,
        "bounded integration PEM bundle containing CA certificates only",
        "objectStorage.tls.ca.existingFile",
    ),
];
