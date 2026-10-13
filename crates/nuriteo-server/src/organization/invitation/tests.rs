use super::*;
use uuid::{Uuid, Variant, Version};

#[test]
fn invitation_ids_reject_non_rfc_uuid_v7_at_every_input_boundary() {
    let id = OrganizationInvitationId::new();
    assert_eq!(
        Uuid::parse_str(&id.to_string())
            .unwrap_or_else(|error| panic!("generated UUID: {error}"))
            .get_variant(),
        Variant::RFC4122
    );
    let mut bytes = Uuid::parse_str(&id.to_string())
        .unwrap_or_else(|error| panic!("generated UUID: {error}"))
        .into_bytes();
    bytes[8] &= 0x3f;
    let invalid = Uuid::from_bytes(bytes);
    assert_eq!(invalid.get_version(), Some(Version::SortRand));
    assert_ne!(invalid.get_variant(), Variant::RFC4122);
    assert_eq!(
        OrganizationInvitationId::from_uuid(invalid),
        Err(OrganizationInvitationError::InvalidIdentifier)
    );
    assert_eq!(
        invalid.to_string().parse::<OrganizationInvitationId>(),
        Err(OrganizationInvitationError::InvalidIdentifier)
    );
    assert!(
        serde_json::from_value::<OrganizationInvitationId>(serde_json::json!(invalid.to_string()))
            .is_err()
    );
}

#[test]
fn token_is_distinct_bounded_canonical_and_redacted() {
    let token = OrganizationInvitationToken::generate()
        .unwrap_or_else(|error| panic!("token generation: {error}"));
    assert!(token.expose().starts_with("nrt_org_inv_"));
    assert_eq!(token.expose().len(), TOKEN_WIRE_BYTES);
    assert_eq!(
        OrganizationInvitationToken::parse(token.expose().to_owned()).map(|parsed| parsed.digest()),
        Ok(token.digest())
    );
    assert!(!format!("{token:?}").contains(token.expose()));
    assert!(!token.to_string().contains(token.expose()));
    assert_eq!(
        format!("{:?}", token.digest()),
        "OrganizationInvitationTokenDigest([REDACTED])"
    );

    for invalid in [
        "nrt_inv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "nrt_org_inv_short",
        "nrt_org_inv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
        "nrt_org_inv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ] {
        assert_eq!(
            OrganizationInvitationToken::parse(invalid.into()),
            Err(OrganizationInvitationError::InvalidToken)
        );
    }
}
