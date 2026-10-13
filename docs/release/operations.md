# 운영 절차

날짜: 2026-09-15

## 재검증 명령

```sh
mise exec node@22.23.0 -- node tooling/checks/check-workspace.ts
mise exec node@22.23.0 -- node tooling/checks/check-incident-playbook.ts
mise exec node@22.23.0 -- node tooling/checks/check-release-policy.ts
mise exec node@22.23.0 -- node tooling/checks/check-release-provenance.ts
mise exec node@22.23.0 -- node tooling/checks/check-release-operations.ts
mise exec node@22.23.0 -- node tooling/checks/check-node-upgrade.ts
mise exec node@22.23.0 -- node tooling/checks/check-package-manager-upgrade.ts
mise exec node@22.23.0 -- node tooling/release/package-sdk.ts
mise exec node@22.23.0 -- node packages/protocol/test/run.ts
mise exec node@22.23.0 -- node packages/node-runtime/test/run.ts
mise exec node@22.23.0 -- node packages/browser-host/test/run.ts
mise exec node@22.23.0 -- node tests/compatibility/package-managers/run.ts
mise exec node@22.23.0 -- node packages/preview/test/run.ts
mise exec node@22.23.0 -- node tests/system/browser/run.ts
mise exec node@22.23.0 -- node tests/compatibility/frameworks/vite/run.ts
mise exec node@22.23.0 -- node tests/contract/sdk-consumer/run.ts
cargo test --workspace
```

## Artifact Provenance

1. `tooling/release/package-sdk.ts`로 SDK package와 WASM asset을 생성한다.
2. `docs/release/fingerprint.json`의 SDK asset fingerprint가 실제 artifact hash와 일치하는지 확인한다.
3. `compat/release-provenance.json`의 required artifact, SBOM component, signing policy를 검토한다.
4. `node tooling/checks/check-release-readiness.ts`로 Node baseline, worker/WASM/tarball hash, fingerprint drift를 확인한다.
5. `node tooling/checks/check-release-provenance.ts`를 실행해 source commit, artifact hash, license, CI command drift를 확인한다.
6. stable 외부 publish 전에는 sigstore 또는 동등한 detached signature와 maintainer attestation을 release note에 연결한다.

## Fingerprint Recovery

`check-release-readiness` 또는 `check-release-provenance`가 fingerprint mismatch로 실패하면 local package artifact와 committed fingerprint가 어긋난 상태다.

```sh
mise exec node@22.23.0 -- node tooling/release/package-sdk.ts --write-fingerprint
mise exec node@22.23.0 -- node tooling/checks/check-release-readiness.ts
mise exec node@22.23.0 -- node tooling/checks/check-release-provenance.ts
```

서비스 배포 path를 `/sdk/`와 분리하려면 package 시 base path를 지정한다.

```sh
mise exec node@22.23.0 -- node tooling/release/package-sdk.ts --base-path=/runtime/sdk/ --write-fingerprint
# or
NURITEO_SDK_BASE_PATH=/runtime/sdk/ mise exec node@22.23.0 -- node tooling/release/package-sdk.ts --write-fingerprint
```

fingerprint를 갱신한 뒤에는 `docs/release/fingerprint.json` 변경을 커밋한다. CI는 `package-sdk` 후 committed fingerprint와 재생성 artifact를 비교해 drift를 실패시킨다.

## Node 업데이트

1. 공식 Node release index와 signed SHASUMS에서 후보와 artifact hash를 확인한다.
2. `compat/versions.json`의 `runtimeBaseline.node.rehearsalCandidate`만 갱신한다.
3. 후보 Node로 node-runtime, package-managers, preview, browser, Vite, browser-host suite를 실행한다.
4. 실패한 fixture는 약화하지 않는다. 필요한 binding/runtime 변경을 따로 기록한다.
5. baseline promotion은 release decision으로 분리한다.

## 패키지 매니저 업데이트

1. npm과 pnpm을 동시에 바꾸지 않는다.
2. 후보 metadata와 tarball SHA256을 `vendor/manifests/{npm,pnpm}.json`의 `rehearsalCandidate`에 기록한다.
3. 현재 top-level manifest는 supported baseline으로 유지하고 `rollbackArtifact`를 갱신한다.
4. npm 후보는 임시 manifest/vendor directory에서 실행 smoke를 통과해야 한다.
5. pnpm 후보가 native-binary handoff나 entry drift를 도입하면 promotion hold로 둔다.
6. 기준 manifest로 G5/G6 회귀를 다시 실행한다.

## SDK 패키징

1. `tooling/release/package-sdk.ts`로 `dist/sdk/package`, tarball, `asset-manifest.json`을 새로 생성한다.
2. release 기준 artifact를 고정할 때는 `--write-fingerprint`로 `docs/release/fingerprint.json`을 함께 갱신한다.
3. `asset-manifest.json`의 worker/WASM SHA256, basePath, 필수 headers/MIME을 확인한다.
4. `tests/contract/sdk-consumer/run.ts`로 기본 `/sdk/` base path 소비자 앱을 검증한다. 서비스 배포 path는 `--base-path`로 분리한다.
5. 외부 배포나 registry publish는 별도 승인 후 수행한다.

## 복구

- Worker boot failure: supervisor status가 `failed` 또는 `stopped`로 전환되는지 확인하고 teardown을 반복 실행한다.
- Snapshot corruption: 최신 valid generation으로 fallback한다.
- Package install interruption: cache/store temp generation을 버리고 기준 lockfile hash를 재검증한다.
- Candidate regression: candidate status를 failed/held로 남기고 top-level baseline manifest로 회귀 suite를 실행한다.

## Incident 대응

장애 유형별 owner, mitigation, 사용자 커뮤니케이션 템플릿은 `docs/release/incident-playbook.md`와 `compat/incident-playbook.json`을 기준으로 한다. 모든 incident triage에는 runtime support bundle을 첨부한다.

## Release Channels

SG29 channel contract는 `compat/release-channels.json`에 고정한다. 허용 channel은 `internal`, `private-beta`, `public-beta`, `stable`이며 현재 active channel은 `currentChannel`이다.

승격 전 공통 조건:

1. `node tooling/release/package-sdk.ts`로 versioned SDK/runtime artifact를 만든다.
2. `node tooling/checks/check-release-readiness.ts`로 fingerprint drift를 차단한다.
3. `node tooling/checks/check-release-ops-sg29.ts`로 channel/asset policy, migration contract, rollback rehearsal를 검증한다.

## Versioned Assets And CDN Cache Policy

Machine-readable 배포 계약은 `compat/release-asset-policy.json`이다.

- immutable versioned root: `/sdk/releases/{channel}/{assetSetId}/`
- channel pointer: `/sdk/channels/{channel}/current.json` (`Cache-Control: no-cache, must-revalidate`)
- previous pointer: `/sdk/channels/{channel}/previous.json`
- versioned bytes: `Cache-Control: public, max-age=31536000, immutable`
- release artifact에 `compat/public-compatibility-matrix.json`과 `docs/release/known-limitations.md`를 함께 묶는다.

`assetSetId`는 fingerprint hash set에서 유도한다. CDN에 새 bytes를 올린 뒤 channel pointer만 갱신해서 activate한다.

## Rollback

Automated rollback은 previous SDK/runtime asset set으로 channel pointer를 전환한다. bytes를 다시 빌드하거나 CDN에서 삭제하지 않는다.

```sh
mise exec node@22.23.0 -- node tooling/checks/check-release-ops-sg29.ts
mise exec node@22.23.0 -- node tests/system/release-ops/rollback-rehearsal.test.ts
```

Local rehearsal는 CDN 없이 두 hash set을 만들고 `planRollback(current, previous)`로 pointer switch를 검증한다. migration 실패 시 `ProjectSnapshot` 원본 bytes는 보존해야 한다 (`migrationContract.onUnsupportedVersion = reject-load-preserve-bytes`).

## Release Acceptance

P16 release operations checklist는 `docs/release/release-checklist.md`와 `compat/release-checklist.json`을 기준으로 한다. SG29부터 checklist의 `package-sdk` / `check-release-readiness` / `check-release-ops-sg29` 명령이 CI gate로 승격된다.
