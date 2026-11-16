export type ContainerCaseKind = "spa" | "next";

export const containerCaseKinds = ["spa", "next"] as const satisfies readonly ContainerCaseKind[];

export interface ContainerCaseFile {
  path: string;
  contents: string;
}

export interface ContainerCase {
  kind: ContainerCaseKind;
  entry: string;
  previewScript: string | null;
  files: readonly ContainerCaseFile[];
}
