use super::*;

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
