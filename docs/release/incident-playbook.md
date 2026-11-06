# Incident playbook

Use this playbook for a self-hosted NURITEO instance. Send a NURITEO redacted Support Bundle with the report. Security reports follow [vulnerability-and-incident-response.md](../security/vulnerability-and-incident-response.md).

## rollback

Stop promotion, restore the last verified runtime artifact, and rerun the release provenance and smoke checks. Existing projects stay available.

## browser-regression

Pin the known-good browser matrix and publish the affected browser versions. Hold the release until runtime startup works on a supported Chromium version.

## registry-outage

Keep cached packages available when their integrity is already verified. Show an offline diagnostic for new installs and retry with backoff.

## quota-corruption

Preserve the latest valid snapshot. Evict cache prefixes only, and offer a project archive export before any workspace reset.

## security-report

Acknowledge the report privately. Reproduce it from the redacted bundle, patch and rotate affected credentials, and publish an advisory when a fixed artifact is ready.
