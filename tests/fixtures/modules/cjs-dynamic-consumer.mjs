const loaded = await import("./cjs-target.cjs");

export const hasDefault = typeof loaded.default === "function";
export const namedStatic = loaded.kind;
export const rendered = loaded.default("ok");
