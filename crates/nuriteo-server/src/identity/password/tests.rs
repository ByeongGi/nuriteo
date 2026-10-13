use argon2::password_hash::PasswordHasher;

use super::*;

const PASSWORD: &[u8] = b"correct horse battery staple";
const KNOWN_SALT: &[u8] = b"known-salt-value";
const KNOWN_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

#[test]
fn generated_hashes_use_the_explicit_policy_and_round_trip() {
    let service = PasswordService::default();
    let first = service.hash(PASSWORD).unwrap();
    let second = service.hash(PASSWORD).unwrap();

    assert_ne!(first.expose(), second.expose());
    assert_eq!(
        service.verify(PASSWORD, &first).unwrap(),
        PasswordVerification::Match
    );
    assert_eq!(
        service.verify(b"wrong password", &first).unwrap(),
        PasswordVerification::Mismatch
    );

    let parsed = ParsedPasswordHash::new(first.expose()).unwrap();
    assert_eq!(parsed.algorithm.as_str(), "argon2id");
    assert_eq!(parsed.version, Some(ARGON2_VERSION));
    assert_eq!(parsed.params.get_decimal("m"), Some(GENERATED_MEMORY_KIB));
    assert_eq!(parsed.params.get_decimal("t"), Some(GENERATED_TIME_COST));
    assert_eq!(parsed.params.get_decimal("p"), Some(GENERATED_PARALLELISM));
    assert_eq!(
        decoded_salt_len(&parsed.salt.unwrap()),
        GENERATED_SALT_BYTES
    );
    assert_eq!(parsed.hash.unwrap().len(), GENERATED_OUTPUT_BYTES);
}

#[test]
fn matches_a_fixed_known_vector() {
    let service = PasswordService::default();
    let actual = service
        .argon2()
        .unwrap()
        .hash_password_with_salt(PASSWORD, KNOWN_SALT)
        .unwrap()
        .to_string();
    assert_eq!(actual, KNOWN_HASH);

    let stored = StoredPasswordHash::new(KNOWN_HASH.to_owned()).unwrap();
    assert_eq!(
        service.verify(PASSWORD, &stored).unwrap(),
        PasswordVerification::Match
    );
}

#[test]
fn rejects_empty_and_oversized_inputs() {
    let service = PasswordService::default();
    let oversized_password = vec![b'x'; MAX_PASSWORD_BYTES + 1];
    assert_eq!(
        service.hash(b""),
        Err(PasswordHashError::InvalidPasswordLength)
    );
    assert_eq!(
        service.hash(&oversized_password),
        Err(PasswordHashError::InvalidPasswordLength)
    );

    assert_eq!(
        StoredPasswordHash::new(String::new()),
        Err(PasswordHashInputError::InvalidLength)
    );
    assert_eq!(
        StoredPasswordHash::new("x".repeat(MAX_PHC_BYTES + 1)),
        Err(PasswordHashInputError::InvalidLength)
    );
}

#[test]
fn rejects_malformed_and_unsupported_phc_without_exposing_it() {
    let service = PasswordService::default();
    for value in [
        "not-phc",
        "$argon2id$v=19$m=19456,t=2,p=1$invalid*$hash",
        "$argon2id$v=19$m=19456,t=2,p=1",
        "$argon2id$v=19$m=x,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let stored = StoredPasswordHash::new(value.to_owned()).unwrap();
        assert_eq!(
            service.verify(PASSWORD, &stored),
            Err(PasswordVerifyError::MalformedHash),
            "case must fail: {}",
            stored
        );
    }

    for value in [
        "$argon2i$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=16$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=2,p=1,keyid=AAAA$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let stored = StoredPasswordHash::new(value.to_owned()).unwrap();
        assert_eq!(
            service.verify(PASSWORD, &stored),
            Err(PasswordVerifyError::UnsupportedHash)
        );
    }
}

#[test]
fn rejects_out_of_policy_costs_before_argon2_execution() {
    let service = PasswordService::default();
    let cases = [
        "$argon2id$v=19$m=4294967295,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=4294967295,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=2,p=16777215$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=8192,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=1,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=2,p=1$MTIzNDU2Nzg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAA",
        "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ];
    for value in cases {
        let stored = StoredPasswordHash::new(value.to_owned()).unwrap();
        assert_eq!(
            service.verify(PASSWORD, &stored),
            Err(PasswordVerifyError::ResourceLimit)
        );
    }
}

#[test]
fn secret_bearing_values_and_errors_are_redacted() {
    let generated = PasswordService::default().hash(PASSWORD).unwrap();
    assert_eq!(format!("{generated:?}"), "StoredPasswordHash([REDACTED])");
    assert_eq!(generated.to_string(), "[REDACTED]");
    assert!(!format!("{generated:?}").contains("argon2"));
    assert!(
        !PasswordHashError::OperationFailed
            .to_string()
            .contains("horse")
    );
    assert!(
        !PasswordVerifyError::MalformedHash
            .to_string()
            .contains("argon2")
    );
}

#[test]
fn policy_is_explicit_and_within_the_enforced_ceiling() {
    let policy = PasswordPolicy::STANDARD;
    assert_eq!(policy.memory_kib(), 19 * 1024);
    assert_eq!(policy.time_cost(), 2);
    assert_eq!(policy.parallelism(), 1);
    assert_eq!(policy.output_bytes(), 32);
    assert_eq!(policy.salt_bytes(), 16);
    assert_eq!(policy.max_memory_kib(), 64 * 1024);
    assert_eq!(policy.max_time_cost(), 4);
    assert_eq!(policy.max_parallelism(), 4);
    assert_eq!(policy.max_output_bytes(), 32);
    assert_eq!(policy.max_salt_bytes(), 32);
    assert_eq!(policy.max_password_bytes(), 1024);
    assert_eq!(policy.max_phc_bytes(), 256);
}
