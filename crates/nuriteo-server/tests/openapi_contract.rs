use axum::Router;

use axum::body::{Body, to_bytes};

use axum::http::{Request, StatusCode, header::CONTENT_TYPE};

use axum::response::Response;

use nuriteo_server::app::build_router;

use nuriteo_server::openapi::{self, DOCS_PATH, DOCUMENT_PATH};

use serde_json::{Value, json};

use tower::ServiceExt;


const REQUEST_ID: &str = "openapi-contract-01";

const SNAPSHOT: &str = include_str!("fixtures/openapi-v1.json");

#[path = "openapi_contract/document.rs"]
mod document;
pub(crate) use document::*;
#[path = "openapi_contract/routes.rs"]
mod routes;
pub(crate) use routes::*;
