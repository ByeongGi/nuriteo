use std::time::Duration;

use serde_json::json;
use uuid::Version;

use super::*;

fn timestamp(seconds: i64) -> Timestamp {
    Timestamp::from_unix_timestamp(seconds).unwrap_or_else(|error| panic!("{error}"))
}

fn pending_fields() -> ActivationInvitationFields {
    ActivationInvitationFields {
        id: ActivationInvitationId::new(),
        normalized_email: NormalizedEmail::parse("member@example.test".to_owned())
            .unwrap_or_else(|error| panic!("{error}")),
        invited_by_user_id: UserId::new(),
        status: ActivationInvitationStatus::Pending,
        created_at: timestamp(100),
        expires_at: timestamp(100 + 7 * 86_400),
        accepted_at: None,
        expired_at: None,
        revoked_at: None,
        superseded_at: None,
        replaced_by_invitation_id: None,
    }
}

#[test]
fn generated_token_has_exact_entropy_wire_digest_and_redaction_contract() {
    let first = ActivationToken::generate().unwrap_or_else(|error| panic!("{error}"));
    let second = ActivationToken::generate().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(first.expose().len(), TOKEN_WIRE_BYTES);
    assert!(first.expose().starts_with(TOKEN_PREFIX));
    assert_ne!(first.expose(), second.expose());
    assert_ne!(first.digest(), second.digest());
    assert_eq!(first.digest().as_bytes().len(), TOKEN_DIGEST_BYTES);
    assert_eq!(format!("{first:?}"), "ActivationToken([REDACTED])");
    assert_eq!(first.to_string(), "[REDACTED]");
    assert_eq!(
        format!("{:?}", first.digest()),
        "ActivationTokenDigest([REDACTED])"
    );
    assert!(!format!("{first:?} {}", first.digest().as_bytes().len()).contains(first.expose()));
}

#[test]
fn token_parser_rejects_every_noncanonical_or_unbounded_shape() {
    let invalid = [
        String::new(),
        "nrt_inv_short".to_owned(),
        format!("wrong_{}", "A".repeat(TOKEN_ENCODED_BYTES)),
        format!("{TOKEN_PREFIX}{}*", "A".repeat(TOKEN_ENCODED_BYTES - 1)),
        format!("{TOKEN_PREFIX}{}", "A".repeat(TOKEN_ENCODED_BYTES + 1)),
        format!("{TOKEN_PREFIX}{}=", "A".repeat(TOKEN_ENCODED_BYTES - 1)),
    ];
    for value in invalid {
        assert_eq!(
            ActivationToken::parse(value),
            Err(ActivationTokenError::InvalidToken)
        );
    }
}

#[test]
fn expiry_policy_has_fixed_default_and_exact_bounds() {
    let created_at = timestamp(1_000_000);
    let default = InvitationExpiryPolicy::default();
    let fixed_expiry = default
        .expires_at(created_at)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(default.duration(), Duration::from_secs(7 * 86_400));
    assert_eq!(fixed_expiry, timestamp(1_000_000 + 7 * 86_400));

    for duration in [MIN_EXPIRY, MAX_EXPIRY] {
        assert!(InvitationExpiryPolicy::new(duration).is_ok());
    }
    for duration in [
        MIN_EXPIRY - Duration::from_secs(1),
        MAX_EXPIRY + Duration::from_secs(1),
    ] {
        assert_eq!(
            InvitationExpiryPolicy::new(duration),
            Err(InvitationPolicyError::InvalidExpiry)
        );
    }
    assert_eq!(fixed_expiry, timestamp(1_000_000 + 7 * 86_400));
}

#[test]
fn normalized_email_and_uuid_v7_are_validated() {
    let normalized = NormalizedEmail::from_email("Member@Example.test")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(normalized.as_str(), "member@example.test");
    assert_eq!(
        NormalizedEmail::parse("Member@example.test".to_owned()),
        Err(IdentityError::InvalidInvitationEmail)
    );
    let id = ActivationInvitationId::new();
    assert_eq!(id.into_uuid().get_version(), Some(Version::SortRand));
}

#[test]
fn lifecycle_table_matches_persistence_constraints() {
    let accepted = timestamp(200);
    let expired = pending_fields().expires_at;
    let replacement = ActivationInvitationId::new();
    let cases = [
        (
            ActivationInvitationStatus::Pending,
            None,
            None,
            None,
            None,
            None,
            true,
        ),
        (
            ActivationInvitationStatus::Accepted,
            Some(accepted),
            None,
            None,
            None,
            None,
            true,
        ),
        (
            ActivationInvitationStatus::Expired,
            None,
            Some(expired),
            None,
            None,
            None,
            true,
        ),
        (
            ActivationInvitationStatus::Revoked,
            None,
            None,
            Some(accepted),
            None,
            None,
            true,
        ),
        (
            ActivationInvitationStatus::Superseded,
            None,
            None,
            None,
            Some(accepted),
            Some(replacement),
            true,
        ),
        (
            ActivationInvitationStatus::Pending,
            Some(accepted),
            None,
            None,
            None,
            None,
            false,
        ),
        (
            ActivationInvitationStatus::Accepted,
            None,
            None,
            None,
            None,
            None,
            false,
        ),
        (
            ActivationInvitationStatus::Superseded,
            None,
            None,
            None,
            Some(accepted),
            None,
            false,
        ),
    ];
    for (status, accepted_at, expired_at, revoked_at, superseded_at, replaced_by, expected) in cases
    {
        let fields = ActivationInvitationFields {
            status,
            accepted_at,
            expired_at,
            revoked_at,
            superseded_at,
            replaced_by_invitation_id: replaced_by,
            ..pending_fields()
        };
        assert_eq!(ActivationInvitation::new(fields).is_ok(), expected);
    }
}

#[test]
fn serialization_cannot_bypass_domain_validation_or_include_a_token() {
    let invitation =
        ActivationInvitation::new(pending_fields()).unwrap_or_else(|error| panic!("{error}"));
    let encoded = serde_json::to_string(&invitation).unwrap_or_else(|error| panic!("{error}"));
    assert!(!encoded.contains(TOKEN_PREFIX));
    let mut invalid: serde_json::Value =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    invalid["status"] = json!("accepted");
    assert!(serde_json::from_value::<ActivationInvitation>(invalid).is_err());
}
