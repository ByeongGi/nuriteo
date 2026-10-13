use sqlx::{Postgres, Transaction};

// All mutations that can change the active/local/MFA-enrolled population share
// this transaction-scoped lock. Besides preserving the last-administrator
// invariant, it makes policy population proof rechecks and reconciliation one
// serializable application-level operation.
const MFA_POPULATION_LOCK_NAMESPACE: i32 = 1_314_212_948;

pub(crate) async fn acquire_mfa_population_lock(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, 0)")
        .bind(MFA_POPULATION_LOCK_NAMESPACE)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

/// Revalidates the enforced-policy safety invariant from the transaction's
/// current state. Call after the candidate mutation and immediately before
/// audit/commit so concurrent lifecycle and MFA changes cannot invalidate it.
pub(crate) async fn has_required_active_local_enrolled_admin(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT CASE WHEN policy.value #>> '{}' = 'off' THEN TRUE ELSE EXISTS( \
           SELECT 1 FROM users account \
           JOIN local_password_credentials local ON local.user_id=account.id \
           JOIN mfa_totp_credentials mfa ON mfa.user_id=account.id AND mfa.state='active' \
           WHERE account.status='active' AND account.is_instance_admin \
         ) END \
         FROM instance_settings policy WHERE policy.key='security.mfa_enforcement'",
    )
    .fetch_one(&mut **transaction)
    .await
}
