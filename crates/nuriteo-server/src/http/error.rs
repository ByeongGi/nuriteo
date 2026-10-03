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
    Validation,
    Internal,
}

impl ProblemKind {
    const fn status(self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    const fn type_uri(self) -> &'static str {
        match self {
            Self::NotFound => "/docs/problems/route-not-found",
            Self::MethodNotAllowed => "/docs/problems/method-not-allowed",
            Self::Validation => "/docs/problems/validation-failed",
            Self::Internal => "/docs/problems/internal-server-error",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::NotFound => "Resource not found",
            Self::MethodNotAllowed => "Method not allowed",
            Self::Validation => "Validation failed",
            Self::Internal => "Internal server error",
        }
    }

    const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "ROUTE_NOT_FOUND",
            Self::MethodNotAllowed => "METHOD_NOT_ALLOWED",
            Self::Validation => "VALIDATION_FAILED",
            Self::Internal => "INTERNAL_SERVER_ERROR",
        }
    }

    const fn detail(self) -> &'static str {
        match self {
            Self::NotFound => "The requested resource does not exist.",
            Self::MethodNotAllowed => "The requested method is not supported for this resource.",
            Self::Validation => "One or more fields are invalid.",
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
