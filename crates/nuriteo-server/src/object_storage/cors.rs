use std::fmt;

use aws_sdk_s3::types::{CorsConfiguration, CorsRule};
use bytes::Bytes;
use url::Url;

use super::error::classify_sdk_error;
use super::{
    ObjectOperation, ObjectStoreErrorKind, PresignExpiry, PresignedMultipartPartRequest,
    PresignedPutRequest, ProbePrefix, S3ObjectStore, Sha256Checksum,
};

const RULE_ID: &str = "nuriteo-browser-upload-v1";
const ALLOWED_METHOD: &str = "PUT";
const ALLOWED_HEADERS: [&str; 3] = [
    "content-type",
    "x-amz-checksum-sha256",
    "x-amz-sdk-checksum-algorithm",
];
const EXPOSE_HEADERS: [&str; 2] = ["etag", "x-amz-checksum-sha256"];
const MAX_AGE_SECONDS: i32 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserUploadCorsCheck {
    Exact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserUploadCorsError {
    InvalidOrigin,
    Mismatch,
    Authentication,
    Authorization,
    Unsupported,
    Timeout,
    Unavailable,
    Internal,
}

impl fmt::Display for BrowserUploadCorsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidOrigin => "browser upload CORS origin is invalid",
            Self::Mismatch => "browser upload CORS policy does not match",
            Self::Authentication => "browser upload CORS authentication failed",
            Self::Authorization => "browser upload CORS authorization failed",
            Self::Unsupported => "browser upload CORS is unsupported",
            Self::Timeout => "browser upload CORS operation timed out",
            Self::Unavailable => "browser upload CORS backend is unavailable",
            Self::Internal => "browser upload CORS operation failed",
        })
    }
}

impl std::error::Error for BrowserUploadCorsError {}

impl S3ObjectStore {
    /// Replaces the bucket CORS document with the one-rule NURITEO browser
    /// upload policy. This is intentionally available only to an explicit
    /// operator command and the bundled-storage initializer.
    pub async fn configure_browser_upload_cors(
        &self,
        external_url: &Url,
    ) -> Result<BrowserUploadCorsCheck, BrowserUploadCorsError> {
        let origin = canonical_origin(external_url)?;
        let rule = desired_rule(&origin)?;
        let configuration = CorsConfiguration::builder()
            .cors_rules(rule)
            .build()
            .map_err(|_| BrowserUploadCorsError::Internal)?;
        self.client
            .put_bucket_cors()
            .bucket(&self.bucket)
            .cors_configuration(configuration)
            .send()
            .await
            .map_err(|error| {
                map_store_error(classify_sdk_error(
                    ObjectOperation::BrowserUploadCors,
                    &error,
                ))
            })?;
        self.check_browser_upload_cors(external_url).await
    }

    /// Reads and compares the complete bucket CORS document. Extra rules,
    /// wildcard values, extra methods/headers, credentials, and drift all fail
    /// closed; this method never changes an operator-owned bucket.
    pub async fn check_browser_upload_cors(
        &self,
        external_url: &Url,
    ) -> Result<BrowserUploadCorsCheck, BrowserUploadCorsError> {
        let origin = canonical_origin(external_url)?;
        let output = self
            .client
            .get_bucket_cors()
            .bucket(&self.bucket)
            .send()
            .await
            .map_err(|error| {
                map_store_error(classify_sdk_error(
                    ObjectOperation::BrowserUploadCors,
                    &error,
                ))
            })?;
        let rules = output.cors_rules();
        if rules.len() != 1 || !matches_rule(&rules[0], &origin) {
            return Err(BrowserUploadCorsError::Mismatch);
        }
        Ok(BrowserUploadCorsCheck::Exact)
    }

    /// Proves the real browser boundary: an unsigned OPTIONS request followed
    /// by Origin-bearing presigned single and multipart PUTs. Probe keys remain
    /// in the reserved namespace and cleanup is attempted on every path.
    pub async fn probe_browser_upload_cors(
        &self,
        external_url: &Url,
        prefix: &ProbePrefix,
    ) -> Result<BrowserUploadCorsCheck, BrowserUploadCorsError> {
        self.check_browser_upload_cors(external_url).await?;
        let origin = canonical_origin(external_url)?;
        let expiry = PresignExpiry::minutes(5).map_err(|_| BrowserUploadCorsError::Internal)?;

        let single_key = prefix
            .object("browser-single-put")
            .map_err(|_| BrowserUploadCorsError::Internal)?;
        let single_body = Bytes::from_static(b"nuriteo-browser-upload-cors");
        let single = self
            .presign_put(PresignedPutRequest {
                key: single_key.clone(),
                content_length: single_body.len() as u64,
                content_type: "application/vnd.nuriteo.project-bundle".to_owned(),
                checksum: Sha256Checksum::calculate(&single_body),
                expiry,
            })
            .await
            .map_err(map_store_error)?;
        let single_result = self.browser_put(&single, single_body, &origin).await;
        let single_cleanup = self.delete(&single_key).await.map_err(map_store_error);
        single_result?;
        single_cleanup?;

        let multipart_key = prefix
            .object("browser-multipart-put")
            .map_err(|_| BrowserUploadCorsError::Internal)?;
        let upload = self
            .create_multipart(multipart_key)
            .await
            .map_err(map_store_error)?;
        let multipart_body = Bytes::from(vec![b'm'; super::MIN_MULTIPART_PART_BYTES]);
        let multipart_request = PresignedMultipartPartRequest::new(
            upload.clone(),
            1,
            multipart_body.len() as u64,
            Sha256Checksum::calculate(&multipart_body),
            expiry,
        )
        .map_err(|_| BrowserUploadCorsError::Internal)?;
        let multipart = match self.presign_multipart_part(multipart_request).await {
            Ok(multipart) => multipart,
            Err(error) => {
                let _ = self.abort_multipart(&upload).await;
                return Err(map_store_error(error));
            }
        };
        let multipart_result = self.browser_put(&multipart, multipart_body, &origin).await;
        let multipart_cleanup = self.abort_multipart(&upload).await.map_err(map_store_error);
        multipart_result?;
        multipart_cleanup?;
        Ok(BrowserUploadCorsCheck::Exact)
    }

    async fn browser_put(
        &self,
        request: &super::BoundedPresignedRequest,
        body: Bytes,
        origin: &str,
    ) -> Result<(), BrowserUploadCorsError> {
        let requested_headers = request
            .signed_headers()
            .map(|(name, _)| name.to_ascii_lowercase())
            .filter(|name| name != "content-length" && name != "host")
            .collect::<Vec<_>>();
        if requested_headers.is_empty()
            || requested_headers
                .iter()
                .any(|name| !ALLOWED_HEADERS.contains(&name.as_str()))
        {
            return Err(BrowserUploadCorsError::Internal);
        }
        let preflight = self
            .presigned_client
            .request(
                reqwest::Method::OPTIONS,
                request.url.expose_bearer_url().clone(),
            )
            .header("origin", origin)
            .header("access-control-request-method", ALLOWED_METHOD)
            .header(
                "access-control-request-headers",
                requested_headers.join(","),
            )
            .send()
            .await
            .map_err(|_| BrowserUploadCorsError::Unavailable)?;
        validate_cors_response(&preflight, origin, true, &requested_headers)?;
        self.reject_preflight(
            request,
            "https://invalid-origin.invalid",
            &requested_headers,
        )
        .await?;
        self.reject_preflight(request, origin, &["authorization".to_owned()])
            .await?;

        let mut put = self
            .presigned_client
            .put(request.url.expose_bearer_url().clone())
            .header("origin", origin);
        for (name, value) in request.signed_headers() {
            put = put.header(name, value);
        }
        let response = put
            .body(body)
            .send()
            .await
            .map_err(|_| BrowserUploadCorsError::Unavailable)?;
        validate_cors_response(&response, origin, false, &requested_headers)
    }

    async fn reject_preflight(
        &self,
        request: &super::BoundedPresignedRequest,
        origin: &str,
        requested_headers: &[String],
    ) -> Result<(), BrowserUploadCorsError> {
        let response = self
            .presigned_client
            .request(
                reqwest::Method::OPTIONS,
                request.url.expose_bearer_url().clone(),
            )
            .header("origin", origin)
            .header("access-control-request-method", ALLOWED_METHOD)
            .header(
                "access-control-request-headers",
                requested_headers.join(","),
            )
            .send()
            .await
            .map_err(|_| BrowserUploadCorsError::Unavailable)?;
        let allowed_origin = response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok());
        let allowed_headers = response
            .headers()
            .get("access-control-allow-headers")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(',').map(str::trim).collect::<Vec<_>>())
            .unwrap_or_default();
        let requested_headers_allowed = requested_headers.iter().all(|requested| {
            allowed_headers
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(requested))
        });
        if response.status().is_success()
            && allowed_origin == Some(origin)
            && requested_headers_allowed
        {
            return Err(BrowserUploadCorsError::Mismatch);
        }
        Ok(())
    }
}

fn validate_cors_response(
    response: &reqwest::Response,
    origin: &str,
    preflight: bool,
    requested_headers: &[String],
) -> Result<(), BrowserUploadCorsError> {
    if !response.status().is_success()
        || response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok())
            != Some(origin)
        || response
            .headers()
            .get("access-control-allow-credentials")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Err(BrowserUploadCorsError::Mismatch);
    }
    if preflight {
        let methods = csv_header(response, "access-control-allow-methods")?;
        let headers = csv_header(response, "access-control-allow-headers")?;
        if !methods.iter().any(|value| value == ALLOWED_METHOD)
            || !requested_headers.iter().all(|expected| {
                headers
                    .iter()
                    .any(|actual| actual.eq_ignore_ascii_case(expected))
            })
        {
            return Err(BrowserUploadCorsError::Mismatch);
        }
    } else {
        let exposed = csv_header(response, "access-control-expose-headers")?;
        if !EXPOSE_HEADERS.iter().all(|expected| {
            exposed
                .iter()
                .any(|actual| actual.eq_ignore_ascii_case(expected))
        }) {
            return Err(BrowserUploadCorsError::Mismatch);
        }
    }
    Ok(())
}

fn csv_header(
    response: &reqwest::Response,
    name: &str,
) -> Result<Vec<String>, BrowserUploadCorsError> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(|part| part.trim().to_owned())
                .collect()
        })
        .ok_or(BrowserUploadCorsError::Mismatch)
}

fn canonical_origin(url: &Url) -> Result<String, BrowserUploadCorsError> {
    if url.cannot_be_a_base()
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(BrowserUploadCorsError::InvalidOrigin);
    }
    let origin = url.origin().ascii_serialization();
    if origin == "null" || origin.contains('*') {
        return Err(BrowserUploadCorsError::InvalidOrigin);
    }
    Ok(origin)
}

fn desired_rule(origin: &str) -> Result<CorsRule, BrowserUploadCorsError> {
    CorsRule::builder()
        .id(RULE_ID)
        .allowed_origins(origin)
        .allowed_methods(ALLOWED_METHOD)
        .set_allowed_headers(Some(
            ALLOWED_HEADERS.iter().map(ToString::to_string).collect(),
        ))
        .set_expose_headers(Some(
            EXPOSE_HEADERS.iter().map(ToString::to_string).collect(),
        ))
        .max_age_seconds(MAX_AGE_SECONDS)
        .build()
        .map_err(|_| BrowserUploadCorsError::Internal)
}

fn matches_rule(rule: &CorsRule, origin: &str) -> bool {
    rule.id() == Some(RULE_ID)
        && exact(rule.allowed_origins(), &[origin])
        && exact(rule.allowed_methods(), &[ALLOWED_METHOD])
        && exact_case_insensitive(rule.allowed_headers(), &ALLOWED_HEADERS)
        && exact_case_insensitive(rule.expose_headers(), &EXPOSE_HEADERS)
        && rule.max_age_seconds() == Some(MAX_AGE_SECONDS)
        && !rule
            .allowed_origins()
            .iter()
            .any(|value| value.contains('*'))
        && !rule
            .allowed_headers()
            .iter()
            .any(|value| value.contains('*'))
}

fn exact(actual: &[String], expected: &[&str]) -> bool {
    actual.len() == expected.len()
        && expected
            .iter()
            .all(|expected| actual.iter().any(|actual| actual == expected))
}

fn exact_case_insensitive(actual: &[String], expected: &[&str]) -> bool {
    actual.len() == expected.len()
        && expected.iter().all(|expected| {
            actual
                .iter()
                .any(|actual| actual.eq_ignore_ascii_case(expected))
        })
}

fn map_store_error(error: super::ObjectStoreError) -> BrowserUploadCorsError {
    match error.kind() {
        ObjectStoreErrorKind::Authentication => BrowserUploadCorsError::Authentication,
        ObjectStoreErrorKind::Authorization => BrowserUploadCorsError::Authorization,
        ObjectStoreErrorKind::Unsupported | ObjectStoreErrorKind::NotFound => {
            BrowserUploadCorsError::Unsupported
        }
        ObjectStoreErrorKind::Timeout => BrowserUploadCorsError::Timeout,
        ObjectStoreErrorKind::Unavailable
        | ObjectStoreErrorKind::ResponseUnknown
        | ObjectStoreErrorKind::Throttled => BrowserUploadCorsError::Unavailable,
        ObjectStoreErrorKind::InvalidRequest
        | ObjectStoreErrorKind::Conflict
        | ObjectStoreErrorKind::ResponseTooLarge
        | ObjectStoreErrorKind::Integrity
        | ObjectStoreErrorKind::Internal => BrowserUploadCorsError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_policy_rejects_wildcards_and_extra_capability() {
        let origin = "https://app.example.test";
        let exact_rule = desired_rule(origin).unwrap();
        assert!(matches_rule(&exact_rule, origin));

        let wildcard = CorsRule::builder()
            .id(RULE_ID)
            .allowed_origins("*")
            .allowed_methods(ALLOWED_METHOD)
            .allowed_headers("*")
            .expose_headers("ETag")
            .max_age_seconds(MAX_AGE_SECONDS)
            .build()
            .unwrap();
        assert!(!matches_rule(&wildcard, origin));
    }

    #[test]
    fn origin_is_serialized_without_path_or_credentials() {
        assert_eq!(
            canonical_origin(&Url::parse("https://app.example.test/").unwrap()).unwrap(),
            "https://app.example.test"
        );
        assert!(canonical_origin(&Url::parse("https://user@app.example.test/").unwrap()).is_err());
        assert!(canonical_origin(&Url::parse("https://app.example.test/path").unwrap()).is_err());
    }
}
