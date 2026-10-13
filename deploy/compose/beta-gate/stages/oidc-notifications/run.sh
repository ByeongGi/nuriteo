#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$here/../../../../.." && pwd)"
readonly runtime="${NURITEO_BETA_GATE_ENGINE:?set NURITEO_BETA_GATE_ENGINE}"
readonly postgres_container="${NURITEO_BETA_GATE_POSTGRES_CONTAINER:?set NURITEO_BETA_GATE_POSTGRES_CONTAINER}"
readonly run_root="${NURITEO_BETA_GATE_STAGE_WORK_DIR:?set NURITEO_BETA_GATE_STAGE_WORK_DIR}"
readonly control_dir="${NURITEO_BETA_GATE_PROVIDER_TLS_DIR:?set NURITEO_BETA_GATE_PROVIDER_TLS_DIR}/control"
readonly output="${NURITEO_BETA_GATE_STAGE_ASSERTIONS:?set NURITEO_BETA_GATE_STAGE_ASSERTIONS}"

mkdir -p "$run_root"

query() {
  "$runtime" exec "$postgres_container" psql -X --username nuriteo --dbname nuriteo \
    --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"
}

uuid_v7() {
  node -e 'const c=require("node:crypto"),b=c.randomBytes(16),t=BigInt(Date.now());for(let i=5;i>=0;i--)b[5-i]=Number((t>>BigInt(i*8))&255n);b[6]=(b[6]&15)|112;b[8]=(b[8]&63)|128;const h=b.toString("hex");console.log(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`)'
}

before="$(query "SELECT json_build_object('lineage',(SELECT database_lineage::text FROM beta_gate_lineage),'admins',(SELECT count(*) FROM users WHERE is_instance_admin),'organizations',(SELECT count(*) FROM organizations),'projects',(SELECT count(*) FROM projects));")"
smtp_before="$(cat "$control_dir/smtp-stats.json")"

export NURITEO_GATE_OIDC_PHASE=create
export NURITEO_GATE_OIDC_STATE_FILE="$run_root/oidc-state.json"
export NURITEO_GATE_OIDC_RESULT_FILE="$run_root/oidc-result.json"
node --experimental-strip-types "$here/oidc-journey.ts" >"$run_root/oidc-create.log" 2>&1
export NURITEO_GATE_OIDC_PHASE=activate-login
node --experimental-strip-types "$here/oidc-journey.ts" >"$run_root/oidc-login.log" 2>&1

sent_user="$(uuid_v7)"; retry_user="$(uuid_v7)"; dead_user="$(uuid_v7)"
sent_notification="$(uuid_v7)"; retry_notification="$(uuid_v7)"; dead_notification="$(uuid_v7)"
sent_outbox="$(uuid_v7)"; retry_outbox="$(uuid_v7)"; dead_outbox="$(uuid_v7)"
query "BEGIN;
  INSERT INTO users(id,email,normalized_email,display_name) VALUES
    ('$sent_user','gate-005-sent@example.invalid','gate-005-sent@example.invalid','GATE SMTP Sent'),
    ('$retry_user','gate-005-retry@example.invalid','gate-005-retry@example.invalid','GATE SMTP Retry'),
    ('$dead_user','gate-005-dead-letter@example.invalid','gate-005-dead-letter@example.invalid','GATE SMTP Dead Letter');
  INSERT INTO notifications(id,recipient_user_id,classification,event_code,template_id,locale,resource_type,resource_id,rendering_data,first_occurred_at,last_occurred_at) VALUES
    ('$sent_notification','$sent_user','account_access','gate.delivery','gate.delivery','en-US','user','$sent_user','{\"safe\":\"sent\"}',transaction_timestamp(),transaction_timestamp()),
    ('$retry_notification','$retry_user','account_access','gate.delivery','gate.delivery','en-US','user','$retry_user','{\"safe\":\"retry\"}',transaction_timestamp(),transaction_timestamp()),
    ('$dead_notification','$dead_user','account_access','gate.delivery','gate.delivery','en-US','user','$dead_user','{\"safe\":\"dead\"}',transaction_timestamp(),transaction_timestamp());
  INSERT INTO email_outbox(id,notification_id,recipient_user_id,recipient_email,classification,template_id,locale,resource_type,resource_id,rendering_data) VALUES
    ('$sent_outbox','$sent_notification','$sent_user','gate-005-sent@example.invalid','account_access','gate.delivery','en-US','user','$sent_user','{\"safe\":\"sent\"}'),
    ('$retry_outbox','$retry_notification','$retry_user','gate-005-retry@example.invalid','account_access','gate.delivery','en-US','user','$retry_user','{\"safe\":\"retry\"}'),
    ('$dead_outbox','$dead_notification','$dead_user','gate-005-dead-letter@example.invalid','account_access','gate.delivery','en-US','user','$dead_user','{\"safe\":\"dead\"}');
COMMIT;" >/dev/null

attempt=0
until [ "$(query "SELECT state FROM email_outbox WHERE id='$retry_outbox';")" = retry_wait ]; do
  attempt=$((attempt+1)); [ "$attempt" -lt 120 ] || { echo 'retry delivery did not enter retry_wait' >&2; exit 1; }; sleep 0.25
done

attempt=0
while :; do
  states="$(query "SELECT string_agg(state,',' ORDER BY recipient_email) FROM email_outbox WHERE id IN ('$sent_outbox','$retry_outbox','$dead_outbox');")"
  [ "$states" = 'dead_letter,sent,sent' ] && break
  # The production worker's first retry uses a stable 48..72 second jittered
  # delay. Preserve the outbox's monotonic schedule invariant and observe the
  # real retry instead of mutating available_at to accelerate the gate.
  attempt=$((attempt+1)); [ "$attempt" -lt 480 ] || { echo "notification terminal states not reached: $states" >&2; exit 1; }; sleep 0.25
done

notification_result="$(query "SELECT json_build_object(
  'smtpConfigured',(SELECT value='true'::jsonb FROM instance_settings WHERE key='smtp.enabled'),
  'sent',(SELECT state='sent' AND attempt_count=1 AND last_smtp_code=250 FROM email_outbox WHERE id='$sent_outbox'),
  'retried',(SELECT state='sent' AND attempt_count=2 AND last_smtp_code=250 FROM email_outbox WHERE id='$retry_outbox'),
  'deadLetter',(SELECT state='dead_letter' AND attempt_count=1 AND last_smtp_code=550 AND last_error_class='permanent' FROM email_outbox WHERE id='$dead_outbox'),
  'leasesCleared',(SELECT bool_and(lease_owner IS NULL AND lease_expires_at IS NULL) FROM email_outbox WHERE id IN ('$sent_outbox','$retry_outbox','$dead_outbox'))); ")"
after="$(query "SELECT json_build_object('lineage',(SELECT database_lineage::text FROM beta_gate_lineage),'admins',(SELECT count(*) FROM users WHERE is_instance_admin),'organizations',(SELECT count(*) FROM organizations),'projects',(SELECT count(*) FROM projects));")"

node - "$before" "$after" "$run_root/oidc-result.json" "$control_dir/oidc-stats.json" "$notification_result" "$smtp_before" "$control_dir/smtp-stats.json" "$output" <<'NODE'
const fs=require("node:fs");
const [beforeRaw,afterRaw,oidcResultPath,oidcStatsPath,notificationRaw,smtpBeforeRaw,smtpStatsPath,output]=process.argv.slice(2);
const before=JSON.parse(beforeRaw),after=JSON.parse(afterRaw),oidc=JSON.parse(fs.readFileSync(oidcResultPath,"utf8"));
const oidcStats=JSON.parse(fs.readFileSync(oidcStatsPath,"utf8")),notification=JSON.parse(notificationRaw),smtpBefore=JSON.parse(smtpBeforeRaw),smtp=JSON.parse(fs.readFileSync(smtpStatsPath,"utf8"));
if(before.lineage!==after.lineage||before.admins!==after.admins||before.organizations!==after.organizations||before.projects!==after.projects)throw new Error("pre-existing clean-install lineage changed");
if(!oidc.login||!oidc.identityLinked||oidc.jwksRotatedTo!=="gate-next")throw new Error("OIDC login assertion failed");
if(oidcStats.authorize!==1||oidcStats.token!==1||oidcStats.pkceVerified!==1||oidcStats.stateRoundTrips!==1||oidcStats.nonceSigned!==1||!oidcStats.kids.includes("gate-next"))throw new Error("OIDC provider protocol ledger failed");
if(!notification.smtpConfigured||!notification.sent||!notification.retried||!notification.deadLetter||!notification.leasesCleared)throw new Error("notification database contract failed");
const smtpDelta={accepted:smtp.accepted-smtpBefore.accepted,temporary:smtp.temporary-smtpBefore.temporary,deadLetter:smtp.deadLetter-smtpBefore.deadLetter,authFailures:smtp.authFailures-smtpBefore.authFailures};
if(smtpDelta.accepted!==2||smtpDelta.temporary!==1||smtpDelta.deadLetter!==1||smtpDelta.authFailures!==0)throw new Error("SMTP provider delta ledger failed");
const serialized=JSON.stringify({oidc,oidcStats,notification,smtp,before,after});
if(/gate-smtp-password-ephemeral|gate-005-client-secret/.test(serialized))throw new Error("credential leaked into stage evidence");
fs.writeFileSync(output,JSON.stringify({
  "oidc-provider-administration":[
    {kind:"api",name:"administrator created and activated the custom-CA OIDC provider through live Core",status:"PASS"},
    {kind:"process",name:"provider credential remained server-held and absent from stable evidence",status:"PASS"}
  ],
  "oidc-user":[
    {kind:"browser",name:"invited existing user completed live Web/Core authorization-code login with state, nonce, and S256 PKCE",status:"PASS"},
    {kind:"process",name:"rotated JWKS signing kid was accepted without issuer drift",status:"PASS"},
    {kind:"browser",name:"administrator staged and activated custom CA trust through the live Web/Core CA administration surface",status:"PASS"}
  ],
  notifications:[
    {kind:"container",name:"live Core worker authenticated to the custom-CA implicit-TLS SMTP provider",status:"PASS"},
    {kind:"database",name:"same-lineage outbox recorded delivery, transient retry, permanent dead letter, and cleared leases",status:"PASS"},
    {kind:"process",name:"SMTP credential and provider detail were absent from stable stage evidence",status:"PASS"}
  ]
})+"\n",{mode:0o600});
NODE

echo "GATE-005 oidc-user and notifications stages passed"
