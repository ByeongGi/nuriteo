export {
  assertBrowserRuntimeResourceAdmission,
  BrowserRuntimeResourceError,
  createBoundedWebAssemblyMemoryConstructor,
  DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES,
  DEFAULT_BROWSER_WASM_MEMORY_LIMIT_BYTES,
  installWebAssemblyMemoryLimit,
  WASM_PAGE_BYTES
} from "./browser-resource-policy.ts";
export type { BrowserRuntimeResourceAdmission, BrowserRuntimeResourceEstimate } from "./browser-resource-policy.ts";
