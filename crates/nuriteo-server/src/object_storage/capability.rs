use std::time::{SystemTime, UNIX_EPOCH};

use aws_sdk_s3::presigning::{PresignedRequest as AwsPresignedRequest, PresigningConfig};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{ChecksumAlgorithm, CompletedMultipartUpload, CompletedPart};
use bytes::{Bytes, BytesMut};

use super::capability_types::{
    BoundedPresignedRequest, CapabilityReport, CapabilityState, CapabilityValidationError,
    MAX_MULTIPART_PARTS, MIN_MULTIPART_PART_BYTES, MultipartLimits, MultipartPartRequest,
    MultipartUpload, PresignExpiry, PresignedMultipartPartRequest, PresignedOperation,
    PresignedPutRequest, ProbePrefix, Sha256Checksum, UploadedPart,
};
use super::error::{ObjectOperation, ObjectStoreError, ObjectStoreErrorKind, classify_sdk_error};
use super::{ObjectKey, PutRequest, S3ObjectStore, SensitiveUrl};

const PROBE_CONTENT_TYPE: &str = "application/octet-stream";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MultipartReconcileOutcome {
    Aborted,
    Missing,
}

impl S3ObjectStore {
    pub async fn put_with_checksum(
        &self,
        request: PutRequest,
        checksum: &Sha256Checksum,
    ) -> Result<(), ObjectStoreError> {
        request
            .validate(&self.limits)
            .map_err(|_| invalid(ObjectOperation::Checksum))?;
        if Sha256Checksum::calculate(&request.body) != *checksum {
            return Err(integrity(ObjectOperation::Checksum));
        }
        let mut operation = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(request.key.expose())
            .content_length(
                i64::try_from(request.body.len())
                    .map_err(|_| invalid(ObjectOperation::Checksum))?,
            )
            .checksum_sha256(checksum.base64())
            .body(ByteStream::from(request.body));
        if let Some(content_type) = request.content_type {
            operation = operation.content_type(content_type);
        }
        let output = operation
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Checksum, &error))?;
        if output
            .checksum_sha256()
            .is_some_and(|value| value != checksum.base64())
        {
            return Err(integrity(ObjectOperation::Checksum));
        }
        Ok(())
    }

    pub async fn get_with_checksum(
        &self,
        key: &ObjectKey,
    ) -> Result<(Bytes, Sha256Checksum), ObjectStoreError> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key.expose())
            .checksum_mode(aws_sdk_s3::types::ChecksumMode::Enabled)
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Checksum, &error))?;
        let advertised = output
            .checksum_sha256()
            .ok_or_else(|| unsupported(ObjectOperation::Checksum))
            .and_then(|value| {
                Sha256Checksum::from_base64(value).map_err(|_| integrity(ObjectOperation::Checksum))
            })?;
        if output.content_length().is_some_and(|length| {
            length < 0
                || u64::try_from(length).is_ok_and(|length| length > self.limits.max_body_bytes)
        }) {
            return Err(too_large(ObjectOperation::Checksum));
        }
        let body = read_aws_body(output.body, self.limits.max_body_bytes).await?;
        if Sha256Checksum::calculate(&body) != advertised {
            return Err(integrity(ObjectOperation::Checksum));
        }
        Ok((body, advertised))
    }

    pub async fn presign_get(
        &self,
        key: &ObjectKey,
        expiry: PresignExpiry,
    ) -> Result<BoundedPresignedRequest, ObjectStoreError> {
        let config = PresigningConfig::expires_in(expiry.duration())
            .map_err(|_| invalid(ObjectOperation::Presign))?;
        let request = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key.expose())
            .presigned(config)
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Presign, &error))?;
        bounded_presigned(
            request,
            PresignedOperation::Get,
            None,
            self.limits.max_body_bytes,
            &[],
        )
    }

    pub async fn presign_put(
        &self,
        request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, ObjectStoreError> {
        validate_presigned_put(&request, self.limits.max_body_bytes)?;
        let content_length =
            i64::try_from(request.content_length).map_err(|_| invalid(ObjectOperation::Presign))?;
        let config = PresigningConfig::expires_in(request.expiry.duration())
            .map_err(|_| invalid(ObjectOperation::Presign))?;
        let signed = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(request.key.expose())
            .content_length(content_length)
            .content_type(request.content_type)
            .checksum_sha256(request.checksum.base64())
            .presigned(config)
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::Presign, &error))?;
        bounded_presigned(
            signed,
            PresignedOperation::Put,
            Some(request.content_length),
            0,
            &["content-length", "content-type", "x-amz-checksum-sha256"],
        )
    }

    pub async fn execute_presigned(
        &self,
        request: &BoundedPresignedRequest,
        body: Option<Bytes>,
    ) -> Result<Bytes, ObjectStoreError> {
        let operation = ObjectOperation::Presign;
        match (
            request.operation,
            request.expected_body_bytes,
            body.as_ref(),
        ) {
            (PresignedOperation::Get, None, None) => {}
            (PresignedOperation::Put, Some(expected), Some(body))
                if body.len() as u64 == expected => {}
            _ => return Err(invalid(operation)),
        }
        let method = match request.operation {
            PresignedOperation::Get => reqwest::Method::GET,
            PresignedOperation::Put => reqwest::Method::PUT,
        };
        let mut builder = self
            .presigned_client
            .request(method, request.url.expose_bearer_url().clone());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = body {
            builder = builder.body(body);
        }
        let mut response = builder.send().await.map_err(|_| unavailable(operation))?;
        if !response.status().is_success() {
            return Err(http_status_error(operation, response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > request.maximum_response_bytes)
        {
            return Err(too_large(operation));
        }
        let mut result = BytesMut::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable(operation))? {
            let next = result
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| too_large(operation))?;
            if next as u64 > request.maximum_response_bytes {
                return Err(too_large(operation));
            }
            result.extend_from_slice(&chunk);
        }
        Ok(result.freeze())
    }

    pub async fn create_multipart(
        &self,
        key: ObjectKey,
    ) -> Result<MultipartUpload, ObjectStoreError> {
        let output = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(key.expose())
            .checksum_algorithm(ChecksumAlgorithm::Sha256)
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::MultipartCreate, &error))?;
        let upload_id = output
            .upload_id()
            .map(str::to_owned)
            .ok_or_else(|| internal(ObjectOperation::MultipartCreate))?;
        Ok(MultipartUpload { key, upload_id })
    }

    pub async fn upload_part(
        &self,
        request: MultipartPartRequest,
        limits: &MultipartLimits,
    ) -> Result<UploadedPart, ObjectStoreError> {
        request
            .validate(limits)
            .map_err(|_| invalid(ObjectOperation::MultipartUpload))?;
        let output = self
            .client
            .upload_part()
            .bucket(&self.bucket)
            .key(request.upload.key.expose())
            .upload_id(&request.upload.upload_id)
            .part_number(i32::from(request.part_number))
            .content_length(
                i64::try_from(request.body.len())
                    .map_err(|_| invalid(ObjectOperation::MultipartUpload))?,
            )
            .checksum_sha256(request.checksum.base64())
            .body(ByteStream::from(request.body))
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::MultipartUpload, &error))?;
        let e_tag = output
            .e_tag()
            .map(str::to_owned)
            .ok_or_else(|| internal(ObjectOperation::MultipartUpload))?;
        if output
            .checksum_sha256()
            .is_some_and(|value| value != request.checksum.base64())
        {
            return Err(integrity(ObjectOperation::MultipartUpload));
        }
        Ok(UploadedPart {
            part_number: request.part_number,
            e_tag,
            checksum: request.checksum,
        })
    }

    pub async fn presign_multipart_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> Result<BoundedPresignedRequest, ObjectStoreError> {
        let content_length = i64::try_from(request.content_length)
            .map_err(|_| invalid(ObjectOperation::MultipartUpload))?;
        let config = PresigningConfig::expires_in(request.expiry.duration())
            .map_err(|_| invalid(ObjectOperation::MultipartUpload))?;
        let signed = self
            .client
            .upload_part()
            .bucket(&self.bucket)
            .key(request.upload.key.expose())
            .upload_id(&request.upload.upload_id)
            .part_number(i32::from(request.part_number))
            .content_length(content_length)
            .checksum_algorithm(ChecksumAlgorithm::Sha256)
            .checksum_sha256(request.checksum.base64())
            .presigned(config)
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::MultipartUpload, &error))?;
        bounded_presigned(
            signed,
            PresignedOperation::Put,
            Some(request.content_length),
            0,
            &["content-length", "x-amz-checksum-sha256"],
        )
    }

    pub async fn complete_multipart(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> Result<(), ObjectStoreError> {
        validate_completed_parts(&parts)
            .map_err(|_| invalid(ObjectOperation::MultipartComplete))?;
        let completed_parts = parts
            .into_iter()
            .map(|part| {
                CompletedPart::builder()
                    .part_number(i32::from(part.part_number))
                    .e_tag(part.e_tag)
                    .checksum_sha256(part.checksum.base64())
                    .build()
            })
            .collect();
        let multipart = CompletedMultipartUpload::builder()
            .set_parts(Some(completed_parts))
            .build();
        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(upload.key.expose())
            .upload_id(&upload.upload_id)
            .multipart_upload(multipart)
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::MultipartComplete, &error))?;
        Ok(())
    }

    pub async fn abort_multipart(&self, upload: &MultipartUpload) -> Result<(), ObjectStoreError> {
        match self
            .client
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(upload.key.expose())
            .upload_id(&upload.upload_id)
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                let mapped = classify_sdk_error(ObjectOperation::MultipartAbort, &error);
                if mapped.kind() == ObjectStoreErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(mapped)
                }
            }
        }
    }

    /// Reconciles create-response loss without guessing an upload identity.
    /// Only incomplete uploads whose key exactly matches the server-owned key
    /// are aborted. The page is deliberately bounded; observing more matches
    /// fails closed so an operator can investigate instead of issuing an
    /// unbounded destructive sweep.
    pub(crate) async fn reconcile_multipart_for_exact_key(
        &self,
        key: &ObjectKey,
    ) -> Result<MultipartReconcileOutcome, ObjectStoreError> {
        const MAX_MATCHES: usize = 8;
        let output = self
            .client
            .list_multipart_uploads()
            .bucket(&self.bucket)
            .prefix(key.expose())
            .max_uploads(9)
            .send()
            .await
            .map_err(|error| classify_sdk_error(ObjectOperation::MultipartReconcile, &error))?;
        let mut matching = output
            .uploads()
            .iter()
            .filter(|upload| upload.key() == Some(key.expose()))
            .map(|upload| upload.upload_id().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| internal(ObjectOperation::MultipartReconcile))?;
        if matching.len() > MAX_MATCHES || matches!(output.is_truncated(), Some(true)) {
            return Err(ObjectStoreError::new(
                ObjectOperation::MultipartReconcile,
                ObjectStoreErrorKind::Conflict,
                false,
            ));
        }
        if matching.is_empty() {
            return Ok(MultipartReconcileOutcome::Missing);
        }
        for upload_id in matching.drain(..) {
            self.abort_multipart(&MultipartUpload {
                key: key.clone(),
                upload_id,
            })
            .await?;
        }
        Ok(MultipartReconcileOutcome::Aborted)
    }

    pub async fn probe_capabilities(&self, prefix: &ProbePrefix) -> CapabilityReport {
        let checked_at_unix_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs());
        let mut cleanup = ProbeCleanup::default();

        let checksum_key = prefix.object("checksum").ok();
        let checksum_body = Bytes::from_static(b"nuriteo-checksum-capability");
        let checksum = Sha256Checksum::calculate(&checksum_body);
        let checksum_state = if let Some(key) = checksum_key.clone() {
            cleanup.objects.push(key.clone());
            state(
                async {
                    self.put_with_checksum(
                        PutRequest {
                            key: key.clone(),
                            body: checksum_body.clone(),
                            content_type: Some(PROBE_CONTENT_TYPE.to_owned()),
                        },
                        &checksum,
                    )
                    .await?;
                    let (body, returned) = self.get_with_checksum(&key).await?;
                    if body == checksum_body && returned == checksum {
                        Ok(())
                    } else {
                        Err(integrity(ObjectOperation::Checksum))
                    }
                }
                .await,
            )
        } else {
            CapabilityState::Failed
        };

        let presign_key = prefix.object("presigned").ok();
        let presign_body = Bytes::from_static(b"nuriteo-presigned-capability");
        let presign_checksum = Sha256Checksum::calculate(&presign_body);
        let expiry = PresignExpiry::minutes(5).ok();
        let (presigned_put, presigned_get) = if let (Some(key), Some(expiry)) =
            (presign_key.clone(), expiry)
        {
            cleanup.objects.push(key.clone());
            let put_result = async {
                let signed = self
                    .presign_put(PresignedPutRequest {
                        key: key.clone(),
                        content_length: presign_body.len() as u64,
                        content_type: PROBE_CONTENT_TYPE.to_owned(),
                        checksum: presign_checksum,
                        expiry,
                    })
                    .await?;
                self.execute_presigned(&signed, Some(presign_body.clone()))
                    .await?;
                let tampered = Bytes::from(vec![b'x'; presign_body.len()]);
                match self.execute_presigned(&signed, Some(tampered)).await {
                    Err(error) if error.kind() == ObjectStoreErrorKind::InvalidRequest => Ok(()),
                    Ok(_) => Err(integrity(ObjectOperation::Presign)),
                    Err(error) => Err(error),
                }
            }
            .await;
            let get_result = if put_result.is_ok() {
                async {
                    let signed = self.presign_get(&key, expiry).await?;
                    let body = self.execute_presigned(&signed, None).await?;
                    if body == presign_body {
                        Ok(())
                    } else {
                        Err(integrity(ObjectOperation::Presign))
                    }
                }
                .await
            } else {
                Err(internal(ObjectOperation::Presign))
            };
            (state(put_result), state(get_result))
        } else {
            (CapabilityState::Failed, CapabilityState::Failed)
        };

        let multipart_limits = MultipartLimits::new(MIN_MULTIPART_PART_BYTES).ok();
        let multipart_complete = if let (Some(key), Some(limits)) = (
            prefix.object("multipart-complete").ok(),
            multipart_limits.as_ref(),
        ) {
            cleanup.objects.push(key.clone());
            let result = async {
                let upload = self.create_multipart(key).await?;
                cleanup.uploads.push(upload.clone());
                let first_body = Bytes::from(vec![b'a'; limits.part_size_bytes()]);
                let second_body = Bytes::from_static(b"final-part");
                let first = self
                    .upload_part(
                        MultipartPartRequest {
                            upload: upload.clone(),
                            part_number: 1,
                            checksum: Sha256Checksum::calculate(&first_body),
                            body: first_body.clone(),
                            final_part: false,
                        },
                        limits,
                    )
                    .await?;
                let second = self
                    .upload_part(
                        MultipartPartRequest {
                            upload: upload.clone(),
                            part_number: 2,
                            checksum: Sha256Checksum::calculate(&second_body),
                            body: second_body.clone(),
                            final_part: true,
                        },
                        limits,
                    )
                    .await?;
                self.complete_multipart(&upload, vec![first, second])
                    .await?;
                let stored = self.get(&upload.key).await?;
                let mut expected = BytesMut::with_capacity(first_body.len() + second_body.len());
                expected.extend_from_slice(&first_body);
                expected.extend_from_slice(&second_body);
                if Sha256Checksum::calculate(&stored.body) == Sha256Checksum::calculate(&expected) {
                    Ok(())
                } else {
                    Err(integrity(ObjectOperation::MultipartComplete))
                }
            }
            .await;
            state(result)
        } else {
            CapabilityState::Failed
        };

        let multipart_abort = if let Ok(key) = prefix.object("multipart-abort") {
            cleanup.objects.push(key.clone());
            let result = async {
                let upload = self.create_multipart(key).await?;
                cleanup.uploads.push(upload.clone());
                self.abort_multipart(&upload).await?;
                self.abort_multipart(&upload).await
            }
            .await;
            state(result)
        } else {
            CapabilityState::Failed
        };

        let cleanup_state = cleanup.run(self, prefix).await;
        CapabilityReport {
            backend: self.backend_identifier.clone(),
            checked_at_unix_seconds,
            server_release: crate::VERSION.to_owned(),
            checksum: checksum_state,
            presigned_get,
            presigned_put,
            multipart_complete,
            multipart_abort,
            cleanup: cleanup_state,
            orphan_warning: cleanup_state != CapabilityState::Supported,
        }
    }
}

#[derive(Default)]
struct ProbeCleanup {
    objects: Vec<ObjectKey>,
    uploads: Vec<MultipartUpload>,
}

impl ProbeCleanup {
    async fn run(self, store: &S3ObjectStore, prefix: &ProbePrefix) -> CapabilityState {
        let mut clean = true;
        for upload in &self.uploads {
            clean &= store.abort_multipart(upload).await.is_ok();
        }
        for key in &self.objects {
            clean &= store.delete(key).await.is_ok();
        }
        let objects_empty = store
            .client
            .list_objects_v2()
            .bucket(&store.bucket)
            .prefix(prefix.expose())
            .max_keys(1)
            .send()
            .await
            .is_ok_and(|output| output.contents().is_empty());
        let uploads_empty = store
            .client
            .list_multipart_uploads()
            .bucket(&store.bucket)
            .prefix(prefix.expose())
            .max_uploads(1)
            .send()
            .await
            .is_ok_and(|output| output.uploads().is_empty());
        clean &= objects_empty && uploads_empty;
        if clean {
            CapabilityState::Supported
        } else {
            CapabilityState::Failed
        }
    }
}

fn bounded_presigned(
    request: AwsPresignedRequest,
    expected_operation: PresignedOperation,
    expected_body_bytes: Option<u64>,
    maximum_response_bytes: u64,
    required_put_headers: &[&str],
) -> Result<BoundedPresignedRequest, ObjectStoreError> {
    let actual = match request.method() {
        "GET" => PresignedOperation::Get,
        "PUT" => PresignedOperation::Put,
        _ => return Err(internal(ObjectOperation::Presign)),
    };
    if actual != expected_operation {
        return Err(internal(ObjectOperation::Presign));
    }
    let url = SensitiveUrl::parse(request.uri()).map_err(|_| internal(ObjectOperation::Presign))?;
    let headers = request
        .headers()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect::<Vec<_>>();
    if matches!(actual, PresignedOperation::Put)
        && !required_put_headers.iter().all(|required| {
            headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(required))
        })
    {
        return Err(unsupported(ObjectOperation::Presign));
    }
    Ok(BoundedPresignedRequest {
        operation: actual,
        url,
        headers,
        expected_body_bytes,
        maximum_response_bytes,
    })
}

fn validate_presigned_put(
    request: &PresignedPutRequest,
    maximum: u64,
) -> Result<(), ObjectStoreError> {
    if request.content_length == 0
        || request.content_length > maximum
        || request.content_type.is_empty()
        || request.content_type.len() > 255
        || request.content_type.chars().any(char::is_control)
    {
        return Err(invalid(ObjectOperation::Presign));
    }
    Ok(())
}

fn validate_completed_parts(parts: &[UploadedPart]) -> Result<(), CapabilityValidationError> {
    if parts.is_empty() || parts.len() > usize::from(MAX_MULTIPART_PARTS) {
        return Err(CapabilityValidationError::InvalidPartSequence);
    }
    for (index, part) in parts.iter().enumerate() {
        if usize::from(part.part_number) != index + 1 {
            return Err(CapabilityValidationError::InvalidPartSequence);
        }
    }
    Ok(())
}

async fn read_aws_body(body: ByteStream, maximum: u64) -> Result<Bytes, ObjectStoreError> {
    use tokio::io::AsyncReadExt as _;

    let mut reader = body.into_async_read().take(maximum.saturating_add(1));
    let mut result = Vec::with_capacity(usize::try_from(maximum.min(1024 * 1024)).unwrap_or(0));
    reader
        .read_to_end(&mut result)
        .await
        .map_err(|_| unavailable(ObjectOperation::Checksum))?;
    if result.len() as u64 > maximum {
        return Err(too_large(ObjectOperation::Checksum));
    }
    Ok(Bytes::from(result))
}

fn state(result: Result<(), ObjectStoreError>) -> CapabilityState {
    match result {
        Ok(()) => CapabilityState::Supported,
        Err(error) if error.kind() == ObjectStoreErrorKind::Unsupported => {
            CapabilityState::Unsupported
        }
        Err(_) => CapabilityState::Failed,
    }
}

const fn invalid(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::InvalidRequest, false)
}

const fn integrity(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::Integrity, false)
}

const fn internal(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::Internal, false)
}

const fn unsupported(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::Unsupported, false)
}

const fn unavailable(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::Unavailable, true)
}

const fn too_large(operation: ObjectOperation) -> ObjectStoreError {
    ObjectStoreError::new(operation, ObjectStoreErrorKind::ResponseTooLarge, false)
}

const fn http_status_error(operation: ObjectOperation, status: u16) -> ObjectStoreError {
    match status {
        401 => ObjectStoreError::new(operation, ObjectStoreErrorKind::Authentication, false),
        403 => ObjectStoreError::new(operation, ObjectStoreErrorKind::Authorization, false),
        404 => ObjectStoreError::new(operation, ObjectStoreErrorKind::NotFound, false),
        405 | 501 => ObjectStoreError::new(operation, ObjectStoreErrorKind::Unsupported, false),
        408 | 504 => ObjectStoreError::new(operation, ObjectStoreErrorKind::Timeout, true),
        429 => ObjectStoreError::new(operation, ObjectStoreErrorKind::Throttled, true),
        500..=599 => ObjectStoreError::new(operation, ObjectStoreErrorKind::Unavailable, true),
        _ => ObjectStoreError::new(operation, ObjectStoreErrorKind::InvalidRequest, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_storage::BackendIdentifier;

    #[test]
    fn completed_parts_require_a_bounded_consecutive_sequence() {
        let checksum = Sha256Checksum::calculate(b"part");
        let part = |part_number| UploadedPart {
            part_number,
            e_tag: "opaque".to_owned(),
            checksum: checksum.clone(),
        };
        assert!(validate_completed_parts(&[part(1), part(2)]).is_ok());
        assert_eq!(
            validate_completed_parts(&[part(2)]),
            Err(CapabilityValidationError::InvalidPartSequence)
        );
        assert_eq!(
            validate_completed_parts(&[]),
            Err(CapabilityValidationError::InvalidPartSequence)
        );
    }

    #[test]
    fn backend_identifier_does_not_reveal_endpoint() {
        let identifier = BackendIdentifier::from_endpoint("https://private.example.test");
        let rendered = format!("{identifier:?}");
        assert!(!rendered.contains("private.example.test"));
    }
}
