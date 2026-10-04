use std::env;
use std::fs;
use std::sync::Arc;
use std::time::Duration;

use nuriteo_server::audit::AuditEventId;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{NormalizedEmail, SessionId, UserId};
use nuriteo_server::organization::{
    IssuedOrganizationInvitation, OrganizationId, OrganizationInvitationActor,
    OrganizationInvitationAuditContext, OrganizationInvitationInvitee,
    OrganizationInvitationPolicy, OrganizationInvitationRevokeResult,
    OrganizationInvitationService, OrganizationInvitationServiceError,
    OrganizationInvitationStatus, OrganizationInvitationToken, OrganizationRole,
};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Executor};
use tokio::sync::Barrier;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const OWNER: &str = "0199ee6c-c777-7000-8000-000000000901";
const INVITEE: &str = "0199ee6c-c777-7000-8000-000000000902";
const OTHER: &str = "0199ee6c-c777-7000-8000-000000000903";
const MEMBER: &str = "0199ee6c-c777-7000-8000-000000000904";
const OWNER_RECENT_SESSION: &str = "0199ee6c-c777-7000-8000-000000000911";
const OWNER_STALE_SESSION: &str = "0199ee6c-c777-7000-8000-000000000912";
const INVITEE_SESSION: &str = "0199ee6c-c777-7000-8000-000000000913";
const OTHER_SESSION: &str = "0199ee6c-c777-7000-8000-000000000914";
const MEMBER_SESSION: &str = "0199ee6c-c777-7000-8000-000000000915";
const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000000921";
const SECOND_ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000000922";
const CAPACITY_ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000000923";
const CROSS_CAPACITY_ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000000924";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-organization-invitation/run.sh"]
async fn organization_invitations_are_role_bound_atomic_and_single_use() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = migrate(&pool).await;
    let expected_latest = i64::try_from(report.known_migrations)
        .unwrap_or_else(|_| panic!("embedded migration count must fit in i64"));
    assert!(expected_latest > 0);
    assert_eq!(report.latest_version, Some(expected_latest));
    insert_fixture(&pool).await;
    verify_schema_rejects_invalid_rows(&pool).await;

    let service =
        OrganizationInvitationService::new(pool.clone(), OrganizationInvitationPolicy::default());
    verify_concurrent_accept_member_limit(&pool, &service).await;
    verify_cross_path_member_limit(&pool, &service).await;
    let organization_id = organization_id(ORGANIZATION);
    let owner_recent = actor(OWNER, OWNER_RECENT_SESSION);
    let owner_stale = actor(OWNER, OWNER_STALE_SESSION);
    let first_audit = audit(OWNER);

    let member_issue = service
        .issue(
            organization_id,
            owner_stale,
            email("invitee@example.test"),
            OrganizationRole::Member,
            &first_audit,
        )
        .await
        .unwrap_or_else(|error| panic!("member issue must not require recent reauth: {error}"));
    assert_eq!(
        member_issue.invitation().status(),
        OrganizationInvitationStatus::Pending
    );
    assert_eq!(
        stored_digest_count(&pool, member_issue.token().expose()).await,
        1
    );
    assert_eq!(
        stored_raw_token_count(&pool, member_issue.token().expose()).await,
        0
    );
    assert_eq!(
        service
            .issue(
                organization_id,
                actor(MEMBER, MEMBER_SESSION),
                email("other@example.test"),
                OrganizationRole::Member,
                &audit(MEMBER),
            )
            .await
            .map(|_| ()),
        Err(OrganizationInvitationServiceError::InviteeUnavailable)
    );
    assert_eq!(
        service
            .issue(
                organization_id,
                owner_recent,
                email("invitee@example.test"),
                OrganizationRole::Member,
                &audit(OWNER),
            )
            .await
            .map(|_| ()),
        Err(OrganizationInvitationServiceError::AlreadyPending)
    );
    assert_eq!(
        service
            .reissue(
                member_issue.invitation().id(),
                owner_stale,
                OrganizationRole::Owner,
                &audit(OWNER),
            )
            .await
            .map(|_| ()),
        Err(OrganizationInvitationServiceError::ReauthenticationRequired)
    );

    let original_token = member_issue.token().expose().to_owned();
    let owner_issue = service
        .reissue(
            member_issue.invitation().id(),
            owner_recent,
            OrganizationRole::Owner,
            &audit(OWNER),
        )
        .await
        .unwrap_or_else(|error| panic!("owner reissue with recent reauth must succeed: {error}"));
    assert_eq!(
        owner_issue.invitation().proposed_role(),
        OrganizationRole::Owner
    );
    assert_eq!(
        service
            .accept(
                &OrganizationInvitationToken::parse(original_token)
                    .unwrap_or_else(|error| panic!("original token must parse: {error}")),
                &invitee(INVITEE, INVITEE_SESSION, "invitee@example.test"),
                &audit(INVITEE),
            )
            .await,
        Err(OrganizationInvitationServiceError::InvalidInvitation)
    );

    let accepted_token = owner_issue.token().expose().to_owned();
    assert_eq!(
        service
            .accept(
                owner_issue.token(),
                &invitee(INVITEE, INVITEE_SESSION, "other@example.test"),
                &audit(INVITEE),
            )
            .await,
        Err(OrganizationInvitationServiceError::InvalidInvitation)
    );
    let accepted = service
        .accept(
            owner_issue.token(),
            &invitee(INVITEE, INVITEE_SESSION, "invitee@example.test"),
            &audit(INVITEE),
        )
        .await
        .unwrap_or_else(|error| panic!("matching invitee must accept: {error}"));
    assert_eq!(accepted.status(), OrganizationInvitationStatus::Accepted);
    assert_eq!(
        role(&pool, ORGANIZATION, INVITEE).await.as_deref(),
        Some("owner")
    );
    assert_eq!(
        service
            .accept(
                &OrganizationInvitationToken::parse(accepted_token)
                    .unwrap_or_else(|error| panic!("accepted token must parse: {error}")),
                &invitee(INVITEE, INVITEE_SESSION, "invitee@example.test"),
                &audit(INVITEE),
            )
            .await,
        Err(OrganizationInvitationServiceError::InvalidInvitation)
    );
    assert_eq!(
        service
            .issue(
                organization_id,
                owner_recent,
                email("invitee@example.test"),
                OrganizationRole::Member,
                &audit(OWNER),
            )
            .await
            .map(|_| ()),
        Err(OrganizationInvitationServiceError::AlreadyMember)
    );

    verify_audit_rollbacks(&pool, &service, owner_recent, &first_audit).await;
    verify_decline(&service, owner_recent).await;
    verify_expiry(&pool, &service).await;
    verify_terminal_race(&pool, &service, owner_recent).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("organization invitation fixture pool must close"));
}

async fn verify_audit_rollbacks(
    pool: &DatabasePool,
    service: &OrganizationInvitationService,
    owner: OrganizationInvitationActor,
    reused_audit: &OrganizationInvitationAuditContext,
) {
    assert_eq!(
        service
            .issue(
                organization_id(SECOND_ORGANIZATION),
                owner,
                email("other@example.test"),
                OrganizationRole::Member,
                reused_audit,
            )
            .await
            .map(|_| ()),
        Err(OrganizationInvitationServiceError::AuditUnavailable)
    );
    assert_eq!(pending_count(pool, SECOND_ORGANIZATION, OTHER).await, 0);

    let issued = issue_member(
        service,
        organization_id(SECOND_ORGANIZATION),
        owner,
        "other@example.test",
    )
    .await;
    let duplicate_accept_audit = audit(OTHER);
    let declined = service
        .decline(
            issued.token(),
            &invitee(OTHER, OTHER_SESSION, "other@example.test"),
            &duplicate_accept_audit,
        )
        .await
        .unwrap_or_else(|error| panic!("setup decline must succeed: {error}"));
    assert_eq!(declined.status(), OrganizationInvitationStatus::Declined);
    let second = issue_member(
        service,
        organization_id(SECOND_ORGANIZATION),
        owner,
        "other@example.test",
    )
    .await;
    assert_eq!(
        service
            .accept(
                second.token(),
                &invitee(OTHER, OTHER_SESSION, "other@example.test"),
                &duplicate_accept_audit,
            )
            .await,
        Err(OrganizationInvitationServiceError::AuditUnavailable)
    );
    assert_eq!(role(pool, SECOND_ORGANIZATION, OTHER).await, None);
    assert_eq!(
        status(pool, &second.invitation().id().to_string()).await,
        "pending"
    );
    assert_eq!(
        service
            .revoke(second.invitation().id(), owner, &audit(OWNER))
            .await,
        Ok(OrganizationInvitationRevokeResult::Revoked)
    );
}

async fn verify_decline(
    service: &OrganizationInvitationService,
    owner: OrganizationInvitationActor,
) {
    let issued = issue_member(
        service,
        organization_id(SECOND_ORGANIZATION),
        owner,
        "other@example.test",
    )
    .await;
    let declined = service
        .decline(
            issued.token(),
            &invitee(OTHER, OTHER_SESSION, "other@example.test"),
            &audit(OTHER),
        )
        .await
        .unwrap_or_else(|error| panic!("decline must succeed: {error}"));
    assert_eq!(declined.status(), OrganizationInvitationStatus::Declined);
}

async fn verify_expiry(pool: &DatabasePool, service: &OrganizationInvitationService) {
    let token = OrganizationInvitationToken::generate()
        .unwrap_or_else(|error| panic!("expiry token generation: {error}"));
    let digest: [u8; 32] = Sha256::digest(token.expose().as_bytes()).into();
    let invitation_id = "0199ee6c-c777-7000-8000-000000000931";
    sqlx::query(
        "INSERT INTO organization_invitations \
         (id, organization_id, invitee_user_id, normalized_email, invited_by_user_id, \
          proposed_role, token_hash, created_at, expires_at) \
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'other@example.test', $4::uuid, \
                 'member', $5, transaction_timestamp() - INTERVAL '2 hours', \
                 transaction_timestamp() - INTERVAL '1 hour')",
    )
    .bind(invitation_id)
    .bind(ORGANIZATION)
    .bind(OTHER)
    .bind(OWNER)
    .bind(digest.as_slice())
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("expired fixture invitation must insert: {error}"));
    assert_eq!(
        service
            .accept(
                &token,
                &invitee(OTHER, OTHER_SESSION, "other@example.test"),
                &audit(OTHER),
            )
            .await,
        Err(OrganizationInvitationServiceError::InvalidInvitation)
    );
    assert_eq!(status(pool, invitation_id).await, "expired");
}

async fn verify_terminal_race(
    pool: &DatabasePool,
    service: &OrganizationInvitationService,
    owner: OrganizationInvitationActor,
) {
    let issued = issue_member(
        service,
        organization_id(ORGANIZATION),
        owner,
        "other@example.test",
    )
    .await;
    let invitation_id = issued.invitation().id();
    let wire = issued.token().expose().to_owned();

    let accept_service = service.clone();
    let accept_token = parse_token(&wire);
    let accept = tokio::spawn(async move {
        accept_service
            .accept(
                &accept_token,
                &invitee(OTHER, OTHER_SESSION, "other@example.test"),
                &audit(OTHER),
            )
            .await
            .map(|_| "accepted")
    });
    let decline_service = service.clone();
    let decline_token = parse_token(&wire);
    let decline = tokio::spawn(async move {
        decline_service
            .decline(
                &decline_token,
                &invitee(OTHER, OTHER_SESSION, "other@example.test"),
                &audit(OTHER),
            )
            .await
            .map(|_| "declined")
    });
    let revoke_service = service.clone();
    let revoke = tokio::spawn(async move {
        revoke_service
            .revoke(invitation_id, owner, &audit(OWNER))
            .await
            .and_then(|result| match result {
                OrganizationInvitationRevokeResult::Revoked => Ok("revoked"),
                OrganizationInvitationRevokeResult::AlreadyInactive => {
                    Err(OrganizationInvitationServiceError::InvitationNotPending)
                }
            })
    });
    let reissue_service = service.clone();
    let reissue = tokio::spawn(async move {
        reissue_service
            .reissue(
                invitation_id,
                owner,
                OrganizationRole::Member,
                &audit(OWNER),
            )
            .await
            .map(|_| "superseded")
    });

    let results = [
        accept
            .await
            .unwrap_or_else(|_| panic!("accept race must join")),
        decline
            .await
            .unwrap_or_else(|_| panic!("decline race must join")),
        revoke
            .await
            .unwrap_or_else(|_| panic!("revoke race must join")),
        reissue
            .await
            .unwrap_or_else(|_| panic!("reissue race must join")),
    ];
    assert_eq!(results.into_iter().filter(Result::is_ok).count(), 1);
    assert_eq!(terminal_count(pool, &invitation_id.to_string()).await, 1);
    assert!(membership_count(pool, ORGANIZATION, OTHER).await <= 1);
}

async fn verify_concurrent_accept_member_limit(
    pool: &DatabasePool,
    service: &OrganizationInvitationService,
) {
    sqlx::query(
        "WITH inserted_users AS (\
           INSERT INTO users (id, email, normalized_email, display_name) \
           SELECT ('0199ee6c-c777-7000-8003-' || lpad(sequence::text, 12, '0'))::uuid, \
                  'invitation-capacity-' || sequence || '@example.test', \
                  'invitation-capacity-' || sequence || '@example.test', \
                  'Invitation Capacity Member ' || sequence \
           FROM generate_series(1, 98) AS generated(sequence) \
           RETURNING id \
         ) \
         INSERT INTO organization_memberships (organization_id, user_id, role) \
         SELECT $1::uuid, id, 'member' FROM inserted_users",
    )
    .bind(CAPACITY_ORGANIZATION)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("capacity memberships must insert: {error}"));
    assert_eq!(member_count(pool, CAPACITY_ORGANIZATION).await, 99);

    let first = issue_member(
        service,
        organization_id(CAPACITY_ORGANIZATION),
        actor(OWNER, OWNER_RECENT_SESSION),
        "invitee@example.test",
    )
    .await;
    let second = issue_member(
        service,
        organization_id(CAPACITY_ORGANIZATION),
        actor(OWNER, OWNER_RECENT_SESSION),
        "other@example.test",
    )
    .await;
    let first_id = first.invitation().id().to_string();
    let second_id = second.invitation().id().to_string();

    let mut blocker_connection = acquire(pool).await;
    let mut blocker = blocker_connection
        .begin()
        .await
        .unwrap_or_else(|error| panic!("capacity blocker must begin: {error}"));
    sqlx::query("SELECT pg_advisory_xact_lock(1314212943, hashtext($1))")
        .bind(CAPACITY_ORGANIZATION)
        .execute(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("capacity blocker must lock organization: {error}"));

    let barrier = Arc::new(Barrier::new(3));
    let first_barrier = barrier.clone();
    let first_service = service.clone();
    let first_accept = tokio::spawn(async move {
        first_barrier.wait().await;
        first_service
            .accept(
                first.token(),
                &invitee(INVITEE, INVITEE_SESSION, "invitee@example.test"),
                &audit(INVITEE),
            )
            .await
    });
    let second_barrier = barrier.clone();
    let second_service = service.clone();
    let second_accept = tokio::spawn(async move {
        second_barrier.wait().await;
        second_service
            .accept(
                second.token(),
                &invitee(OTHER, OTHER_SESSION, "other@example.test"),
                &audit(OTHER),
            )
            .await
    });
    barrier.wait().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !first_accept.is_finished(),
        "first accept must wait on the held organization admission lock"
    );
    assert!(
        !second_accept.is_finished(),
        "second accept must wait on the held organization admission lock"
    );
    blocker
        .commit()
        .await
        .unwrap_or_else(|error| panic!("capacity blocker must commit: {error}"));
    let results = [
        first_accept
            .await
            .unwrap_or_else(|_| panic!("first capacity acceptance must join")),
        second_accept
            .await
            .unwrap_or_else(|_| panic!("second capacity acceptance must join")),
    ];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                matches!(
                    result,
                    Err(OrganizationInvitationServiceError::MemberLimitReached)
                )
            })
            .count(),
        1
    );
    assert_eq!(member_count(pool, CAPACITY_ORGANIZATION).await, 100);
    let statuses = [
        status(pool, &first_id).await,
        status(pool, &second_id).await,
    ];
    assert_eq!(
        statuses.iter().filter(|value| *value == "accepted").count(),
        1
    );
    assert_eq!(
        statuses.iter().filter(|value| *value == "pending").count(),
        1
    );
}

async fn verify_cross_path_member_limit(
    pool: &DatabasePool,
    invitation_service: &OrganizationInvitationService,
) {
    sqlx::query(
        "WITH inserted_users AS (\
           INSERT INTO users (id, email, normalized_email, display_name) \
           SELECT ('0199ee6c-c777-7000-8005-' || lpad(sequence::text, 12, '0'))::uuid, \
                  'cross-capacity-' || sequence || '@example.test', \
                  'cross-capacity-' || sequence || '@example.test', \
                  'Cross Capacity Member ' || sequence \
           FROM generate_series(1, 98) AS generated(sequence) \
           RETURNING id \
         ) \
         INSERT INTO organization_memberships (organization_id, user_id, role) \
         SELECT $1::uuid, id, 'member' FROM inserted_users",
    )
    .bind(CROSS_CAPACITY_ORGANIZATION)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("cross-path capacity memberships must insert: {error}"));
    assert_eq!(member_count(pool, CROSS_CAPACITY_ORGANIZATION).await, 99);

    let issued = issue_member(
        invitation_service,
        organization_id(CROSS_CAPACITY_ORGANIZATION),
        actor(OWNER, OWNER_RECENT_SESSION),
        "invitee@example.test",
    )
    .await;
    let invitation_id = issued.invitation().id().to_string();
    let mut blocker_connection = acquire(pool).await;
    let mut blocker = blocker_connection
        .begin()
        .await
        .unwrap_or_else(|error| panic!("cross-path blocker must begin: {error}"));
    sqlx::query("SELECT pg_advisory_xact_lock(1314212943, hashtext($1))")
        .bind(CROSS_CAPACITY_ORGANIZATION)
        .execute(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("cross-path blocker must lock organization: {error}"));

    let barrier = Arc::new(Barrier::new(2));
    let raw_pool = pool.clone();
    let raw_barrier = barrier.clone();
    let raw_insert = tokio::spawn(async move {
        raw_barrier.wait().await;
        sqlx::query(
            "INSERT INTO organization_memberships (organization_id, user_id, role) \
             VALUES ($1::uuid, $2::uuid, 'member')",
        )
        .bind(CROSS_CAPACITY_ORGANIZATION)
        .bind(MEMBER)
        .execute(&mut *acquire(&raw_pool).await)
        .await
    });
    barrier.wait().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !raw_insert.is_finished(),
        "raw insert must wait on the held organization admission lock"
    );
    let accept_service = invitation_service.clone();
    let accept = tokio::spawn(async move {
        accept_service
            .accept(
                issued.token(),
                &invitee(INVITEE, INVITEE_SESSION, "invitee@example.test"),
                &audit(INVITEE),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !accept.is_finished(),
        "accept must queue behind the raw insert on the admission lock"
    );
    blocker
        .commit()
        .await
        .unwrap_or_else(|error| panic!("cross-path blocker must commit: {error}"));

    let accept = accept
        .await
        .unwrap_or_else(|_| panic!("cross-path accept must join"));
    let raw_insert = raw_insert
        .await
        .unwrap_or_else(|_| panic!("cross-path raw insert must join"));
    raw_insert.unwrap_or_else(|error| panic!("raw insert must win the queued race: {error}"));
    assert_eq!(
        accept,
        Err(OrganizationInvitationServiceError::MemberLimitReached),
        "the losing service admission must retain its typed conflict"
    );
    assert_eq!(member_count(pool, CROSS_CAPACITY_ORGANIZATION).await, 100);
    assert_eq!(
        status(pool, &invitation_id).await,
        if accept.is_ok() {
            "accepted"
        } else {
            "pending"
        }
    );
}

async fn issue_member(
    service: &OrganizationInvitationService,
    organization_id: OrganizationId,
    owner: OrganizationInvitationActor,
    invitee_email: &str,
) -> IssuedOrganizationInvitation {
    service
        .issue(
            organization_id,
            owner,
            email(invitee_email),
            OrganizationRole::Member,
            &audit(OWNER),
        )
        .await
        .unwrap_or_else(|error| panic!("member invitation must issue: {error}"))
}

async fn verify_schema_rejects_invalid_rows(pool: &DatabasePool) {
    for statement in [
        "INSERT INTO organization_invitations \
         (id, organization_id, invitee_user_id, normalized_email, invited_by_user_id, \
          proposed_role, token_hash, expires_at) VALUES \
         ('0199ee6c-c777-7000-8000-000000000941', \
          '0199ee6c-c777-7000-8000-000000000921', \
          '0199ee6c-c777-7000-8000-000000000903', 'other@example.test', \
          '0199ee6c-c777-7000-8000-000000000901', 'admin', repeat(E'\\001', 32)::bytea, \
          transaction_timestamp() + INTERVAL '7 days')",
        "INSERT INTO organization_invitations \
         (id, organization_id, invitee_user_id, normalized_email, invited_by_user_id, \
          proposed_role, token_hash, expires_at) VALUES \
         ('0199ee6c-c777-7000-8000-000000000942', \
          '0199ee6c-c777-7000-8000-000000000921', \
          '0199ee6c-c777-7000-8000-000000000903', 'other@example.test', \
          '0199ee6c-c777-7000-8000-000000000901', 'member', repeat(E'\\002', 32)::bytea, \
          transaction_timestamp() + INTERVAL '31 days')",
    ] {
        assert!(
            sqlx::query(statement)
                .execute(&mut *acquire(pool).await)
                .await
                .is_err()
        );
    }
}

fn actor(user: &str, session: &str) -> OrganizationInvitationActor {
    OrganizationInvitationActor::new(user_id(user), session_id(session))
}

fn invitee(user: &str, session: &str, email: &str) -> OrganizationInvitationInvitee {
    OrganizationInvitationInvitee::new(
        user_id(user),
        session_id(session),
        NormalizedEmail::from_email(email)
            .unwrap_or_else(|error| panic!("fixture email must normalize: {error}")),
    )
}

fn email(value: &str) -> NormalizedEmail {
    NormalizedEmail::from_email(value)
        .unwrap_or_else(|error| panic!("fixture email must normalize: {error}"))
}

fn audit(actor: &str) -> OrganizationInvitationAuditContext {
    let event_id = AuditEventId::new();
    OrganizationInvitationAuditContext::new(
        event_id,
        user_id(actor),
        None,
        format!("org-invitation-test:{event_id}"),
        None,
    )
}

fn parse_token(value: &str) -> OrganizationInvitationToken {
    OrganizationInvitationToken::parse(value.to_owned())
        .unwrap_or_else(|error| panic!("fixture token must parse: {error}"))
}

fn user_id(value: &str) -> UserId {
    value
        .parse()
        .unwrap_or_else(|error| panic!("fixture user id: {error}"))
}

fn session_id(value: &str) -> SessionId {
    value
        .parse()
        .unwrap_or_else(|error| panic!("fixture session id: {error}"))
}

fn organization_id(value: &str) -> OrganizationId {
    value
        .parse()
        .unwrap_or_else(|error| panic!("fixture organization id: {error}"))
}

async fn insert_fixture(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users (id, email, normalized_email, display_name) VALUES \
         ($1::uuid, 'owner@example.test', 'owner@example.test', 'Owner'), \
         ($2::uuid, 'invitee@example.test', 'invitee@example.test', 'Invitee'), \
         ($3::uuid, 'other@example.test', 'other@example.test', 'Other'), \
         ($4::uuid, 'member@example.test', 'member@example.test', 'Member')",
    )
    .bind(OWNER)
    .bind(INVITEE)
    .bind(OTHER)
    .bind(MEMBER)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("fixture users must insert: {error}"));
    sqlx::query(
        "INSERT INTO organizations (id, slug, display_name) VALUES \
         ($1::uuid, 'primary-org', 'Primary Organization'), \
         ($2::uuid, 'second-org', 'Second Organization'), \
         ($3::uuid, 'capacity-org', 'Capacity Organization'), \
         ($4::uuid, 'cross-capacity-org', 'Cross Capacity Organization')",
    )
    .bind(ORGANIZATION)
    .bind(SECOND_ORGANIZATION)
    .bind(CAPACITY_ORGANIZATION)
    .bind(CROSS_CAPACITY_ORGANIZATION)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("fixture organizations must insert: {error}"));
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
         ($1::uuid, $3::uuid, 'owner'), ($2::uuid, $3::uuid, 'owner'), \
         ($1::uuid, $4::uuid, 'member'), ($5::uuid, $3::uuid, 'owner'), \
         ($6::uuid, $3::uuid, 'owner')",
    )
    .bind(ORGANIZATION)
    .bind(SECOND_ORGANIZATION)
    .bind(OWNER)
    .bind(MEMBER)
    .bind(CAPACITY_ORGANIZATION)
    .bind(CROSS_CAPACITY_ORGANIZATION)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("fixture memberships must insert: {error}"));
    sqlx::query(
        "INSERT INTO sessions \
         (id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, \
          absolute_expires_at, last_reauthenticated_at) VALUES \
         ($1::uuid, $5::uuid, repeat(E'\\011', 32)::bytea, transaction_timestamp() - INTERVAL '1 hour', \
          transaction_timestamp(), transaction_timestamp() + INTERVAL '1 hour', \
          transaction_timestamp() + INTERVAL '2 hours', transaction_timestamp()), \
         ($2::uuid, $5::uuid, repeat(E'\\012', 32)::bytea, transaction_timestamp() - INTERVAL '1 hour', \
          transaction_timestamp(), transaction_timestamp() + INTERVAL '1 hour', \
          transaction_timestamp() + INTERVAL '2 hours', transaction_timestamp() - INTERVAL '30 minutes'), \
         ($3::uuid, $6::uuid, repeat(E'\\013', 32)::bytea, transaction_timestamp() - INTERVAL '1 hour', \
          transaction_timestamp(), transaction_timestamp() + INTERVAL '1 hour', \
          transaction_timestamp() + INTERVAL '2 hours', NULL), \
         ($4::uuid, $7::uuid, repeat(E'\\014', 32)::bytea, transaction_timestamp() - INTERVAL '1 hour', \
          transaction_timestamp(), transaction_timestamp() + INTERVAL '1 hour', \
          transaction_timestamp() + INTERVAL '2 hours', NULL), \
         ($8::uuid, $9::uuid, repeat(E'\\015', 32)::bytea, transaction_timestamp() - INTERVAL '1 hour', \
          transaction_timestamp(), transaction_timestamp() + INTERVAL '1 hour', \
          transaction_timestamp() + INTERVAL '2 hours', NULL)",
    )
    .bind(OWNER_RECENT_SESSION)
    .bind(OWNER_STALE_SESSION)
    .bind(INVITEE_SESSION)
    .bind(OTHER_SESSION)
    .bind(OWNER)
    .bind(INVITEE)
    .bind(OTHER)
    .bind(MEMBER_SESSION)
    .bind(MEMBER)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("fixture sessions must insert: {error}"));
}

async fn stored_digest_count(pool: &DatabasePool, token: &str) -> i64 {
    let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    sqlx::query_scalar("SELECT COUNT(*) FROM organization_invitations WHERE token_hash = $1")
        .bind(digest.as_slice())
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("digest count must read"))
}

async fn stored_raw_token_count(pool: &DatabasePool, token: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations WHERE row_to_json(organization_invitations)::text LIKE '%' || $1 || '%'",
    )
    .bind(token)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("raw token count must read"))
}

async fn pending_count(pool: &DatabasePool, organization: &str, user: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations \
         WHERE organization_id = $1::uuid AND invitee_user_id = $2::uuid AND status = 'pending'",
    )
    .bind(organization)
    .bind(user)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("pending count must read"))
}

async fn status(pool: &DatabasePool, invitation: &str) -> String {
    sqlx::query_scalar("SELECT status FROM organization_invitations WHERE id = $1::uuid")
        .bind(invitation)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("invitation status must read"))
}

async fn terminal_count(pool: &DatabasePool, invitation: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations \
         WHERE id = $1::uuid AND status IN ('accepted', 'declined', 'expired', 'revoked', 'superseded')",
    )
    .bind(invitation)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("terminal count must read"))
}

async fn role(pool: &DatabasePool, organization: &str, user: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid",
    )
    .bind(organization)
    .bind(user)
    .fetch_optional(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("membership role must read"))
}

async fn membership_count(pool: &DatabasePool, organization: &str, user: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid",
    )
    .bind(organization)
    .bind(user)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("membership count must read"))
}

async fn member_count(pool: &DatabasePool, organization: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1::uuid",
    )
    .bind(organization)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("member count must read"))
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by fixture"));
    let ca = fs::read(ca_path).unwrap_or_else(|_| panic!("fixture CA must be readable"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|_| panic!("fixture TLS must be valid"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        16,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|_| panic!("fixture database config must be valid"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|_| panic!("fixture database must connect"))
}

async fn migrate(pool: &DatabasePool) -> nuriteo_server::database::MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|_| panic!("fixture migrations must succeed"))
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap_or_else(|_| panic!("fixture schema must drop"));
    connection
        .execute("CREATE SCHEMA public")
        .await
        .unwrap_or_else(|_| panic!("fixture schema must recreate"));
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture connection must be available"))
}
