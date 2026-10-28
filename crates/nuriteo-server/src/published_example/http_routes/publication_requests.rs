#![allow(unused_imports)]
use super::*;
use super::publication::*;
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


use super::super::{
    PublicPublishedExampleListView, PublicPublishedExampleView, PublishedExampleCreateView,
    PublishedExampleForkKey, PublishedExampleForkView, PublishedExampleHttpError,
    PublishedExampleHttpService, PublishedExampleId, PublishedExampleName,
    PublishedExamplePublicId, PublishedExampleVersionMutationView, PublishedExampleView,
    PublishedExampleVisibility,
};
use super::{COLLECTION, ITEM, VERSIONS, ACTIVE_VERSION, UNPUBLISH, REPUBLISH, PUBLIC_COLLECTION, PUBLIC_ITEM, PUBLIC_VERSION, PUBLIC_CONTENT, PUBLIC_VERSION_CONTENT, PUBLIC_FORKS, PUBLIC_VERSION_FORKS, MAX_BODY, DEFAULT_PUBLIC_LIMIT, ORIGIN, CSRF, IDEMPOTENCY_KEY, PREVIEW_ABUSE_KEY, PREVIEW_ABUSE_PROOF, CreateRequest, AddVersionRequest, SelectVersionRequest, VisibilityRequest, DeleteRequest, DestinationOwnerRequest, ForkRequest, PublicListQuery, ManagementPath, ManagementItemPath, PublishedExampleBundleBinary, BrowserHeaders};



pub(crate) fn parse_id<T: FromStr>(    value: &str,
    field: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    value
        .parse()
        .map_err(|_| validation(request_id, path, field))
}


pub(crate) fn parse_visibility(    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<PublishedExampleVisibility, HttpError> {
    match value {
        "unlisted" => Ok(PublishedExampleVisibility::Unlisted),
        "public" => Ok(PublishedExampleVisibility::Public),
        _ => Err(validation(request_id, path, "visibility")),
    }
}


pub(crate) fn parse_if_match(    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<i64, HttpError> {
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    let [value] = values.as_slice() else {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    };
    let raw = value
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    let generation = raw
        .strip_prefix("\"published-example-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 1)
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    if raw != format!("\"published-example-v{generation}\"") {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    Ok(generation)
}


pub(crate) fn parse_idempotency_key(    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<PublishedExampleForkKey, HttpError> {
    let values: Vec<_> = headers.get_all(&IDEMPOTENCY_KEY).iter().collect();
    let [value] = values.as_slice() else {
        return Err(validation(request_id, path, "Idempotency-Key"));
    };
    PublishedExampleForkKey::new(
        value
            .to_str()
            .map_err(|_| validation(request_id, path, "Idempotency-Key"))?
            .to_owned(),
    )
    .map_err(|_| validation(request_id, path, "Idempotency-Key"))
}


pub(crate) fn example_response(    view: PublishedExampleView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let generation = view.generation;
    let mut response = (StatusCode::OK, Json(view)).into_response();
    insert_generation_headers(&mut response, generation, &request_id, path)?;
    Ok(response)
}


pub(crate) fn insert_generation_headers(    response: &mut Response,
    generation: i64,
    request_id: &RequestId,
    path: &str,
) -> Result<(), HttpError> {
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"published-example-v{generation}\""))
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(())
}


pub(crate) fn private_no_store(mut response: Response) -> Response {    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}


pub(crate) fn public_cache(mut response: Response) -> Response {    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60"),
    );
    response
}


pub(crate) fn validation(request_id: &RequestId, path: &str, field: &str) -> HttpError {    HttpError::validation(
        request_id.clone(),
        path,
        [FieldViolation::new(
            field,
            "INVALID",
            "The value is invalid.",
        )],
    )
}


pub(crate) fn map_error(error: PublishedExampleHttpError, request_id: RequestId, path: &str) -> HttpError {    match error {
        PublishedExampleHttpError::AuthenticationFailed => {
            HttpError::authentication(request_id, path)
        }
        PublishedExampleHttpError::Forbidden => HttpError::forbidden(request_id, path),
        PublishedExampleHttpError::ConfirmationRequired => validation(&request_id, path, "name"),
        PublishedExampleHttpError::NotFound => HttpError::not_found(request_id, path),
        PublishedExampleHttpError::InvalidInput => validation(&request_id, path, "request"),
        PublishedExampleHttpError::Conflict => HttpError::conflict(request_id, path),
        PublishedExampleHttpError::QuotaExceeded => HttpError::quota_exceeded(request_id, path),
        PublishedExampleHttpError::RateLimited => HttpError::rate_limited(request_id, path),
        PublishedExampleHttpError::PreconditionFailed => {
            HttpError::precondition_failed(request_id, path)
        }
        PublishedExampleHttpError::Unavailable => HttpError::service_unavailable(request_id, path),
        PublishedExampleHttpError::OperationTimeout => {
            HttpError::operation_timeout(request_id, path)
        }
        PublishedExampleHttpError::CommitOutcomeUnknown => {
            HttpError::commit_outcome_unknown(request_id, path)
        }
        PublishedExampleHttpError::Internal => HttpError::internal(request_id, path),
    }
}
