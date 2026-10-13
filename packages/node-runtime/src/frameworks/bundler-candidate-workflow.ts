import { createLoopbackNetwork, type LoopbackNetwork } from "../net/index.ts";

export type BundlerCandidateId = "webpack" | "rspack";
export type BundlerCandidateStage = "install" | "cli-bootstrap" | "dev-server" | "preview" | "edit-update" | "build" | "recovery";
export type BundlerCandidateBlockerCode =
  | "ERR_BUNDLER_FIXTURE_REVISION_INVALID"
  | "ERR_BUNDLER_INTEGRITY_MISSING"
  | "ERR_BUNDLER_VERSION_NOT_EXACT"
  | "ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING"
  | "ERR_PM_NATIVE_ADDON_UNSUPPORTED"
  | "ERR_BUNDLER_WASM_RUNTIME_UNVALIDATED";

export interface BundlerCandidateDependency {
  integrity: string;
  name: string;
  role: "bundler" | "cli" | "dev-server" | "binding" | "wasm-binding";
  version: string;
}

export interface BundlerCandidateFixture {
  repository: string;
  revision: string;
  subdirectory: string;
}

export interface BundlerCandidateBlocker {
  code: BundlerCandidateBlockerCode;
  message: string;
  package?: string;
  stage: BundlerCandidateStage;
}

export interface BundlerCandidateWorkflowOptions {
  bundler: BundlerCandidateId;
  dependencies: BundlerCandidateDependency[];
  fixture: BundlerCandidateFixture;
  network?: LoopbackNetwork;
  port?: number;
  precompiledCliFactory?: boolean;
  wasmBindingValidatedInBrowserWorker?: boolean;
}

export interface BundlerCandidateInstallResult {
  dependencies: BundlerCandidateDependency[];
  fixture: BundlerCandidateFixture;
  installed: boolean;
  lock: "exact-version-and-sri";
}

export interface BundlerCandidateReadiness {
  blockers: BundlerCandidateBlocker[];
  bundler: BundlerCandidateId;
  productSupport: boolean;
  status: "candidate-blocked" | "supported";
}

export interface BundlerCandidateRecoveryResult {
  listenerCount: number;
  recovered: true;
  restartCount: number;
}

/**
 * Product contract for exact, integrity-pinned browser bundler lanes. Runtime
 * execution is supplied by the process worker's static factory and loopback
 * bridges; this class keeps readiness and recovery policy independently testable.
 */
export class BundlerCandidateWorkflow {
  readonly bundler: BundlerCandidateId;
  readonly dependencies: BundlerCandidateDependency[];
  readonly fixture: BundlerCandidateFixture;
  readonly network: LoopbackNetwork;

  #port: number;
  #precompiledCliFactory: boolean;
  #restartCount = 0;
  #wasmBindingValidatedInBrowserWorker: boolean;

  constructor(options: BundlerCandidateWorkflowOptions) {
    this.bundler = options.bundler;
    this.dependencies = options.dependencies.map((dependency) => ({ ...dependency }));
    this.fixture = { ...options.fixture };
    this.network = options.network || createLoopbackNetwork();
    this.#port = options.port ?? (options.bundler === "webpack" ? 8080 : 8081);
    this.#precompiledCliFactory = options.precompiledCliFactory ?? false;
    this.#wasmBindingValidatedInBrowserWorker = options.wasmBindingValidatedInBrowserWorker ?? false;
  }

  install(): BundlerCandidateInstallResult {
    const blockers = inspectReproducibility(this.fixture, this.dependencies);
    if (blockers.length > 0) throw new BundlerCandidateBlockedError(blockers[0]!, blockers);
    return {
      dependencies: this.dependencies.map((dependency) => ({ ...dependency })),
      fixture: { ...this.fixture },
      installed: true,
      lock: "exact-version-and-sri"
    };
  }

  inspectReadiness(): BundlerCandidateReadiness {
    const blockers = inspectReproducibility(this.fixture, this.dependencies);
    if (!this.#precompiledCliFactory) {
      blockers.push({
        code: "ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING",
        message: `${this.bundler} has no integrity-checked precompiled factory artifact for its complete CLI/dev-server graph under script-src 'self'; unsafe-eval remains forbidden.`,
        stage: "cli-bootstrap"
      });
    }
    if (this.bundler === "rspack") {
      const nativeBinding = this.dependencies.find((dependency) => dependency.role === "binding");
      const wasmBinding = this.dependencies.find((dependency) => dependency.role === "wasm-binding");
      if (nativeBinding && !wasmBinding) {
        blockers.push({
          code: "ERR_PM_NATIVE_ADDON_UNSUPPORTED",
          message: `${nativeBinding.name}@${nativeBinding.version} requires a native .node binding and no pinned WASM fallback is present.`,
          package: nativeBinding.name,
          stage: "cli-bootstrap"
        });
      } else if (wasmBinding && !this.#wasmBindingValidatedInBrowserWorker) {
        blockers.push({
          code: "ERR_BUNDLER_WASM_RUNTIME_UNVALIDATED",
          message: `${wasmBinding.name}@${wasmBinding.version} is pinned, but its WASI threads/runtime path has not passed the strict-CSP browser worker gate.`,
          package: wasmBinding.name,
          stage: "cli-bootstrap"
        });
      }
    }
    return blockers.length > 0
      ? { blockers, bundler: this.bundler, productSupport: false, status: "candidate-blocked" }
      : { blockers, bundler: this.bundler, productSupport: true, status: "supported" };
  }

  startDevServer(): { bundler: BundlerCandidateId; port: number; ready: true } {
    this.install();
    const readiness = this.inspectReadiness();
    if (readiness.blockers.length > 0) throw new BundlerCandidateBlockedError(readiness.blockers[0]!, readiness.blockers);
    if (!this.network.listeners.has(this.#port)) {
      this.network.listen(this.#port, () => ({ statusCode: 200, body: `${this.bundler} preview ready` }));
    }
    return { bundler: this.bundler, port: this.#port, ready: true };
  }

  preview(): { port: number; ready: true } {
    this.#assertSupported("preview");
    return { port: this.#port, ready: true };
  }

  editSource(): { hmr: true; updated: true } {
    this.#assertSupported("edit-update");
    return { hmr: true, updated: true };
  }

  build(): { emitted: true; exitCode: 0 } {
    this.#assertSupported("build");
    return { emitted: true, exitCode: 0 };
  }

  stop(): BundlerCandidateRecoveryResult {
    const listener = this.network.listeners.get(this.#port);
    if (listener) {
      listener.closed = true;
      this.network.listeners.delete(this.#port);
    }
    return { listenerCount: this.network.listeners.size, recovered: true, restartCount: this.#restartCount };
  }

  restart(): { bundler: BundlerCandidateId; port: number; ready: true } {
    this.stop();
    this.#restartCount += 1;
    return this.startDevServer();
  }

  #assertSupported(stage: BundlerCandidateStage): void {
    const readiness = this.inspectReadiness();
    if (readiness.blockers.length > 0) this.#blockedStage(stage);
  }

  #blockedStage(stage: BundlerCandidateStage): never {
    const readiness = this.inspectReadiness();
    const primary = readiness.blockers[0] || {
      code: "ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING" as const,
      message: `${this.bundler} product execution is not ready.`,
      stage
    };
    throw new BundlerCandidateBlockedError({ ...primary, stage }, readiness.blockers);
  }
}

export class BundlerCandidateBlockedError extends Error {
  readonly blockers: BundlerCandidateBlocker[];
  readonly code: BundlerCandidateBlockerCode;
  readonly stage: BundlerCandidateStage;

  constructor(primary: BundlerCandidateBlocker, blockers: BundlerCandidateBlocker[]) {
    super(`${primary.code}: ${primary.message}`);
    this.name = "BundlerCandidateBlockedError";
    this.blockers = blockers.map((blocker) => ({ ...blocker }));
    this.code = primary.code;
    this.stage = primary.stage;
  }
}

function inspectReproducibility(
  fixture: BundlerCandidateFixture,
  dependencies: BundlerCandidateDependency[]
): BundlerCandidateBlocker[] {
  const blockers: BundlerCandidateBlocker[] = [];
  if (!/^https:\/\/github\.com\/.+/.test(fixture.repository) || !/^[0-9a-f]{40}$/.test(fixture.revision)) {
    blockers.push({
      code: "ERR_BUNDLER_FIXTURE_REVISION_INVALID",
      message: "Bundler fixture must use a public GitHub repository and an exact 40-character revision.",
      stage: "install"
    });
  }
  for (const dependency of dependencies) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dependency.version)) {
      blockers.push({
        code: "ERR_BUNDLER_VERSION_NOT_EXACT",
        message: `${dependency.name} must use an exact version, not a range or tag.`,
        package: dependency.name,
        stage: "install"
      });
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dependency.integrity)) {
      blockers.push({
        code: "ERR_BUNDLER_INTEGRITY_MISSING",
        message: `${dependency.name}@${dependency.version} must have a registry SHA-512 integrity pin.`,
        package: dependency.name,
        stage: "install"
      });
    }
  }
  return blockers;
}
