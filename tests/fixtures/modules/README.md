# Module Execution Fixtures

These fixtures define the P0 module behavior that later runtime tests must execute inside the browser-native Node layer. They are intentionally small and parser-agnostic.

Required cases:

- live ESM bindings stay live across namespace and dynamic import consumers,
- circular re-exports do not snapshot TDZ or `undefined`,
- top-level await uses an async execution path,
- dynamic import of CommonJS exposes a namespace with `default`,
- `import.meta.url`, `import.meta.dirname`, `import.meta.filename`, and `import.meta.resolve` follow Node-shaped behavior,
- TypeScript emits sourcemaps through existing tooling rather than a custom parser.

Reference evidence is recorded in `docs/archive/implementation-2026-09-15/evidence/P0-03.md`.
