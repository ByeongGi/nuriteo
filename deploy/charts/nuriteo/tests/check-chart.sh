#!/bin/sh
set -eu

chart_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
kind_release="$chart_dir/tests/kind-release.sh"
output_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart.XXXXXX")
rotated_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-rotated.XXXXXX")
upgrade_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-upgrade.XXXXXX")
ingress_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-ingress.XXXXXX")
cron_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-cron.XXXXXX")
toolbox_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-toolbox.XXXXXX")
restore_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-restore.XXXXXX")
restricted_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-restricted.XXXXXX")
error_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-error.XXXXXX")
operations_digest=sha256:2222222222222222222222222222222222222222222222222222222222222222
trap 'rm -f "$output_file" "$rotated_file" "$upgrade_file" "$ingress_file" "$cron_file" "$toolbox_file" "$restore_file" "$restricted_file" "$error_file"' EXIT HUP INT TERM

bash -n "$kind_release"
grep -F 'partialFailureFenced' "$kind_release" >/dev/null
grep -F 'helm rollback nuriteo 1' "$kind_release" >/dev/null
grep -F 'externalSecretsPreserved' "$kind_release" >/dev/null

helm lint --strict "$chart_dir"
helm template nuriteo "$chart_dir" --namespace nuriteo >"$output_file"
helm template nuriteo "$chart_dir" --namespace nuriteo --is-upgrade >"$upgrade_file"

grep -F 'nuriteo.dev/contract: digest-pinned-pair-v1' "$output_file" >/dev/null
grep -F 'ghcr.io/nuriteo/nuriteo-server@sha256:1a144aded2998a652093435a658c51a247354a635e4b46be13bddfc91d477c92' "$output_file" >/dev/null
grep -F 'ghcr.io/nuriteo/nuriteo-web@sha256:69dbee9f5b3abff0aaff99fc59c296cf4eaa3ed149620644bb6922341592a13a' "$output_file" >/dev/null
grep -F 'kind: ConfigMap' "$output_file" >/dev/null
grep -F 'name: nuriteo-nuriteo-runtime' "$output_file" >/dev/null
grep -F 'runtime-config-name: "nuriteo-nuriteo-runtime"' "$output_file" >/dev/null
grep -F 'checksum/nuriteo-runtime-config:' "$output_file" >/dev/null
grep -F 'checksum/nuriteo-secret-refs:' "$output_file" >/dev/null
grep -F 'configMapRef:' "$output_file" >/dev/null
grep -F 'secretName: nuriteo-postgresql' "$output_file" >/dev/null
grep -F 'secretName: nuriteo-object-storage' "$output_file" >/dev/null
grep -F 'secretName: nuriteo-application' "$output_file" >/dev/null
grep -F 'defaultMode: 0400' "$output_file" >/dev/null
test "$(grep -c '^kind: Deployment$' "$output_file")" -eq 2
test "$(grep -c '^kind: Service$' "$output_file")" -eq 2
test "$(grep -c '^kind: PodDisruptionBudget$' "$output_file")" -eq 2
grep -F 'name: nuriteo-nuriteo-core' "$output_file" >/dev/null
grep -F 'name: nuriteo-nuriteo-web' "$output_file" >/dev/null
test "$(grep -c 'minAvailable: 1' "$output_file")" -eq 2
if grep -F 'kind: NetworkPolicy' "$output_file" >/dev/null; then
  echo 'full egress restriction must remain opt-in until dependency CIDRs are explicit' >&2
  exit 1
fi
test "$(grep -c '^kind: Job$' "$output_file")" -eq 2
test "$(grep -c 'helm.sh/hook: pre-install,pre-upgrade' "$output_file")" -eq 2
grep -F 'helm.sh/hook-weight: "-20"' "$output_file" >/dev/null
grep -F 'helm.sh/hook-weight: "-10"' "$output_file" >/dev/null
test "$(grep -c 'backoffLimit: 0' "$output_file")" -eq 2
grep -F -- '- "storage-check"' "$output_file" >/dev/null
grep -F -- '- "upgrade-preflight"' "$upgrade_file" >/dev/null
grep -F 'args: ["migrate"]' "$output_file" >/dev/null
grep -F 'httpGet: { path: /health/live, port: http }' "$output_file" >/dev/null
grep -F 'httpGet: { path: /health/ready, port: http }' "$output_file" >/dev/null
grep -F 'name: management' "$output_file" >/dev/null
grep -F 'name: OTEL_TRACES_EXPORTER' "$output_file" >/dev/null
grep -F 'value: "none"' "$output_file" >/dev/null
if grep -F 'name: NURITEO_OTLP_AUTHORIZATION' "$output_file" >/dev/null; then
  echo 'default chart must not render an absent OTLP authorization Secret reference' >&2
  exit 1
fi
grep -F 'httpGet: { path: /sign-in, port: http }' "$output_file" >/dev/null
if grep -F 'kind: Ingress' "$output_file" >/dev/null; then
  echo 'Ingress must remain opt-in until external edge readiness is acknowledged' >&2
  exit 1
fi
if grep -F 'kind: CronJob' "$output_file" >/dev/null || grep -F 'nuriteo.dev/operator-invoked:' "$output_file" >/dev/null; then
  echo 'backup schedule, toolbox and restore must remain opt-in' >&2
  exit 1
fi

helm template nuriteo "$chart_dir" --namespace nuriteo \
  --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.externalEgress.cidrBlocks[0]=10.42.0.0/16' >"$restricted_file"
test "$(grep -c '^kind: NetworkPolicy$' "$restricted_file")" -eq 4
grep -F 'name: nuriteo-nuriteo-default-deny' "$restricted_file" >/dev/null
grep -F 'name: nuriteo-nuriteo-external-egress' "$restricted_file" >/dev/null
grep -F 'kubernetes.io/metadata.name: ingress-nginx' "$restricted_file" >/dev/null
grep -F 'kubernetes.io/metadata.name: kube-system' "$restricted_file" >/dev/null
grep -F 'ipBlock: { cidr: "10.42.0.0/16" }' "$restricted_file" >/dev/null
grep -F -- '- { protocol: TCP, port: 5432 }' "$restricted_file" >/dev/null
grep -F -- '- { protocol: UDP, port: 53 }' "$restricted_file" >/dev/null
grep -F 'operator: NotIn' "$restricted_file" >/dev/null
grep -F 'values: [web]' "$restricted_file" >/dev/null

helm template nuriteo "$chart_dir" --namespace nuriteo \
  --show-only templates/backup-cronjob.yaml \
  --set-string images.operations.digest="$operations_digest" \
  --set backupSchedule.enabled=true >"$cron_file"
test "$(grep -c '^kind: CronJob$' "$cron_file")" -eq 1
grep -F 'concurrencyPolicy: Forbid' "$cron_file" >/dev/null
grep -F 'startingDeadlineSeconds: 900' "$cron_file" >/dev/null
grep -F 'activeDeadlineSeconds: 14400' "$cron_file" >/dev/null
grep -F 'successfulJobsHistoryLimit: 3' "$cron_file" >/dev/null
grep -F 'failedJobsHistoryLimit: 3' "$cron_file" >/dev/null
grep -F 'args: ["backup", "create"]' "$cron_file" >/dev/null
grep -F "ghcr.io/nuriteo/nuriteo-operations@${operations_digest}" "$cron_file" >/dev/null
grep -F 'name: NURITEO_BACKUP_S3_ENDPOINT' "$cron_file" >/dev/null
grep -F 'secretName: nuriteo-backup-storage' "$cron_file" >/dev/null
if grep -F 'secretName: nuriteo-application' "$cron_file" >/dev/null; then
  echo 'backup jobs must not mount application signing or encryption keys' >&2
  exit 1
fi

helm template nuriteo "$chart_dir" --namespace nuriteo \
  --show-only templates/toolbox-job.yaml \
  --set-string images.operations.digest="$operations_digest" \
  --set toolbox.enabled=true >"$toolbox_file"
grep -F 'app.kubernetes.io/component: toolbox' "$toolbox_file" >/dev/null
grep -F 'nuriteo.dev/operator-invoked: "true"' "$toolbox_file" >/dev/null
grep -F 'suspend: true' "$toolbox_file" >/dev/null
grep -F 'args: ["backup", "list"]' "$toolbox_file" >/dev/null

restore_id=0199ee6c-c777-7000-8000-000000007099
helm template nuriteo "$chart_dir" --namespace nuriteo \
  --show-only templates/restore-job.yaml \
  --set-string images.operations.digest="$operations_digest" \
  --set restore.enabled=true \
  --set-string restore.restorePointId="$restore_id" \
  --set-string restore.target.identity=isolated-drill \
  --set-string restore.target.postgresql.existingSecret.name=nuriteo-restore-postgresql \
  --set-string restore.target.objectStorage.endpoint=https://restore-s3.example.com \
  --set-string restore.target.objectStorage.bucket=nuriteo-restore \
  --set-string restore.target.objectStorage.existingSecret.name=nuriteo-restore-storage \
  --set restore.fence.maintenanceModeAcknowledged=true \
  --set restore.fence.writesDrainedAcknowledged=true \
  --set restore.fence.targetValidatedAcknowledged=true >"$restore_file"
grep -F 'app.kubernetes.io/component: restore' "$restore_file" >/dev/null
grep -F 'nuriteo.dev/restore-point-id: "0199ee6c-c777-7000-8000-000000007099"' "$restore_file" >/dev/null
grep -F 'nuriteo.dev/target-postgresql-secret: "nuriteo-restore-postgresql"' "$restore_file" >/dev/null
grep -F 'nuriteo.dev/target-object-storage-bucket: "nuriteo-restore"' "$restore_file" >/dev/null
grep -F 'nuriteo.dev/operator-fence: "acknowledged"' "$restore_file" >/dev/null
grep -F 'suspend: true' "$restore_file" >/dev/null
grep -F 'args: ["backup", "restore", "0199ee6c-c777-7000-8000-000000007099"]' "$restore_file" >/dev/null
grep -F 'automountServiceAccountToken: false' "$restore_file" >/dev/null
grep -F 'runAsNonRoot: true' "$restore_file" >/dev/null
grep -F 'readOnlyRootFilesystem: true' "$restore_file" >/dev/null
grep -F 'secretName: nuriteo-restore-postgresql' "$restore_file" >/dev/null
grep -F 'secretName: nuriteo-restore-storage' "$restore_file" >/dev/null
grep -F 'name: NURITEO_BACKUP_S3_ENDPOINT' "$restore_file" >/dev/null
grep -F 'name: NURITEO_RESTORE_DATABASE_URL_FILE' "$restore_file" >/dev/null
grep -F 'name: NURITEO_RESTORE_S3_ENDPOINT' "$restore_file" >/dev/null

helm template nuriteo "$chart_dir" --namespace nuriteo \
  --set ingress.enabled=true \
  --set-string ingress.className=nginx \
  --set-string ingress.tls.existingSecretName=nuriteo-edge-tls \
  --set preview.wildcardReady=true \
  --set ingress.readiness.wildcardDns=true \
  --set ingress.readiness.wildcardTls=true \
  --set ingress.readiness.originalHost=true \
  --set ingress.readiness.webSocket=true \
  --set ingress.readiness.crossOrigin=true \
  --set ingress.readiness.hmr=true >"$ingress_file"
test "$(grep -c '^kind: Ingress$' "$ingress_file")" -eq 1
grep -F 'ingressClassName: "nginx"' "$ingress_file" >/dev/null
grep -F 'secretName: nuriteo-edge-tls' "$ingress_file" >/dev/null
test "$(grep -c -- '- "nuriteo.example.com"' "$ingress_file")" -eq 1
test "$(grep -c -F -- '- "*.preview.nuriteo.example.com"' "$ingress_file")" -eq 1
grep -F 'host: "nuriteo.example.com"' "$ingress_file" >/dev/null
grep -F 'host: "*.preview.nuriteo.example.com"' "$ingress_file" >/dev/null
test "$(grep -c 'name: nuriteo-nuriteo-web' "$ingress_file")" -ge 3
test "$(grep -c 'name: http' "$ingress_file")" -ge 3
grep -F 'NURITEO_PREVIEW_WILDCARD_READY: "true"' "$ingress_file" >/dev/null

if grep -F 'helm.sh/hook-delete-policy: hook-succeeded' "$output_file" >/dev/null; then
  echo 'completed or failed hook evidence must be retained until the next attempt' >&2
  exit 1
fi

if grep -Eq '^(kind: Secret|data:.*password|stringData:)' "$output_file"; then
  echo 'rendered chart must not create or inline Secret values' >&2
  exit 1
fi

base_config_checksum=$(grep 'checksum/nuriteo-runtime-config:' "$output_file" | head -1)
base_secret_checksum=$(grep 'checksum/nuriteo-secret-refs:' "$output_file" | head -1)

helm template nuriteo "$chart_dir" \
  --set-string externalUrl=https://rotated.example.com >"$rotated_file"
rotated_config_checksum=$(grep 'checksum/nuriteo-runtime-config:' "$rotated_file" | head -1)
rotated_secret_checksum=$(grep 'checksum/nuriteo-secret-refs:' "$rotated_file" | head -1)
test "$base_config_checksum" != "$rotated_config_checksum"
test "$base_secret_checksum" = "$rotated_secret_checksum"

helm template nuriteo "$chart_dir" \
  --set-string rollout.externalSecretsRevision=rotation-2 >"$rotated_file"
rotated_config_checksum=$(grep 'checksum/nuriteo-runtime-config:' "$rotated_file" | head -1)
rotated_secret_checksum=$(grep 'checksum/nuriteo-secret-refs:' "$rotated_file" | head -1)
test "$base_config_checksum" = "$rotated_config_checksum"
test "$base_secret_checksum" != "$rotated_secret_checksum"

helm template nuriteo "$chart_dir" \
  --set runtimeConfig.create=false \
  --set-string runtimeConfig.existingConfigMap.name=nuriteo-runtime-external \
  --set-string runtimeConfig.existingConfigMap.revision=config-7 >"$rotated_file"
grep -F 'runtime-config-name: "nuriteo-runtime-external"' "$rotated_file" >/dev/null
if grep -F 'name: nuriteo-nuriteo-runtime' "$rotated_file" >/dev/null; then
  echo 'chart-owned runtime ConfigMap rendered while an existing ConfigMap was selected' >&2
  exit 1
fi

if helm template nuriteo "$chart_dir" --set-string images.server.digest=latest >"$output_file" 2>"$error_file"; then
  echo 'expected a non-sha256 server digest to fail schema validation' >&2
  exit 1
fi
grep -F '/images/server/digest' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" --set-string images.web.repository=nuriteo-web:latest >"$output_file" 2>"$error_file"; then
  echo 'expected a tagged web repository to fail template validation' >&2
  exit 1
fi
grep -F 'digest-only' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" --set-string release.lineage=another-lineage >"$output_file" 2>"$error_file"; then
  echo 'expected release lineage drift to fail schema validation' >&2
  exit 1
fi
grep -F '/release/lineage' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string applicationSecrets.existingSecret.masterKey=do-not-inline-secrets \
  >"$output_file" 2>"$error_file"; then
  echo 'expected an inline secret value to fail schema validation' >&2
  exit 1
fi
grep -F 'additional properties' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set runtimeConfig.create=false >"$output_file" 2>"$error_file"; then
  echo 'expected an existing ConfigMap without name/revision to fail schema validation' >&2
  exit 1
fi
grep -F '/runtimeConfig/existingConfigMap' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set jobs.migration.enabled=false >"$output_file" 2>"$error_file"; then
  echo 'expected disabling the migration rollout fence to fail schema validation' >&2
  exit 1
fi
grep -F '/jobs/migration/enabled' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string backupSchedule.schedule='@daily' >"$output_file" 2>"$error_file"; then
  echo 'expected a non-five-field backup schedule to fail schema validation' >&2
  exit 1
fi
grep -F '/backupSchedule/schedule' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set toolbox.enabled=true --set-string toolbox.operation=restore \
  >"$output_file" 2>"$error_file"; then
  echo 'expected restore to be unavailable through the generic toolbox' >&2
  exit 1
fi
grep -F '/toolbox/operation' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string images.operations.digest="$operations_digest" \
  --set restore.enabled=true >"$output_file" 2>"$error_file"; then
  echo 'expected restore without point, target and fence acknowledgements to fail closed' >&2
  exit 1
fi
grep -F '/restore/' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string images.operations.digest="$operations_digest" \
  --set restore.enabled=true \
  --set-string restore.restorePointId="$restore_id" \
  --set-string restore.target.identity=production-primary \
  --set-string restore.target.postgresql.existingSecret.name=nuriteo-postgresql \
  --set-string restore.target.objectStorage.endpoint=https://restore-s3.example.com \
  --set-string restore.target.objectStorage.bucket=nuriteo-restore \
  --set-string restore.target.objectStorage.existingSecret.name=nuriteo-restore-storage \
  --set restore.fence.maintenanceModeAcknowledged=true \
  --set restore.fence.writesDrainedAcknowledged=true \
  --set restore.fence.targetValidatedAcknowledged=true \
  >"$output_file" 2>"$error_file"; then
  echo 'expected restore target confirmation drift to fail closed' >&2
  exit 1
fi
grep -F 'must differ from the production PostgreSQL Secret' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set backupSchedule.enabled=true >"$output_file" 2>"$error_file"; then
  echo 'expected backup Jobs without a published operations image to fail closed' >&2
  exit 1
fi
grep -F 'require a release-published images.operations.digest' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set networkPolicy.enabled=true >"$output_file" 2>"$error_file"; then
  echo 'expected a restricted network profile without dependency CIDRs to fail closed' >&2
  exit 1
fi
grep -F '/networkPolicy/externalEgress/cidrBlocks' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set core.podDisruptionBudget.minAvailable=2 >"$output_file" 2>"$error_file"; then
  echo 'expected a PDB minimum above the replica count to fail closed' >&2
  exit 1
fi
grep -F 'core.podDisruptionBudget.minAvailable must not exceed core.replicas' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string externalUrl=https://admin:password@nuriteo.example.com \
  >"$output_file" 2>"$error_file"; then
  echo 'expected credential-bearing external URL to fail schema validation' >&2
  exit 1
fi
grep -F '/externalUrl' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string objectStorage.endpoint=https://access:secret@s3.example.com \
  >"$output_file" 2>"$error_file"; then
  echo 'expected credential-bearing object endpoint to fail schema validation' >&2
  exit 1
fi
grep -F '/objectStorage/endpoint' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set ingress.enabled=true >"$output_file" 2>"$error_file"; then
  echo 'expected an enabled Ingress without class/TLS/readiness to fail closed' >&2
  exit 1
fi
grep -F '/ingress/' "$error_file" >/dev/null

helm template nuriteo "$chart_dir" \
  --set ingress.enabled=true \
  --set-string ingress.className=nginx \
  --set-string ingress.tls.existingSecretName=nuriteo-edge-tls >"$rotated_file"
grep -F 'host: "nuriteo.example.com"' "$rotated_file" >/dev/null
if grep -F 'host: "*.preview.nuriteo.example.com"' "$rotated_file" >/dev/null; then
  echo 'wildcard host must not render before Preview readiness is acknowledged' >&2
  exit 1
fi
grep -F 'NURITEO_PREVIEW_WILDCARD_READY: "false"' "$rotated_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string ingress.annotations.rewrite=unsafe >"$output_file" 2>"$error_file"; then
  echo 'expected controller-specific Ingress annotations to be rejected' >&2
  exit 1
fi
grep -F 'additional properties' "$error_file" >/dev/null

for readiness in wildcardDns wildcardTls originalHost webSocket crossOrigin hmr; do
  if helm template nuriteo "$chart_dir" \
    --set preview.wildcardReady=true \
    --set ingress.readiness.wildcardDns=true \
    --set ingress.readiness.wildcardTls=true \
    --set ingress.readiness.originalHost=true \
    --set ingress.readiness.webSocket=true \
    --set ingress.readiness.crossOrigin=true \
    --set ingress.readiness.hmr=true \
    --set "ingress.readiness.${readiness}=false" >"$output_file" 2>"$error_file"; then
    echo "expected missing ${readiness} readiness to fail closed" >&2
    exit 1
  fi
  grep -F '/ingress/readiness/' "$error_file" >/dev/null
done

if helm template nuriteo "$chart_dir" \
  --set-string externalUrl=https://preview.nuriteo.example.com \
  >"$output_file" 2>"$error_file"; then
  echo 'expected application/Preview origin overlap to fail closed' >&2
  exit 1
fi
grep -F 'must not equal or be covered by preview.baseDomain' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string externalUrl=https://app.preview.nuriteo.example.com \
  >"$output_file" 2>"$error_file"; then
  echo 'expected an application host covered by the Preview wildcard to fail closed' >&2
  exit 1
fi
grep -F 'must not equal or be covered by preview.baseDomain' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string externalUrl=https://nuriteo.example.com:99999 \
  >"$output_file" 2>"$error_file"; then
  echo 'expected an invalid canonical origin port to fail closed' >&2
  exit 1
fi
grep -F 'externalUrl port must be between 1 and 65535' "$error_file" >/dev/null

if helm template nuriteo "$chart_dir" \
  --set-string preview.baseDomain="$(printf 'a%.0s' $(seq 1 64)).example.com" \
  >"$output_file" 2>"$error_file"; then
  echo 'expected an overlong Preview DNS label to fail schema validation' >&2
  exit 1
fi
grep -F '/preview/baseDomain' "$error_file" >/dev/null

helm template nuriteo "$chart_dir" \
  --set bootstrapAdmin.enabled=true \
  --set-string bootstrapAdmin.email=admin@example.com \
  --set-string bootstrapAdmin.name=Administrator \
  --set-string bootstrapAdmin.existingSecret.name=nuriteo-bootstrap >"$rotated_file"
grep -F 'app.kubernetes.io/component: bootstrap-admin' "$rotated_file" >/dev/null
grep -F 'helm.sh/hook-weight: "-5"' "$rotated_file" >/dev/null
grep -F 'secretName: nuriteo-bootstrap' "$rotated_file" >/dev/null

echo 'nuriteo Helm chart contract ok (schema, digests, refs, rollout, jobs, workloads, ingress, backup schedule, suspended toolbox/restore, PDB, restricted network profile)'
