# 릴리스 정책

날짜: 2026-09-15

## 채널

| 채널 | 대상 | 승격 기준 | 외부 배포 |
|---|---|---|---|
| internal | maintainer와 통제된 제품 QA | PG15 PASS, support bundle 사용 가능, known limitations 검토 | no |
| beta-candidate | 신뢰된 browser IDE integration | PG16 PASS, PG17 PASS, PG18 scoring, rollback artifact 검증 | no |
| stable | production browser development session | PG20 PASS, release checklist PASS, support window 공지 | yes |

## 버전 정책

SDK는 SemVer를 따른다.

- major: public SDK API break, runtime ABI incompatibility, migration 없이 호환 불가능한 변경.
- minor: 현재 runtime ABI 안에서 지원 기능 추가.
- patch: bug fix, security fix, 문서 정정, compatibility fixture 확대.

Runtime ABI의 현재 기준은 `1`이다. minor/patch release는 ABI v1 호환을 유지해야 하고, ABI break는 SDK major release로만 승격한다. Protocol ABI가 바뀌면 release note에 `packages/protocol/src/generated.ts`의 ABI_VERSION 변경 이유와 호환 범위를 기록한다.

## 지원 창

| 항목 | 현재 baseline | 후보 | 정책 |
|---|---|---|---|
| Node | `22.23.0` / 22.x | `22.23.2` | patch candidate는 rehearsal 후 promotion, major line 변경은 compatibility lane 필요 |
| npm | `10.9.2` | `10.9.8` | 한 release candidate에서 하나의 package manager만 승격 |
| pnpm | `9.15.9` | `12.4.1` | pnpm 12는 entry contract 지원 전까지 hold |
| Browser | COOP/COEP + SharedArrayBuffer 가능한 Chromium family | release 시점 current stable + previous two stable | beta/stable 전 브라우저 matrix 재검증 |

지원 종료는 기본 90일 전에 공지한다. Node/npm/pnpm baseline을 승격하면 이전 baseline은 최소 한 minor release 동안 overlap support로 유지한다. 단, critical security fix는 mitigation과 함께 overlap을 단축할 수 있다.

## Candidate Rehearsal

1. 후보 artifact의 source URL, integrity, SHA256을 먼저 manifest에 기록한다.
2. protocol, node-runtime, browser-host, package-manager, preview, browser, Vite, SDK consumer suite를 실행한다.
3. product gate와 rollback artifact 갱신 전까지 후보 상태는 `rehearsed-not-promoted`로 유지한다.
4. promotion 또는 hold 이유를 release note와 manifest에 남긴다.

## Release Note 필수 항목

- SDK version과 runtime ABI.
- Node/npm/pnpm/browser support window.
- 새로 지원된 기능과 fixture 증거.
- WebContainers parity scope 안의 supported/held/unsupported 항목.
- rollback artifact와 known limitations.
