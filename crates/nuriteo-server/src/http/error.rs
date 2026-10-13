use axum::Json;
use axum::http::{HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use super::RequestId;

const PROBLEM_CONTENT_TYPE: &str = "application/problem+json";
const MAX_FIELD_ERRORS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProblemKind {
    NotFound,
    MethodNotAllowed,
    Authentication,
    Forbidden,
    ReauthenticationRequired,
    PayloadTooLarge,
    UnsupportedMediaType,
    Validation,
    Conflict,
    QuotaExceeded,
    ReconciliationRequired,
    PreconditionRequired,
    PreconditionFailed,
    RangeNotSatisfiable,
    RateLimited,
    ServiceUnavailable,
    OperationTimeout,
    CommitOutcomeUnknown,
    Internal,
}

impl ProblemKind {
    const fn status(self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::Authentication => StatusCode::UNAUTHORIZED,
            Self::Forbidden | Self::ReauthenticationRequired => StatusCode::FORBIDDEN,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Conflict | Self::QuotaExceeded => StatusCode::CONFLICT,
            Self::PreconditionRequired => StatusCode::PRECONDITION_REQUIRED,
            Self::PreconditionFailed => StatusCode::PRECONDITION_FAILED,
            Self::RangeNotSatisfiable => StatusCode::RANGE_NOT_SATISFIABLE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::ServiceUnavailable
            | Self::ReconciliationRequired
            | Self::CommitOutcomeUnknown => StatusCode::SERVICE_UNAVAILABLE,
            Self::OperationTimeout => StatusCode::GATEWAY_TIMEOUT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    const fn type_uri(self) -> &'static str {
        match self {
            Self::NotFound => "/docs/problems/route-not-found",
            Self::MethodNotAllowed => "/docs/problems/method-not-allowed",
            Self::Authentication => "/docs/problems/authentication-failed",
            Self::Forbidden => "/docs/problems/request-forbidden",
            Self::ReauthenticationRequired => "/docs/problems/reauthentication-required",
            Self::PayloadTooLarge => "/docs/problems/payload-too-large",
            Self::UnsupportedMediaType => "/docs/problems/unsupported-media-type",
            Self::Validation => "/docs/problems/validation-failed",
            Self::Conflict => "/docs/problems/resource-conflict",
            Self::QuotaExceeded => "/docs/problems/quota-exceeded",
            Self::ReconciliationRequired => "/docs/problems/reconciliation-required",
            Self::PreconditionRequired => "/docs/problems/precondition-required",
            Self::PreconditionFailed => "/docs/problems/precondition-failed",
            Self::RangeNotSatisfiable => "/docs/problems/range-not-satisfiable",
            Self::RateLimited => "/docs/problems/rate-limited",
            Self::ServiceUnavailable => "/docs/problems/service-unavailable",
            Self::OperationTimeout => "/docs/problems/operation-timeout",
            Self::CommitOutcomeUnknown => "/docs/problems/commit-outcome-unknown",
            Self::Internal => "/docs/problems/internal-server-error",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::NotFound => "Resource not found",
            Self::MethodNotAllowed => "Method not allowed",
            Self::Authentication => "Authentication failed",
            Self::Forbidden => "Request forbidden",
            Self::ReauthenticationRequired => "Recent reauthentication required",
            Self::PayloadTooLarge => "Payload too large",
            Self::UnsupportedMediaType => "Unsupported media type",
            Self::Validation => "Validation failed",
            Self::Conflict => "Resource conflict",
            Self::QuotaExceeded => "Storage quota exceeded",
            Self::ReconciliationRequired => "Reconciliation required",
            Self::PreconditionRequired => "Precondition required",
            Self::PreconditionFailed => "Precondition failed",
            Self::RangeNotSatisfiable => "Range not satisfiable",
            Self::RateLimited => "Rate limit exceeded",
            Self::ServiceUnavailable => "Service unavailable",
            Self::OperationTimeout => "Operation timed out",
            Self::CommitOutcomeUnknown => "Commit outcome unknown",
            Self::Internal => "Internal server error",
        }
    }

    const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "ROUTE_NOT_FOUND",
            Self::MethodNotAllowed => "METHOD_NOT_ALLOWED",
            Self::Authentication => "AUTHENTICATION_FAILED",
            Self::Forbidden => "REQUEST_FORBIDDEN",
            Self::ReauthenticationRequired => "REAUTHENTICATION_REQUIRED",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::UnsupportedMediaType => "UNSUPPORTED_MEDIA_TYPE",
            Self::Validation => "VALIDATION_FAILED",
            Self::Conflict => "RESOURCE_CONFLICT",
            Self::QuotaExceeded => "QUOTA_EXCEEDED",
            Self::ReconciliationRequired => "RECONCILIATION_REQUIRED",
            Self::PreconditionRequired => "PRECONDITION_REQUIRED",
            Self::PreconditionFailed => "PRECONDITION_FAILED",
            Self::RangeNotSatisfiable => "RANGE_NOT_SATISFIABLE",
            Self::RateLimited => "RATE_LIMITED",
            Self::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            Self::OperationTimeout => "OPERATION_TIMEOUT",
            Self::CommitOutcomeUnknown => "COMMIT_OUTCOME_UNKNOWN",
            Self::Internal => "INTERNAL_SERVER_ERROR",
        }
    }

    const fn detail(self) -> &'static str {
        match self {
            Self::NotFound => "The requested resource does not exist.",
            Self::MethodNotAllowed => "The requested method is not supported for this resource.",
            Self::Authentication => "The supplied authentication could not be accepted.",
            Self::Forbidden => "The request did not satisfy the required security policy.",
            Self::ReauthenticationRequired => {
                "Sign in again to refresh recent authentication before retrying."
            }
            Self::PayloadTooLarge => "The request body exceeds the allowed size.",
            Self::UnsupportedMediaType => "The request body must use application/json.",
            Self::Validation => "One or more fields are invalid.",
            Self::Conflict => "The resource state conflicts with the request.",
            Self::QuotaExceeded => "The Workspace storage quota does not allow this Save.",
            Self::ReconciliationRequired => {
                "The operation outcome must be reconciled before retrying."
            }
            Self::PreconditionRequired => "A current resource validator is required.",
            Self::PreconditionFailed => "The supplied resource validator is not current.",
            Self::RangeNotSatisfiable => "Byte-range downloads are not supported.",
            Self::RateLimited => "The API request rate limit was exceeded.",
            Self::ServiceUnavailable => "The service is temporarily unavailable.",
            Self::OperationTimeout => "The operation did not complete before its deadline.",
            Self::CommitOutcomeUnknown => {
                "The mutation may have committed. Re-read the resource before retrying."
            }
            Self::Internal => "The server could not complete the request.",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldViolation {
    path: String,
    code: String,
    detail: String,
}

impl FieldViolation {
    #[must_use]
    pub fn new(
        path: impl Into<String>,
        code: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            code: code.into(),
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpError {
    kind: ProblemKind,
    request_id: RequestId,
    instance: String,
    errors: Vec<FieldViolation>,
}

impl HttpError {
    #[must_use]
    pub fn not_found(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(ProblemKind::NotFound, request_id, instance, Vec::new())
    }

    #[must_use]
    pub fn method_not_allowed(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::MethodNotAllowed,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn internal(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(ProblemKind::Internal, request_id, instance, Vec::new())
    }

    #[must_use]
    pub fn authentication(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::Authentication,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn forbidden(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(ProblemKind::Forbidden, request_id, instance, Vec::new())
    }

    #[must_use]
    pub fn rate_limited(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(ProblemKind::RateLimited, request_id, instance, Vec::new())
    }

    #[must_use]
    pub fn reauthentication_required(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::ReauthenticationRequired,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn payload_too_large(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::PayloadTooLarge,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn unsupported_media_type(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::UnsupportedMediaType,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn validation(
        request_id: RequestId,
        instance: impl Into<String>,
        errors: impl IntoIterator<Item = FieldViolation>,
    ) -> Self {
        Self::new(
            ProblemKind::Validation,
            request_id,
            instance,
            errors.into_iter().take(MAX_FIELD_ERRORS).collect(),
        )
    }

    #[must_use]
    pub fn conflict(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(ProblemKind::Conflict, request_id, instance, Vec::new())
    }

    #[must_use]
    pub fn quota_exceeded(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(ProblemKind::QuotaExceeded, request_id, instance, Vec::new())
    }

    #[must_use]
    pub fn reconciliation_required(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::ReconciliationRequired,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn precondition_required(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::PreconditionRequired,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn precondition_failed(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::PreconditionFailed,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn range_not_satisfiable(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::RangeNotSatisfiable,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn service_unavailable(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::ServiceUnavailable,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn operation_timeout(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::OperationTimeout,
            request_id,
            instance,
            Vec::new(),
        )
    }

    #[must_use]
    pub fn commit_outcome_unknown(request_id: RequestId, instance: impl Into<String>) -> Self {
        Self::new(
            ProblemKind::CommitOutcomeUnknown,
            request_id,
            instance,
            Vec::new(),
        )
    }

    fn new(
        kind: ProblemKind,
        request_id: RequestId,
        instance: impl Into<String>,
        errors: Vec<FieldViolation>,
    ) -> Self {
        Self {
            kind,
            request_id,
            instance: instance.into(),
            errors,
        }
    }
}

#[derive(Debug, Serialize)]
struct ProblemDetails<'a> {
    #[serde(rename = "type")]
    type_uri: &'a str,
    title: &'a str,
    status: u16,
    detail: &'a str,
    instance: &'a str,
    code: &'a str,
    request_id: &'a str,
    errors: &'a [FieldViolation],
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let status = self.kind.status();
        let problem = ProblemDetails {
            type_uri: self.kind.type_uri(),
            title: self.kind.title(),
            status: status.as_u16(),
            detail: self.kind.detail(),
            instance: &self.instance,
            code: self.kind.code(),
            request_id: self.request_id.as_str(),
            errors: &self.errors,
        };
        let mut response = (status, Json(problem)).into_response();
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(PROBLEM_CONTENT_TYPE));
        response
    }
}
