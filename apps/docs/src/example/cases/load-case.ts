import type { ContainerCase, ContainerCaseKind } from "./types.ts";

const loaders = {
  spa: () => import("./spa.ts"),
  next: () => import("./next.ts")
} satisfies Record<ContainerCaseKind, () => Promise<{ containerCase: ContainerCase }>>;

export function loadContainerCase(kind: ContainerCaseKind): Promise<ContainerCase> {
  return loaders[kind]().then((module) => module.containerCase);
}
