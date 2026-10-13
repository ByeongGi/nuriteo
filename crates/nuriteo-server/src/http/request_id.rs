use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use uuid::Uuid;

pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId {
    text: String,
    header: HeaderValue,
}

impl RequestId {
    fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let mut values = headers.get_all(&REQUEST_ID_HEADER).iter();
        let value = values.next()?;
        if values.next().is_some() {
            return None;
        }

        let text = value.to_str().ok()?;
        if text.is_empty()
            || text.len() > 128
            || !text.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return None;
        }

        Some(Self {
            text: text.to_owned(),
            header: value.clone(),
        })
    }

    pub(crate) fn generate() -> Self {
        let text = Uuid::new_v4().hyphenated().to_string();
        match HeaderValue::from_str(&text) {
            Ok(header) => Self { text, header },
            Err(_) => Self {
                text: "00000000-0000-4000-8000-000000000000".to_owned(),
                header: HeaderValue::from_static("00000000-0000-4000-8000-000000000000"),
            },
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

pub async fn propagate_request_id(mut request: Request, next: Next) -> Response {
    let request_id = RequestId::from_headers(request.headers()).unwrap_or_else(RequestId::generate);
    request.extensions_mut().insert(request_id.clone());

    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(REQUEST_ID_HEADER, request_id.header);
    response
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::*;

    #[test]
    fn accepts_one_bounded_safe_identifier() {
        let mut headers = HeaderMap::new();
        headers.insert(
            &REQUEST_ID_HEADER,
            HeaderValue::from_static("edge:trace-01"),
        );

        let request_id = RequestId::from_headers(&headers).unwrap();

        assert_eq!(request_id.as_str(), "edge:trace-01");
    }

    #[test]
    fn rejects_ambiguous_or_unsafe_values() {
        for value in ["contains a space", "contains/slash", "contains,comma"] {
            let mut headers = HeaderMap::new();
            headers.insert(&REQUEST_ID_HEADER, HeaderValue::from_str(value).unwrap());
            assert!(RequestId::from_headers(&headers).is_none());
        }

        let mut oversized = HeaderMap::new();
        oversized.insert(
            &REQUEST_ID_HEADER,
            HeaderValue::from_str(&"x".repeat(129)).unwrap(),
        );
        assert!(RequestId::from_headers(&oversized).is_none());

        let mut duplicate = HeaderMap::new();
        duplicate.append(&REQUEST_ID_HEADER, HeaderValue::from_static("trace-01"));
        duplicate.append(&REQUEST_ID_HEADER, HeaderValue::from_static("trace-02"));
        assert!(RequestId::from_headers(&duplicate).is_none());
    }

    #[test]
    fn generates_random_v4_ids() {
        let request_id = RequestId::generate();
        let uuid = Uuid::try_parse(request_id.as_str()).unwrap();

        assert_eq!(uuid.get_version(), Some(uuid::Version::Random));
    }
}
