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
  productSupport: false;
  status: "candidate-blocked";
}

export interface BundlerCandidateRecoveryResult {
  listenerCount: number;
  recovered: true;
  restartCount: number;
}

/**
 * Product boundary for bundlers that are not yet safe to execute in the browser
 * guest. It validates reproducibility inputs and fails before binding a port.
 * This is deliberately not an adapter implementation of webpack or Rspack.
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
        message: `${this.bundler} has no integrity-checked precompiled CLI factory for script-src 'self'; unsafe-eval remains forbidden.`,
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
    return { blockers, bundler: this.bundler, productSupport: false, status: "candidate-blocked" };
  }

  startDevServer(): never {
    this.install();
    const readiness = this.inspectReadiness();
    throw new BundlerCandidateBlockedError(readiness.blockers[0]!, readiness.blockers);
  }

  preview(): never {
    return this.#blockedStage("preview");
  }

  editSource(): never {
    return this.#blockedStage("edit-update");
  }

  build(): never {
    return this.#blockedStage("build");
  }

  stop(): BundlerCandidateRecoveryResult {
    const listener = this.network.listeners.get(this.#port);
    if (listener) {
      listener.closed = true;
      this.network.listeners.delete(this.#port);
    }
    return { listenerCount: this.network.listeners.size, recovered: true, restartCount: this.#restartCount };
  }

  restart(): never {
    this.stop();
    this.#restartCount += 1;
    return this.startDevServer();
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
