use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::Path;

use crate::config::{Environment, FileReader};

use super::*;

const TEST_CA: &str = r#"-----BEGIN CERTIFICATE-----
MIIC2jCCAcKgAwIBAgIJAJnWhGat5XcIMA0GCSqGSIb3DQEBCwUAMBoxGDAWBgNV
BAMMD05VUklURU8tVGVzdC1DQTAeFw0yNjEwMDMxNDAxNDRaFw0zNjA5MzAxNDAx
NDRaMBoxGDAWBgNVBAMMD05VUklURU8tVGVzdC1DQTCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAL6a2l40oGS7tlrf4DeH7Minh/5fGb0Q9j/50NlOXW5/
plJ/Hbokgs4grWuMBADRJN9S22bIG8CYZqzU/uaAT5g62UNKOXZKjlDJv+3ncbV5
XNhqzAgM20Xns3KPvnIeVINMj24HeMh780Sbl42r35oR2tHWLG6fNqYeTKmbOz87
7CBg+akmx1HOYPX1kJK/X4zIdFONmMT+24p6WFBkIQxM1uVQifHUa1uQistrG4bi
L4pplVheOhVROOIBngGfuAuzVgCU9cXOw0ECULc2A08xGO/Q4hP/IH/Kl5beLRTf
Dd/gAEwd3qCCIKLMmm2Kta63s55l2d8Xge088W0kdB0CAwEAAaMjMCEwDwYDVR0T
AQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBABmw
ZTc6+qnB/nnptaGmUsHgV0o+DFRm2+hnqIfDZwBrDSrvEFo+X6iegGAq/B3KhDNY
6casmgLdHCAO6UwkyimapUMCBszj1pcnud3GiO5HorvWGqKL2E/TNGNxbF8ywUN2
qitx/JiS7Ly3f3gZuodJsAInJjtSgVcILdNLvt4EAL+jFn+gBlZpfY0O6p4NettH
L8eqHNhonlwfR5kBENm1GhQwqO/QyiVzHgbR4p1xy4D5AaI+4v8+26RRyZTFYg1K
HsUO1fmp+r86ha3RsU9TFLAsHEeVpBifI3nX2PiKBbhgDKL016CKzAf1fwVZt5Zx
4w/tcKpxUxLIE0GuFmk=
-----END CERTIFICATE-----
"#;

const TEST_LEAF_CERTIFICATE: &str = r#"-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIJAMNYKLY7iOWFMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNV
BAMME3N0b3JhZ2UuZXhhbXBsZS5jb20wHhcNMjYxMDAzMTQwNzU1WhcNMzYwOTMw
MTQwNzU1WjAeMRwwGgYDVQQDDBNzdG9yYWdlLmV4YW1wbGUuY29tMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzdbdOYD/oQJZRne92oo9wZ9I7MR2AtHj
i8eOtdnh7Dmlvg+Jr2p1WQq5LDORtJCV4hi+s92gW4MbCUC5qEdcdYWueKEHcVhI
xoXoECFunFSPcwe/xNS7KdLblhZq3L1Q5uHO+bB4Nvkho3GbfXTZZT5cNPW7zHPj
u1tmzWRPtsqi7FsoumjsTpIaSyWhOZpY8MTC27q3meMLdNwGlRFFCrSRsGQLGIS3
VDLjAJpFi9dTkkPpeejltdeOhyl6ypa3zdnMM9vATYKKmObPZ6tYQUa76RPTQrWe
Nn7YiBRtVu/S8hQ5H4Bbft+OuebfvDnFQ3UIFmq291KtQxBjVsAp1QIDAQABoyAw
HjAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIFoDANBgkqhkiG9w0BAQsFAAOC
AQEAfaZ5tQFhSSEc3aBHZlJlvSkewmx60wo+tsMB0jfyLRBE/In3CytCZvS41Z6Q
PMboX1zQ6/AM7o0rw+0X2KoelVJDyO8ECcOx59TpnjvSqWtb27hERJ0ZotlEb7r3
c1hBYpnhHRwI4DLkNxqoXp8F8TqEjTo8m7uwDaJsqHAqVQV1eUDiLljUtS7AbEhI
0pFbZ6d3TaWCNPFTOvrCF4Q+OgOntIxSWqqKBz0kNccC69DFr569s1eMyMBlJZQq
yrldHDqGIP2b5z5V4MvrIo4Zio4ncn7PMCPw6MuDgRuJ7Fsc0vA2WBqK0XtOCABt
QOgzz9S8qEidCCvnABnB2IdJqQ==
-----END CERTIFICATE-----
"#;

#[derive(Default)]
struct TestEnvironment(Vec<(OsString, OsString)>);

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

#[derive(Default)]
struct TestFiles(BTreeMap<String, Vec<u8>>);

impl FileReader for TestFiles {
    fn read(&self, path: &Path, _limit: usize) -> io::Result<Vec<u8>> {
        self.0
            .get(path.to_string_lossy().as_ref())
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "fixture missing"))
    }
}

fn environment(entries: &[(&str, &str)]) -> TestEnvironment {
    TestEnvironment(
        entries
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect(),
    )
}

fn base(provider: &'static str) -> Vec<(&'static str, &'static str)> {
    vec![
        ("NURITEO_S3_ENDPOINT", "https://storage.example.com"),
        ("NURITEO_S3_REGION", "us-east-1"),
        ("NURITEO_S3_BUCKET", "nuriteo-projects"),
        ("NURITEO_S3_ADDRESSING_STYLE", "path"),
        ("NURITEO_S3_CREDENTIAL_PROVIDER", provider),
    ]
}

#[test]
fn loads_each_explicit_non_static_provider_without_fallback() {
    for (value, expected) in [
        ("workload", CredentialProvider::Workload),
        ("default", CredentialProvider::Default),
    ] {
        let config =
            ObjectStorageConfig::load(&environment(&base(value)), &TestFiles::default()).unwrap();

        assert_eq!(config.credential_provider(), &expected);
        assert!(config.tls_trust().uses_system_roots());
        assert_eq!(config.tls_trust().instance_ca(), None);
        assert_eq!(config.tls_trust().integration_ca(), None);
    }
}

#[test]
fn global_strict_configuration_registry_accepts_s3_inputs() {
    let mut entries = base("default");
    entries.push(("NURITEO_EXTERNAL_URL", "https://nuriteo.example.com"));

    let report =
        crate::config::Config::load(&environment(&entries), &TestFiles::default()).unwrap();

    assert!(report.warnings.is_empty());
}

#[test]
fn static_credentials_load_from_files_and_are_redacted_everywhere() {
    let access = "sensitive-access-key";
    let secret = "sensitive-secret-key";
    let token = "sensitive-session-token";
    let mut entries = base("static");
    entries.extend([
        ("NURITEO_S3_ACCESS_KEY_ID_FILE", "/private/access"),
        ("NURITEO_S3_SECRET_ACCESS_KEY_FILE", "/private/secret"),
        ("NURITEO_S3_SESSION_TOKEN_FILE", "/private/token"),
    ]);
    let files = TestFiles(BTreeMap::from([
        ("/private/access".into(), format!("{access}\n").into_bytes()),
        (
            "/private/secret".into(),
            format!("{secret}\r\n").into_bytes(),
        ),
        ("/private/token".into(), format!("{token}\n").into_bytes()),
    ]));

    let config = ObjectStorageConfig::load(&environment(&entries), &files).unwrap();
    let CredentialProvider::Static(credentials) = config.credential_provider() else {
        panic!("expected explicit static credentials")
    };
    assert_eq!(credentials.access_key_id().expose_secret(), access);
    assert_eq!(credentials.secret_access_key().expose_secret(), secret);
    assert_eq!(
        credentials
            .session_token()
            .map(|value| value.expose_secret()),
        Some(token)
    );

    let debug = format!("{config:?}");
    let snapshot = serde_json::to_string(&config.snapshot()).unwrap();
    for prohibited in [
        access,
        secret,
        token,
        "/private/access",
        "/private/secret",
        "/private/token",
        "storage.example.com",
        "nuriteo-projects",
    ] {
        assert!(!debug.contains(prohibited));
        assert!(!snapshot.contains(prohibited));
    }
}

#[test]
fn credential_selection_fails_closed_table() {
    struct Case {
        name: &'static str,
        provider: &'static str,
        additions: &'static [(&'static str, &'static str)],
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "provider required",
            provider: "",
            additions: &[],
            expected: "configuration NURITEO_S3_CREDENTIAL_PROVIDER must not be empty",
        },
        Case {
            name: "static access key required",
            provider: "static",
            additions: &[("NURITEO_S3_SECRET_ACCESS_KEY", "do-not-log")],
            expected: "required configuration NURITEO_S3_ACCESS_KEY_ID is missing",
        },
        Case {
            name: "static source conflict",
            provider: "static",
            additions: &[
                ("NURITEO_S3_ACCESS_KEY_ID", "do-not-log"),
                ("NURITEO_S3_ACCESS_KEY_ID_FILE", "/private/access"),
                ("NURITEO_S3_SECRET_ACCESS_KEY", "do-not-log"),
            ],
            expected: "credential configuration NURITEO_S3_ACCESS_KEY_ID is invalid",
        },
        Case {
            name: "workload rejects static values",
            provider: "workload",
            additions: &[("NURITEO_S3_ACCESS_KEY_ID", "do-not-log")],
            expected: "static credential inputs are not allowed with the explicit workload provider",
        },
        Case {
            name: "default rejects static files",
            provider: "default",
            additions: &[("NURITEO_S3_SECRET_ACCESS_KEY_FILE", "/private/secret")],
            expected: "static credential inputs are not allowed with the explicit default provider",
        },
        Case {
            name: "no inferred provider",
            provider: "automatic",
            additions: &[],
            expected: "configuration NURITEO_S3_CREDENTIAL_PROVIDER must be static, workload, or default",
        },
    ];

    for case in cases {
        let mut entries = base(case.provider);
        entries.extend_from_slice(case.additions);
        let error =
            ObjectStorageConfig::load(&environment(&entries), &TestFiles::default()).unwrap_err();
        assert_eq!(error.to_string(), case.expected, "{}", case.name);
        assert!(!error.to_string().contains("do-not-log"));
        assert!(!error.to_string().contains("/private/secret"));
    }
}

#[test]
fn validates_adapter_fields_table() {
    struct Case {
        name: &'static str,
        variable: &'static str,
        value: &'static str,
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "non-loopback HTTP",
            variable: "NURITEO_S3_ENDPOINT",
            value: "http://storage.example.com",
            expected: "configuration NURITEO_S3_ENDPOINT must use HTTPS except for a loopback development endpoint",
        },
        Case {
            name: "endpoint path",
            variable: "NURITEO_S3_ENDPOINT",
            value: "https://storage.example.com/private/path?token=secret",
            expected: "configuration NURITEO_S3_ENDPOINT must be an origin without credentials, path, query, or fragment",
        },
        Case {
            name: "region characters",
            variable: "NURITEO_S3_REGION",
            value: "bad region",
            expected: "configuration NURITEO_S3_REGION must be a 1-63 character region identifier",
        },
        Case {
            name: "bucket syntax",
            variable: "NURITEO_S3_BUCKET",
            value: "Invalid_Bucket",
            expected: "configuration NURITEO_S3_BUCKET must be a valid DNS-compatible S3 bucket name",
        },
        Case {
            name: "addressing style",
            variable: "NURITEO_S3_ADDRESSING_STYLE",
            value: "auto",
            expected: "configuration NURITEO_S3_ADDRESSING_STYLE must be path or virtual-hosted",
        },
    ];

    for case in cases {
        let mut entries = base("default");
        let target = entries
            .iter_mut()
            .find(|(name, _)| *name == case.variable)
            .unwrap();
        target.1 = case.value;
        let error =
            ObjectStorageConfig::load(&environment(&entries), &TestFiles::default()).unwrap_err();
        assert_eq!(error.to_string(), case.expected, "{}", case.name);
        assert!(!error.to_string().contains(case.value));
    }
}

#[test]
fn validates_additive_ca_bundles_without_exposing_paths_or_pem() {
    let mut entries = base("default");
    entries.extend([
        ("NURITEO_INSTANCE_CA_FILE", "/private/instance-ca.pem"),
        ("NURITEO_S3_CA_FILE", "/private/s3-ca.pem"),
    ]);
    let files = TestFiles(BTreeMap::from([
        (
            "/private/instance-ca.pem".into(),
            TEST_CA.as_bytes().to_vec(),
        ),
        ("/private/s3-ca.pem".into(), TEST_CA.as_bytes().to_vec()),
    ]));

    let config = ObjectStorageConfig::load(&environment(&entries), &files).unwrap();
    let trust = config.tls_trust();
    assert!(trust.uses_system_roots());
    assert_eq!(
        trust.instance_ca().map(CaBundle::certificate_count),
        Some(1)
    );
    assert_eq!(
        trust.integration_ca().map(CaBundle::certificate_count),
        Some(1)
    );
    assert_eq!(
        trust
            .integration_ca()
            .into_iter()
            .flat_map(CaBundle::certificates_der)
            .count(),
        1
    );

    let debug = format!("{config:?}");
    assert!(!debug.contains("/private/"));
    assert!(!debug.contains("BEGIN CERTIFICATE"));
}

#[test]
fn rejects_unsafe_or_unusable_ca_configuration_table() {
    struct Case {
        name: &'static str,
        endpoint: &'static str,
        bytes: Vec<u8>,
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "private key is not a CA bundle",
            endpoint: "https://storage.example.com",
            bytes: b"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".to_vec(),
            expected: "CA bundle referenced by NURITEO_S3_CA_FILE is invalid",
        },
        Case {
            name: "leaf certificate is not a CA",
            endpoint: "https://storage.example.com",
            bytes: TEST_LEAF_CERTIFICATE.as_bytes().to_vec(),
            expected: "CA bundle referenced by NURITEO_S3_CA_FILE is invalid",
        },
        Case {
            name: "bounded CA input",
            endpoint: "https://storage.example.com",
            bytes: vec![b'x'; 1024 * 1024 + 1],
            expected: "CA bundle referenced by NURITEO_S3_CA_FILE exceeds its size limit",
        },
        Case {
            name: "CA on plaintext endpoint",
            endpoint: "http://127.0.0.1:9000",
            bytes: TEST_CA.as_bytes().to_vec(),
            expected: "configuration NURITEO_S3_CA_FILE cannot be used with an HTTP endpoint",
        },
    ];

    for case in cases {
        let mut entries = base("default");
        entries
            .iter_mut()
            .find(|(name, _)| *name == "NURITEO_S3_ENDPOINT")
            .unwrap()
            .1 = case.endpoint;
        entries.push(("NURITEO_S3_CA_FILE", "/private/s3-ca.pem"));
        let files = TestFiles(BTreeMap::from([("/private/s3-ca.pem".into(), case.bytes)]));
        let error = ObjectStorageConfig::load(&environment(&entries), &files).unwrap_err();
        assert_eq!(error.to_string(), case.expected, "{}", case.name);
        assert!(!error.to_string().contains("/private/s3-ca.pem"));
        assert!(!error.to_string().contains("BEGIN PRIVATE KEY"));
    }
}

#[test]
fn signed_urls_are_redacted_from_debug_and_errors() {
    let raw = "https://storage.example.com/private/object?X-Amz-Signature=top-secret";
    let signed = SensitiveUrl::parse(raw).unwrap();
    let debug = format!("{signed:?}");
    assert_eq!(debug, "SensitiveUrl([REDACTED])");
    assert!(!debug.contains("private/object"));
    assert!(!debug.contains("top-secret"));

    let invalid = "not-a-url/private?token=top-secret";
    let error = SensitiveUrl::parse(invalid).unwrap_err();
    assert_eq!(error.to_string(), "signed URL is invalid");
    assert!(!error.to_string().contains(invalid));
}
