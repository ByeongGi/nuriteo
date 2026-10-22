import { getCurrentWorkspaces, getProject } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { previewOriginConfiguration } from "#src/lib/preview/config.ts";
import { resolveWorkspaceSelection } from "#src/lib/workspace-selection.ts";
import { ProjectStudioScreen } from "#src/app/(studio)/projects/[projectId]/studio/project-studio-screen.tsx";

export const metadata: Metadata = { title: "Studio" };

const CONTENT_HASH = /^[0-9a-f]{64}$/u;

interface Props {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<{ workspace?: string | string[] }>;
}

export default async function ProjectStudioPage({ params, searchParams }: Props) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  try {
    const client = await createServerApiClient();
    const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
    const selectedScope = resolveWorkspaceSelection(workspaces, query.workspace);
    const workspace = workspaces.find((item) => item.storageScopeId === selectedScope);
    if (workspace === undefined) {
      return (
        <EntryUnavailable
          title="워크스페이스가 없습니다"
          description="이 프로젝트를 열 수 있는 워크스페이스를 찾지 못했습니다."
          retryHref="/projects"
        />
      );
    }
    const owner = { ownerType: workspace.ownerType, ownerId: workspace.ownerId } as const;
    const projectResult = await getProject(client, { owner, projectId });

    return (
      <ProjectStudioScreen
        {...runtimeAssetRevisionProps()}
        previewConfiguration={previewOriginConfiguration()}
        project={projectResult.data}
        projectEtag={projectResult.etag}
        workspaceLabel={workspace.displayLabel}
        workspaceScope={workspace.storageScopeId}
      />
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="Studio를 열 수 없습니다"
        description="프로젝트 실행 환경을 안전하게 준비하지 못했습니다."
        reference={safeRequestReference(error)}
        retryHref="/projects"
      />
    );
  }
}

function runtimeAssetRevisionProps(): { readonly runtimeAssetRevision?: string } {
  const revision = process.env.NURITEO_RUNTIME_ASSET_REVISION;
  return revision !== undefined && CONTENT_HASH.test(revision)
    ? { runtimeAssetRevision: revision }
    : {};
}
