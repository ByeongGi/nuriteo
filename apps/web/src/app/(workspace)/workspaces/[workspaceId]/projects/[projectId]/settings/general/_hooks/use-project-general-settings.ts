"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { projectGeneralSchema } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/general/_schema/project-general.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { projectError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { renameProject } from "@/services/projects/api.ts";

import type { FormEvent } from "react";
import type { Project } from "@nuriteo/api-client";

export function useProjectGeneralSettings(initialEtag: string, initialProject: Project) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [project, setProject] = useState(initialProject);
  const [etag, setEtag] = useState(initialEtag);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = projectGeneralSchema.safeParse({
      name: String(new FormData(event.currentTarget).get("name") ?? "")
    });
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? "입력값을 확인하세요." });
      return;
    }
    const name = parsed.data.name.trim();
    if (name === project.name) return;
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await renameProject(createBrowserApiClient(), {
          owner: { ownerType: project.ownerType, ownerId: project.ownerId },
          projectId: project.id,
          etag,
          name
        }, { csrfToken: readCsrfCredential() });
        setProject(result.data);
        setEtag(result.etag);
        setFeedback({ error: false, text: "프로젝트 이름을 저장했습니다." });
        router.refresh();
      } catch (error) {
        setFeedback({ error: true, text: projectError(error, "project-profile").message });
      }
    });
  }

  return {
    feedback,
    isPending: mutation.isPending,
    project,
    rename
  };
}
