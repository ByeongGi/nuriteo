# Security Policy

## Supported versions

NURITEO supports the latest patch of the current self-hosted v1 minor release. After a new minor release, the previous
minor receives a 90-day overlap. Release candidates and beta builds stop receiving fixes after the corresponding GA.
End-of-support changes are announced at least 90 days in advance when practicable.

## Reporting a vulnerability

Use the repository host's private vulnerability reporting flow (**Security → Report a vulnerability**) when available.
Do not open a public issue containing exploit details, credentials, private Project data, backups, or unredacted Support
Bundles. If private vulnerability reporting is unavailable, ask a maintainer for the private security contact listed in
the current release notes before sending technical details.

Include the affected NURITEO version and image digest, reproduction steps, security impact, and redacted operation/audit
identifiers. Never attach passwords, tokens, private keys, Project source, raw backups, or personal data. NURITEO does
not upload diagnostic data automatically.

We acknowledge Critical reports within 4 hours, High within 24 hours, Medium within 48 hours, and Low within 5 days.
These are response targets for the open-source project, not a paid support SLA. Severity may change after validation.

## Coordinated disclosure

We privately validate, bound affected versions, prepare mitigation and a fixed signed artifact, then publish a GHSA or
equivalent advisory when applicable. Reporter credit requires consent. This project does not currently operate a bug
bounty program.

The detailed severity, ownership, incident state, release-blocking, and disclosure contracts are documented in
[the vulnerability and incident response guide](docs/security/vulnerability-and-incident-response.md).
