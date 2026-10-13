# 알려진 제한

날짜: 2026-10-12

이 문서는 사용자·배포자가 알아야 할 현재 제품 제약을 요약한다. 내부 구현 백로그와
출시 승인 기록은 공개 배포물에 포함하지 않는다.

## Node Runtime

- Full Node.js compatibility is not claimed.
- The supported Node surface is the browser JS/TS development subset proven by `compat/node-api-gap.json` and productization tests. `buffer`, `events`, `stream`, and `util` are supported for the current npm/pnpm/Vite paths, but this is not a blanket Node API claim.
- `internalBinding` is allow-listed. Unknown bindings fail explicitly instead of being stubbed as successful.
- Dynamic code generation remains blocked by the browser CSP policy.

## Package Managers

- npm `10.9.2` and pnpm `9.15.9` are the supported vendored CLI versions for the current browser guest runtime path.
- npm `10.9.8` was rehearsed but not promoted.
- pnpm `12.4.1` was rehearsed and held. Its entry path changed to a shell/native-binary handoff, which introduces `node:child_process` and native binary acquisition pressure.
- Arbitrary native `.node` addons are unsupported unless a package-specific WASM adapter is proven and integrity-pinned.
- The public Vite React ecosystem gate passes all 10 measured exact-revision fixtures on the Node-worker scorer. A browser-worker run of the same public cohort remains a separate validation step.
- Yarn Classic `1.22.22` is supported for the pinned browser guest path, including local/registry install and scripts. Yarn Berry, private registry authentication UX, offline mirror, selective resolutions, and framework-specific Yarn parity are not covered by this gate.

## Browser And Hosting

- Cross-origin isolation is mandatory. Hosts must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- `SharedArrayBuffer` is a runtime requirement.
- Preview relay assumes same-origin session validation and does not support forged cross-origin preview clients.
- Chrome, Edge, and macOS desktop Safari 26.6.2 are supported. Safari evidence covers cross-origin isolation, SharedArrayBuffer, Service Worker preview routing, iframe rendering, OPFS reopen, and product quota recovery. iOS/mobile Safari and older desktop Safari releases remain outside the tested support claim.
- Browsers do not expose a per-Worker V8 JavaScript heap hard-cap API. The product instead enforces a 256 MiB declared-resource admission budget, a separate 2 GiB JS-created WebAssembly linear-memory ceiling needed by the pinned Rspack WASI binding, the actual 256 MiB workspace byte quota, and Worker-pair watchdog teardown/reboot. Page memory measurements are observational only.

## Terminal And Processes

- The preview-service terminal is an xterm front end over isolated browser shell sessions, not a kernel POSIX PTY. An opt-in Worker PTY line discipline supports canonical input, echo, erase/line-kill, Ctrl-D EOF, and Ctrl-C virtual SIGINT. Kernel termios/ioctl, process groups, job control, and native Unix signals remain unsupported.
- Built-ins and npm/pnpm/yarn workflow commands use parsed argv plus an allowlist. A limited production command set is wired through `HostProcessTable` to bundled BrowserProcess Workers with per-tab cwd/environment, streaming/backpressure, resize, and virtual signals. Package install/dev/build remain workflow adapters, not Worker-owned processes.
- Multiple terminal tabs have independent virtual sessions and foreground commands; they do not imply independent OS PTYs or process groups.

## Frameworks And Tooling

- Vite React, Vue, and Svelte are product-supported at their documented fixture baselines. Webpack 5.111.0 and Rspack 2.2.4 are product-supported only through their pinned strict-CSP browser workflows. This is not a claim that arbitrary bundler versions, every community plugin, runtime-generated CommonJS factories, or Rspack native bindings work.
- Next.js support is pinned to 15.5.26 with version-matched WASM SWC. The full CLI/runtime passes strict-CSP Chrome dev/HMR/build/start/restart and App/Pages Router, config/plugin, RSC/Server Actions, Middleware/Edge, ISR, and Image Optimization coverage. Arbitrary Next versions and native `.node` SWC remain unsupported.
- `jq-wasm` and `sqlite-wasm` are supported only through the documented project-scoped adapters. SQLite is an embedded OPFS database, not a TCP database replacement.
- Python WASI and Git WASM remain hold. Python's integrity-pinned Node/Chrome Worker slices pass project I/O, network deny, output/timeout/cancel, and a 256 MiB static allocation admission check; its 150 MiB external WEBC, modified-MIT attribution condition, production provenance, and unenforced guest peak-memory ceiling remain blockers. Git local operations and project-namespaced OPFS reopen pass with corruption, symlink-import, oversized-file, credential-redaction, and pack admission fixtures; license review, actual pack indexing/application budgets, pthread status/log capture, and transport-to-libgit2 integration remain. Git fetch/clone are intentionally disabled, and neither candidate is registered as a shell command or listed as supported.

## SDK Packaging

- The current SDK package has browser-native smoke verification, ESM/CJS/types packaging evidence, consumer bundler matrix coverage, and quickstart documentation.
- Stable external publish still requires release checklist and fingerprint reconfirmation at publish time.
- Framework consumer matrices beyond the documented Vite/Webpack/Rspack/Next smoke coverage remain future expansion scope.
- File-system convenience, package-manager, port-discovery, project import/export, and tracing APIs are not stable root SDK contracts yet.

## Service Backend

- Self-hosted v1 uses PostgreSQL for authoritative metadata and S3-compatible object storage for immutable Project Bundles. The local OPFS layer is a draft/runtime cache and is not the server source of truth.
- Local administrator-managed identity, Workspace/Project authorization, invitations, optional TOTP MFA, and multiple instance-wide OIDC providers are included. Public self-registration, WebAuthn/passkeys, billing, managed cloud hosting, and a vendor-operated control plane are not included.
- Project secret or environment-variable injection into browser-executed code is intentionally not provided because workspace collaborators and browser code could observe those values.
- The authoritative deployment combinations and known limitations are published in [Self-hosted v1 support matrix](./self-hosted-v1-support-matrix.md).

## Operations

- OPFS-like storage, snapshot recovery, multi-tab writer conflict, quota behavior, and import/export recovery have productization fixtures. Broader browser-matrix expansion remains future release hardening.
- Soak covers 1000 boot/run/teardown iterations in Chrome headless for the P15-03 gate.
- PG20 passed. External deployment or registry publish is allowed only after final release checklist/fingerprint reconfirmation.
