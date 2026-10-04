use super::*;

#[test]
fn credentials_and_idempotency_material_are_redacted() {
    let key = IdempotencyKey::new("client-retry-key-0001".to_owned()).unwrap();
    let secret = IdempotencySecret::new([7; 32]).unwrap();
    assert_eq!(format!("{key:?}"), "IdempotencyKey([REDACTED])");
    assert_eq!(format!("{secret:?}"), "IdempotencySecret([REDACTED])");
}

#[test]
fn idempotency_inputs_are_bounded() {
    assert!(IdempotencyKey::new("short".to_owned()).is_err());
    assert!(IdempotencyKey::new("x".repeat(129)).is_err());
    assert!(IdempotencyKey::new("invalid key material".to_owned()).is_err());
    assert!(IdempotencySecret::new([0; 32]).is_err());
}
