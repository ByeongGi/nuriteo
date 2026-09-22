export interface MonacoTypeLibrary {
  path: string;
  data: string;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const REACT_TYPES = `
declare namespace JSX {
  interface Element {}
  interface ElementClass { render: unknown; }
  interface IntrinsicElements { [elementName: string]: any; }
}

declare namespace React {
  type ReactNode = JSX.Element | string | number | boolean | null | undefined;
}

declare module "react" {
  export type ReactNode = React.ReactNode;
  export type SetStateAction<State> = State | ((previousState: State) => State);
  export type Dispatch<Action> = (action: Action) => void;
  export interface StrictModeProps { children?: ReactNode; }
  export function StrictMode(props: StrictModeProps): JSX.Element;
  export function useState<State>(initialState: State | (() => State)): [State, Dispatch<SetStateAction<State>>];
  export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  export function useMemo<Value>(factory: () => Value, dependencies: readonly unknown[]): Value;
  export function useCallback<Callback extends (...args: any[]) => any>(callback: Callback, dependencies: readonly unknown[]): Callback;
  export function useRef<Value>(initialValue: Value): { current: Value };
}

declare module "react/jsx-runtime" {
  export const Fragment: unique symbol;
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element;
}

declare module "react/jsx-dev-runtime" {
  export { Fragment } from "react/jsx-runtime";
  export function jsxDEV(type: unknown, props: unknown, key: unknown): JSX.Element;
}
`;

const REACT_DOM_TYPES = `
declare module "react-dom/client" {
  import type { ReactNode } from "react";
  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element | DocumentFragment): Root;
  export function hydrateRoot(container: Element | Document, initialChildren: ReactNode): Root;
}
`;

const VITE_TYPES = `
interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly PROD: boolean;
  readonly SSR: boolean;
  readonly [key: string]: string | boolean | undefined;
}
interface ImportMeta { readonly env: ImportMetaEnv; readonly hot?: unknown; }

declare module "vite" {
  export interface UserConfig { [key: string]: unknown; }
  export type UserConfigExport = UserConfig | Promise<UserConfig> | (() => UserConfig | Promise<UserConfig>);
  export function defineConfig(config: UserConfigExport): UserConfigExport;
}
`;

const VITE_REACT_TYPES = `
declare module "@vitejs/plugin-react" {
  interface ReactPluginOptions { [key: string]: unknown; }
  interface Plugin { readonly name: string; [key: string]: unknown; }
  export default function react(options?: ReactPluginOptions): Plugin;
}
declare module "@vitejs/plugin-react-swc" {
  interface ReactPluginOptions { [key: string]: unknown; }
  interface Plugin { readonly name: string; [key: string]: unknown; }
  export default function react(options?: ReactPluginOptions): Plugin;
}
`;

const NEXT_TYPES = `
declare module "next" {
  export interface NextConfig {
    [option: string]: unknown;
  }
}

declare module "next/link" {
  import type { ReactNode } from "react";
  export interface LinkProps {
    href: string;
    children?: ReactNode;
    [property: string]: unknown;
  }
  export default function Link(props: LinkProps): JSX.Element;
}
`;

const NEXT_IMAGE_TYPES = `
// Next.js image declarations are referenced by next-env.d.ts.
`;

const DETAILED_PACKAGES = new Set([
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "@vitejs/plugin-react-swc",
  "react",
  "react-dom",
  "vite",
  "next"
]);

export function createMonacoTypeLibraries(files: Array<{ path: string; data: string }>): MonacoTypeLibrary[] {
  const packageNames = collectPackageNames(files);
  const libraries: MonacoTypeLibrary[] = [];

  if (packageNames.has("react") || packageNames.has("@types/react")) {
    libraries.push({ path: "file:///node_modules/react/index.d.ts", data: REACT_TYPES });
    libraries.push({ path: "file:///node_modules/react/jsx-runtime.d.ts", data: REACT_TYPES });
  }
  if (packageNames.has("react-dom") || packageNames.has("@types/react-dom")) {
    libraries.push({ path: "file:///node_modules/react-dom/client.d.ts", data: REACT_DOM_TYPES });
  }
  if (packageNames.has("vite")) {
    libraries.push({ path: "file:///node_modules/vite/index.d.ts", data: VITE_TYPES });
    libraries.push({ path: "file:///node_modules/vite/client.d.ts", data: VITE_TYPES });
  }
  if (packageNames.has("@vitejs/plugin-react") || packageNames.has("@vitejs/plugin-react-swc")) {
    libraries.push({ path: "file:///node_modules/@vitejs/plugin-react/index.d.ts", data: VITE_REACT_TYPES });
  }
  if (packageNames.has("next")) {
    for (const root of collectPackageRoots(files, "next")) {
      libraries.push({ path: `file://${root}/node_modules/next/index.d.ts`, data: NEXT_TYPES });
      libraries.push({
        path: `file://${root}/node_modules/next/image-types/global.d.ts`,
        data: NEXT_IMAGE_TYPES
      });
    }
  }

  const fallbackDeclarations = [...packageNames]
    .filter((packageName) => !DETAILED_PACKAGES.has(packageName))
    .sort()
    .flatMap((packageName) => [
      `declare module ${JSON.stringify(packageName)};`,
      `declare module ${JSON.stringify(`${packageName}/*`)};`
    ])
    .join("\n");
  if (fallbackDeclarations) {
    libraries.push({
      path: "file:///node_modules/@types/__cargo_dependencies/index.d.ts",
      data: `${fallbackDeclarations}\n`
    });
  }

  return libraries;
}

function collectPackageRoots(files: Array<{ path: string; data: string }>, packageName: string): string[] {
  const roots: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith("/package.json")) continue;
    try {
      const manifest = JSON.parse(file.data) as PackageManifest;
      if ([manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
        (dependencies) => Object.hasOwn(dependencies || {}, packageName)
      )) {
        roots.push(file.path.slice(0, -"/package.json".length));
      }
    } catch {
      // The JSON worker reports invalid manifests.
    }
  }
  return roots;
}

function collectPackageNames(files: Array<{ path: string; data: string }>): Set<string> {
  const packageNames = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith("/package.json") && file.path !== "package.json") continue;
    try {
      const manifest = JSON.parse(file.data) as PackageManifest;
      for (const dependencies of [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies
      ]) {
        for (const packageName of Object.keys(dependencies || {})) packageNames.add(packageName);
      }
    } catch {
      // Invalid package.json diagnostics belong to the JSON worker; keep TypeScript sync available.
    }
  }
  return packageNames;
}
