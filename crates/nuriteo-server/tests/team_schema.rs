use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-team-schema/run.sh"]
async fn team_schema_enforces_organization_membership_and_project_role_boundaries() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;

    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Pending {
            current: None,
            target: 36
        }
    );
    let report = migrate(&pool).await;
    assert_eq!(
        report,
        MigrationReport {
            latest_version: Some(40),
            known_migrations: 40
        }
    );
    assert_eq!(migrate(&pool).await, report);
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Ready { version: 33 }
    );

    seed_fixture(&pool).await;
    verify_team_constraints(&pool).await;
    verify_membership_role_matrix(&pool).await;
    verify_project_role_matrix(&pool).await;
    verify_immutable_identity_and_lock_versions(&pool).await;
    verify_membership_dependency(&pool).await;
    verify_fail_closed_lifecycle(&pool).await;
    verify_schema_shape(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("team schema fixture pool must close"));
}

async fn seed_fixture(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO users (id, email, normalized_email, display_name) VALUES
         ('0199ee6c-c777-7000-8000-000000002001', 'owner@example.test', 'owner@example.test', 'Owner'),
         ('0199ee6c-c777-7000-8000-000000002002', 'member@example.test', 'member@example.test', 'Member'),
         ('0199ee6c-c777-7000-8000-000000002003', 'disabled@example.test', 'disabled@example.test', 'Disabled'),
         ('0199ee6c-c777-7000-8000-000000002004', 'dependent@example.test', 'dependent@example.test', 'Dependent')",
        "fixture users",
    )
    .await;
    execute(
        pool,
        "INSERT INTO organizations (id, slug, display_name) VALUES
         ('0199ee6c-c777-7000-8000-000000002101', 'first-org', 'First Organization'),
         ('0199ee6c-c777-7000-8000-000000002102', 'second-org', 'Second Organization'),
         ('0199ee6c-c777-7000-8000-000000002103', 'archived-org', 'Archived Organization')",
        "fixture organizations",
    )
    .await;
    execute(
        pool,
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES
         ('0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002001', 'owner'),
         ('0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002002', 'member'),
         ('0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002003', 'member'),
         ('0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002004', 'member'),
         ('0199ee6c-c777-7000-8000-000000002102', '0199ee6c-c777-7000-8000-000000002001', 'owner'),
         ('0199ee6c-c777-7000-8000-000000002103', '0199ee6c-c777-7000-8000-000000002001', 'owner')",
        "fixture organization memberships",
    )
    .await;
    execute(
        pool,
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = '0199ee6c-c777-7000-8000-000000002003'",
        "disable fixture user",
    )
    .await;
    execute(
        pool,
        "UPDATE organizations SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
         WHERE id = '0199ee6c-c777-7000-8000-000000002103'",
        "archive fixture organization",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id, owner_organization_id) VALUES
         ('0199ee6c-c777-7000-8000-000000002201', '0199ee6c-c777-7000-8000-000000002101'),
         ('0199ee6c-c777-7000-8000-000000002202', '0199ee6c-c777-7000-8000-000000002102')",
        "fixture Organization storage scopes",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id, owner_user_id) VALUES
         ('0199ee6c-c777-7000-8000-000000002002', '0199ee6c-c777-7000-8000-000000002002')",
        "fixture personal storage scope",
    )
    .await;
    execute(
        pool,
        "INSERT INTO projects
         (id, owner_organization_id, storage_scope_id, slug, name) VALUES
         ('0199ee6c-c777-7000-8000-000000002301', '0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002201', 'read-project', 'Read Project'),
         ('0199ee6c-c777-7000-8000-000000002302', '0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002201', 'write-project', 'Write Project'),
         ('0199ee6c-c777-7000-8000-000000002303', '0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002201', 'admin-project', 'Admin Project'),
         ('0199ee6c-c777-7000-8000-000000002304', '0199ee6c-c777-7000-8000-000000002102', '0199ee6c-c777-7000-8000-000000002202', 'other-project', 'Other Project')",
        "fixture Organization Projects",
    )
    .await;
    execute(
        pool,
        "INSERT INTO projects
         (id, owner_user_id, storage_scope_id, slug, name) VALUES
         ('0199ee6c-c777-7000-8000-000000002305', '0199ee6c-c777-7000-8000-000000002002', '0199ee6c-c777-7000-8000-000000002002', 'personal-project', 'Personal Project')",
        "fixture personal Project",
    )
    .await;
}

async fn verify_team_constraints(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO teams (id, organization_id, slug, display_name) VALUES
         ('0199ee6c-c777-7000-8000-000000002401', '0199ee6c-c777-7000-8000-000000002101', 'platform', 'Platform'),
         ('0199ee6c-c777-7000-8000-000000002402', '0199ee6c-c777-7000-8000-000000002102', 'platform', 'Other Platform')",
        "valid Organization-local Team slugs",
    )
    .await;

    let cases = [
        (
            "UUIDv7 identifier",
            "INSERT INTO teams (id, organization_id, slug, display_name) VALUES
             ('0199ee6c-c777-4000-8000-000000002411', '0199ee6c-c777-7000-8000-000000002101', 'bad-id', 'Bad ID')",
        ),
        (
            "canonical slug",
            "INSERT INTO teams (id, organization_id, slug, display_name) VALUES
             ('0199ee6c-c777-7000-8000-000000002412', '0199ee6c-c777-7000-8000-000000002101', 'Uppercase', 'Bad Slug')",
        ),
        (
            "trimmed display name",
            "INSERT INTO teams (id, organization_id, slug, display_name) VALUES
             ('0199ee6c-c777-7000-8000-000000002413', '0199ee6c-c777-7000-8000-000000002101', 'bad-name', ' Bad Name')",
        ),
        (
            "Organization-local slug uniqueness",
            "INSERT INTO teams (id, organization_id, slug, display_name) VALUES
             ('0199ee6c-c777-7000-8000-000000002414', '0199ee6c-c777-7000-8000-000000002101', 'platform', 'Duplicate')",
        ),
        (
            "active Organization target",
            "INSERT INTO teams (id, organization_id, slug, display_name) VALUES
             ('0199ee6c-c777-7000-8000-000000002415', '0199ee6c-c777-7000-8000-000000002103', 'archived', 'Archived')",
        ),
        (
            "positive lock version",
            "INSERT INTO teams (id, organization_id, slug, display_name, lock_version) VALUES
             ('0199ee6c-c777-7000-8000-000000002416', '0199ee6c-c777-7000-8000-000000002101', 'zero-version', 'Zero Version', 0)",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
    }
}

async fn verify_membership_role_matrix(pool: &DatabasePool) {
    for (user_id, role) in [
        ("0199ee6c-c777-7000-8000-000000002001", "maintainer"),
        ("0199ee6c-c777-7000-8000-000000002002", "member"),
        ("0199ee6c-c777-7000-8000-000000002004", "member"),
    ] {
        sqlx::query(
            "INSERT INTO team_memberships (team_id, organization_id, user_id, role)
             VALUES ('0199ee6c-c777-7000-8000-000000002401',
                     '0199ee6c-c777-7000-8000-000000002101', $1::uuid, $2)",
        )
        .bind(user_id)
        .bind(role)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("{role} Team membership must succeed: {error}"));
    }

    let cases = [
        (
            "unknown Team role",
            "INSERT INTO team_memberships (team_id, organization_id, user_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002402', '0199ee6c-c777-7000-8000-000000002102', '0199ee6c-c777-7000-8000-000000002001', 'owner')",
        ),
        (
            "Organization membership dependency",
            "INSERT INTO team_memberships (team_id, organization_id, user_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002402', '0199ee6c-c777-7000-8000-000000002102', '0199ee6c-c777-7000-8000-000000002002', 'member')",
        ),
        (
            "same Organization Team identity",
            "INSERT INTO team_memberships (team_id, organization_id, user_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002401', '0199ee6c-c777-7000-8000-000000002102', '0199ee6c-c777-7000-8000-000000002001', 'member')",
        ),
        (
            "active User target",
            "INSERT INTO team_memberships (team_id, organization_id, user_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002401', '0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002003', 'member')",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
    }
}

async fn verify_project_role_matrix(pool: &DatabasePool) {
    for (project_id, role) in [
        ("0199ee6c-c777-7000-8000-000000002301", "read"),
        ("0199ee6c-c777-7000-8000-000000002302", "write"),
        ("0199ee6c-c777-7000-8000-000000002303", "admin"),
    ] {
        sqlx::query(
            "INSERT INTO team_project_roles (team_id, organization_id, project_id, role)
             VALUES ('0199ee6c-c777-7000-8000-000000002401',
                     '0199ee6c-c777-7000-8000-000000002101', $1::uuid, $2)",
        )
        .bind(project_id)
        .bind(role)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("{role} Project role must succeed: {error}"));
    }

    for (contract, statement) in [
        (
            "unknown Project role",
            "INSERT INTO team_project_roles (team_id, organization_id, project_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002402', '0199ee6c-c777-7000-8000-000000002102', '0199ee6c-c777-7000-8000-000000002304', 'owner')",
        ),
        (
            "same Organization Project",
            "INSERT INTO team_project_roles (team_id, organization_id, project_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002401', '0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002304', 'read')",
        ),
        (
            "Organization-owned Project only",
            "INSERT INTO team_project_roles (team_id, organization_id, project_id, role) VALUES
             ('0199ee6c-c777-7000-8000-000000002401', '0199ee6c-c777-7000-8000-000000002101', '0199ee6c-c777-7000-8000-000000002305', 'read')",
        ),
    ] {
        assert_rejected(pool, statement, contract).await;
    }

    for (user_id, project_id, expected) in [
        (
            "0199ee6c-c777-7000-8000-000000002001",
            "0199ee6c-c777-7000-8000-000000002301",
            Some("read"),
        ),
        (
            "0199ee6c-c777-7000-8000-000000002002",
            "0199ee6c-c777-7000-8000-000000002302",
            Some("write"),
        ),
        (
            "0199ee6c-c777-7000-8000-000000002002",
            "0199ee6c-c777-7000-8000-000000002303",
            Some("admin"),
        ),
        (
            "0199ee6c-c777-7000-8000-000000002003",
            "0199ee6c-c777-7000-8000-000000002303",
            None,
        ),
    ] {
        assert_eq!(
            effective_role(pool, user_id, project_id).await.as_deref(),
            expected
        );
    }
}

async fn verify_immutable_identity_and_lock_versions(pool: &DatabasePool) {
    for (contract, statement) in [
        (
            "immutable Team slug",
            "UPDATE teams SET slug = 'renamed', updated_at = CURRENT_TIMESTAMP,
             lock_version = lock_version + 1
             WHERE id = '0199ee6c-c777-7000-8000-000000002401'",
        ),
        (
            "exact Team lock version",
            "UPDATE teams SET display_name = 'Skipped', updated_at = CURRENT_TIMESTAMP,
             lock_version = lock_version + 2
             WHERE id = '0199ee6c-c777-7000-8000-000000002401'",
        ),
        (
            "immutable Team membership identity",
            "UPDATE team_memberships SET user_id = '0199ee6c-c777-7000-8000-000000002003',
             updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
             WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
               AND user_id = '0199ee6c-c777-7000-8000-000000002002'",
        ),
        (
            "exact Team membership lock version",
            "UPDATE team_memberships SET role = 'maintainer', updated_at = CURRENT_TIMESTAMP
             WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
               AND user_id = '0199ee6c-c777-7000-8000-000000002002'",
        ),
        (
            "immutable Team Project role identity",
            "UPDATE team_project_roles SET project_id = '0199ee6c-c777-7000-8000-000000002304',
             updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
             WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
               AND project_id = '0199ee6c-c777-7000-8000-000000002301'",
        ),
        (
            "exact Team Project role lock version",
            "UPDATE team_project_roles SET role = 'write', updated_at = CURRENT_TIMESTAMP,
             lock_version = lock_version + 2
             WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
               AND project_id = '0199ee6c-c777-7000-8000-000000002301'",
        ),
    ] {
        assert_rejected(pool, statement, contract).await;
    }

    execute(
        pool,
        "UPDATE teams SET display_name = 'Platform Engineering', updated_at = CURRENT_TIMESTAMP,
         lock_version = lock_version + 1
         WHERE id = '0199ee6c-c777-7000-8000-000000002401' AND lock_version = 1",
        "versioned Team update",
    )
    .await;
    execute(
        pool,
        "UPDATE team_memberships SET role = 'maintainer', updated_at = CURRENT_TIMESTAMP,
         lock_version = lock_version + 1
         WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
           AND user_id = '0199ee6c-c777-7000-8000-000000002002' AND lock_version = 1",
        "versioned Team membership update",
    )
    .await;
    execute(
        pool,
        "UPDATE team_project_roles SET role = 'write', updated_at = CURRENT_TIMESTAMP,
         lock_version = lock_version + 1
         WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
           AND project_id = '0199ee6c-c777-7000-8000-000000002301' AND lock_version = 1",
        "versioned Team Project role update",
    )
    .await;
}

async fn verify_membership_dependency(pool: &DatabasePool) {
    execute(
        pool,
        "DELETE FROM organization_memberships
         WHERE organization_id = '0199ee6c-c777-7000-8000-000000002101'
           AND user_id = '0199ee6c-c777-7000-8000-000000002004'",
        "remove dependent Organization membership",
    )
    .await;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM team_memberships
         WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
           AND user_id = '0199ee6c-c777-7000-8000-000000002004'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("dependent Team membership must be inspectable: {error}"));
    assert_eq!(count, 0);
}

async fn verify_fail_closed_lifecycle(pool: &DatabasePool) {
    execute(
        pool,
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = '0199ee6c-c777-7000-8000-000000002002'",
        "disable Team member",
    )
    .await;
    assert_eq!(
        effective_role(
            pool,
            "0199ee6c-c777-7000-8000-000000002002",
            "0199ee6c-c777-7000-8000-000000002303"
        )
        .await,
        None
    );
    assert_eq!(
        relation_count(
            pool,
            "team_memberships",
            "user_id",
            "0199ee6c-c777-7000-8000-000000002002"
        )
        .await,
        1,
        "disabling a User must preserve Team membership audit context"
    );

    execute(
        pool,
        "UPDATE projects SET state = 'archived', archived_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
         WHERE id = '0199ee6c-c777-7000-8000-000000002303'",
        "archive granted Project",
    )
    .await;
    assert_eq!(
        effective_role(
            pool,
            "0199ee6c-c777-7000-8000-000000002001",
            "0199ee6c-c777-7000-8000-000000002303"
        )
        .await,
        Some("admin".to_owned()),
        "Project archive preserves the existing access role"
    );
    assert_eq!(
        relation_count(
            pool,
            "team_project_roles",
            "project_id",
            "0199ee6c-c777-7000-8000-000000002303"
        )
        .await,
        1,
        "archiving a Project must preserve its Team role"
    );
    assert_rejected(
        pool,
        "UPDATE team_project_roles SET role = 'read', updated_at = CURRENT_TIMESTAMP,
         lock_version = lock_version + 1
         WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
           AND project_id = '0199ee6c-c777-7000-8000-000000002303'",
        "Team Project role mutation after Project archive",
    )
    .await;
    execute(
        pool,
        "DELETE FROM team_project_roles
         WHERE team_id = '0199ee6c-c777-7000-8000-000000002401'
           AND project_id = '0199ee6c-c777-7000-8000-000000002303'",
        "revoke Team role from archived Project",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO team_project_roles (team_id, organization_id, project_id, role) VALUES
         ('0199ee6c-c777-7000-8000-000000002401',
          '0199ee6c-c777-7000-8000-000000002101',
          '0199ee6c-c777-7000-8000-000000002303', 'read')",
        "new Team binding to archived Project",
    )
    .await;

    execute(
        pool,
        "UPDATE organizations SET status = 'archived', archived_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1
         WHERE id = '0199ee6c-c777-7000-8000-000000002101'",
        "archive Team Organization",
    )
    .await;
    assert_eq!(
        effective_role(
            pool,
            "0199ee6c-c777-7000-8000-000000002001",
            "0199ee6c-c777-7000-8000-000000002302"
        )
        .await,
        None
    );
}

async fn verify_schema_shape(pool: &DatabasePool) {
    let constraints: Vec<String> = sqlx::query_scalar(
        "SELECT conname FROM pg_constraint
         WHERE conrelid IN ('teams'::regclass, 'team_memberships'::regclass,
                            'team_project_roles'::regclass)
         ORDER BY conname",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("Team constraints must be inspectable: {error}"));
    for required in [
        "teams_organization_slug_unique",
        "team_memberships_organization_membership_fk",
        "team_memberships_role_check",
        "team_project_roles_project_owner_fk",
        "team_project_roles_role_check",
    ] {
        assert!(
            constraints.iter().any(|value| value == required),
            "missing {required}"
        );
    }

    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename IN ('teams', 'team_memberships', 'team_project_roles')
         ORDER BY indexname",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("Team indexes must be inspectable: {error}"));
    for required in [
        "teams_organization_idx",
        "team_memberships_user_idx",
        "team_memberships_maintainer_idx",
        "team_project_roles_project_idx",
    ] {
        assert!(
            indexes.iter().any(|value| value == required),
            "missing {required}"
        );
    }

    let team_owner_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'projects'
           AND column_name IN ('team_id', 'owner_team_id')",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("Project ownership shape must be inspectable: {error}"));
    assert_eq!(
        team_owner_columns, 0,
        "Teams must never become Project owners"
    );
}

async fn effective_role(pool: &DatabasePool, user_id: &str, project_id: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role.role
         FROM team_memberships membership
         JOIN users member ON member.id = membership.user_id AND member.status = 'active'
         JOIN teams team ON team.id = membership.team_id
                        AND team.organization_id = membership.organization_id
         JOIN organizations organization ON organization.id = team.organization_id
                                        AND organization.status = 'active'
         JOIN team_project_roles role ON role.team_id = team.id
                                     AND role.organization_id = team.organization_id
         JOIN projects project ON project.id = role.project_id
                              AND project.owner_organization_id = organization.id
         WHERE membership.user_id = $1::uuid AND project.id = $2::uuid",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_optional(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("effective Team Project role must be queryable: {error}"))
}

async fn relation_count(pool: &DatabasePool, table: &str, column: &str, id: &str) -> i64 {
    let statement = match (table, column) {
        ("team_memberships", "user_id") => {
            "SELECT COUNT(*) FROM team_memberships WHERE user_id = $1::uuid"
        }
        ("team_project_roles", "project_id") => {
            "SELECT COUNT(*) FROM team_project_roles WHERE project_id = $1::uuid"
        }
        _ => panic!("unsupported fixture relation count"),
    };
    sqlx::query_scalar(statement)
        .bind(id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("relation count must be queryable: {error}"))
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca = fs::read(ca_path).unwrap_or_else(|_| panic!("fixture CA must be readable"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|_| panic!("fixture TLS must be valid"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|_| panic!("fixture database config must be valid"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|_| panic!("fixture database must connect"))
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

async fn migrate(pool: &DatabasePool) -> MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|error| panic!("embedded Team migrations must succeed: {error}"))
}

async fn readiness(pool: &DatabasePool) -> SchemaReadiness {
    check_schema_readiness(pool)
        .await
        .unwrap_or_else(|_| panic!("schema readiness must be available"))
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture connection must be available"))
}

async fn execute(pool: &DatabasePool, statement: &'static str, contract: &str) {
    sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|error| panic!("{contract} must succeed: {error}"));
}

async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    assert!(
        sqlx::query(statement)
            .execute(&mut *acquire(pool).await)
            .await
            .is_err(),
        "{contract} must reject invalid direct SQL"
    );
}
