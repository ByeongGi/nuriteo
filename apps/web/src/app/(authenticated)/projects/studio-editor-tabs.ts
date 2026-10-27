export type EditorOpenMode = "activate" | "pin" | "preview";

export interface EditorTabs {
  readonly openPaths: readonly string[];
  readonly pinnedPaths: ReadonlySet<string>;
  readonly previewPath?: string;
}

export interface EditorDraftState {
  readonly dirtyPaths: ReadonlySet<string>;
  readonly pending: ReadonlyMap<string, string>;
}

export function createEditorTabs(): EditorTabs {
  return { openPaths: [], pinnedPaths: new Set() };
}

function editorTabs(openPaths: readonly string[], pinnedPaths: ReadonlySet<string>, previewPath?: string): EditorTabs {
  return previewPath === undefined ? { openPaths, pinnedPaths } : { openPaths, pinnedPaths, previewPath };
}

export function createEditorDraftState(): EditorDraftState {
  return { dirtyPaths: new Set(), pending: new Map() };
}

export function openEditorFile(
  tabs: EditorTabs,
  path: string,
  mode: EditorOpenMode,
  options?: { readonly keepPath?: string }
): EditorTabs {
  if (mode === "activate") {
    return tabs.openPaths.includes(path) ? tabs : openEditorFile(tabs, path, "preview", options);
  }
  if (mode === "pin") {
    if (tabs.pinnedPaths.has(path) && tabs.openPaths.includes(path) && tabs.previewPath !== path) return tabs;
    const pinnedPaths = new Set(tabs.pinnedPaths);
    pinnedPaths.add(path);
    return editorTabs(
      tabs.openPaths.includes(path) ? tabs.openPaths : [...tabs.openPaths, path],
      pinnedPaths,
      tabs.previewPath === path ? undefined : tabs.previewPath
    );
  }
  if (tabs.openPaths.includes(path)) return tabs;
  const preview = tabs.previewPath;
  const canReplace = preview !== undefined
    && tabs.openPaths.includes(preview)
    && !tabs.pinnedPaths.has(preview)
    && preview !== options?.keepPath;
  if (canReplace && preview !== undefined) {
    return {
      openPaths: tabs.openPaths.map((candidate) => candidate === preview ? path : candidate),
      pinnedPaths: tabs.pinnedPaths,
      previewPath: path
    };
  }
  const pinnedPaths = new Set(tabs.pinnedPaths);
  if (preview !== undefined && preview === options?.keepPath) pinnedPaths.add(preview);
  return editorTabs([...tabs.openPaths, path], pinnedPaths, path);
}

export function closeEditorFile(tabs: EditorTabs, path: string): EditorTabs {
  if (!tabs.openPaths.includes(path) && tabs.previewPath !== path && !tabs.pinnedPaths.has(path)) return tabs;
  const pinnedPaths = new Set(tabs.pinnedPaths);
  pinnedPaths.delete(path);
  return editorTabs(
    tabs.openPaths.filter((candidate) => candidate !== path),
    pinnedPaths,
    tabs.previewPath === path ? undefined : tabs.previewPath
  );
}

export function closeSavedEditorTabs(tabs: EditorTabs, dirtyPaths: ReadonlySet<string>): EditorTabs {
  const openPaths = tabs.openPaths.filter((path) => dirtyPaths.has(path));
  return editorTabs(
    openPaths,
    new Set([...tabs.pinnedPaths].filter((path) => openPaths.includes(path))),
    tabs.previewPath !== undefined && openPaths.includes(tabs.previewPath) ? tabs.previewPath : undefined
  );
}

export function renameEditorPath(tabs: EditorTabs, from: string, to: string): EditorTabs {
  if (from === to || (!tabs.openPaths.includes(from) && tabs.previewPath !== from && !tabs.pinnedPaths.has(from))) return tabs;
  return editorTabs(
    tabs.openPaths.map((path) => path === from ? to : path),
    new Set([...tabs.pinnedPaths].map((path) => path === from ? to : path)),
    tabs.previewPath === from ? to : tabs.previewPath
  );
}

export function noteEditorDraft(state: EditorDraftState, path: string, content: string): EditorDraftState {
  if (state.pending.get(path) === content && state.dirtyPaths.has(path)) return state;
  const pending = new Map(state.pending);
  pending.set(path, content);
  const dirtyPaths = new Set(state.dirtyPaths);
  dirtyPaths.add(path);
  return { dirtyPaths, pending };
}

export function settleEditorDraft(state: EditorDraftState, path: string, content: string): EditorDraftState {
  if (state.pending.get(path) !== content) return state;
  const pending = new Map(state.pending);
  pending.delete(path);
  const dirtyPaths = new Set(state.dirtyPaths);
  dirtyPaths.delete(path);
  return { dirtyPaths, pending };
}

export function forgetEditorDraft(state: EditorDraftState, path: string): EditorDraftState {
  if (!state.pending.has(path) && !state.dirtyPaths.has(path)) return state;
  const pending = new Map(state.pending);
  pending.delete(path);
  const dirtyPaths = new Set(state.dirtyPaths);
  dirtyPaths.delete(path);
  return { dirtyPaths, pending };
}

export function rewriteProjectPath(path: string, from: string, to: string): string {
  return path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

export function relocateEditorPath(tabs: EditorTabs, from: string, to: string): EditorTabs {
  const affected = (path: string | undefined) => path === from || (path?.startsWith(`${from}/`) ?? false);
  if (!tabs.openPaths.some((path) => affected(path)) && !affected(tabs.previewPath) && ![...tabs.pinnedPaths].some((path) => affected(path))) return tabs;
  const rewrite = (path: string) => rewriteProjectPath(path, from, to);
  return editorTabs(
    tabs.openPaths.map(rewrite),
    new Set([...tabs.pinnedPaths].map(rewrite)),
    tabs.previewPath === undefined ? undefined : rewrite(tabs.previewPath)
  );
}

export function relocateEditorDraft(state: EditorDraftState, from: string, to: string): EditorDraftState {
  const affected = [...state.pending.keys(), ...state.dirtyPaths].filter((path) => path === from || path.startsWith(`${from}/`));
  if (affected.length === 0) return state;
  let next = state;
  for (const path of affected) next = renameEditorDraft(next, path, rewriteProjectPath(path, from, to));
  return next;
}

export function forgetEditorDraftPrefix(state: EditorDraftState, prefix: string): EditorDraftState {
  const affected = [...state.pending.keys(), ...state.dirtyPaths].filter((path) => path === prefix || path.startsWith(`${prefix}/`));
  return affected.reduce((current, path) => forgetEditorDraft(current, path), state);
}

export function renameEditorDraft(state: EditorDraftState, from: string, to: string): EditorDraftState {
  if (from === to || (!state.pending.has(from) && !state.dirtyPaths.has(from))) return state;
  const pending = new Map(state.pending);
  const content = pending.get(from);
  pending.delete(from);
  if (content !== undefined) pending.set(to, content);
  const dirtyPaths = new Set(state.dirtyPaths);
  if (dirtyPaths.delete(from)) dirtyPaths.add(to);
  return { dirtyPaths, pending };
}
