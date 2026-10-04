use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use aws_sdk_s3::primitives::ByteStream;
use bytes::Bytes;
use http_body::{Frame, SizeHint};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::Notify;
use tokio::time::{Instant, Sleep};

use super::capability_types::{
    MAX_MULTIPART_PART_BYTES, MAX_MULTIPART_PARTS, MIN_MULTIPART_PART_BYTES, MultipartLimits,
    MultipartUpload, Sha256Checksum, UploadedPart,
};
use super::error::{ObjectOperation, ObjectStoreError, ObjectStoreErrorKind, classify_sdk_error};
use super::{ObjectKey, OperationLimits, S3ObjectStore};

/// The direct relay keeps single PUTs at the browser-save boundary used by the
/// product. Larger objects must use multipart parts so no intermediary needs a
/// correspondingly large replay buffer.
pub const MAX_STREAMING_SINGLE_PUT_BYTES: u64 = 64 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// Deadlines applied while a non-replayable producer is being relayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UploadDeadlines {
    idle: Duration,
    total: Duration,
}

impl UploadDeadlines {
    pub fn for_put(idle: Duration, total: Duration) -> Result<Self, ObjectStoreError> {
        Self::new(ObjectOperation::Put, idle, total)
    }

    pub fn for_multipart_part(idle: Duration, total: Duration) -> Result<Self, ObjectStoreError> {
        Self::new(ObjectOperation::MultipartUpload, idle, total)
    }

    fn new(
        operation: ObjectOperation,
        idle: Duration,
        total: Duration,
    ) -> Result<Self, ObjectStoreError> {
        if idle.is_zero() || total.is_zero() || idle > total {
            return Err(invalid(operation));
        }
        Ok(Self { idle, total })
    }

    fn validate(
        self,
        limits: &OperationLimits,
        operation: ObjectOperation,
    ) -> Result<Self, ObjectStoreError> {
        if self.total > limits.request_timeout {
            return Err(invalid(operation));
        }
        Ok(self)
    }
}

/// Producer side of an explicit upload cancellation pair.
#[derive(Clone)]
pub struct UploadAbortHandle {
    inner: Arc<AbortState>,
}

/// Consumer side of an explicit upload cancellation pair.
#[derive(Clone)]
pub struct UploadAbortSignal {
    inner: Arc<AbortState>,
}

struct AbortState {
    aborted: AtomicBool,
    notify: Notify,
}

impl fmt::Debug for UploadAbortHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadAbortHandle")
            .field("aborted", &self.inner.aborted.load(Ordering::Acquire))
            .finish()
    }
}

impl fmt::Debug for UploadAbortSignal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadAbortSignal")
            .field("aborted", &self.inner.aborted.load(Ordering::Acquire))
            .finish()
    }
}

#[must_use]
pub fn upload_abort_pair() -> (UploadAbortHandle, UploadAbortSignal) {
    let inner = Arc::new(AbortState {
        aborted: AtomicBool::new(false),
        notify: Notify::new(),
    });
    (
        UploadAbortHandle {
            inner: Arc::clone(&inner),
        },
        UploadAbortSignal { inner },
    )
}

impl UploadAbortHandle {
    pub fn abort(&self) {
        if !self.inner.aborted.swap(true, Ordering::AcqRel) {
            self.inner.notify.notify_waiters();
        }
    }
}

impl UploadAbortSignal {
    async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.inner.aborted.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

/// A single-use, non-replayable upload body with an exact byte and SHA-256
/// contract. The reader is polled only when the S3 transport requests data.
pub struct UploadBody {
    reader: Pin<Box<dyn AsyncRead + Send + 'static>>,
    declared_size: u64,
    checksum: Sha256Checksum,
}

impl UploadBody {
    #[must_use]
    pub fn from_reader(
        reader: impl AsyncRead + Send + 'static,
        declared_size: u64,
        checksum: Sha256Checksum,
    ) -> Self {
        Self {
            reader: Box::pin(reader),
            declared_size,
            checksum,
        }
    }

    #[must_use]
    pub const fn declared_size(&self) -> u64 {
        self.declared_size
    }
}

impl fmt::Debug for UploadBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadBody")
            .field("declared_size", &self.declared_size)
            .field("checksum", &self.checksum)
            .finish_non_exhaustive()
    }
}

pub struct StreamingPutRequest {
    pub key: ObjectKey,
    pub body: UploadBody,
    pub content_type: Option<String>,
    pub deadlines: UploadDeadlines,
    pub abort: UploadAbortSignal,
}

impl fmt::Debug for StreamingPutRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StreamingPutRequest")
            .field("key", &self.key)
            .field("body", &self.body)
            .field("content_type_configured", &self.content_type.is_some())
            .field("deadlines", &self.deadlines)
            .field("abort", &self.abort)
            .finish()
    }
}

pub struct StreamingMultipartPartRequest {
    pub upload: MultipartUpload,
    pub part_number: u16,
    pub body: UploadBody,
    pub final_part: bool,
    pub deadlines: UploadDeadlines,
    pub abort: UploadAbortSignal,
}

impl fmt::Debug for StreamingMultipartPartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StreamingMultipartPartRequest")
            .field("upload", &self.upload)
            .field("part_number", &self.part_number)
            .field("body", &self.body)
            .field("final_part", &self.final_part)
            .field("deadlines", &self.deadlines)
            .field("abort", &self.abort)
            .finish()
    }
}

impl S3ObjectStore {
    /// Relays a body into a private S3 object exactly once. This method never
    /// buffers the whole body and never retries the non-replayable producer.
    pub async fn put_stream_once(
        &self,
        request: StreamingPutRequest,
    ) -> Result<(), ObjectStoreError> {
        let operation = ObjectOperation::Put;
        let deadlines = request.deadlines.validate(&self.limits, operation)?;
        validate_content_type(request.content_type.as_deref(), operation)?;
        if request.body.declared_size == 0
            || request.body.declared_size > MAX_STREAMING_SINGLE_PUT_BYTES
            || request.body.declared_size > self.limits.max_stream_bytes
        {
            return Err(invalid(operation));
        }
        let declared_size = request.body.declared_size;
        let checksum = request.body.checksum.clone();
        let (stream, status) = validated_stream(request.body, deadlines.idle);
        let mut upload = self
            .streaming_client
            .put_object()
            .bucket(&self.bucket)
            .key(request.key.expose())
            .content_length(i64::try_from(declared_size).map_err(|_| invalid(operation))?)
            .checksum_sha256(checksum.base64())
            .body(stream);
        if let Some(content_type) = request.content_type {
            upload = upload.content_type(content_type);
        }
        let result = relay_once(upload.send(), request.abort, deadlines.total, operation).await;
        finish_relay(result, &status, operation).map(|_| ())
    }

    /// Relays one multipart part exactly once under the same body contract.
    pub async fn upload_part_stream_once(
        &self,
        request: StreamingMultipartPartRequest,
        limits: &MultipartLimits,
    ) -> Result<UploadedPart, ObjectStoreError> {
        let operation = ObjectOperation::MultipartUpload;
        let deadlines = request.deadlines.validate(&self.limits, operation)?;
        let declared_size = request.body.declared_size;
        if request.part_number == 0
            || request.part_number > MAX_MULTIPART_PARTS
            || declared_size == 0
            || declared_size > MAX_MULTIPART_PART_BYTES as u64
            || declared_size > limits.part_size_bytes() as u64
            || (!request.final_part && declared_size != limits.part_size_bytes() as u64)
            || (!request.final_part && declared_size < MIN_MULTIPART_PART_BYTES as u64)
        {
            return Err(invalid(operation));
        }
        let checksum = request.body.checksum.clone();
        let (stream, status) = validated_stream(request.body, deadlines.idle);
        let upload = self
            .streaming_client
            .upload_part()
            .bucket(&self.bucket)
            .key(request.upload.key.expose())
            .upload_id(&request.upload.upload_id)
            .part_number(i32::from(request.part_number))
            .content_length(i64::try_from(declared_size).map_err(|_| invalid(operation))?)
            .checksum_sha256(checksum.base64())
            .body(stream);
        let output = relay_once(upload.send(), request.abort, deadlines.total, operation).await;
        let output = finish_relay(output, &status, operation)?;
        let e_tag = output
            .e_tag()
            .map(str::to_owned)
            .ok_or_else(|| internal(operation))?;
        if output
            .checksum_sha256()
            .is_some_and(|value| value != checksum.base64())
        {
            return Err(integrity(operation));
        }
        Ok(UploadedPart {
            part_number: request.part_number,
            e_tag,
            checksum,
        })
    }
}

async fn relay_once<F, T, E, R>(
    operation_future: F,
    abort: UploadAbortSignal,
    total: Duration,
    operation: ObjectOperation,
) -> Result<T, ObjectStoreError>
where
    F: Future<Output = Result<T, aws_sdk_s3::error::SdkError<E, R>>>,
    E: aws_sdk_s3::error::ProvideErrorMetadata,
{
    tokio::select! {
        biased;
        () = abort.cancelled() => Err(ObjectStoreError::new(
            operation,
            ObjectStoreErrorKind::ResponseUnknown,
            false,
        )),
        result = tokio::time::timeout(total, operation_future) => match result {
            Ok(result) => result.map_err(|error| non_retryable(classify_sdk_error(operation, &error))),
            Err(_) => Err(ObjectStoreError::new(operation, ObjectStoreErrorKind::Timeout, false)),
        },
    }
}

fn validated_stream(body: UploadBody, idle: Duration) -> (ByteStream, Arc<AtomicU8>) {
    let status = Arc::new(AtomicU8::new(StreamStatus::Active as u8));
    let reader = ValidatingReader::new(body, idle, Arc::clone(&status));
    let body = UploadHttpBody::new(reader);
    (ByteStream::from_body_1_x(body), status)
}

fn finish_relay<T>(
    result: Result<T, ObjectStoreError>,
    status: &AtomicU8,
    operation: ObjectOperation,
) -> Result<T, ObjectStoreError> {
    match StreamStatus::from_u8(status.load(Ordering::Acquire)) {
        StreamStatus::Complete => result,
        StreamStatus::Underrun | StreamStatus::Overrun | StreamStatus::ChecksumMismatch => {
            Err(integrity(operation))
        }
        StreamStatus::IdleTimeout => Err(ObjectStoreError::new(
            operation,
            ObjectStoreErrorKind::Timeout,
            false,
        )),
        StreamStatus::ProducerError => Err(ObjectStoreError::new(
            operation,
            ObjectStoreErrorKind::Unavailable,
            false,
        )),
        StreamStatus::Active => result,
    }
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamStatus {
    Active = 0,
    Complete = 1,
    Underrun = 2,
    Overrun = 3,
    ChecksumMismatch = 4,
    IdleTimeout = 5,
    ProducerError = 6,
}

impl StreamStatus {
    const fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Complete,
            2 => Self::Underrun,
            3 => Self::Overrun,
            4 => Self::ChecksumMismatch,
            5 => Self::IdleTimeout,
            6 => Self::ProducerError,
            _ => Self::Active,
        }
    }
}

struct ValidatingReader {
    reader: Mutex<Pin<Box<dyn AsyncRead + Send + 'static>>>,
    remaining: u64,
    expected_checksum: Sha256Checksum,
    hasher: Option<Sha256>,
    idle_duration: Duration,
    idle_sleep: Pin<Box<Sleep>>,
    staging: Box<[u8; READ_CHUNK_BYTES]>,
    status: Arc<AtomicU8>,
    complete: bool,
}

/// A Sync HTTP body is required by the Smithy transport. Keeping the reader in
/// `ValidatingReader`'s mutex allows the body to meet that contract without
/// claiming that an arbitrary non-replayable producer itself is Sync.
struct UploadHttpBody {
    reader: ValidatingReader,
    buffer: Box<[u8; READ_CHUNK_BYTES]>,
    remaining_hint: u64,
    complete: bool,
}

impl UploadHttpBody {
    fn new(reader: ValidatingReader) -> Self {
        Self {
            remaining_hint: reader.remaining,
            reader,
            buffer: Box::new([0; READ_CHUNK_BYTES]),
            complete: false,
        }
    }
}

impl http_body::Body for UploadHttpBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if self.complete {
            return Poll::Ready(None);
        }
        let this = &mut *self;
        let mut output = ReadBuf::new(&mut this.buffer[..]);
        match Pin::new(&mut this.reader).poll_read(cx, &mut output) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => {
                this.complete = true;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(Ok(())) if output.filled().is_empty() => {
                this.complete = true;
                this.remaining_hint = 0;
                Poll::Ready(None)
            }
            Poll::Ready(Ok(())) => {
                let bytes = Bytes::copy_from_slice(output.filled());
                this.remaining_hint = this.remaining_hint.saturating_sub(bytes.len() as u64);
                Poll::Ready(Some(Ok(Frame::data(bytes))))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.complete
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining_hint)
    }
}

impl ValidatingReader {
    fn new(body: UploadBody, idle_duration: Duration, status: Arc<AtomicU8>) -> Self {
        Self {
            reader: Mutex::new(body.reader),
            remaining: body.declared_size,
            expected_checksum: body.checksum,
            hasher: Some(Sha256::new()),
            idle_duration,
            idle_sleep: Box::pin(tokio::time::sleep(idle_duration)),
            staging: Box::new([0; READ_CHUNK_BYTES]),
            status,
            complete: false,
        }
    }

    fn fail(&mut self, state: StreamStatus, message: &'static str) -> Poll<io::Result<()>> {
        self.status.store(state as u8, Ordering::Release);
        Poll::Ready(Err(io::Error::other(message)))
    }

    fn reset_idle(&mut self) {
        self.idle_sleep
            .as_mut()
            .reset(Instant::now() + self.idle_duration);
    }
}

impl AsyncRead for ValidatingReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.complete || output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        let probe = self.remaining == 0;
        let maximum = if probe {
            1
        } else {
            usize::try_from(self.remaining)
                .unwrap_or(usize::MAX)
                .min(output.remaining())
                .min(READ_CHUNK_BYTES)
        };
        let this = &mut *self;
        let mut staging = ReadBuf::new(&mut this.staging[..maximum]);
        let read = this
            .reader
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .poll_read(cx, &mut staging);
        match read {
            Poll::Pending => {
                if self.idle_sleep.as_mut().poll(cx).is_ready() {
                    self.fail(
                        StreamStatus::IdleTimeout,
                        "upload producer idle deadline exceeded",
                    )
                } else {
                    Poll::Pending
                }
            }
            Poll::Ready(Err(_)) => self.fail(StreamStatus::ProducerError, "upload producer failed"),
            Poll::Ready(Ok(())) if staging.filled().is_empty() => {
                if self.remaining != 0 {
                    return self.fail(
                        StreamStatus::Underrun,
                        "upload body ended before declared size",
                    );
                }
                let Some(hasher) = self.hasher.take() else {
                    return self.fail(
                        StreamStatus::ProducerError,
                        "upload digest state unavailable",
                    );
                };
                let actual: [u8; 32] = hasher.finalize().into();
                if actual != *self.expected_checksum.as_bytes() {
                    return self.fail(StreamStatus::ChecksumMismatch, "upload checksum mismatch");
                }
                self.status
                    .store(StreamStatus::Complete as u8, Ordering::Release);
                self.complete = true;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Ok(())) if probe => {
                self.fail(StreamStatus::Overrun, "upload body exceeded declared size")
            }
            Poll::Ready(Ok(())) => {
                let output_start = output.filled().len();
                let count = staging.filled().len() as u64;
                output.put_slice(staging.filled());
                this.remaining -= count;
                if let Some(hasher) = this.hasher.as_mut() {
                    hasher.update(&output.filled()[output_start..]);
                }
                this.reset_idle();
                Poll::Ready(Ok(()))
            }
        }
    }
}

fn validate_content_type(
    content_type: Option<&str>,
    operation: ObjectOperation,
) -> Result<(), ObjectStoreError> {
    if content_type.is_some_and(|value| {
        value.is_empty() || value.len() > 255 || value.chars().any(char::is_control)
    }) {
        return Err(invalid(operation));
    }
    Ok(())
}

const fn non_retryable(error: ObjectStoreError) -> ObjectStoreError {
    ObjectStoreError::new(error.operation(), error.kind(), false)
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn body(bytes: &'static [u8], declared_size: u64, checksum: Sha256Checksum) -> UploadBody {
        UploadBody::from_reader(Cursor::new(bytes), declared_size, checksum)
    }

    async fn consume(body: UploadBody, idle: Duration) -> (io::Result<Vec<u8>>, StreamStatus) {
        let status = Arc::new(AtomicU8::new(StreamStatus::Active as u8));
        let mut reader = ValidatingReader::new(body, idle, Arc::clone(&status));
        let mut output = Vec::new();
        let result = reader.read_to_end(&mut output).await.map(|_| output);
        (
            result,
            StreamStatus::from_u8(status.load(Ordering::Acquire)),
        )
    }

    #[tokio::test]
    async fn exact_body_completes_without_replay_buffer() {
        let bytes = b"bounded-stream";
        let (result, status) = consume(
            body(bytes, bytes.len() as u64, Sha256Checksum::calculate(bytes)),
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(result.unwrap(), bytes);
        assert_eq!(status, StreamStatus::Complete);
    }

    #[tokio::test]
    async fn underrun_overrun_and_checksum_mismatch_fail_closed() {
        let cases = [
            (
                body(b"short", 6, Sha256Checksum::calculate(b"short!")),
                StreamStatus::Underrun,
            ),
            (
                body(b"overrun", 6, Sha256Checksum::calculate(b"overru")),
                StreamStatus::Overrun,
            ),
            (
                body(b"wrong", 5, Sha256Checksum::calculate(b"other")),
                StreamStatus::ChecksumMismatch,
            ),
        ];
        for (body, expected) in cases {
            let (result, status) = consume(body, Duration::from_secs(1)).await;
            assert!(result.is_err());
            assert_eq!(status, expected);
        }
    }

    #[tokio::test]
    async fn stalled_reader_hits_idle_deadline() {
        let (_writer, reader) = tokio::io::duplex(1);
        let body = UploadBody::from_reader(reader, 1, Sha256Checksum::calculate(&[0]));
        let (result, status) = consume(body, Duration::from_millis(20)).await;
        assert!(result.is_err());
        assert_eq!(status, StreamStatus::IdleTimeout);
    }

    #[tokio::test]
    async fn bounded_reader_applies_backpressure_to_gated_producer() {
        let payload = vec![7_u8; READ_CHUNK_BYTES * 2];
        let checksum = Sha256Checksum::calculate(&payload);
        let (mut producer, reader) = tokio::io::duplex(1);
        let produced = payload.clone();
        let write = tokio::spawn(async move {
            producer.write_all(&produced).await.unwrap();
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(20), async {
                while !write.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_err()
        );

        let (result, status) = consume(
            UploadBody::from_reader(reader, payload.len() as u64, checksum),
            Duration::from_secs(1),
        )
        .await;
        write.await.unwrap();
        assert_eq!(result.unwrap(), payload);
        assert_eq!(status, StreamStatus::Complete);
    }

    #[tokio::test]
    async fn abort_pair_is_sticky_and_wakes_waiter() {
        let (handle, signal) = upload_abort_pair();
        handle.abort();
        tokio::time::timeout(Duration::from_millis(50), signal.cancelled())
            .await
            .unwrap();
    }

    #[test]
    fn debug_output_redacts_source_and_checksum() {
        let secret = b"secret-payload";
        let upload = body(
            secret,
            secret.len() as u64,
            Sha256Checksum::calculate(secret),
        );
        let debug = format!("{upload:?}");
        assert!(!debug.contains("secret-payload"));
        assert!(!debug.contains(&Sha256Checksum::calculate(secret).base64()));
    }

    #[test]
    fn deadline_validation_preserves_the_requested_operation() {
        let put = UploadDeadlines::for_put(Duration::ZERO, Duration::from_secs(1)).unwrap_err();
        assert_eq!(put.operation(), ObjectOperation::Put);

        let multipart =
            UploadDeadlines::for_multipart_part(Duration::from_secs(2), Duration::from_secs(1))
                .unwrap_err();
        assert_eq!(multipart.operation(), ObjectOperation::MultipartUpload);
    }
}
