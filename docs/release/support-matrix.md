# 지원 매트릭스

날짜: 2026-09-27

> 이 문서는 브라우저 내부 개발 런타임의 호환성 표다. Self-hosted 배포·운영 환경은
> [Self-hosted v1 지원·호환성 표](./self-hosted-v1-support-matrix.md)를 정본으로 사용한다.

지원 등급은 실제 호환성 검사와 릴리스 검증 결과를 기준으로 승격한다. 내부 작업 계획과
승인 기록은 공개 배포물에 포함하지 않는다.

## 기준 환경

| 항목 | 지원 기준 | 상태 |
|---|---|---|
| Browser runtime | Chromium/Chrome headless with COOP/COEP isolation | supported for current gates |
| Chrome stable | product-supported browser | supported |
| Edge stable | Edge 155 desktop smoke with COOP/COEP, SAB, SW, OPFS, and retained Vite React preview | supported |
| Safari 26.6.2 desktop | COOP/COEP, SAB, SW preview iframe, OPFS reopen, quota recovery smoke | supported; iOS/mobile Safari excluded |
| SharedArrayBuffer | required | supported when host provides COOP/COEP |
| Node baseline | `22.23.0` | supported baseline |
| Node rehearsal | `22.23.2` | rehearsed, not promoted |
| Rust | `1.97.1` | supported build toolchain |
| WASM target | `wasm32-unknown-unknown` | supported for system WASM |
| npm | `10.9.2` | supported vendored CLI |
| npm rehearsal | `10.9.8` | rehearsed, not promoted |
| pnpm | `9.15.9` | supported vendored CLI |
| pnpm rehearsal | `12.4.1` | promotion hold |
| Yarn v1 | pinned 1.22.22 artifact; local/registry install, scripts/exec, strict-CSP Chrome Worker recovery | supported for Yarn Classic 1.22.22; Berry/private-auth UX out of scope |
| Vite React | `8.2.0` product workflow | supported product target |
| Vite Vue runtime | pinned Vite template; npm/pnpm worker-backed install/dev/HMR/build/recovery | supported |
| Vite Svelte | pinned Vite template; npm/pnpm worker-backed install/dev/HMR/build/recovery | supported |
| Webpack dev workflow | pinned Webpack 5.111.0, webpack-cli 7.2.3, and webpack-dev-server 5.2.2; complete static factory graph; real build/dev/HMR/restart/recovery in strict-CSP Chrome | product-supported for the pinned workflow; arbitrary versions and runtime-generated factories are out of scope |
| Rspack dev workflow | pinned Rspack 2.2.4 CLI/dev server with integrity-pinned WASI browser binding and nested Worker; real build/dev/HMR/restart/recovery in strict-CSP Chrome | product-supported for the pinned WASI workflow; native bindings and arbitrary versions are out of scope |
| Next.js App Router preview adapter | route/layout/link preview, edit refresh, adapter build output | product-preview |
| Next.js 15.5.26 full CLI/runtime | real dev/HMR/build/start/restart, App/Pages Router, config/plugin, WASM SWC, RSC/Server Actions, Middleware/Edge, ISR/Image Optimization | product-supported; strict-CSP Chrome and release-security PASS |

## Release Policy

- Channel policy: `docs/release/release-policy.md`
- Machine-readable policy: `compat/release-policy.json`
- Support ending: 90-day notice by default, with one minor release overlap for previous Node/npm/pnpm baselines after promotion.

## Runtime Surface

| 기능 | 상태 | 증거 |
|---|---|---|
| Worker boot/teardown | supported | `tests/system/browser/boot.test.ts` |
| Browser Worker resource contract | supported | 256 MiB declared-resource admission, 256 MiB workspace bytes, 2 GiB JS-created WASM ceiling required by pinned Rspack, timeout/error Worker-pair teardown and clean reboot; generic V8 heap hard cap unavailable and not claimed |
| SAB syscall bridge | supported for current ABI v1 | `packages/protocol/test/sync-client.test.ts` |
| MemoryFS basic operations | supported | `cargo test -p system-core fs` |
| symlink/hardlink/rename/truncate/watch fixture | supported | `cargo test -p system-core fs` |
| CommonJS/ESM/TLA/dynamic import fixture | supported | `packages/node-runtime/test/modules.test.ts` |
| TypeScript transform sourcemap fixture | supported | `packages/node-runtime/test/typescript.test.ts` |
| process lifecycle/stdio/thread fixture | supported | `packages/node-runtime/test/io-process.test.ts`, `packages/browser-host/test/process-lifecycle.test.ts` |
| loopback HTTP/preview/HMR fixture | supported | `packages/preview/test/run.ts`, `tests/compatibility/frameworks/vite/run.ts` |
| Microsoft Edge desktop smoke | supported | historical executable result in `compat/browser-smoke-results.json`; canonical source migration is recorded by LEG-002 |
| Safari desktop smoke | supported for Safari 26.6.2 on macOS | historical executable result in `compat/browser-smoke-results.json`; iOS remains outside the claim |
| SDK consumer package smoke | supported | `tests/contract/sdk-consumer/run.ts` |
| Actual public Vite React fixture gate | supported on Node-worker scorer | `compat/ecosystem-fixture-actual-product-results.json` 10/10 PASS; browser-worker cohort validation remains separate |
| SG25 service-workflow fixture set (20) | pass-or-hold gate | `compat/service-workflow-fixture-results.json` 19 pass + 1 hold |
| Vite Vue / Svelte product workflows | supported | `tests/compatibility/frameworks/vite/vite-vue-svelte-actual.test.ts`, `compat/framework-product-support.json` |
| Webpack / Rspack dev workflows | supported for pinned versions | `tests/compatibility/frameworks/bundlers/bundler-candidate-workflow.test.ts`, `compat/bundler-dev-workflow-results.json`, `compat/framework-product-support.json` |
| Next.js App Router preview adapter | product-preview | `apps/web/test/preview-next-subdomain-browser.test.ts` |
| Next.js 15.5.26 full CLI/runtime | product-supported | `apps/web/test/gate-project-runtime-browser.test.ts`, `compat/nextjs-security-baseline.json`; native `.node` SWC unsupported, integrity-pinned version-matched WASM SWC only |
| Unsupported diagnostics | supported | `compat/unsupported-diagnostics.json`, `tests/productization/unsupported-diagnostics.test.ts` |
| jq/sqlite project-scoped WASM adapters | supported | `compat/non-js-tooling-candidates.json` |
| Python WASI / Git WASM project adapters | hold | Node/Chrome vertical slices and Git OPFS/host-transport boundaries exist; Python legal/provenance/guest-memory and Git legal/actual-pack/transport-integration gates remain |

## Browser Grades

브라우저 승격 조건과 실행 한계는 `compat/runtime-reliability-policy.json`을 본다.

## Not A Claim

- This matrix does not claim full Node.js API compatibility.
- This matrix does not claim arbitrary npm ecosystem package compatibility.
- This matrix claims the pinned Next.js 15.5.26 full CLI/runtime path, not arbitrary Next versions or native `.node` SWC. It also does not claim native addon general execution, pnpm 12 browser promotion, Docker, direct TCP database connections, or arbitrary Linux binary execution.
- Safari support is limited to the tested macOS desktop Safari 26.6.2 path; iOS/mobile Safari and older desktop releases are not claimed.
- Python WASI and Git WASM candidate APIs are not product support claims. Python's pinned Node/Chrome evidence enforces a static allocation admission limit, but still lacks guest peak-memory enforcement and production artifact provenance. Git's project-namespaced OPFS reopen and host transport boundary pass, but actual pack application and transport-to-libgit2 integration do not. Remote Git operations remain disabled.
