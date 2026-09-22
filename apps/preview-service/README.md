# Preview Service App

Product IDE for Cargo Container, built like a WebContainers-style workspace.

## Stack

- **Vite + React + TypeScript**
- **Tailwind CSS v4**
- **Base UI** (`@base-ui/react`) for dialogs/primitives
- **Monaco Editor** (`@monaco-editor/react`) for the code editor
- **xterm** (`@xterm/xterm`) interactive terminal
- **react-resizable-panels** for IDE layout
- **lucide-react** icons
- Workflow engine: `@cargo-container/preview-service`

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
- Monaco language workers: real TS/JSON/CSS/HTML workers via `vite-plugin-monaco-editor` (esbuild prebundle; Vite 8 `?worker` bypass)

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
