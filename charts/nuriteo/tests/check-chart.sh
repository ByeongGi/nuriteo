#!/bin/sh
set -eu

chart_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart.XXXXXX")
error_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-chart-error.XXXXXX")
trap 'rm -f "$output_file" "$error_file"' EXIT HUP INT TERM

helm lint --strict "$chart_dir"
helm template nuriteo "$chart_dir" --namespace nuriteo >"$output_file"

grep -F 'nuriteo.dev/contract: digest-pinned-pair-v1' "$output_file" >/dev/null
grep -F 'ghcr.io/nuriteo/nuriteo-server@sha256:1a144aded2998a652093435a658c51a247354a635e4b46be13bddfc91d477c92' "$output_file" >/dev/null
grep -F 'ghcr.io/nuriteo/nuriteo-web@sha256:69dbee9f5b3abff0aaff99fc59c296cf4eaa3ed149620644bb6922341592a13a' "$output_file" >/dev/null

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

echo 'nuriteo Helm chart contract ok (schema, render, paired digests)'
