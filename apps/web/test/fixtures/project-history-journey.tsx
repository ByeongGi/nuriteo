import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import type { Project } from "@nuriteo/api-client";

import { ProjectHistoryPanel } from "../../src/app/(authenticated)/projects/project-history-panel.tsx";

declare global {
  interface Window { __nuriteoHistoryProbe: { committedEtag?: string; committedVersion?: number; reloads: number; resumes: number } }
}

const initialProject: Project = {
  id: "0199ee6c-c777-7000-8000-00000000d002",
  ownerType: "user",
  ownerId: "0199ee6c-c777-7000-8000-00000000d001",
  storageScopeId: "0199ee6c-c777-7000-8000-00000000d001",
  slug: "history-journey",
  name: "History Journey",
  state: "active",
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
  archivedAt: null,
  version: 1
};

window.__nuriteoHistoryProbe = { reloads: 0, resumes: 0 };

function Fixture() {
  const [project, setProject] = useState(initialProject);
  const [etag, setEtag] = useState('"project-v1"');
  return <main>
    <button type="button" onClick={() => setProject((current) => ({ ...current, state: "archived", archivedAt: "2026-10-05T03:00:00Z" }))}>Archive fixture Project</button>
    <ProjectHistoryPanel
      hasLocalDraft
      project={project}
      projectEtag={etag}
      onProjectCommit={(result) => {
        setEtag(result.projectEtag);
        setProject((current) => ({ ...current, version: result.projectVersion }));
        window.__nuriteoHistoryProbe.committedEtag = result.projectEtag;
        window.__nuriteoHistoryProbe.committedVersion = result.projectVersion;
      }}
      onReloadProject={() => { window.__nuriteoHistoryProbe.reloads += 1; }}
      onResumeRestoredSave={() => { window.__nuriteoHistoryProbe.resumes += 1; }}
    />
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
