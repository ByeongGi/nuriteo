use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use uuid::{Uuid, Variant};

pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId(HeaderValue);

impl RequestId {
    fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let mut values = headers.get_all(&REQUEST_ID_HEADER).iter();
        let value = values.next()?;
        if values.next().is_some() {
            return None;
        }

        let text = value.to_str().ok()?;
        let uuid = Uuid::try_parse(text).ok()?;
        if uuid.is_nil()
            || uuid.get_variant() != Variant::RFC4122
            || uuid.hyphenated().to_string() != text
        {
            return None;
        }

        Some(Self(value.clone()))
    }

    fn generate() -> Self {
        let value = HeaderValue::from_str(&Uuid::new_v4().hyphenated().to_string())
            .expect("a formatted UUID is always a valid HTTP header value");
        Self(value)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0
            .to_str()
            .expect("RequestId only contains validated ASCII UUID values")
    }
}

pub async fn propagate_request_id(mut request: Request, next: Next) -> Response {
    let request_id = RequestId::from_headers(request.headers()).unwrap_or_else(RequestId::generate);
    request.extensions_mut().insert(request_id.clone());

    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(REQUEST_ID_HEADER, request_id.0);
    response
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use uuid::Version;

    use super::*;

    #[test]
    fn accepts_one_canonical_rfc_uuid() {
        let mut headers = HeaderMap::new();
        headers.insert(
            &REQUEST_ID_HEADER,
            HeaderValue::from_static("018f47a2-9d3c-7b21-a848-123456789abc"),
        );

        let request_id = RequestId::from_headers(&headers).unwrap();

        assert_eq!(request_id.as_str(), "018f47a2-9d3c-7b21-a848-123456789abc");
    }

    #[test]
    fn rejects_ambiguous_or_noncanonical_values() {
        let invalid_values = [
            "018F47A2-9D3C-7B21-A848-123456789ABC",
            "018f47a29d3c7b21a848123456789abc",
            "00000000-0000-0000-0000-000000000000",
            "not-a-request-id",
        ];

        for value in invalid_values {
            let mut headers = HeaderMap::new();
            headers.insert(&REQUEST_ID_HEADER, HeaderValue::from_str(value).unwrap());
            assert!(
                RequestId::from_headers(&headers).is_none(),
                "accepted {value}"
            );
        }

        let mut duplicate = HeaderMap::new();
        duplicate.append(
            &REQUEST_ID_HEADER,
            HeaderValue::from_static("018f47a2-9d3c-7b21-a848-123456789abc"),
        );
        duplicate.append(
            &REQUEST_ID_HEADER,
            HeaderValue::from_static("018f47a2-9d3c-7b21-a848-123456789abd"),
        );
        assert!(RequestId::from_headers(&duplicate).is_none());
    }

    #[test]
    fn generates_random_v4_ids() {
        let request_id = RequestId::generate();
        let uuid = Uuid::try_parse(request_id.as_str()).unwrap();

        assert_eq!(uuid.get_version(), Some(Version::Random));
        assert_eq!(uuid.get_variant(), Variant::RFC4122);
    }
}
