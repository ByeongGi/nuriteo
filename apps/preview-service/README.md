# Preview Service App

> **Lifecycle: REFERENCE-ONLY.** This Vite application is retained as the UI,
> accessibility, error-handling, and browser-test reference for the Self-hosted
> transition. Do not add new product features or import this application from
> new production code.

Product IDE for NURITEO, built like a WebContainers-style workspace.

## Reference-only contract

Allowed changes are limited to regression fixes needed to keep the canonical
suite trustworthy and extracting behavior, scenarios, or fixtures into the new
implementation. New product UI belongs in `apps/web`; shared browser Runtime
behavior belongs in the existing Runtime packages rather than in this app.

The app, its source files, server and Vite configuration, tests, and checked-in
public assets remain available as transition evidence. Existing checks and
packaging tools may continue to read them. New production code in `apps/web`,
`packages/api-client`, or `crates/nuriteo-server` must not import or take a path
dependency on `apps/preview-service` or `@nuriteo/preview-service-app`.

Removal is allowed only after the replacement Next.js journeys and their G4
acceptance evidence cover the required behavior and remaining public assets
have an explicit production-owned location.

## Stack

- **Vite + React + TypeScript**
- **Tailwind CSS v4**
- **Base UI** (`@base-ui/react`) for dialogs/primitives
- **Monaco Editor** (`@monaco-editor/react`) for the code editor
- **xterm** (`@xterm/xterm`) interactive terminal
- **react-resizable-panels** for IDE layout
- **lucide-react** icons
- Workflow engine: `@nuriteo/preview-service`

## IDE capabilities (IDE-1…4)

- Resizable file tree / editor / preview / dock
- Activity bar: Explorer / Search / SCM / Outline / Ports / Settings
- Interactive multi-terminal: `help`, `ls`, `cat`, `mkdir`, `touch`, `rm`, `mv`, `head`, `wc`, `pnpm|npm …`
- File create / rename / delete; Explorer tree DnD move; OS file drop into Explorer
- Search replace-all + include/exclude globs; editor tab reorder DnD; breadcrumbs
- Dirty tabs + autosave or manual save (Settings)
- Command palette (F1), Go to File (⌘P), Prettier Format, split editor
- Preview soft reload, editable path, multi path tabs
- Deep links: `?file=src/main.tsx&terminal=dev`, `?template=vite-react`, `?github=owner/repo`
- Runtime: `exportTreeJson` / `exportPathZip`, preview error bridge, change status
- Project-wide Monaco language service: TypeScript/JavaScript completion, hover, parameter and inlay hints, semantic diagnostics, and cross-file go-to-definition.
- Language-service errors and warnings appear in the status bar and the clickable Problems panel.
- Monaco language workers are real TS/JSON/CSS/HTML module workers bundled from Monaco 0.56's native `new URL(..., import.meta.url)` declarations by Vite 8. There is no legacy plugin or no-op worker fallback. `apps/preview-service/test/monaco-workers.test.ts` exercises semantic diagnostics, completion, hover, and cross-file definition resolution.

This is the browser-native Monaco language-service layer. External stdio/WebSocket LSP servers and a VS Code extension host remain outside the Classic Editor runtime.

Layer C (Share/Fork/accounts) is intentionally out of scope. See `docs/productization/classic-parity-spec-and-plan.md`.

## Run

```sh
mise exec node@22.23.0 -- pnpm run dev:preview
```

Open `http://127.0.0.1:5180` in Chrome (COOP/COEP headers are set by Vite).

## Build

```sh
mise exec node@22.23.0 -- pnpm run build:preview
```
