import { normalize } from "../builtins/path.ts";
import type { CjsContext, RuntimeValue } from "../types.ts";

export type StaticCjsFactory = (context: CjsContext, globals: Record<string, RuntimeValue>) => void;

export interface StaticCjsFactoryArtifact {
  factory: StaticCjsFactory;
  path: string;
  sha256: string;
  sourceSha256: string;
}

export class StaticCjsFactoryRegistry {
  readonly #artifacts = new Map<string, StaticCjsFactoryArtifact>();

  register(artifact: StaticCjsFactoryArtifact): this {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^[a-f0-9]{64}$/.test(artifact.sourceSha256)) {
      throw new Error(`ESTATICFACTORYINTEGRITY: invalid SHA-256 metadata for ${artifact.path}`);
    }
    const path = normalize(artifact.path);
    this.#artifacts.set(path, { ...artifact, path });
    return this;
  }

  resolve(path: string, sourceSha256?: string): StaticCjsFactory | undefined {
    const artifact = this.#artifacts.get(normalize(path));
    if (!artifact) return undefined;
    if (sourceSha256 && artifact.sourceSha256 !== sourceSha256) {
      throw new Error(`ESTATICFACTORYSOURCEMISMATCH: ${path}`);
    }
    return artifact.factory;
  }

  factories(): Record<string, StaticCjsFactory> {
    return Object.fromEntries([...this.#artifacts].map(([path, artifact]) => [path, artifact.factory]));
  }

  paths(): string[] {
    return [...this.#artifacts.keys()].sort();
  }
}

export function createStaticCjsFactoryRegistry(artifacts: StaticCjsFactoryArtifact[] = []): StaticCjsFactoryRegistry {
  const registry = new StaticCjsFactoryRegistry();
  for (const artifact of artifacts) registry.register(artifact);
  return registry;
}
