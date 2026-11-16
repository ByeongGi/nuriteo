import type { ApiItem } from "./types.ts";

export const containerApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "createContainer", signature: "createContainer(options: NuriteoOptions): Nuriteo", text: "`systemWorkerUrl`, `processWorkerUrl`, `systemWasmUrl`로 워커와 WASM을 지정합니다. `services`로 어댑터를 넘깁니다." },
    { name: "boot", signature: "boot(options?: { timeoutMs?: number }): Promise<ReadyMessage>", text: "런타임을 부팅합니다. 반환의 `protocolVersion`으로 프로토콜을 확인합니다." },
    { name: "run", signature: "run(source: string, options?: { entrypoint?: string; timeoutMs?: number }): Promise<RuntimeRunResult>", text: "`entrypoint`로 준비된 입구를 실행합니다. 런타임 안의 임의 JavaScript 평가는 막혀 있으므로 `source` 문자열은 실행되지 않습니다. `ok`가 거짓이면 `error`를 봅니다." },
    { name: "status", signature: "status: \"idle\" | \"booting\" | \"ready\" | \"failed\" | \"stopped\"", text: "현재 런타임 상태입니다." },
    { name: "metrics", signature: "metrics: RuntimeMetrics", text: "부팅 횟수, 종료 횟수, 활성 워커, 대기 중인 요청을 읽습니다." },
    { name: "systemMetrics", signature: "systemMetrics(options?: { timeoutMs?: number }): Promise<MessageDetails>", text: "시스템 워커의 메트릭을 요청합니다." },
    { name: "teardown", signature: "teardown(): Promise<void>", text: "워커를 멈추고 상태를 정리합니다." },
    { name: "services", signature: "services: NuriteoServices", text: "파일, 패키지, 미리보기, 프로젝트, 프로세스 API가 이 객체에 있습니다." }
  ],
  en: [
    { name: "createContainer", signature: "createContainer(options: NuriteoOptions): Nuriteo", text: "Pass `systemWorkerUrl`, `processWorkerUrl`, and `systemWasmUrl` for the workers and WASM. Pass adapters through `services`." },
    { name: "boot", signature: "boot(options?: { timeoutMs?: number }): Promise<ReadyMessage>", text: "Boots the runtime. Read `protocolVersion` on the result to see the protocol." },
    { name: "run", signature: "run(source: string, options?: { entrypoint?: string; timeoutMs?: number }): Promise<RuntimeRunResult>", text: "Runs a prepared entry through `entrypoint`. Arbitrary JavaScript evaluation inside the runtime is disabled, so the `source` string does not execute. Read `error` when `ok` is false." },
    { name: "status", signature: "status: \"idle\" | \"booting\" | \"ready\" | \"failed\" | \"stopped\"", text: "The current runtime state." },
    { name: "metrics", signature: "metrics: RuntimeMetrics", text: "Reads boot count, teardown count, active workers, and pending requests." },
    { name: "systemMetrics", signature: "systemMetrics(options?: { timeoutMs?: number }): Promise<MessageDetails>", text: "Requests metrics from the system worker." },
    { name: "teardown", signature: "teardown(): Promise<void>", text: "Stops the workers and clears the runtime." },
    { name: "services", signature: "services: NuriteoServices", text: "Files, packages, Preview, projects, and processes live on this object." }
  ]
};

export const filesystemApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "readFile", signature: "readFile(path: string): Promise<Uint8Array | string>", text: "파일 내용을 읽습니다. 경로는 비어 있을 수 없습니다." },
    { name: "writeFile", signature: "writeFile(path: string, data: Uint8Array | string): Promise<void>", text: "파일에 바이트 또는 문자열을 씁니다." },
    { name: "readdir", signature: "readdir(path: string): Promise<NuriteoFileEntry[]>", text: "각 항목은 `path`, `type`(`file`, `directory`, `symlink`), 선택적인 `size`를 가집니다." },
    { name: "mkdir", signature: "mkdir(path: string, options?: { recursive?: boolean }): Promise<void>", text: "디렉터리를 만듭니다. 어댑터에 `mkdir`가 없으면 호출은 실패합니다." },
    { name: "rm", signature: "rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>", text: "파일이나 디렉터리를 지웁니다. 어댑터에 `rm`이 없으면 호출은 실패합니다." },
    { name: "watch", signature: "watch(path: string, listener): () => void", text: "반환한 함수를 호출하면 감시를 멈춥니다. 이벤트 `type`은 `create`, `change`, `delete`, `rename`입니다." }
  ],
  en: [
    { name: "readFile", signature: "readFile(path: string): Promise<Uint8Array | string>", text: "Reads a file. The path cannot be empty." },
    { name: "writeFile", signature: "writeFile(path: string, data: Uint8Array | string): Promise<void>", text: "Writes bytes or a string." },
    { name: "readdir", signature: "readdir(path: string): Promise<NuriteoFileEntry[]>", text: "Each entry has `path`, `type` (`file`, `directory`, or `symlink`), and an optional `size`." },
    { name: "mkdir", signature: "mkdir(path: string, options?: { recursive?: boolean }): Promise<void>", text: "Creates a directory. The call fails when the adapter has no `mkdir`." },
    { name: "rm", signature: "rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>", text: "Removes a file or directory. The call fails when the adapter has no `rm`." },
    { name: "watch", signature: "watch(path: string, listener): () => void", text: "Call the returned function to stop watching. Event `type` is `create`, `change`, `delete`, or `rename`." }
  ]
};

export const packagesApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "install", signature: "install(options?: { packageManager?: \"npm\" | \"pnpm\" | \"yarn\"; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoCommandResult>", text: "프로젝트가 선언한 패키지를 설치합니다. `packageManager`를 생략하면 어댑터가 매니저를 고릅니다." },
    { name: "run", signature: "run(script: string, options?: { args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoCommandResult>", text: "패키지 스크립트를 실행합니다. `script`는 비어 있을 수 없습니다." },
    { name: "exec", signature: "exec(binary: string, options?: { args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoCommandResult>", text: "바이너리를 실행합니다. 결과는 `command`, `exitCode`, `stdout`, `stderr`입니다." }
  ],
  en: [
    { name: "install", signature: "install(options?: { packageManager?: \"npm\" | \"pnpm\" | \"yarn\"; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoCommandResult>", text: "Installs the packages the project declares. Omit `packageManager` to let the adapter choose." },
    { name: "run", signature: "run(script: string, options?: { args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoCommandResult>", text: "Runs a package script. `script` cannot be empty." },
    { name: "exec", signature: "exec(binary: string, options?: { args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoCommandResult>", text: "Runs a binary. The result is `command`, `exitCode`, `stdout`, and `stderr`." }
  ]
};

export const processesApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "spawn", signature: "spawn(options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoProcessHandle>", text: "`command`는 비어 있을 수 없습니다. 핸들의 `pid`로 프로세스를 구분합니다." },
    { name: "wait", signature: "wait(): Promise<NuriteoCommandResult>", text: "종료를 기다립니다. 결과는 `exitCode`, `stdout`, `stderr`입니다." },
    { name: "kill", signature: "kill(signal?: \"SIGINT\" | \"SIGTERM\" | \"SIGKILL\"): Promise<void> | void", text: "프로세스에 신호를 보냅니다." },
    { name: "write", signature: "write?(data: string): Promise<void> | void", text: "표준 입력에 문자열을 씁니다. 어댑터 핸들에 `write`가 있을 때만 있습니다." },
    { name: "resize", signature: "resize?(columns: number, rows: number): Promise<void> | void", text: "터미널 크기를 바꿉니다. 어댑터 핸들에 `resize`가 있을 때만 있습니다." }
  ],
  en: [
    { name: "spawn", signature: "spawn(options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<NuriteoProcessHandle>", text: "`command` cannot be empty. `pid` on the handle identifies the process." },
    { name: "wait", signature: "wait(): Promise<NuriteoCommandResult>", text: "Waits for exit. The result carries `exitCode`, `stdout`, and `stderr`." },
    { name: "kill", signature: "kill(signal?: \"SIGINT\" | \"SIGTERM\" | \"SIGKILL\"): Promise<void> | void", text: "Sends a signal to the process." },
    { name: "write", signature: "write?(data: string): Promise<void> | void", text: "Writes a string to standard input. Present only when the adapter handle implements `write`." },
    { name: "resize", signature: "resize?(columns: number, rows: number): Promise<void> | void", text: "Changes the terminal size. Present only when the adapter handle implements `resize`." }
  ]
};

export const previewApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "ports", signature: "ports(): Promise<NuriteoPreviewPort[]>", text: "열린 포트를 읽습니다. 각 항목은 `port`, `protocol`(`http` 또는 `https`), `url`, 선택적인 `label`입니다." },
    { name: "setPreviewScript", signature: "setPreviewScript(script: string | null): Promise<void>", text: "미리보기 스크립트를 바꾸거나 `null`로 지웁니다." },
    { name: "subscribe", signature: "subscribe(listener: (event: NuriteoPreviewEvent) => void): () => void", text: "이벤트 `type`은 `port`, `server-ready`, `server-close`입니다. 반환한 함수로 구독을 끊습니다." },
    { name: "resolveNuriteoWorkerAssets", signature: "resolveNuriteoWorkerAssets(baseUrl: string | URL): { systemWorkerUrl, processWorkerUrl, systemWasmUrl }", text: "`systemWasmUrl`은 `assets/system_wasm.wasm`을 가리킵니다. 주소는 `baseUrl` 기준으로 계산합니다." },
    { name: "registerNuriteoPreviewServiceWorker", signature: "registerNuriteoPreviewServiceWorker({ scriptUrl, scope? }): Promise<ServiceWorkerRegistration>", text: "미리보기 서비스 워커 주소는 `scriptUrl`로 넘깁니다. 서비스 워커가 없으면 `ESDK_SERVICE_WORKER_UNAVAILABLE`, 등록이 실패하면 `ESDK_SERVICE_WORKER_REGISTRATION_FAILED`입니다." }
  ],
  en: [
    { name: "ports", signature: "ports(): Promise<NuriteoPreviewPort[]>", text: "Reads open ports. Each item has `port`, `protocol` (`http` or `https`), `url`, and an optional `label`." },
    { name: "setPreviewScript", signature: "setPreviewScript(script: string | null): Promise<void>", text: "Sets the Preview script, or clears it with `null`." },
    { name: "subscribe", signature: "subscribe(listener: (event: NuriteoPreviewEvent) => void): () => void", text: "Event `type` is `port`, `server-ready`, or `server-close`. Call the returned function to unsubscribe." },
    { name: "resolveNuriteoWorkerAssets", signature: "resolveNuriteoWorkerAssets(baseUrl: string | URL): { systemWorkerUrl, processWorkerUrl, systemWasmUrl }", text: "`systemWasmUrl` points at `assets/system_wasm.wasm`. URLs are resolved from `baseUrl`." },
    { name: "registerNuriteoPreviewServiceWorker", signature: "registerNuriteoPreviewServiceWorker({ scriptUrl, scope? }): Promise<ServiceWorkerRegistration>", text: "Pass the preview service worker as `scriptUrl`. Missing support throws `ESDK_SERVICE_WORKER_UNAVAILABLE`. A failed registration throws `ESDK_SERVICE_WORKER_REGISTRATION_FAILED`." }
  ]
};

export const projectsApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "export", signature: "export(): Promise<Uint8Array>", text: "프로젝트 어댑터가 묶음 바이트를 만듭니다." },
    { name: "import", signature: "import(archive: Uint8Array | ArrayBuffer | string): Promise<void>", text: "같은 어댑터가 묶음을 다시 읽습니다. 어댑터가 없으면 호출은 실패합니다." }
  ],
  en: [
    { name: "export", signature: "export(): Promise<Uint8Array>", text: "The project adapter produces the bundle bytes." },
    { name: "import", signature: "import(archive: Uint8Array | ArrayBuffer | string): Promise<void>", text: "The same adapter reads a bundle back. The call fails without that adapter." }
  ]
};

export const webcontainerApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "createNuriteoWebContainer", signature: "createNuriteoWebContainer(options?: { coep?: \"require-corp\" | \"credentialless\" | \"none\"; workdirName?: string; services?; lifecycle? }): NuriteoWebContainer", text: "`coep` 기본값은 `require-corp`입니다. `workdir` 기본 경로는 `/workspace`입니다." },
    { name: "boot", signature: "boot(): Promise<NuriteoWebContainer>", text: "미리보기 어댑터가 없어도 부팅은 진행됩니다. 미리보기 이벤트만 오지 않습니다. 그 밖의 생명주기 실패는 `ESDK_LIFECYCLE_FAILED`입니다." },
    { name: "mount", signature: "mount(tree | snapshot, options?: { mountPoint?: string }): Promise<void>", text: "`createNuriteoMountSnapshot()`의 파일은 문자열 `path`와 `contents`입니다. 스키마가 다르면 `ESDK_INVALID_ARGUMENT`입니다." },
    { name: "spawn", signature: "spawn(command: string, args?: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<NuriteoProcessHandle>", text: "작업 디렉터리를 생략하면 `workdir`에서 실행합니다." },
    { name: "on", signature: "on(event: \"port\" | \"server-ready\" | \"server-close\", listener): () => void", text: "미리보기 이벤트를 구독합니다. 반환한 함수로 리스너를 제거합니다." },
    { name: "fs", signature: "fs.readFile / writeFile / readdir / mkdir / rm / watch", text: "`writeFile`의 `createParents: true`는 부모 디렉터리를 만든 뒤 씁니다." },
    { name: "teardown", signature: "teardown(): Promise<void>", text: "구독과 리스너를 지우고 생명주기 `teardown`을 호출합니다." }
  ],
  en: [
    { name: "createNuriteoWebContainer", signature: "createNuriteoWebContainer(options?: { coep?: \"require-corp\" | \"credentialless\" | \"none\"; workdirName?: string; services?; lifecycle? }): NuriteoWebContainer", text: "The default `coep` is `require-corp`. The default `workdir` is `/workspace`." },
    { name: "boot", signature: "boot(): Promise<NuriteoWebContainer>", text: "Boot still proceeds without a Preview adapter. Preview events are the part that stays quiet. Other lifecycle failures throw `ESDK_LIFECYCLE_FAILED`." },
    { name: "mount", signature: "mount(tree | snapshot, options?: { mountPoint?: string }): Promise<void>", text: "Files from `createNuriteoMountSnapshot()` need a string `path` and `contents`. A different schema throws `ESDK_INVALID_ARGUMENT`." },
    { name: "spawn", signature: "spawn(command: string, args?: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<NuriteoProcessHandle>", text: "Omitting the working directory runs the command in `workdir`." },
    { name: "on", signature: "on(event: \"port\" | \"server-ready\" | \"server-close\", listener): () => void", text: "Subscribes to a Preview event. Call the returned function to remove the listener." },
    { name: "fs", signature: "fs.readFile / writeFile / readdir / mkdir / rm / watch", text: "`writeFile` with `createParents: true` creates the parent directory before writing." },
    { name: "teardown", signature: "teardown(): Promise<void>", text: "Clears subscriptions and listeners, then calls lifecycle `teardown`." }
  ]
};

export const errorApi: Record<"ko" | "en", ApiItem[]> = {
  ko: [
    { name: "ESDK_ADAPTER_MISSING", signature: "SdkError", text: "그 호출에 필요한 어댑터가 없습니다." },
    { name: "ESDK_INVALID_ARGUMENT", signature: "SdkError", text: "인자 형태가 API와 다릅니다. 마운트 스냅샷의 스키마가 잘못된 경우가 여기 해당합니다." },
    { name: "ESDK_LIFECYCLE_FAILED", signature: "SdkError", text: "WebContainer 부팅이나 종료의 생명주기가 실패했습니다." },
    { name: "ESDK_PATH_INVALID", signature: "SdkError", text: "경로 조각이 비어 있거나 경로가 루트 밖으로 나갑니다." },
    { name: "ESDK_SERVICE_WORKER_UNAVAILABLE", signature: "SdkError", text: "이 환경에는 서비스 워커가 없습니다." },
    { name: "ESDK_SERVICE_WORKER_REGISTRATION_FAILED", signature: "SdkError", text: "미리보기 서비스 워커 등록이 실패했습니다." },
    { name: "ESDK_SYMLINK_UNSUPPORTED", signature: "SdkError", text: "이 런타임은 심볼릭 링크를 만들지 않습니다." }
  ],
  en: [
    { name: "ESDK_ADAPTER_MISSING", signature: "SdkError", text: "The adapter required by that call is missing." },
    { name: "ESDK_INVALID_ARGUMENT", signature: "SdkError", text: "The argument shape does not match the API. A mount snapshot with the wrong schema lands here." },
    { name: "ESDK_LIFECYCLE_FAILED", signature: "SdkError", text: "WebContainer boot or teardown failed in its lifecycle." },
    { name: "ESDK_PATH_INVALID", signature: "SdkError", text: "A path segment is empty, or the path escapes its root." },
    { name: "ESDK_SERVICE_WORKER_UNAVAILABLE", signature: "SdkError", text: "This environment has no service worker." },
    { name: "ESDK_SERVICE_WORKER_REGISTRATION_FAILED", signature: "SdkError", text: "Preview service worker registration failed." },
    { name: "ESDK_SYMLINK_UNSUPPORTED", signature: "SdkError", text: "This runtime does not create symbolic links." }
  ]
};
