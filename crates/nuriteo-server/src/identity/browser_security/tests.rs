use super::*;

fn production() -> BrowserCookieBoundary {
    BrowserCookieBoundary::new(&Url::parse("https://nuriteo.example.test").unwrap()).unwrap()
}

fn development(url: &str) -> BrowserCookieBoundary {
    BrowserCookieBoundary::new(&Url::parse(url).unwrap()).unwrap()
}

fn lifetime() -> CookieLifetime {
    CookieLifetime::new(timestamp(1_800_000_000), timestamp(1_800_086_400)).unwrap()
}

fn timestamp(seconds: i64) -> Timestamp {
    Timestamp::from_unix_timestamp(seconds).unwrap()
}

fn session_token() -> SessionToken {
    SessionToken::parse(format!("nrt_sess_{}", "A".repeat(43))).unwrap()
}

#[test]
fn production_and_loopback_cookie_contracts_are_deterministic() {
    let session = session_token();
    let production_headers = production().issue(&session, lifetime()).unwrap();
    let production_session = production_headers.session().expose();
    let production_csrf = production_headers.csrf().expose();
    assert!(production_session.starts_with("__Host-nuriteo_session=nrt_sess_"));
    assert!(production_csrf.starts_with("__Host-nuriteo_csrf=nrt_csrf_"));
    for value in [production_session, production_csrf] {
        assert!(value.contains("; Path=/; Max-Age=86400; Expires="));
        assert!(value.contains("; Secure"));
        assert!(value.ends_with("; SameSite=Lax"));
        assert!(!value.contains("Domain="));
    }
    assert!(production_session.contains("; HttpOnly"));
    assert!(!production_csrf.contains("; HttpOnly"));

    for url in [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
    ] {
        let headers = development(url).issue(&session, lifetime()).unwrap();
        assert!(
            headers
                .session()
                .expose()
                .starts_with("nuriteo_dev_session=")
        );
        assert!(headers.csrf().expose().starts_with("nuriteo_dev_csrf="));
        assert!(!headers.session().expose().contains("; Secure"));
        assert!(!headers.csrf().expose().contains("; Secure"));
        assert!(!headers.session().expose().starts_with("__Host-"));
    }
}

#[test]
fn external_url_and_lifetime_policy_fail_closed() {
    let cases = [
        (
            "http://example.test",
            BrowserCookieError::InsecureExternalUrl,
        ),
        ("ftp://localhost", BrowserCookieError::InvalidExternalUrl),
        (
            "https://user@example.test",
            BrowserCookieError::InvalidExternalUrl,
        ),
        (
            "https://example.test/path",
            BrowserCookieError::InvalidExternalUrl,
        ),
        (
            "https://example.test/?query=1",
            BrowserCookieError::InvalidExternalUrl,
        ),
    ];
    for (url, expected) in cases {
        assert_eq!(
            BrowserCookieBoundary::new(&Url::parse(url).unwrap()),
            Err(expected)
        );
    }

    assert_eq!(
        CookieLifetime::new(timestamp(100), timestamp(100)),
        Err(BrowserCookieError::InvalidLifetime)
    );
    assert_eq!(
        CookieLifetime::new(
            timestamp(100),
            timestamp(100 + MAX_COOKIE_LIFETIME_SECONDS + 1)
        ),
        Err(BrowserCookieError::InvalidLifetime)
    );
}

#[test]
fn deletion_preserves_the_same_host_and_path_boundaries() {
    let production = production().deletion().unwrap();
    assert_eq!(
        production.session().expose(),
        "__Host-nuriteo_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax"
    );
    assert_eq!(
        production.csrf().expose(),
        "__Host-nuriteo_csrf=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax"
    );

    let development = development("http://localhost:3000").deletion().unwrap();
    assert!(
        development
            .session()
            .expose()
            .starts_with("nuriteo_dev_session=;")
    );
    assert!(!development.session().expose().contains("; Secure"));
}

#[test]
fn unsafe_methods_require_exact_origin_and_double_submit_csrf() {
    for method in [
        BrowserMethod::Post,
        BrowserMethod::Put,
        BrowserMethod::Patch,
        BrowserMethod::Delete,
    ] {
        let (cookie, csrf) = valid_cookie_header();
        let boundary = production();
        let validated = boundary
            .validate(BrowserRequestHeaders {
                method,
                origins: &["https://nuriteo.example.test"],
                cookie_headers: &[&cookie],
                csrf_headers: &[&csrf],
            })
            .unwrap();
        assert_eq!(
            validated.into_session_token().expose(),
            session_token().expose()
        );
    }
}

#[test]
fn unsafe_request_rejection_matrix_is_fail_closed() {
    let (cookie, csrf) = valid_cookie_header();
    let other_csrf = CsrfToken::generate().unwrap().expose().to_owned();
    let duplicate_session = format!(
        "{cookie}; {}={}",
        PRODUCTION_SESSION_COOKIE,
        session_token().expose()
    );
    let duplicate_csrf = format!("{cookie}; {PRODUCTION_CSRF_COOKIE}={csrf}");
    let malformed_session =
        format!("{PRODUCTION_SESSION_COOKIE}=bad; {PRODUCTION_CSRF_COOKIE}={csrf}");
    let malformed_cookie = format!("{cookie}; broken");
    let oversized = "x".repeat(MAX_COOKIE_HEADER_BYTES + 1);
    let oversized_origin = "x".repeat(MAX_ORIGIN_BYTES + 1);
    let malformed_csrf_cookie = format!(
        "{PRODUCTION_SESSION_COOKIE}={}; {PRODUCTION_CSRF_COOKIE}=bad",
        session_token().expose()
    );
    let duplicate_session_headers = vec![
        format!("{PRODUCTION_SESSION_COOKIE}={}", session_token().expose()),
        format!("{PRODUCTION_SESSION_COOKIE}={}", session_token().expose()),
    ];
    struct Case {
        origins: Vec<String>,
        cookies: Vec<String>,
        csrf_headers: Vec<String>,
        expected: BrowserCookieError,
    }
    let canonical = "https://nuriteo.example.test".to_owned();
    let cases = vec![
        Case {
            origins: vec![],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::MissingOrigin,
        },
        Case {
            origins: vec!["null".to_owned()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::InvalidOrigin,
        },
        Case {
            origins: vec!["https://other.example.test".to_owned()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::InvalidOrigin,
        },
        Case {
            origins: vec!["https://r-runtime-p3000.preview.nuriteo.example.test".to_owned()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::InvalidOrigin,
        },
        Case {
            origins: vec![oversized_origin],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::InvalidOrigin,
        },
        Case {
            origins: vec![canonical.clone(), canonical.clone()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::DuplicateOrigin,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![],
            expected: BrowserCookieError::MissingCsrf,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![csrf.clone(), csrf.clone()],
            expected: BrowserCookieError::DuplicateCsrfHeader,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec![other_csrf],
            expected: BrowserCookieError::CsrfMismatch,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![cookie.clone()],
            csrf_headers: vec!["bad".to_owned()],
            expected: BrowserCookieError::InvalidCsrf,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![duplicate_session],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::DuplicateSessionCookie,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: duplicate_session_headers,
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::DuplicateSessionCookie,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![duplicate_csrf],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::DuplicateCsrfCookie,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![malformed_session],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::InvalidSessionCookie,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![malformed_csrf_cookie],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::InvalidCsrf,
        },
        Case {
            origins: vec![canonical.clone()],
            cookies: vec![malformed_cookie],
            csrf_headers: vec![csrf.clone()],
            expected: BrowserCookieError::MalformedCookie,
        },
        Case {
            origins: vec![canonical],
            cookies: vec![oversized],
            csrf_headers: vec![csrf],
            expected: BrowserCookieError::CookieHeadersTooLarge,
        },
    ];

    for case in cases {
        let origins = case.origins.iter().map(String::as_str).collect::<Vec<_>>();
        let cookies = case.cookies.iter().map(String::as_str).collect::<Vec<_>>();
        let csrf_headers = case
            .csrf_headers
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            production().validate(BrowserRequestHeaders {
                method: BrowserMethod::Post,
                origins: &origins,
                cookie_headers: &cookies,
                csrf_headers: &csrf_headers,
            }),
            Err(case.expected)
        );
    }
}

#[test]
fn safe_methods_skip_csrf_but_never_accept_ambiguous_sessions() {
    for method in [
        BrowserMethod::Get,
        BrowserMethod::Head,
        BrowserMethod::Options,
    ] {
        let boundary = production();
        let session = session_token();
        let cookie = format!(
            "other=value; {PRODUCTION_SESSION_COOKIE}={}",
            session.expose()
        );
        assert!(
            boundary
                .validate(BrowserRequestHeaders {
                    method,
                    origins: &[],
                    cookie_headers: &[&cookie],
                    csrf_headers: &[],
                })
                .is_ok()
        );
        let duplicate = format!("{cookie}; {PRODUCTION_SESSION_COOKIE}={}", session.expose());
        assert_eq!(
            boundary.validate(BrowserRequestHeaders {
                method,
                origins: &[],
                cookie_headers: &[&duplicate],
                csrf_headers: &[],
            }),
            Err(BrowserCookieError::DuplicateSessionCookie)
        );
    }
}

#[test]
fn cookie_count_name_value_and_multi_header_bounds_are_enforced() {
    let too_many = (0..=MAX_COOKIE_COUNT)
        .map(|index| format!("c{index}=x"))
        .collect::<Vec<_>>()
        .join("; ");
    let long_name = format!("{}=x", "n".repeat(MAX_COOKIE_NAME_BYTES + 1));
    let long_value = format!("other={}", "v".repeat(MAX_COOKIE_VALUE_BYTES + 1));
    for (headers, expected) in [
        (vec![too_many.as_str()], BrowserCookieError::TooManyCookies),
        (
            vec![long_name.as_str()],
            BrowserCookieError::MalformedCookie,
        ),
        (
            vec![long_value.as_str()],
            BrowserCookieError::MalformedCookie,
        ),
        (
            vec!["a=x", "b=\"quoted\""],
            BrowserCookieError::MalformedCookie,
        ),
    ] {
        assert_eq!(
            production().validate(BrowserRequestHeaders {
                method: BrowserMethod::Get,
                origins: &[],
                cookie_headers: &headers,
                csrf_headers: &[],
            }),
            Err(expected)
        );
    }
}

#[test]
fn secret_bearing_types_and_errors_are_redacted() {
    let session = session_token();
    let issued = production().issue(&session, lifetime()).unwrap();
    let csrf = CsrfToken::generate().unwrap();
    assert_eq!(format!("{csrf:?}"), "CsrfToken([REDACTED])");
    assert_eq!(csrf.to_string(), "[REDACTED]");
    assert_eq!(
        format!("{:?}", issued.session()),
        "SetCookieHeader([REDACTED])"
    );
    assert_eq!(issued.session().to_string(), "[REDACTED]");
    assert_eq!(
        format!("{issued:?}"),
        "IssuedBrowserCookies { session: \"[REDACTED]\", csrf: \"[REDACTED]\" }"
    );
    for error in [
        BrowserCookieError::InvalidCsrf,
        BrowserCookieError::CsrfMismatch,
    ] {
        assert!(!format!("{error:?}: {error}").contains(csrf.expose()));
    }
}

fn valid_cookie_header() -> (String, String) {
    let session = session_token();
    let csrf = CsrfToken::generate().unwrap();
    (
        format!(
            "other=value; {PRODUCTION_SESSION_COOKIE}={}; {PRODUCTION_CSRF_COOKIE}={}",
            session.expose(),
            csrf.expose()
        ),
        csrf.expose().to_owned(),
    )
}
