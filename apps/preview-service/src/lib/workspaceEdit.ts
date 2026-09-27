import type { LspPosition, LspTextEdit, LspWorkspaceEdit } from "./lspProtocol.ts";

export interface WorkspaceEditTarget {
  root: string;
  read(path: string): string;
  write(path: string, text: string): void;
}

export function applyLspWorkspaceEdit(edit: LspWorkspaceEdit, target: WorkspaceEditTarget): string[] {
  const updates = Object.entries(edit.changes ?? {}).map(([uri, edits]) => {
    const path = workspacePath(uri, target.root);
    const current = target.read(path);
    return { path, text: applyTextEdits(current, edits) };
  });
  for (const update of updates) target.write(update.path, update.text);
  return updates.map((update) => update.path);
}

function workspacePath(uri: string, root: string): string {
  const parsed = new URL(uri);
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (parsed.protocol !== "file:" || (parsed.pathname !== normalizedRoot && !parsed.pathname.startsWith(`${normalizedRoot}/`))) {
    throw new Error(`Workspace edit escapes the project root: ${uri}`);
  }
  return decodeURIComponent(parsed.pathname);
}

function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const offsets = edits.map((edit) => ({
    start: offsetForPosition(text, edit.range.start),
    end: offsetForPosition(text, edit.range.end),
    newText: edit.newText
  })).sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 1; index < offsets.length; index += 1) {
    const previous = offsets[index - 1];
    const current = offsets[index];
    if (previous && current && current.end > previous.start) throw new Error("Workspace edit contains overlapping text edits.");
  }
  let next = text;
  for (const edit of offsets) next = `${next.slice(0, edit.start)}${edit.newText}${next.slice(edit.end)}`;
  return next;
}

function offsetForPosition(text: string, position: LspPosition): number {
  const lines = text.split("\n");
  const line = lines[position.line];
  if (line === undefined || position.character < 0 || position.character > line.length) {
    throw new Error("Workspace edit range is outside the document.");
  }
  let offset = position.character;
  for (let index = 0; index < position.line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset;
}
