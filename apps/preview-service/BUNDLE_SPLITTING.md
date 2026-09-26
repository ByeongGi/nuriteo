# Preview-service production bundle splitting

Measured on 2026-09-27 with the repository-pinned Node 22.23.0, pnpm 11.15.1, Vite 8.3.0, a frozen install, and a clean production build. Gzip values below were recomputed from emitted files with gzip level 9. Source maps remained enabled in both builds.

## Before and after

| Asset or request group | Before raw | Before gzip | After raw | After gzip | Load point after splitting |
| --- | ---: | ---: | ---: | ---: | --- |
| Entry chunk | 10,739,860 B | 2,870,952 B | 4,258,139 B | 1,209,274 B | Initial document |
| Initial JS graph (entry + modulepreloads) | 10,739,860 B | 2,870,952 B | 4,288,118 B | 1,221,018 B | Initial document |
| Initial stylesheet | 201,510 B | 31,762 B | 36,222 B | 7,319 B | Initial document |
| Monaco editor JS (`CodeEditor` + shared `editor.api` + `vs`) | Included in entry | Included in entry | 3,954,561 B | 999,688 B | First file selection or diff view |
| Monaco editor CSS (`editor` + `vs`) | Included in initial CSS | Included in initial CSS | 161,820 B | 25,173 B | First file selection or diff view |
| Prettier formatter | Included in entry | Included in entry | 2,092,885 B | 558,879 B | Format command |
| Terminal (`BottomDock`) | Included in entry | Included in entry | 349,873 B | 88,767 B | Project opened while dock is visible |
| Diff UI wrapper | Included in entry | Included in entry | 4,108 B | 1,660 B | Diff opened; shares cached Monaco core |
| TypeScript/JavaScript worker | 6,926,113 B | 1,483,992 B | 6,926,113 B | 1,483,992 B | Monaco language service starts |
| CSS worker | 1,075,784 B | 244,806 B | 1,075,784 B | 244,806 B | CSS language service starts |
| HTML worker | 740,801 B | 194,848 B | 740,801 B | 194,848 B | HTML language service starts |
| JSON worker | 430,556 B | 127,454 B | 430,556 B | 127,454 B | JSON language service starts |

The initial JS graph decreased by 60.1% raw and 57.5% gzip. The initial stylesheet decreased by 82.0% raw and 77.0% gzip. The previous build's `chunkSizeWarningLimit: 9000` warning no longer occurs; the limit was not changed.

## Composition and boundaries

The baseline entry source map showed that the largest source was TypeScript (9.14 MB), pulled into the app by the statically imported Prettier TypeScript parser. Prettier's Babel, Markdown, HTML, PostCSS, Estree, and standalone modules added another large formatting-only group. Monaco editor contributions, xterm, React DOM, and the browser runtime/workflow packages were also in the same entry.

Formatting now imports `formatDocument` only when the user runs Format. `App.tsx` uses explicit, statically analyzable `React.lazy` imports for the code editor, terminal/dock, diff, Cloud Projects, import dialog, command palette, Search, Source Control, Outline, Timeline, Ports, and Settings. Explorer, preview chrome, the welcome flow, and the workflow controller stay eager because they are required to open or create the first project.

Monaco 0.56 already emits its language definitions as on-demand chunks. Its TS/JS worker begins only when `CodeEditor` configures semantic diagnostics after a file is selected; JSON, CSS, and HTML workers remain separate native module workers. The editor core is shared by normal and diff editors, so opening diff after the editor reuses the same cached core instead of duplicating it.

The remaining 4.26 MB entry is primarily the preview-service controller and its synchronous public workflow boundary. `loadTemplate()` is a synchronous public API and constructs Vite/Next workflows immediately, so the browser-native TypeScript/runtime stack cannot move behind an async import without changing that API. The 6.93 MB TS worker is intentionally retained because completion, hover, cross-file definition resolution, and semantic diagnostics require the full TypeScript language service. The 2.09 MB formatter is still large because all supported Prettier parsers are retained, but it is no longer an initial dependency.

## Failure recovery and runtime contracts

Every lazy feature is wrapped by `LazyFeatureBoundary`. A failed dynamic import produces a user-visible alert with a Reload application recovery action. `lazy-feature-recovery.test.ts` aborts the command-palette module request, asserts the recovery UI, removes the failure, reloads, and verifies recovery. Formatter import or execution failure also raises an error notification with reload guidance instead of only writing to the terminal log.

Dynamic chunks and Monaco workers remain hashed, same-origin build assets; no blob worker, CDN, eval, or cross-origin fallback was introduced. The production source-map setting, Vite native worker URLs, `worker-src 'self'` contract, preview service-worker routes, and HMR paths are unchanged. Browser isolation, Edge service-worker smoke, offline preview soak, Monaco language-service, editable split, diff/history, and workflow-soak tests cover these contracts.

## Changed files

- `src/App.tsx`: feature-entry lazy boundaries and initial empty editor/terminal shells.
- `src/components/LazyFeatureBoundary.tsx`: shared loading fallback and user-visible reload recovery.
- `src/hooks/usePreviewController.ts`: on-demand formatter import.
- `test/lazy-feature-recovery.test.ts`: failed chunk and reload recovery coverage.
- `test/diff-editor.test.ts` and `test/local-history.test.ts`: explicit manual-save fixtures and lazy-panel readiness waits, so autosave timing does not hide the state under test.
