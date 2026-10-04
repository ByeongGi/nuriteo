export {};

await import("./auth-bff.test.ts");
await import("./authenticated-shell.test.ts");
await import("./collaboration-ux.test.ts");
await import("./browser-client.test.ts");
await import("./contracts.test.ts");
await import("./entry-flow.test.ts");
await import("./project-ux.test.ts");
await import("./project-bundle-v1.test.ts");
await import("./runtime-adapter.test.ts");
await import("./runtime-assets.test.ts");
await import("./server-client.test.ts");

console.log("web tests ok");
