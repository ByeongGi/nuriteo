"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Project } from "@nuriteo/api-client";
import type { RestoredProjectHead } from "@/projects/_components/project-history-panel.tsx";

export function useHistoryScreen(project: Project, projectEtag: string) {
  const router = useRouter();
  const [etag, setEtag] = useState(projectEtag);
  const [version, setVersion] = useState(project.version);
  const currentProject = version === project.version ? project : { ...project, version };

  function updateHead(head: RestoredProjectHead) {
    setEtag(head.projectEtag);
    setVersion(head.projectVersion);
  }

  function reloadProject() {
    router.refresh();
  }

  return {
    currentProject,
    etag,
    reloadProject,
    updateHead
  };
}
