use std::fmt;
use std::future::Future;
use std::pin::Pin;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use url::Url;
use uuid::{Uuid, Variant, Version};
use zeroize::Zeroizing;

use crate::database::DatabasePool;

use super::{
    ClaimedEmail, DeliveryBoundaryError, EmailAttemptPreparer, InvitationAttemptContext,
    InvitationAttemptToken, InvitationAttemptTokenIssuer, PreparedEmail,
};

const TOKEN_BYTES: usize = 32;
const ACTIVATION_TOKEN_PREFIX: &str = "nrt_inv_";
const ORGANIZATION_TOKEN_PREFIX: &str = "nrt_org_inv_";

#[derive(Clone)]
pub struct DatabaseInvitationAttemptTokenIssuer {
    pool: DatabasePool,
}

impl DatabaseInvitationAttemptTokenIssuer {
    #[must_use]
    pub const fn new(pool: DatabasePool) -> Self {
        Self { pool }
    }

    async fn rotate(
        &self,
        context: &InvitationAttemptContext,
    ) -> Result<InvitationAttemptToken, DeliveryBoundaryError> {
        validate_context(context)?;
        let prefix = match context.resource_type.as_str() {
            "activation_invitation" => ACTIVATION_TOKEN_PREFIX,
            "organization_invitation" => ORGANIZATION_TOKEN_PREFIX,
            _ => return Err(DeliveryBoundaryError::Permanent),
        };
        let (token, digest) = generate_token(prefix)?;
        let statement = match context.resource_type.as_str() {
            "activation_invitation" => {
                "UPDATE activation_invitations \
                 SET token_hash=$3,delivery_token_generation=delivery_token_generation+1 \
                 WHERE id=$1::uuid AND normalized_email=$2 AND status='pending' \
                   AND expires_at>transaction_timestamp()"
            }
            "organization_invitation" => {
                "UPDATE organization_invitations \
                 SET token_hash=$3,delivery_token_generation=delivery_token_generation+1 \
                 WHERE id=$1::uuid AND normalized_email=$2 AND status='pending' \
                   AND expires_at>transaction_timestamp()"
            }
            _ => return Err(DeliveryBoundaryError::Permanent),
        };
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| DeliveryBoundaryError::Retryable)?;
        let updated = sqlx::query(statement)
            .bind(&context.invitation_id)
            .bind(&context.recipient_email)
            .bind(digest.as_slice())
            .execute(&mut *connection)
            .await
            .map_err(|_| DeliveryBoundaryError::Retryable)?;
        if updated.rows_affected() != 1 {
            return Err(DeliveryBoundaryError::Cancel);
        }
        Ok(token)
    }
}

impl InvitationAttemptTokenIssuer for DatabaseInvitationAttemptTokenIssuer {
    fn issue<'a>(
        &'a self,
        context: &'a InvitationAttemptContext,
    ) -> Pin<
        Box<dyn Future<Output = Result<InvitationAttemptToken, DeliveryBoundaryError>> + Send + 'a>,
    > {
        Box::pin(self.rotate(context))
    }
}

impl fmt::Debug for DatabaseInvitationAttemptTokenIssuer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DatabaseInvitationAttemptTokenIssuer")
            .finish_non_exhaustive()
    }
}

fn validate_context(context: &InvitationAttemptContext) -> Result<(), DeliveryBoundaryError> {
    let id =
        Uuid::parse_str(&context.invitation_id).map_err(|_| DeliveryBoundaryError::Permanent)?;
    if id.is_nil()
        || id.get_version() != Some(Version::SortRand)
        || id.get_variant() != Variant::RFC4122
        || context.recipient_email != context.recipient_email.trim().to_lowercase()
        || context.recipient_email.contains(char::is_control)
        || !(3..=320).contains(&context.recipient_email.len())
        || context.attempt_count == 0
    {
        return Err(DeliveryBoundaryError::Permanent);
    }
    Ok(())
}

fn generate_token(
    prefix: &str,
) -> Result<(InvitationAttemptToken, [u8; 32]), DeliveryBoundaryError> {
    let mut entropy = Zeroizing::new([0_u8; TOKEN_BYTES]);
    getrandom::fill(&mut *entropy).map_err(|_| DeliveryBoundaryError::Retryable)?;
    let plaintext = format!("{prefix}{}", URL_SAFE_NO_PAD.encode(*entropy));
    let digest = Sha256::digest(plaintext.as_bytes()).into();
    Ok((InvitationAttemptToken::new(plaintext), digest))
}

/// Deliberately small production renderer. Outbox projections are allowlisted
/// identifiers, not trusted prose, so arbitrary rendering JSON never crosses
/// the SMTP boundary.
#[derive(Clone, Debug)]
pub struct ProductionEmailAttemptPreparer {
    external_url: Url,
}

impl ProductionEmailAttemptPreparer {
    #[must_use]
    pub fn new(external_url: Url) -> Self {
        Self { external_url }
    }

    fn render_notification(
        &self,
        email: &ClaimedEmail,
    ) -> Result<PreparedEmail, DeliveryBoundaryError> {
        let (subject, summary) = match email.classification() {
            "critical_security" => (
                "NURITEO security alert",
                "A critical security event needs your attention.",
            ),
            "account_access" => (
                "NURITEO account notification",
                "There was an account access event.",
            ),
            "collaboration" => (
                "NURITEO collaboration update",
                "There is a collaboration update.",
            ),
            "operations" => (
                "NURITEO operations update",
                "There is an operations update.",
            ),
            _ => return Err(DeliveryBoundaryError::Permanent),
        };
        let body = format!(
            "{summary}\n\nOpen NURITEO to review the details:\n{}\n\nReference: {}",
            self.external_url,
            email.template_id()
        );
        PreparedEmail::new(subject.to_owned(), body)
    }

    fn render_invitation(
        &self,
        email: &ClaimedEmail,
        token: &InvitationAttemptToken,
    ) -> Result<PreparedEmail, DeliveryBoundaryError> {
        let (path, subject, summary) = match email.resource_type() {
            "activation_invitation" => (
                "/activate",
                "Activate your NURITEO account",
                "You were invited to activate a NURITEO account.",
            ),
            "organization_invitation" => (
                "/organization-invitations/accept",
                "Join a NURITEO organization",
                "You were invited to join a NURITEO organization.",
            ),
            _ => return Err(DeliveryBoundaryError::Permanent),
        };
        let mut action_url = self.external_url.clone();
        action_url.set_path(path);
        action_url.set_query(None);
        action_url.set_fragment(None);
        action_url
            .query_pairs_mut()
            .append_pair("token", token.expose_for_message());
        let action_url = Zeroizing::new(String::from(action_url));
        PreparedEmail::new(
            subject.to_owned(),
            format!(
                "{summary}\n\nOpen this one-time link to continue:\n{}\n\nIf you did not expect this invitation, ignore this email.",
                action_url.as_str()
            ),
        )
    }
}

impl EmailAttemptPreparer for ProductionEmailAttemptPreparer {
    fn prepare<'a>(
        &'a self,
        email: &'a ClaimedEmail,
        invitation_token: Option<&'a InvitationAttemptToken>,
    ) -> Pin<Box<dyn Future<Output = Result<PreparedEmail, DeliveryBoundaryError>> + Send + 'a>>
    {
        Box::pin(async move {
            if matches!(
                email.resource_type(),
                "activation_invitation" | "organization_invitation"
            ) {
                return invitation_token
                    .ok_or(DeliveryBoundaryError::Permanent)
                    .and_then(|token| self.render_invitation(email, token));
            }
            if invitation_token.is_some() {
                return Err(DeliveryBoundaryError::Permanent);
            }
            self.render_notification(email)
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn job(classification: &str) -> ClaimedEmail {
        ClaimedEmail {
            id: "0199ee6c-c777-7000-8000-000000005001".into(),
            notification_id: Some("0199ee6c-c777-7000-8000-000000005002".into()),
            recipient_user_id: Some("0199ee6c-c777-7000-8000-000000005003".into()),
            recipient_email: "private@example.invalid".into(),
            classification: classification.into(),
            template_id: "identity.changed".into(),
            locale: "en-US".into(),
            resource_type: "user".into(),
            resource_id: "0199ee6c-c777-7000-8000-000000005003".into(),
            rendering_data: json!({"smtpCredential":"must-not-render"}),
            attempt_count: 1,
            lock_version: 1,
        }
    }

    #[tokio::test]
    async fn renderer_is_allowlisted_and_does_not_render_arbitrary_projection_data() {
        let renderer = ProductionEmailAttemptPreparer::new(
            Url::parse("https://nuriteo.example.test/").unwrap(),
        );
        let email = renderer
            .prepare(&job("account_access"), None)
            .await
            .unwrap();
        assert!(email.body().contains("identity.changed"));
        assert!(!email.body().contains("must-not-render"));
        assert!(renderer.prepare(&job("unknown"), None).await.is_err());
    }

    #[tokio::test]
    async fn invitation_renderer_requires_one_attempt_token_and_uses_canonical_paths() {
        let renderer = ProductionEmailAttemptPreparer::new(
            Url::parse("https://nuriteo.example.test/base?stale=true#fragment").unwrap(),
        );
        let token =
            InvitationAttemptToken::new(format!("{ACTIVATION_TOKEN_PREFIX}{}", "a".repeat(43)));
        let mut activation = job("account_access");
        activation.resource_type = "activation_invitation".into();
        activation.template_id = "activation.invited".into();
        let message = renderer.prepare(&activation, Some(&token)).await.unwrap();
        assert!(message.subject().contains("Activate"));
        assert!(message.body().contains(
            "https://nuriteo.example.test/activate?token=nrt_inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!message.body().contains("stale=true"));
        assert!(!message.body().contains("must-not-render"));
        assert!(renderer.prepare(&activation, None).await.is_err());

        let organization_token =
            InvitationAttemptToken::new(format!("{ORGANIZATION_TOKEN_PREFIX}{}", "b".repeat(43)));
        activation.resource_type = "organization_invitation".into();
        let message = renderer
            .prepare(&activation, Some(&organization_token))
            .await
            .unwrap();
        assert!(message.body().contains(
            "https://nuriteo.example.test/organization-invitations/accept?token=nrt_org_inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ));
    }

    #[test]
    fn generated_credentials_and_debug_output_follow_the_secret_contract() {
        for prefix in [ACTIVATION_TOKEN_PREFIX, ORGANIZATION_TOKEN_PREFIX] {
            let (token, digest) = generate_token(prefix).unwrap();
            let plaintext = token.expose_for_message();
            assert!(plaintext.starts_with(prefix));
            assert_eq!(plaintext.len(), prefix.len() + 43);
            assert_eq!(
                digest,
                <[u8; 32]>::from(Sha256::digest(plaintext.as_bytes()))
            );
            assert_eq!(format!("{token:?}"), "InvitationAttemptToken([REDACTED])");
        }
    }

    #[test]
    fn issuer_context_rejects_ambiguous_or_noncanonical_identity() {
        let mut context = InvitationAttemptContext {
            invitation_id: "0199ee6c-c777-7000-8000-000000005001".into(),
            resource_type: "activation_invitation".into(),
            recipient_email: "private@example.invalid".into(),
            attempt_count: 1,
        };
        assert_eq!(validate_context(&context), Ok(()));
        context.recipient_email = "Private@example.invalid".into();
        assert_eq!(
            validate_context(&context),
            Err(DeliveryBoundaryError::Permanent)
        );
        context.recipient_email = "private@example.invalid".into();
        context.resource_type = "user".into();
        assert_eq!(validate_context(&context), Ok(()));
        context.attempt_count = 0;
        assert_eq!(
            validate_context(&context),
            Err(DeliveryBoundaryError::Permanent)
        );
    }
}
