use nuriteo_server::config::{SystemEnvironment, SystemFileReader};
use nuriteo_server::smtp::{
    SmtpBootstrapConfig, SmtpFailureCategory, SmtpFailureClass, SmtpSecurity, preflight_bootstrap,
};

#[tokio::test]
#[ignore = "requires tests/fixtures/smtp-preflight/run.sh"]
async fn smtp_preflight_verifies_tls_hostname_custom_ca_and_credentials() {
    let config = SmtpBootstrapConfig::load(&SystemEnvironment, &SystemFileReader)
        .unwrap()
        .expect("fixture configures SMTP");
    assert_eq!(config.snapshot().security, SmtpSecurity::ImplicitTls);
    assert_eq!(config.snapshot().integration_ca_certificates, 1);
    let report = preflight_bootstrap(&config).await.unwrap();
    assert!(report.tls_verified);
    assert!(!report.starttls_verified);
    assert!(report.authenticated);
}

#[tokio::test]
#[ignore = "requires tests/fixtures/smtp-preflight/run.sh"]
async fn smtp_preflight_rejects_hostname_mismatch_without_leaking() {
    let config = SmtpBootstrapConfig::load(&SystemEnvironment, &SystemFileReader)
        .unwrap()
        .expect("fixture configures SMTP");
    let error = preflight_bootstrap(&config).await.unwrap_err();
    assert_eq!(error.class(), SmtpFailureClass::Permanent);
    assert_eq!(error.category(), SmtpFailureCategory::Trust);
    assert!(!format!("{error:?} {error}").contains("fixture-password-sensitive"));
}

#[tokio::test]
#[ignore = "requires tests/fixtures/smtp-preflight/run.sh"]
async fn smtp_preflight_redacts_authentication_rejection_response() {
    let config = SmtpBootstrapConfig::load(&SystemEnvironment, &SystemFileReader)
        .unwrap()
        .expect("fixture configures SMTP");
    let error = preflight_bootstrap(&config).await.unwrap_err();
    assert_eq!(error.class(), SmtpFailureClass::Permanent);
    assert_eq!(error.category(), SmtpFailureCategory::Authentication);
    assert_eq!(error.smtp_code(), Some(535));
    assert!(!format!("{error:?} {error}").contains("fixture-password-sensitive"));
}
