// These suites launch Vite against the same repository root. Static imports can
// evaluate top-level-await modules concurrently and race Vite's optimizer cache,
// causing worker module loads to fail with an empty ErrorEvent. Keep them serial.
await import("./boot.test.ts");
await import("./isolation.test.ts");
await import("./non-js-tooling.test.ts");
await import("./recovery.test.ts");
await import("./soak.test.ts");
await import("./static-cjs-factory-csp.test.ts");
