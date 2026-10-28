use std::str::FromStr;


use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Extension, Path, Query, Request, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, RANGE,
        },
    },
    response::{IntoResponse, Response},
};

use serde::Deserialize;

use serde::de::DeserializeOwned;

use tokio_util::io::ReaderStream;

use utoipa::ToSchema;

use utoipa_axum::{router::OpenApiRouter, routes};

use uuid::Uuid;


use crate::{
    http::{FieldViolation, HttpError, RequestId},
    identity::{BrowserMethod, BrowserRequestHeaders, UserId},
    organization::OrganizationId,
    project::{ProjectId, ProjectOwner},
};


use super::{
    PublicPublishedExampleListView, PublicPublishedExampleView, PublishedExampleCreateView,
    PublishedExampleForkKey, PublishedExampleForkView, PublishedExampleHttpError,
    PublishedExampleHttpService, PublishedExampleId, PublishedExampleName,
    PublishedExamplePublicId, PublishedExampleVersionMutationView, PublishedExampleView,
    PublishedExampleVisibility,
};


const COLLECTION: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples";

const ITEM: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}";

const VERSIONS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/versions";

const ACTIVE_VERSION: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/active-version";

const UNPUBLISH: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/unpublish";

const REPUBLISH: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/republish";

const PUBLIC_COLLECTION: &str = "/api/v1/published-examples";

const PUBLIC_ITEM: &str = "/api/v1/published-examples/{public_id}";

const PUBLIC_VERSION: &str = "/api/v1/published-examples/{public_id}/versions/{version_number}";

const PUBLIC_CONTENT: &str = "/api/v1/published-examples/{public_id}/content";

const PUBLIC_VERSION_CONTENT: &str =
    "/api/v1/published-examples/{public_id}/versions/{version_number}/content";

const PUBLIC_FORKS: &str = "/api/v1/published-examples/{public_id}/forks";

const PUBLIC_VERSION_FORKS: &str =
    "/api/v1/published-examples/{public_id}/versions/{version_number}/forks";

const MAX_BODY: usize = 4096;

const DEFAULT_PUBLIC_LIMIT: u16 = 20;

const ORIGIN: HeaderName = HeaderName::from_static("origin");

const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

const PREVIEW_ABUSE_KEY: HeaderName = HeaderName::from_static("x-nuriteo-preview-abuse-key");

const PREVIEW_ABUSE_PROOF: HeaderName = HeaderName::from_static("x-nuriteo-preview-abuse-proof");


#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    project_version_id: String,
    name: String,
    visibility: String,
}


#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddVersionRequest {
    project_version_id: String,
}


#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectVersionRequest {
    version_id: String,
}


#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct VisibilityRequest {
    visibility: String,
}


#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct DeleteRequest {
    name: String,
}


#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DestinationOwnerRequest {
    owner_type: String,
    owner_id: String,
}


#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkRequest {
    destination_owner: DestinationOwnerRequest,
    slug: String,
    name: String,
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicListQuery {
    limit: Option<u16>,
}


type ManagementPath = (String, String, String);

type ManagementItemPath = (String, String, String, String);


macro_rules! publication_action {
    ($handler:ident, $path:expr, $method:ident) => {
        #[utoipa::path(
            post, path = $path, tag = "published-examples",
            security(("projectSessionCookie" = [])),
            params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header), ("If-Match" = String, Header)),
            responses(
                (status = 200, body = PublishedExampleView),
                (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
            )
        )]
        async fn $handler(
            State(service): State<PublishedExampleHttpService>,
            Extension(request_id): Extension<RequestId>,
            Path(path): Path<ManagementItemPath>,
            headers: HeaderMap,
        ) -> Result<Response, HttpError> {
            let generation = parse_if_match(&headers, &request_id, $path)?;
            let browser = BrowserHeaders::read(&headers, &request_id, $path)?;
            let (owner, project_id, example_id) = parse_management_item(path, &request_id, $path)?;
            let view = service
                .$method(
                    browser.request(BrowserMethod::Post),
                    owner,
                    project_id,
                    example_id,
                    generation,
                )
                .await
                .map_err(|error| map_error(error, request_id.clone(), $path))?;
            example_response(view, request_id, $path)
        }
    };
}


publication_action!(unpublish, UNPUBLISH, unpublish);

publication_action!(republish, REPUBLISH, republish);


struct PublishedExampleBundleBinary;


struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_example_etag_rejects_missing_weak_duplicate_and_noncanonical_values() {
        let request_id = RequestId::generate();
        assert!(parse_if_match(&HeaderMap::new(), &request_id, ITEM).is_err());

        for raw in [
            "W/\"published-example-v1\"",
            "\"published-example-v01\"",
            "\"published-example-v+1\"",
            "\"published-example-v0\"",
            "\"project-v1\"",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(IF_MATCH, HeaderValue::from_str(raw).unwrap());
            assert!(parse_if_match(&headers, &request_id, ITEM).is_err());
        }

        let mut duplicate = HeaderMap::new();
        duplicate.append(
            IF_MATCH,
            HeaderValue::from_static("\"published-example-v1\""),
        );
        duplicate.append(
            IF_MATCH,
            HeaderValue::from_static("\"published-example-v2\""),
        );
        assert!(parse_if_match(&duplicate, &request_id, ITEM).is_err());

        let mut valid = HeaderMap::new();
        valid.insert(
            IF_MATCH,
            HeaderValue::from_static("\"published-example-v19\""),
        );
        assert_eq!(parse_if_match(&valid, &request_id, ITEM).unwrap(), 19);
    }

    #[test]
    fn public_projection_schema_contains_no_internal_identifier_fields() {
        let schema = serde_json::to_value(utoipa::openapi::schema::Schema::from(
            <PublicPublishedExampleView as utoipa::PartialSchema>::schema(),
        ))
        .unwrap();
        let serialized = schema.to_string();
        for forbidden in [
            "projectId",
            "projectVersionId",
            "bundleId",
            "userId",
            "storageId",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn fork_contract_redacts_source_locators_and_requires_one_idempotency_key() {
        let schema = serde_json::to_value(utoipa::openapi::schema::Schema::from(
            <PublishedExampleForkView as utoipa::PartialSchema>::schema(),
        ))
        .unwrap();
        let serialized = schema.to_string();
        for forbidden in [
            "sourceExampleId",
            "sourceExampleVersionId",
            "sourceBundleId",
            "projectVersionId",
            "storageScopeId",
            "idempotencyKey",
        ] {
            assert!(!serialized.contains(forbidden));
        }

        let request_id = RequestId::generate();
        assert!(parse_idempotency_key(&HeaderMap::new(), &request_id, PUBLIC_FORKS).is_err());
        let mut valid = HeaderMap::new();
        valid.insert(
            &IDEMPOTENCY_KEY,
            HeaderValue::from_static("browser-fork-request-01"),
        );
        assert_eq!(
            parse_idempotency_key(&valid, &request_id, PUBLIC_FORKS)
                .unwrap()
                .as_str(),
            "browser-fork-request-01"
        );
        valid.append(
            &IDEMPOTENCY_KEY,
            HeaderValue::from_static("browser-fork-request-02"),
        );
        assert!(parse_idempotency_key(&valid, &request_id, PUBLIC_FORKS).is_err());
    }

    #[test]
    fn fork_destination_owner_uses_domain_names_not_path_segments() {
        let request_id = RequestId::generate();
        let user_id = UserId::new();
        let organization_id = OrganizationId::new();

        assert_eq!(
            parse_destination_owner("user", &user_id.to_string(), &request_id, PUBLIC_FORKS)
                .unwrap(),
            ProjectOwner::User(user_id)
        );
        assert_eq!(
            parse_destination_owner(
                "organization",
                &organization_id.to_string(),
                &request_id,
                PUBLIC_FORKS
            )
            .unwrap(),
            ProjectOwner::Organization(organization_id)
        );
        assert!(
            parse_destination_owner("users", &user_id.to_string(), &request_id, PUBLIC_FORKS)
                .is_err()
        );
    }
}


mod publication;
pub(crate) use publication::*;
mod publication_requests;
pub(crate) use publication_requests::*;
