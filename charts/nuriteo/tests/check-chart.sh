#!/bin/sh
set -eu

chart_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart.XXXXXX")
rotated_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-rotated.XXXXXX")
error_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-error.XXXXXX")
trap 'rm -f "$output_file" "$rotated_file" "$error_file"' EXIT HUP INT TERM

helm lint --strict "$chart_dir"
helm template nuriteo "$chart_dir" --namespace nuriteo >"$output_file"

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

echo 'nuriteo Helm chart contract ok (schema, render, paired digests, secret refs, rollout checksums)'
