import { useEffect, useMemo, useState } from "react";
import { Cloud, Copy, FolderOpen, Save, X } from "lucide-react";
import { CloudProjectsClient, type CloudProject } from "../lib/cloudProjects";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

const TOKEN_KEY = "nuriteo.cloud-session";

export function CloudProjectsDialog({ model }: { model: PreviewControllerModel }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [shareToken, setShareToken] = useState("");
  const [message, setMessage] = useState("");
  const client = useMemo(() => new CloudProjectsClient({ token: () => token }), [token]);

  async function refresh() {
    if (!token) { setProjects([]); return; }
    try {
      const next = await client.list();
      setProjects(next);
      setSelectedId((current) => current || next[0]?.id || "");
      setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  useEffect(() => { if (model.cloudOpen) void refresh(); }, [model.cloudOpen, token]);
  if (!model.cloudOpen) return null;

  const files = () => (model.snapshot.project?.listFiles() || []).map((file) => ({
    path: file.path.replace(/^\/workspace\/[^/]+\//, ""),
    content: file.data
  }));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Cloud projects">
      <section className="w-full max-w-xl border border-nuriteo-line bg-nuriteo-elevated p-4 shadow-2xl">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Cloud className="size-4" />Cloud projects</h2>
          <button className="btn-ghost" type="button" onClick={() => model.setCloudOpen(false)}><X className="size-4" /></button>
        </header>
        <label className="mb-3 block text-xs text-nuriteo-muted">
          Session token
          <input className="mt-1 w-full border border-nuriteo-line bg-nuriteo-bg px-2 py-1 font-mono" type="password" value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <div className="mb-3 flex gap-2">
          <button className="btn" type="button" onClick={() => { localStorage.setItem(TOKEN_KEY, token); void refresh(); }}>Connect</button>
          <button className="btn" type="button" disabled={!model.hasProject || !token} onClick={async () => {
            try {
              const project = await client.create(model.snapshot.projectId || "NURITEO project");
              await client.save(project.id, files());
              setSelectedId(project.id); await refresh(); setMessage("Project created and saved.");
            } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          }}><Save className="size-3.5" />Save as new</button>
        </div>
        <select className="mb-3 w-full border border-nuriteo-line bg-nuriteo-bg px-2 py-2 text-sm" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">Select a project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · generation {project.generation}</option>)}
        </select>
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" disabled={!selectedId || !model.hasProject} onClick={async () => {
            try { await client.save(selectedId, files()); await refresh(); setMessage("Saved."); }
            catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          }}><Save className="size-3.5" />Save</button>
          <button className="btn" type="button" disabled={!selectedId} onClick={async () => {
            try {
              const resumed = await client.resume(selectedId);
              model.controller.importProjectFiles(resumed.snapshot.files, resumed.project.name);
              const firstPath = model.controller.getSnapshot().project?.listFiles()[0]?.path;
              if (firstPath) model.openFile(firstPath);
              model.setCloudOpen(false);
            } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          }}><FolderOpen className="size-3.5" />Resume</button>
          <button className="btn" type="button" disabled={!selectedId} onClick={async () => {
            try {
              const share = await client.createShare(selectedId, "forkable");
              await navigator.clipboard.writeText(share.token);
              setMessage("Forkable share token copied.");
            } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          }}><Copy className="size-3.5" />Share</button>
        </div>
        <div className="mt-3 flex gap-2">
          <input className="min-w-0 flex-1 border border-nuriteo-line bg-nuriteo-bg px-2 py-1 font-mono text-xs" value={shareToken} onChange={(event) => setShareToken(event.target.value)} placeholder="Forkable share token" />
          <button className="btn" type="button" disabled={!shareToken} onClick={async () => {
            try {
              const forked = await client.fork(shareToken);
              setShareToken(""); await refresh(); setSelectedId(forked.id); setMessage("Share forked into your projects.");
            } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          }}>Fork</button>
        </div>
        {message ? <p className="mt-3 text-xs text-nuriteo-muted" role="status">{message}</p> : null}
      </section>
    </div>
  );
}
