"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Project } from "@nuriteo/api-client";

export function useProjectStudioScreen(initialProject: Project, initialEtag: string) {
  const router = useRouter();
  const [project, setProject] = useState(initialProject);
  const [etag, setEtag] = useState(initialEtag);

  function commitProject(result: { readonly projectEtag: string; readonly projectVersion: number }) {
    setEtag(result.projectEtag);
    setProject((current) => ({ ...current, version: result.projectVersion }));
  }

  function reloadProject() {
    router.refresh();
  }

  return { commitProject, etag, project, reloadProject };
}
