use axum::Json;
use axum::http::{HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use super::RequestId;

const PROBLEM_CONTENT_TYPE: &str = "application/problem+json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProblemKind {
    NotFound,
    MethodNotAllowed,
    Internal,
}

impl ProblemKind {
    const fn status(self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    const fn type_uri(self) -> &'static str {
        match self {
            Self::NotFound => "urn:nuriteo:problem:not-found",
            Self::MethodNotAllowed => "urn:nuriteo:problem:method-not-allowed",
            Self::Internal => "urn:nuriteo:problem:internal",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::NotFound => "Resource not found",
            Self::MethodNotAllowed => "Method not allowed",
            Self::Internal => "Internal server error",
        }
    }

    const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::MethodNotAllowed => "method_not_allowed",
            Self::Internal => "internal_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpError {
    kind: ProblemKind,
    request_id: RequestId,
}

impl HttpError {
    #[must_use]
    pub const fn not_found(request_id: RequestId) -> Self {
        Self {
            kind: ProblemKind::NotFound,
            request_id,
        }
    }

    #[must_use]
    pub const fn method_not_allowed(request_id: RequestId) -> Self {
        Self {
            kind: ProblemKind::MethodNotAllowed,
            request_id,
        }
    }

    #[must_use]
    pub const fn internal(request_id: RequestId) -> Self {
        Self {
            kind: ProblemKind::Internal,
            request_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProblemDetails<'a> {
    #[serde(rename = "type")]
    type_uri: &'a str,
    title: &'a str,
    status: u16,
    code: &'a str,
    request_id: &'a str,
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let status = self.kind.status();
        let problem = ProblemDetails {
            type_uri: self.kind.type_uri(),
            title: self.kind.title(),
            status: status.as_u16(),
            code: self.kind.code(),
            request_id: self.request_id.as_str(),
        };
        let mut response = (status, Json(problem)).into_response();
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(PROBLEM_CONTENT_TYPE));
        response
    }
}
