use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

use serde::{Serialize, Serializer};

use serde_json::json;

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Postgres, Row, Transaction};

use std::fmt;

use std::sync::Arc;

use time::OffsetDateTime;

use time::format_description::well_known::Rfc3339;

use url::Url;

use utoipa::ToSchema;

use uuid::Uuid;

use zeroize::Zeroizing;

use crate::database::DatabasePool;

use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, CookieLifetime, IssuedBrowserCookies,
    SessionPolicy, SessionService, SessionToken, Timestamp, UserId, acquire_mfa_population_lock,
    has_required_active_local_enrolled_admin,
};

use crate::integration::MasterKeyring;

use super::{
    EnrollmentComplete, EnrollmentStart, MfaChallengePolicy, MfaIdempotencyKey, MfaService,
    MfaServiceError, RecoveryCode, TotpCode,
};

const MAX_POLICY_TARGETS: usize = 10_000;

const ENROLLMENT_ISSUER: &str = "NURITEO";

const POLICY_POPULATION_DOMAIN: &[u8] = b"nuriteo.mfa-policy-population.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfaHttpServiceError {
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    InvalidInput,
    ChallengeFailed,
    NotActive,
    Conflict,
    PreconditionFailed,
    Unavailable,
    Internal,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaStatusView {
    pub local_account: bool,
    pub enrolled: bool,
    pub pending_enrollment: bool,
    pub recovery_codes_remaining: u16,
    pub policy_mode: String,
    pub grace_period_days: u16,
    pub required: bool,
    pub deadline_at: Option<String>,
    pub restricted: bool,
    pub notification_state: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaEnrollmentStartView {
    pub credential_id: String,
    pub manual_secret: SecretText,
    pub provisioning_uri: SecretText,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaEnrollmentCompleteView {
    pub recovery_codes: Vec<SecretText>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaPolicyView {
    pub mode: String,
    pub grace_period_days: u16,
    pub version: u64,
    pub affected_users: u64,
    pub immediately_restricted_users: u64,
    pub enrolled_local_administrators: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaPolicyImpactView {
    pub mode: String,
    pub grace_period_days: u16,
    pub policy_version: u64,
    pub affected_users: u64,
    pub unenrolled_users: u64,
    pub immediately_restricted_users: u64,
    pub enrolled_local_administrators: u64,
    pub population_proof: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaResetTargetView {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub credential_generation: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MfaResetTargetCollectionView {
    pub items: Vec<MfaResetTargetView>,
}

pub(crate) struct RotatedMfaResponse<T> {
    pub(crate) view: T,
    pub(crate) cookies: IssuedBrowserCookies,
}

#[derive(ToSchema)]
#[schema(value_type = String)]
pub struct SecretText(Zeroizing<String>);

#[derive(Clone)]
pub struct MfaHttpService {
    runtime: Option<Arc<MfaHttpRuntime>>,
}

pub(crate) struct MfaHttpRuntime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    service: MfaService,
}

mod enrollment;
pub(crate) use enrollment::*;
mod policy;
pub(crate) use policy::*;
