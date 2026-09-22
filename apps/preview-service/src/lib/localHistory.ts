export type LocalHistoryRevisionKind = "edit" | "save";

type StoredRevision = {
  t: number;
  k: "e" | "s";
  c: string;
};

export interface LocalHistoryStore {
  v: 1;
  p: Record<string, Record<string, StoredRevision[]>>;
}

export interface LocalHistoryRevision {
  id: string;
  projectId: string;
  path: string;
  timestamp: number;
  kind: LocalHistoryRevisionKind;
  content: string;
}

const STORAGE_KEY = "cargo.preview-service.local-history";
const MAX_REVISIONS_PER_FILE = 20;
const MAX_REVISIONS_PER_PROJECT = 100;
const EDIT_CHECKPOINT_WINDOW_MS = 1_500;

export function emptyLocalHistory(): LocalHistoryStore {
  return { v: 1, p: {} };
}

export function loadLocalHistory(storage: Storage | null = browserStorage()): LocalHistoryStore {
  if (!storage) return emptyLocalHistory();
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "null") as unknown;
    return isLocalHistoryStore(parsed) ? parsed : emptyLocalHistory();
  } catch {
    return emptyLocalHistory();
  }
}

export function persistLocalHistory(store: LocalHistoryStore, storage: Storage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function recordLocalHistoryRevision(
  store: LocalHistoryStore,
  input: {
    projectId: string;
    path: string;
    content: string;
    kind: LocalHistoryRevisionKind;
    timestamp?: number;
    force?: boolean;
  }
): LocalHistoryStore {
  const timestamp = input.timestamp ?? Date.now();
  const project = store.p[input.projectId] || {};
  const previous = project[input.path] || [];
  const latest = previous.at(-1);

  if (latest?.c === input.content && latest.k === kindCode(input.kind)) return store;
  if (!input.force && input.kind === "edit" && latest?.k === "e" && timestamp - latest.t < EDIT_CHECKPOINT_WINDOW_MS) {
    return store;
  }

  const revisions = [
    ...previous,
    { t: timestamp, k: kindCode(input.kind), c: input.content }
  ].slice(-MAX_REVISIONS_PER_FILE);
  const nextProject = boundProject({ ...project, [input.path]: revisions });

  return {
    v: 1,
    p: { ...store.p, [input.projectId]: nextProject }
  };
}

export function listLocalHistoryRevisions(
  store: LocalHistoryStore,
  projectId: string,
  path?: string | null
): LocalHistoryRevision[] {
  const project = store.p[projectId] || {};
  const paths = path ? [path] : Object.keys(project);
  const revisions = paths.flatMap((entryPath) =>
    (project[entryPath] || []).map((revision, index) => ({
      id: `${projectId}:${entryPath}:${revision.t}:${index}`,
      projectId,
      path: entryPath,
      timestamp: revision.t,
      kind: revision.k === "s" ? "save" as const : "edit" as const,
      content: revision.c
    }))
  );
  return revisions.sort((left, right) => right.timestamp - left.timestamp);
}

function boundProject(project: Record<string, StoredRevision[]>): Record<string, StoredRevision[]> {
  const newest = Object.entries(project)
    .flatMap(([path, revisions]) => revisions.map((revision) => ({ path, revision })))
    .sort((left, right) => right.revision.t - left.revision.t)
    .slice(0, MAX_REVISIONS_PER_PROJECT)
    .sort((left, right) => left.revision.t - right.revision.t);

  const bounded: Record<string, StoredRevision[]> = {};
  for (const { path, revision } of newest) {
    (bounded[path] ||= []).push(revision);
  }
  return bounded;
}

function kindCode(kind: LocalHistoryRevisionKind): "e" | "s" {
  return kind === "save" ? "s" : "e";
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function isLocalHistoryStore(value: unknown): value is LocalHistoryStore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalHistoryStore>;
  if (candidate.v !== 1 || !candidate.p || typeof candidate.p !== "object") return false;
  return Object.values(candidate.p).every((project) =>
    project && typeof project === "object" && Object.values(project).every((revisions) =>
      Array.isArray(revisions) && revisions.every((revision) =>
        revision && typeof revision === "object"
        && typeof revision.t === "number"
        && (revision.k === "e" || revision.k === "s")
        && typeof revision.c === "string"
      )
    )
  );
}
