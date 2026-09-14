# Browser-Native WebContainer Runtime 연구 및 개발 컨텍스트

이 문서는 StackBlitz WebContainers, CodeSandbox Sandpack 2.0 / Nodebox, 그리고 관련 오픈소스 프로젝트를 참고하여 브라우저 안에서 서버 없이 개발 환경을 실행하는 Browser-Native Runtime을 연구/구현하기 위한 독립 컨텍스트 문서다.

다른 세션에 그대로 복사하거나 업로드해서 이어서 작업할 수 있도록, 지금까지 논의한 기술 판단, 아키텍처 방향, 참고 프로젝트, MVP 단계, 성공 기준을 하나의 Markdown 문서로 정리한다.

---

## 1. 프로젝트 목표

목표는 브라우저 안에서 로컬 서버나 원격 VM 없이 개발 환경을 실행할 수 있는 오픈소스 Browser-Native Runtime을 연구하고 구현하는 것이다.

단순히 StackBlitz WebContainers API를 복제하는 것이 아니라, 브라우저를 하나의 실행 환경으로 보고 그 위에 다음과 같은 시스템을 구성한다.

```text
Browser
  │
  ├── Virtual File System
  ├── Process / IPC
  ├── Shell
  ├── Package Manager
  ├── Module Resolver
  ├── JavaScript Runtime
  ├── Node Compatibility Layer
  ├── WASI Runtime
  ├── Virtual Networking
  └── Dev Server / Preview
```

최종적으로 제공하고 싶은 경험은 다음과 같다.

```bash
npm install

node index.js

npm run dev
```

그리고 장기적으로는 Node 전용 runtime을 넘어 WASI 기반 runtime으로 확장 가능한 구조를 고려한다.

---

## 2. StackBlitz WebContainers 이해

WebContainers는 단순한 JavaScript sandbox가 아니다. 공개 자료에서 StackBlitz는 WebContainers를 WebAssembly 기반 OS/kernel 또는 micro-operating-system에 가까운 개념으로 설명한다.

개념적인 구조는 다음과 같다.

```text
Application
     │
     ▼
Node.js Runtime
     │
     ▼
Node / OS Interface
     │
     ▼
WebContainer Kernel
     │
     ├── Virtual FS
     ├── Process
     ├── Network
     ├── stdin/stdout
     └── OS abstractions
     │
     ▼
WebAssembly
     │
SharedArrayBuffer
Atomics
Workers
Service Workers
     │
     ▼
Browser
```

중요한 점은 실제 Linux VM이나 Docker container가 서버에서 실행되는 구조가 아니라는 것이다. 상당한 runtime이 사용자의 브라우저 CPU/RAM에서 실행된다.

즉 역설계 관점에서 보면 핵심 질문은 다음과 같다.

```text
                    Node.js
                       │
              ┌────────┴────────┐
              │                 │
            V8 API          OS / libuv API
              │                 │
              ▼                 ▼
      Browser JS Engine     WebContainer
                              Kernel
                                │
                       WebAssembly / SAB
                                │
                         Browser APIs
```

V8 쪽은 브라우저 엔진을 최대한 활용하면서, Node가 기대하는 OS/libuv 쪽 환경을 WebAssembly 기반 kernel이 제공하는 방향일 가능성이 높다. 정확한 구현은 공개되어 있지 않으므로 이 부분은 공개 자료 기반의 추정 영역이다.

---

## 3. 핵심 Browser Technology

WebContainers 계열 runtime에서 중요하게 등장하는 브라우저 기술은 다음과 같다.

```text
WebAssembly
SharedArrayBuffer
Atomics
Web Workers
Service Workers
Streams API
Fetch API
iframe
Cross-Origin Isolation
```

특히 SharedArrayBuffer가 중요하다. 여러 Worker 사이의 shared memory 및 synchronization을 위해 사용되며, 일반적으로 다음과 같은 cross-origin isolation 설정이 필요하다.

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

개념적인 구조는 다음과 같다.

```text
Runtime Worker
      │
      │ SharedArrayBuffer
      ▼
Kernel / IO Worker
      │
      ▼
Browser APIs
```

Node의 synchronous API와 Browser의 asynchronous API를 연결할 때 이 구조가 특히 중요해진다.

---

## 4. 가장 어려운 문제: Sync Node API vs Async Browser API

Node에는 synchronous API가 많다.

```js
fs.readFileSync(...)
fs.writeFileSync(...)
```

하지만 Browser API는 대체로 Promise 기반이다.

```js
await fileHandle.getFile()
await writable.write(data)
await fetch(url)
```

따라서 다음 문제가 생긴다.

```text
Node

readFileSync()
     │
     │ synchronous
     ▼
Runtime
     │
     X
     │
Browser API
     │ asynchronous
     ▼
Promise
```

이를 해결하는 한 가지 방법은 Worker + SharedArrayBuffer + Atomics 기반 syscall bridge다.

```text
JS Runtime Worker

fs.readFileSync()

       ↓

runtime syscall

       ↓

SharedArrayBuffer

       ↓

IO Worker

       ↓

Browser async API

       ↓

Atomics.notify()

       ↓

JS execution resume
```

조금 더 구체화하면 다음과 같다.

```text
QuickJS / Runtime Worker

readFileSync()
    │
    ▼
sync syscall request
    │
    ▼
write request into SharedArrayBuffer
    │
    ▼
Atomics.wait()
    │
    │          Kernel / IO Worker
    │                │
    │                ▼
    │        read request from SAB
    │                │
    │                ▼
    │        Browser async IO
    │                │
    │                ▼
    │        write response into SAB
    │                │
    │                ▼
    └──────── Atomics.notify()

execution resumes with result
```

이 sync/asynchronous impedance mismatch가 WebContainer류 runtime의 가장 중요한 기술 난제 중 하나다.

대안은 세 가지다.

```text
1. async only
   - 구현은 단순하지만 Node compatibility가 크게 낮아진다.

2. SharedArrayBuffer + Atomics
   - sync API를 재현할 수 있지만 crossOriginIsolated 환경이 필요하다.

3. Asyncify / continuation transform
   - 일부 경우 가능하지만 runtime 전체 복잡도가 커진다.
```

현재 가장 유력한 방향은 capability에 따라 Lite/Full runtime을 나누는 것이다.

---

## 5. Virtual File System

Browser-native runtime의 가장 기본적인 subsystem은 VFS다.

예를 들어 다음 구조가 실제 OS filesystem이 아니라 Browser runtime 내부에 존재한다.

```text
/
├── package.json
├── src/
│   └── index.js
└── node_modules/
```

Node 호출 흐름은 다음과 같이 생각할 수 있다.

```text
fs.readFileSync()

       ↓

Node Compatibility Layer

       ↓

Kernel FS API

       ↓

VFS

       ↓

MemoryFS / OPFS / IndexedDB
```

Rust core를 만든다면 VFS는 Rust로 구현할 가치가 높은 영역이다.

예시 kernel interface:

```rust
pub trait FileSystem {
    fn open(
        &mut self,
        path: &str,
        flags: OpenFlags,
    ) -> Result<FileDescriptor>;

    fn read(
        &mut self,
        fd: FileDescriptor,
        buf: &mut [u8],
    ) -> Result<usize>;

    fn write(
        &mut self,
        fd: FileDescriptor,
        buf: &[u8],
    ) -> Result<usize>;

    fn close(
        &mut self,
        fd: FileDescriptor,
    ) -> Result<()>;
}
```

Node의:

```js
fs.readFileSync("/foo.txt")
```

는 내부적으로:

```text
Node fs.readFileSync()

        ↓

Node compatibility layer

        ↓

kernel.open()
kernel.read()
kernel.close()

        ↓

VFS

        ↓

MemoryFS / OPFS / IndexedDB
```

처럼 내려갈 수 있다.

VFS의 초기 범위는 다음과 같다.

```text
open
read
write
close
mkdir
readdir
stat
unlink
rename
cwd
path normalization
file descriptors
mount points
```

---

## 6. Process Abstraction

Linux의 실제 fork/exec process를 그대로 구현할 필요는 없다. 필요한 것은 application이 관찰하는 process behavior다.

프로세스 모델은 다음 정도로 시작할 수 있다.

```text
Process

├── PID
├── parent
├── cwd
├── env
├── stdin
├── stdout
├── stderr
├── exit code
├── state
└── signal
```

Rust 구조체 예시는 다음과 같다.

```rust
pub struct Process {
    pub pid: Pid,
    pub parent: Option<Pid>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub stdin: FileDescriptor,
    pub stdout: FileDescriptor,
    pub stderr: FileDescriptor,
    pub state: ProcessState,
}
```

spawn API는 다음처럼 설계할 수 있다.

```rust
pub async fn spawn(
    &mut self,
    command: &str,
    args: &[String],
) -> Result<Pid>
```

외부 API는 WebContainers와 유사하게 노출할 수 있다.

```ts
const p = await container.spawn("node", [
  "index.js",
]);
```

내부적으로는 OS process가 아니라 runtime task, worker, module execution, WASM instance, QuickJS context 등으로 구현할 수 있다.

---

## 7. Pipe / IPC / Shell

개발 환경처럼 보이려면 shell과 pipe도 중요하다.

초기 shell 목표:

```bash
echo hello
cat /hello.txt
echo hello | grep hell
```

구조:

```text
Shell
  │
  ├── lexer
  ├── parser
  ├── command runner
  ├── builtins
  ├── pipeline
  └── process manager
```

pipe는 file descriptor abstraction 위에 올리는 것이 좋다.

```text
Process A stdout
      │
      ▼
Pipe buffer
      │
      ▼
Process B stdin
```

초기에는 완전한 POSIX shell이 아니라 개발 환경에 필요한 최소 shell로 시작한다.

---

## 8. Virtual Networking

Node application에서는 다음이 가능해야 한다.

```js
app.listen(3000);
```

하지만 Browser에서는 Linux의 bind/listen/accept socket을 그대로 열 필요가 없다.

대신 observable behavior를 재현한다.

```text
Express / Vite

server.listen(3000)

       ↓

Node HTTP Compatibility

       ↓

Virtual HTTP Server

       ↓

Service Worker / Browser Router

       ↓

Preview iframe
```

Preview 구조는 다음과 같다.

```text
Application HTTP Server
         │
         ▼
Virtual Port Table
         │
         ▼
Service Worker
         │
         ▼
iframe / preview URL
```

초기 목표는 raw TCP/UDP socket이 아니라 HTTP server compatibility다.

---

## 9. Sandpack 2.0 / Nodebox 방향

Sandpack 2.0에서 중요한 기술은 Nodebox다.

Nodebox는 browser-native Node-compatible runtime이다. 핵심 철학은 다음과 같다.

```text
Node.js feature parity보다 application compatibility를 우선한다.
```

즉 Node.js 내부를 완전히 복제하지 않는다. 목표는 다음이다.

```text
Next.js
Vite
Astro
Express
npm packages

       ↓

Node-compatible APIs

       ↓

Browser Runtime
```

잘못된 목표:

```text
Node.js를 100% 구현한다.
```

현실적인 목표:

```text
Vite가 실행되는가?
Next가 실행되는가?
Express가 실행되는가?
주요 npm package가 실행되는가?
```

즉 implementation compatibility가 아니라 application compatibility를 테스트 기준으로 삼는다.

---

## 10. WebContainers와 Nodebox의 차이

개념적으로 WebContainers는 다음에 가깝다.

```text
WebContainers

Application
     ↓
Node
     ↓
WebAssembly-based OS/kernel
     ↓
Browser
```

반면 Nodebox는 다음에 가깝다.

```text
Nodebox

Application
     ↓
Node-compatible Runtime
     ↓
Browser
```

즉 중간의 OS/POSIX compatibility layer를 상당 부분 제거한다.

Nodebox 계열에서 제한될 수 있는 기능:

```text
N-API native modules
raw external sockets
synchronous exec/spawn
일부 Node APIs
완전한 Unix compatibility
```

그 대신 실제 JavaScript application compatibility를 우선한다.

우리 프로젝트도 이 방향을 참고해야 한다.

```text
Application Compatibility
        >
OS Compatibility
```

즉:

```text
fork()를 완벽하게 구현했는가?
```

보다:

```text
npm install vite
npm run dev
```

가 실제로 동작하는지가 더 중요하다.

---

## 11. Rust/WASM의 역할

Sandpack/Nodebox 전체가 Rust로 만들어진 것은 아니다. 다만 performance-critical/system-oriented 부분을 Rust/WASM으로 이동시키는 방향이 중요하다.

브라우저에서 실제 프로젝트를 실행하면 병목은 단순한 `console.log()` 실행이 아니라 다음 파이프라인에 있다.

```text
package.json
     ↓
dependency resolution
     ↓
수백~수천 packages
     ↓
수천~수만 modules/files
     ↓
module graph
     ↓
TS / JSX / ESM / CJS transform
     ↓
execution
```

Rust가 잘 맞는 영역은 다음과 같다.

```text
VFS
Module Resolver
Dependency Resolver
Package Manager
Dependency Graph
Transpiler
Cache
Snapshot
Process Table
IPC
HTTP Routing
WASI host layer
```

따라서 Rust를 "Node.js를 다시 만드는 언어"로 쓰기보다는 Browser Runtime Kernel의 구현 언어로 보는 것이 좋다.

```text
                 TypeScript
                     │
            Developer-facing API
                     │
                     ▼
              ┌────────────┐
              │ Rust Kernel│
              └─────┬──────┘
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
    VFS          Process        Resolver
     │              │              │
     └──────────────┼──────────────┘
                    ▼
                   WASM
                    │
                    ▼
                 Browser
```

---

## 12. npm / Package Installation

브라우저에서 실제 npm CLI가 PC와 똑같은 작업을 반복하도록 만들 필요는 없다.

Nodebox/Sandpack 계열에서는 CDN, cache, dependency manager를 적극 활용한다.

개념적으로:

```text
package.json

      ↓

Dependency Resolver

      ↓

Package Graph

      ↓

CDN / Registry / Cache

      ↓

Browser VFS
```

목표는:

```text
npm 자체를 완벽하게 emulate
```

하는 것이 아니라:

```text
npm ecosystem의 결과를 효율적으로 runtime에 공급
```

하는 것이다.

초기 package manager는 다음 기능부터 시작한다.

```text
package.json parse
semver resolution
registry metadata fetch
tarball download / unpack
node_modules layout
package exports resolution
cache
```

장기적으로는 lockfile, pnpm-style store, CDN integration, dependency graph snapshot을 고려한다.

---

## 13. JavaScript Engine 선택

Rust kernel과 별도로 JavaScript engine을 어떻게 제공할지 결정해야 한다.

### A. Browser native JS engine

```text
Chrome  → V8
Safari  → JavaScriptCore
Firefox → SpiderMonkey
```

장점:

```text
빠름
별도 JS VM 필요 없음
브라우저 최적화 활용
```

단점:

```text
isolation이 어려움
sync Node API 구현이 까다로움
process abstraction이 어려움
syscall interception이 어려움
```

### B. QuickJS WASM

```text
Browser
   ↓
WASM
   ↓
QuickJS
   ↓
Node compatibility
```

장점:

```text
runtime 완전 제어 가능
isolation 용이
syscall interception 용이
snapshot 가능성
sync API 구현에 유리
```

단점:

```text
V8/Node compatibility 문제
performance 부담
추가 메모리 사용
native Node semantics 차이
```

### C. Rust JS Engine

예: Boa 같은 Rust JS engine.

장점:

```text
Rust-only kernel과 통합하기 좋음
host integration을 직접 설계 가능
```

단점:

```text
Node/V8 compatibility 부담이 큼
성능과 ecosystem 검증이 어려움
```

초기 prototype에는 QuickJS 계열이 유력하다. 이유는 sync syscall과 isolation을 제어하기 쉽기 때문이다.

```text
Rust Kernel
    │
    ├── VFS
    ├── Process
    ├── Pipe
    ├── Network
    │
    ▼
QuickJS
    │
    ▼
Node Compatibility
    │
    ▼
user JS
```

---

## 14. WASI / WASIX 확장 방향

Node 전용 runtime으로 설계하지 않는 것도 중요하다.

Rust kernel을 중심으로 다음처럼 확장할 수 있다.

```text
                    Rust Kernel
                         │
           ┌─────────────┼─────────────┐
           │             │             │
        JS Runtime    WASI Runtime    Shell
           │             │             │
       Node Compat      WASM          CLI
           │             │             │
           └─────────────┼─────────────┘
                         │
                        VFS
                         │
                   Process / IPC
                         │
                      Network
```

장기적으로:

```bash
node index.js
python main.py
sqlite3 db.sqlite
wasm-tool ...
```

같은 형태로 확장할 수 있다.

이 방향은 WebContainers 복제보다 더 넓은 의미의 browser-native POSIX-ish runtime에 가깝다.

---

## 15. 참고 프로젝트: Rust/WASM 계열

### Wasmer / WASIX

Rust 기반 WebAssembly runtime.

특히 WASIX는 WASI를 확장하여 Unix-like 기능을 제공한다.

```text
threads
signals
process
socket
TCP/UDP
chdir
fork/vfork
exec/wait
TTY
pipe
polling
```

Rust 기반 Browser Runtime을 만들 경우 반드시 분석할 가치가 있다.

참고할 점:

```text
WASI host calls
filesystem abstraction
process abstraction
socket model
threading model
capability-based APIs
```

### wasmsh

Rust로 작성된 browser-first shell runtime.

참고할 부분:

```text
Shell
VFS
Pipe
Process execution
CLI utilities
WASM
Web Worker
```

### WOS

Rust 기반 WebAssembly microkernel/OS 프로젝트.

참고 영역:

```text
Process
Memory
IPC
Filesystem
Syscall
Snapshot
/proc
```

### wasi-fs-access

WASI synchronous filesystem과 Browser asynchronous File System API를 연결하는 참고 구현.

특히 다음 문제를 이해하는 데 유용하다.

```text
WASI expects sync filesystem calls

Browser File System Access API is async

sync ↔ async bridge required
```

### Vivari

WebContainer alternative를 목표로 하는 프로젝트.

일부 fundamental component에 Rust/WASM을 사용한다.

참고 영역:

```text
VFS
codec
crypto
Atomics
Node compatibility
browser runtime
```

---

## 16. 참고 프로젝트: JavaScript / TypeScript 계열

### OpenContainers

WebContainers clean-room compatibility 구현을 목표로 하는 프로젝트.

참고할 부분:

```text
WebContainer-compatible API
VFS
Node-like runtime
npm
Service Worker
Preview
```

개념 구조:

```text
OpenContainers
│
├── packages/embed
│      WebContainer-compatible API
│
├── packages/runtime-node
│      Node-like runtime
│      Node built-ins
│
├── packages/fs
│      Virtual File System
│
├── packages/npm
│      npm registry / installer
│
├── packages/service-worker
│
└── packages/preview-client
       HTTP preview
```

API 형태:

```js
import { WebContainer } from "opencontainers/webcontainer";

const container = await WebContainer.boot();

await container.mount(files);

const p = await container.spawn("node", [
  "index.js",
]);

container.on("server-ready", (port, url) => {
  iframe.src = url;
});
```

### Lifo

Browser 자체를 kernel처럼 보는 프로젝트.

핵심 철학:

```text
Browser IS the kernel.
Web APIs ARE syscalls.
```

참고할 부분:

```text
VFS
inode
/proc
/dev
Process
Shell
Pipe
Node compatibility
```

개념 구조:

```text
┌─────────────────────────────┐
│        Terminal UI          │
│          xterm.js           │
├─────────────────────────────┤
│          Shell              │
│      bash-like shell        │
├─────────────────────────────┤
│       Core Utilities        │
│ ls / cat / grep / curl ...  │
├─────────────────────────────┤
│ Node Compatibility Layer    │
│ fs/path/http/process/...    │
├─────────────────────────────┤
│            VFS              │
│ inode / proc / dev / ...    │
├─────────────────────────────┤
│        Kernel API           │
├─────────────────────────────┤
│       Browser APIs          │
│ fetch / streams / OPFS ...  │
└─────────────────────────────┘
```

### Nodepack

QuickJS WASM 기반 Node-compatible browser runtime.

참고할 부분:

```text
QuickJS
Node API shim
memfs
module loader
npm downloader
```

구조:

```text
Browser
   │
   ▼
QuickJS WASM
   │
   ├── JavaScript execution
   ├── Node API shim
   ├── memfs
   ├── Module loader
   └── npm downloader
```

MVP를 직접 만들 때 참고하기 좋다.

### quickjs-wasi

WebContainers clone은 아니지만 QuickJS를 WASM으로 브라우저에서도 사용할 수 있는 JavaScript runtime이다.

참고할 부분:

```text
QuickJS
WASM
WASI
snapshot
isolation
host integration
```

snapshot 아이디어:

```text
BrowserContainer Template

Node environment
+ npm packages
+ filesystem
+ runtime state

        ↓

     snapshot

        ↓

새 Container
        ↓
instant restore
```

---

## 17. 참고 프로젝트 조합 전략

직접 만든다면 다음 세 프로젝트의 장점을 섞는 것이 좋다.

```text
               Our WebContainer
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼

      Lifo         Nodepack    OpenContainers
        │             │             │
        ▼             ▼             ▼

   Kernel/VFS      JS Runtime     Public API
   Process         QuickJS        npm
   Shell           WASM           Preview
   POSIX shim      Node shim      ServiceWorker

                      │
                      ▼

                 quickjs-wasi
                      │
                      ▼
                 WASM Runtime
```

목표 구조:

```text
┌─────────────────────────────────────┐
│          WebContainer API           │
│                                     │
│ boot() / mount() / spawn()          │
├─────────────────────────────────────┤
│               Shell                 │
├─────────────────────────────────────┤
│       Node Compatibility Layer      │
│                                     │
│ fs / path / process / http / ...    │
├─────────────────────────────────────┤
│          Process Manager            │
├─────────────────────────────────────┤
│               VFS                   │
│                                     │
│ /home /tmp /node_modules /proc      │
├─────────────────────────────────────┤
│          JavaScript Runtime         │
│                                     │
│             QuickJS                 │
├─────────────────────────────────────┤
│               WASM                  │
├─────────────────────────────────────┤
│           Browser APIs              │
│                                     │
│ Worker / SW / IndexedDB / OPFS      │
│ Fetch / Streams                     │
└─────────────────────────────────────┘
```

핵심 선택지는 다음이다.

```text
WebContainers를 최대한 복제한다.

vs

Lifo의 Kernel/VFS
+ Nodepack의 QuickJS runtime
+ OpenContainers의 WebContainer-compatible API
를 결합한다.
```

현재는 후자가 더 현실적이고 연구 가치가 높다.

---

## 18. Rust Browser Kernel 방향

추천하는 핵심 방향은 다음이다.

```text
Rust Browser Kernel
        +
Application Compatibility
        +
Node Adapter
        +
WASI Adapter
```

Rust core:

```text
╔══════════════════════════════════╗
║            Rust Core             ║
║                                  ║
║ VFS                              ║
║ Process Manager                  ║
║ Pipe / IPC                       ║
║ Module Resolver                  ║
║ Package Resolver                 ║
║ Dependency Graph                 ║
║ Transpiler                       ║
║ Cache / Snapshot                 ║
║ Virtual HTTP                     ║
║ WASI                             ║
╚════════════════╤═════════════════╝
                 │
                WASM
                 │
                 ▼
              Browser
```

TypeScript side:

```text
Node compatibility APIs
Browser bridge
Worker orchestration
Service Worker
Preview
Public API
```

예상 repository 구조:

```text
runtime/
├── crates/
│   ├── kernel/
│   │   ├── fs.rs
│   │   ├── process.rs
│   │   ├── pipe.rs
│   │   ├── ipc.rs
│   │   └── network.rs
│   │
│   ├── vfs/
│   │   ├── memfs.rs
│   │   ├── mount.rs
│   │   ├── path.rs
│   │   └── fd.rs
│   │
│   ├── module_resolver/
│   │   ├── package_json.rs
│   │   ├── exports.rs
│   │   └── node_modules.rs
│   │
│   ├── package_manager/
│   │   ├── registry.rs
│   │   ├── resolver.rs
│   │   ├── installer.rs
│   │   └── cache.rs
│   │
│   ├── wasi/
│   │   ├── fd.rs
│   │   ├── filesystem.rs
│   │   └── syscall.rs
│   │
│   └── wasm_bindings/
│       └── lib.rs
│
├── packages/
│   ├── runtime-api/
│   ├── node-compat/
│   ├── service-worker/
│   ├── preview-client/
│   └── shell/
│
└── examples/
    ├── hello-node/
    ├── fs-sync/
    ├── lodash/
    └── vite/
```

---

## 19. Lite / Full Runtime

Nodebox와 WebContainers의 장점을 결합하기 위해 capability-based runtime을 설계한다.

### Lite Runtime

SharedArrayBuffer가 없어도 동작한다.

```text
Browser APIs
Async runtime
VFS
Module Resolver
Package Manager
Virtual HTTP
```

목표:

```text
React
Vite-lite
Playground
Documentation
Education
Small applications
```

제한:

```text
sync filesystem APIs 제한
일부 Node API 제한
child_process 제한
WASI 제한
```

### Full Runtime

crossOriginIsolated 환경에서는 다음을 사용한다.

```text
SharedArrayBuffer
Atomics
Workers
```

추가 목표:

```text
sync filesystem
stronger process model
better Node compatibility
WASI
CLI
shell
advanced tooling
```

즉 하나의 runtime에서 환경 capability에 따라 기능을 확장한다.

```text
Runtime boot
     │
     ▼
detect capabilities
     │
     ├── no SAB
     │      ▼
     │    Lite Runtime
     │
     └── SAB + crossOriginIsolated
            ▼
          Full Runtime
```

---

## 20. MVP 개발 순서: M0 ~ M10

처음부터 npm/Vite 전체를 구현하지 않는다.

### M0 - Rust/WASM bootstrap

목표:

```text
Rust → WASM → Browser

console.log("hello")
```

산출물:

```text
Rust crate
wasm-bindgen or wasm-pack setup
TypeScript bridge
basic browser demo
```

### M1 - VFS

목표:

```bash
cat /hello.txt
```

구현:

```text
open
read
write
close
mkdir
readdir
stat
path normalization
```

### M2 - Process abstraction

목표:

```text
PID
cwd
env
stdin
stdout
stderr
exit
```

API:

```ts
const process = await runtime.spawn("echo", ["hello"]);
```

### M3 - Shell

목표:

```bash
echo hello
cat file
echo hello | grep hell
```

필요 요소:

```text
lexer
parser
builtins
pipe
stdout/stderr streams
```

### M4 - JavaScript Runtime

목표:

```bash
node hello.js
```

후보:

```text
QuickJS WASM
Browser native JS Worker
```

초기에는 QuickJS 계열이 유력하다.

### M5 - Node compatibility

우선 구현할 built-in:

```text
fs
path
process
buffer
events
stream
util
```

목표 예시:

```js
const fs = require("fs");

fs.writeFileSync("/tmp/test.txt", "hello");
console.log(fs.readFileSync("/tmp/test.txt", "utf8"));
```

### M6 - Module resolver

구현 범위:

```text
ESM
CommonJS
package.json
main
module
exports
node_modules
relative imports
built-in modules
```

### M7 - Package manager

목표:

```bash
npm install lodash
```

구현:

```text
package.json parse
registry metadata
semver
tarball fetch
unpack into VFS
cache
```

### M8 - HTTP

목표:

```js
http.createServer((req, res) => {
  res.end("hello");
}).listen(3000);
```

구조:

```text
Node http
   ↓
Virtual HTTP server
   ↓
Port table
   ↓
Service Worker
```

### M9 - Preview

목표:

```text
Virtual HTTP
      ↓
Service Worker
      ↓
iframe
```

외부 API:

```ts
container.on("server-ready", (port, url) => {
  iframe.src = url;
});
```

### M10 - Vite

초기 최종 milestone:

```bash
npm install vite
npm run dev
```

브라우저 로컬에서 실행되고 preview iframe에서 결과를 볼 수 있어야 한다.

---

## 21. 첫 번째 성공 기준

초기 성공 기준은 매우 작게 잡는다.

```js
const fs = require("fs");

fs.writeFileSync(
  "/tmp/test.txt",
  "hello"
);

console.log(
  fs.readFileSync(
    "/tmp/test.txt",
    "utf8"
  )
);
```

결과:

```text
hello
```

그 다음:

```bash
npm install lodash
node index.js
```

마지막으로:

```bash
npm install vite
npm run dev
```

까지 확장한다.

---

## 22. 현재 가장 중요한 결정사항

다음 세 가지를 먼저 결정해야 한다.

### A. JavaScript Engine

```text
Browser native engine
vs
QuickJS WASM
vs
Rust JS engine
```

현재 추천:

```text
초기 prototype: QuickJS WASM
장기 연구: Browser native JS engine 활용 가능성 검토
```

이유:

```text
QuickJS는 syscall interception과 isolation에 유리하다.
Browser native engine은 성능은 좋지만 sync Node API 구현이 어렵다.
```

### B. Sync syscall architecture

```text
async only
vs
SharedArrayBuffer + Atomics
vs
Asyncify
```

현재 추천:

```text
Lite Runtime: async only + 제한된 Node compatibility
Full Runtime: SharedArrayBuffer + Atomics 기반 sync bridge
```

### C. Kernel scope

```text
Node compatibility runtime
vs
POSIX-like kernel
vs
WASI/WASIX kernel
```

현재 추천:

```text
Rust Browser Kernel
        +
Application Compatibility
        +
Node Adapter
        +
WASI Adapter
```

처음부터 완전한 POSIX나 Linux를 만들지는 않는다. 그러나 VFS, process, pipe, fd, cwd, env 같은 kernel-ish abstraction은 Rust core에 둔다.

---

## 23. 권장 전체 아키텍처

현재 제안하는 전체 구조는 다음과 같다.

```text
                     Application

              Vite / Next / Express
                         │
                         ▼
               Node Compatibility
                         │
                         ▼
               Runtime Adapter API
                         │
         ┌───────────────┼───────────────┐
         │               │               │
      JS Runtime      WASI Runtime      Shell
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
                  Rust Browser Kernel
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
      VFS            Process/IPC      Virtual HTTP
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                         ▼
                    WASM Boundary
                         │
                         ▼
               Browser Capability Layer
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
    Workers       Service Worker       Storage
       │                 │                 │
       ▼                 ▼                 ▼
 SharedArrayBuffer    iframe        OPFS / IndexedDB
 Atomics              preview       MemoryFS
```

좀 더 세부적으로:

```text
┌───────────────────────────────────────────────────────────┐
│                       Public API                          │
│                                                           │
│ boot() / mount() / spawn() / export() / on(server-ready)  │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                  TypeScript Runtime Layer                 │
│                                                           │
│ Worker orchestration                                      │
│ Service Worker registration                               │
│ Preview iframe routing                                    │
│ Streams bridge                                            │
│ Capability detection                                      │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                    Compatibility Layer                    │
│                                                           │
│ Node built-ins: fs/path/process/http/buffer/events/stream │
│ Module system: CJS/ESM                                    │
│ npm package layout                                        │
│ WASI adapter                                              │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                    Rust Browser Kernel                    │
│                                                           │
│ VFS / FD table / Process table / Pipe / IPC               │
│ Resolver / Package graph / Cache / Snapshot               │
│ Virtual HTTP / WASI host calls                            │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                    Browser Substrate                      │
│                                                           │
│ WebAssembly / Workers / SAB / Atomics                     │
│ Service Worker / Fetch / Streams                          │
│ OPFS / IndexedDB / Memory                                 │
└───────────────────────────────────────────────────────────┘
```

---

## 24. API Shape 초안

WebContainers와 유사한 public API를 제공하되 내부 구현은 clean-room으로 가져간다.

```ts
const container = await BrowserContainer.boot({
  runtime: "auto",
});

await container.mount({
  "package.json": {
    file: {
      contents: JSON.stringify({
        scripts: {
          dev: "vite",
        },
        dependencies: {
          vite: "latest",
        },
      }),
    },
  },
  "src/main.js": {
    file: {
      contents: "console.log('hello')",
    },
  },
});

const install = await container.spawn("npm", [
  "install",
]);

install.output.pipeTo(
  new WritableStream({
    write(chunk) {
      console.log(chunk);
    },
  }),
);

const dev = await container.spawn("npm", [
  "run",
  "dev",
]);

container.on("server-ready", (port, url) => {
  iframe.src = url;
});
```

내부 command mapping:

```text
container.spawn("node", ["index.js"])
       ↓
Process Manager
       ↓
JS Runtime
       ↓
Node Compatibility Layer

container.spawn("npm", ["install"])
       ↓
Package Manager
       ↓
Registry / Cache
       ↓
VFS node_modules

container.spawn("vite", [])
       ↓
Package bin resolver
       ↓
JS Runtime
       ↓
Virtual HTTP
       ↓
Preview
```

---

## 25. Scope Boundaries

초기 범위에 포함할 것:

```text
VFS
basic process model
shell builtins
QuickJS or JS runtime integration
fs/path/process/buffer/events
CommonJS basics
ESM basics
package resolver
npm package fetch/install
virtual HTTP
preview iframe
Vite basic execution
```

초기 범위에서 제외할 것:

```text
완전한 Linux syscall
fork의 완전한 재현
native Node addons
raw TCP/UDP socket
TTY 완전 호환
POSIX permission model 전체
고급 signal semantics
완전한 npm CLI 호환
모든 Node built-ins
```

중요한 판단:

```text
Application이 기대하는 동작을 먼저 구현한다.
내부 OS fidelity는 필요한 만큼만 구현한다.
```

---

## 26. 추천 다음 작업

다음 세션에서 바로 이어간다면, 먼저 아키텍처를 코드로 확정하기보다 아주 작은 vertical slice를 만든다.

추천 순서:

```text
1. Rust VFS crate 생성
2. MemoryFS 구현
3. WASM export로 read/write 호출
4. TypeScript bridge 작성
5. Browser demo에서 /hello.txt 읽고 쓰기
6. Process abstraction 추가
7. Shell builtin cat/echo 구현
8. QuickJS runtime 연결
9. Node fs.readFileSync 구현
```

가장 좋은 첫 번째 milestone:

```text
Browser page
   │
   ▼
TypeScript API
   │
   ▼
Rust WASM VFS
   │
   ▼
write /tmp/test.txt
read /tmp/test.txt
   │
   ▼
display "hello"
```

이 milestone은 작지만 전체 방향을 검증한다.

```text
Rust core가 브라우저에서 동작하는가?
VFS API shape가 맞는가?
TypeScript bridge가 편한가?
향후 Node fs API를 올릴 수 있는가?
```

---

## 27. 최종 정리

현재 프로젝트의 핵심은 "브라우저에서 Node를 완벽히 복제한다"가 아니다.

더 정확한 목표는 다음이다.

```text
Browser-native Application Runtime

Application Compatibility first

Rust/WASM Browser Kernel

Node Adapter + WASI Adapter

Lite/Full capability-based runtime
```

가장 중요한 기술 축:

```text
VFS
Process abstraction
sync/async syscall bridge
SharedArrayBuffer + Atomics
Workers
Service Worker preview
Package resolver
Module resolver
Node compatibility layer
WASI extension
```

가장 현실적인 MVP 경로:

```text
Rust/WASM
  ↓
VFS
  ↓
Process
  ↓
Shell
  ↓
QuickJS
  ↓
Node fs/path/process
  ↓
Module resolver
  ↓
npm package install
  ↓
Virtual HTTP
  ↓
Vite
```

장기적으로는 WebContainers와 Nodebox의 중간 지점에서, Rust 기반 browser kernel과 application compatibility 중심 Node/WASI adapter를 결합한 오픈소스 runtime을 목표로 한다.
