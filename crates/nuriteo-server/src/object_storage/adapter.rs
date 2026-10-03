use std::fmt;

use aws_config::default_provider::credentials::DefaultCredentialsChain;
use aws_config::provider_config::ProviderConfig;
use aws_config::web_identity_token::WebIdentityTokenCredentialsProvider;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use aws_smithy_types::retry::RetryConfig;
use aws_smithy_types::timeout::TimeoutConfig;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use tokio::io::AsyncReadExt;

use super::capability_types::BackendIdentifier;
use super::config::{AddressingStyle, CredentialProvider, ObjectStorageConfig, TlsTrust};
use super::error::{ObjectOperation, ObjectStoreError, ObjectStoreErrorKind, classify_sdk_error};
use super::types::{
    ByteRange, GetResult, ListPage, ListRequest, ObjectKey, ObjectMetadata, ObjectSummary,
    OperationLimits, PutRequest, RequestValidationError,
};

const MAX_CONNECTIONS_PER_HOST: usize = 32;

#[derive(Clone)]
pub struct S3ObjectStore {
    pub(super) client: Client,
    pub(super) bucket: String,
    pub(super) limits: OperationLimits,
    pub(super) presigned_client: reqwest::Client,
    pub(super) backend_identifier: BackendIdentifier,
}

impl fmt::Debug for S3ObjectStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("S3ObjectStore")
            .field("bucket_configured", &true)
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl S3ObjectStore {
    pub async fn new(
        config: &ObjectStorageConfig,
        limits: OperationLimits,
    ) -> Result<Self, ObjectStoreBuildError> {
        limits
            .validate()
            .map_err(|_| ObjectStoreBuildError::InvalidLimits)?;

        let http_client = build_http_client(config.tls_trust())?;
        let presigned_client = build_presigned_client(config.tls_trust(), &limits)?;
        let backend_identifier = BackendIdentifier::from_endpoint(config.endpoint().as_str());
        let region = Region::new(config.region().to_owned());
        let provider_config = ProviderConfig::without_region()
            .with_region(Some(region.clone()))
            .with_http_client(http_client.clone());

        let mut builder = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(region.clone())
            .endpoint_url(config.endpoint().as_str())
            .force_path_style(matches!(config.addressing_style(), AddressingStyle::Path))
            .http_client(http_client)
            .retry_config(RetryConfig::standard().with_max_attempts(limits.max_attempts))
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(limits.connect_timeout)
                    .operation_timeout(limits.request_timeout)
                    .operation_attempt_timeout(limits.attempt_timeout)
                    .build(),
            );

        builder = match config.credential_provider() {
            CredentialProvider::Static(credentials) => {
                let credentials = Credentials::new(
                    credentials.access_key_id().expose_secret(),
                    credentials.secret_access_key().expose_secret(),
                    credentials
                        .session_token()
                        .map(|token| token.expose_secret().to_owned()),
                    None,
                    "nuriteo-static",
                );
                builder.credentials_provider(credentials)
            }
            CredentialProvider::Workload => builder.credentials_provider(
                WebIdentityTokenCredentialsProvider::builder()
                    .configure(&provider_config)
                    .build(),
            ),
            CredentialProvider::Default => {
                let provider = DefaultCredentialsChain::builder()
                    .region(region)
                    .configure(provider_config)
                    .build()
                    .await;
                builder.credentials_provider(provider)
            }
        };

        Ok(Self {
            client: Client::from_conf(builder.build()),
            bucket: config.bucket().to_owned(),
            limits,
            presigned_client,
            backend_identifier,
        })
    }

    pub async fn put(&self, request: PutRequest) -> Result<(), ObjectStoreError> {
        request
            .validate(&self.limits)
            .map_err(|error| validation_error(ObjectOperation::Put, error))?;
        let mut operation = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(request.key.expose())
            .body(ByteStream::from(request.body));
        if let Some(content_type) = request.content_type {
            operation = operation.content_type(content_type);
        }
        operation
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Put, &error))?;
        Ok(())
    }

    pub async fn get(&self, key: &ObjectKey) -> Result<GetResult, ObjectStoreError> {
        self.get_inner(key, None, self.limits.max_body_bytes).await
    }

    pub async fn get_range(
        &self,
        key: &ObjectKey,
        range: ByteRange,
    ) -> Result<GetResult, ObjectStoreError> {
        if range.len() > self.limits.max_range_bytes {
            return Err(ObjectStoreError::new(
                ObjectOperation::Get,
                ObjectStoreErrorKind::InvalidRequest,
                false,
            ));
        }
        self.get_inner(key, Some(range), self.limits.max_range_bytes)
            .await
    }

    async fn get_inner(
        &self,
        key: &ObjectKey,
        range: Option<ByteRange>,
        maximum: u64,
    ) -> Result<GetResult, ObjectStoreError> {
        let mut operation = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key.expose());
        if let Some(range) = range {
            operation = operation.range(range.header_value());
        }
        let output = operation
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Get, &error))?;
        if output.content_length().is_some_and(|length| {
            length < 0 || u64::try_from(length).is_ok_and(|length| length > maximum)
        }) {
            return Err(ObjectStoreError::new(
                ObjectOperation::Get,
                ObjectStoreErrorKind::ResponseTooLarge,
                false,
            ));
        }

        let read_limit = maximum.saturating_add(1);
        let mut reader = output.body.into_async_read().take(read_limit);
        let capacity = usize::try_from(maximum.min(1024 * 1024)).unwrap_or(1024 * 1024);
        let mut body = Vec::with_capacity(capacity);
        reader.read_to_end(&mut body).await.map_err(|_| {
            ObjectStoreError::new(
                ObjectOperation::Get,
                ObjectStoreErrorKind::Unavailable,
                true,
            )
        })?;
        if body.len() as u64 > maximum {
            return Err(ObjectStoreError::new(
                ObjectOperation::Get,
                ObjectStoreErrorKind::ResponseTooLarge,
                false,
            ));
        }
        let content_length = body.len() as u64;
        Ok(GetResult {
            body: Bytes::from(body),
            metadata: ObjectMetadata { content_length },
        })
    }

    pub async fn head(&self, key: &ObjectKey) -> Result<ObjectMetadata, ObjectStoreError> {
        let output = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key.expose())
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Head, &error))?;
        let content_length = output
            .content_length()
            .and_then(|value| u64::try_from(value).ok())
            .ok_or_else(|| {
                ObjectStoreError::new(ObjectOperation::Head, ObjectStoreErrorKind::Internal, false)
            })?;
        Ok(ObjectMetadata { content_length })
    }

    pub async fn delete(&self, key: &ObjectKey) -> Result<(), ObjectStoreError> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key.expose())
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Delete, &error))?;
        Ok(())
    }

    pub async fn list(&self, request: ListRequest) -> Result<ListPage, ObjectStoreError> {
        request
            .validate(&self.limits)
            .map_err(|error| validation_error(ObjectOperation::List, error))?;
        let mut operation = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(request.prefix.expose())
            .max_keys(i32::from(request.page_size.get()));
        if let Some(token) = &request.continuation {
            operation = operation.continuation_token(token.expose());
        }
        let output = operation
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::List, &error))?;
        if output.contents().len() > usize::from(request.page_size.get()) {
            return Err(ObjectStoreError::new(
                ObjectOperation::List,
                ObjectStoreErrorKind::ResponseTooLarge,
                false,
            ));
        }
        let mut objects = Vec::with_capacity(output.contents().len());
        for object in output.contents() {
            let key = object
                .key()
                .map(str::to_owned)
                .ok_or_else(|| malformed_list_error(ObjectOperation::List))
                .and_then(|key| {
                    ObjectKey::parse(key).map_err(|_| malformed_list_error(ObjectOperation::List))
                })?;
            let size = object
                .size()
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| malformed_list_error(ObjectOperation::List))?;
            objects.push(ObjectSummary { key, size });
        }
        let next = if output.is_truncated().unwrap_or(false) {
            Some(
                output
                    .next_continuation_token()
                    .map(str::to_owned)
                    .map(super::types::ContinuationToken::from_service)
                    .ok_or_else(|| malformed_list_error(ObjectOperation::List))?,
            )
        } else {
            None
        };
        Ok(ListPage { objects, next })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectStoreBuildError {
    InvalidLimits,
    TlsClient,
}

impl fmt::Display for ObjectStoreBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidLimits => "object storage operation limits are invalid",
            Self::TlsClient => "object storage TLS client could not be configured",
        })
    }
}

impl std::error::Error for ObjectStoreBuildError {}

fn build_http_client(trust: &TlsTrust) -> Result<PoolClient, ObjectStoreBuildError> {
    let mut trust_store = TrustStore::default();
    for certificate in trust
        .instance_ca()
        .into_iter()
        .chain(trust.integration_ca())
        .flat_map(super::config::CaBundle::certificates_der)
    {
        trust_store.add_pem_certificate(der_to_pem(certificate));
    }
    let context = TlsContext::builder()
        .with_trust_store(trust_store)
        .build()
        .map_err(|_| ObjectStoreBuildError::TlsClient)?;
    let pool = ConnectionPool::builder()
        .max_connections_per_host(MAX_CONNECTIONS_PER_HOST)
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .map_err(|_| ObjectStoreBuildError::TlsClient)?;
    PoolClient::new(&pool).map_err(|_| ObjectStoreBuildError::TlsClient)
}

fn build_presigned_client(
    trust: &TlsTrust,
    limits: &OperationLimits,
) -> Result<reqwest::Client, ObjectStoreBuildError> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.request_timeout);
    for certificate in trust
        .instance_ca()
        .into_iter()
        .chain(trust.integration_ca())
        .flat_map(super::config::CaBundle::certificates_der)
    {
        let certificate = reqwest::Certificate::from_der(certificate)
            .map_err(|_| ObjectStoreBuildError::TlsClient)?;
        builder = builder.add_root_certificate(certificate);
    }
    builder
        .build()
        .map_err(|_| ObjectStoreBuildError::TlsClient)
}

fn der_to_pem(certificate: &[u8]) -> Vec<u8> {
    let encoded = BASE64.encode(certificate);
    let mut pem = Vec::with_capacity(encoded.len() + 55);
    pem.extend_from_slice(b"-----BEGIN CERTIFICATE-----\n");
    for line in encoded.as_bytes().chunks(64) {
        pem.extend_from_slice(line);
        pem.push(b'\n');
    }
    pem.extend_from_slice(b"-----END CERTIFICATE-----\n");
    pem
}

fn validation_error(operation: ObjectOperation, error: RequestValidationError) -> ObjectStoreError {
    let kind = match error {
        RequestValidationError::BodyTooLarge => ObjectStoreErrorKind::ResponseTooLarge,
        _ => ObjectStoreErrorKind::InvalidRequest,
    };
    ObjectStoreError::new(operation, kind, false)
}

const fn malformed_list_error(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::Internal, false)
}
