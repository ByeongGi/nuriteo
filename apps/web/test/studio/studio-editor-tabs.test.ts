import assert from "node:assert/strict";
import fs from "node:fs";

import {
  closeSavedEditorTabs,
  createEditorDraftState,
  createEditorTabs,
  forgetEditorDraft,
  forgetEditorDraftPrefix,
  noteEditorDraft,
  openEditorFile,
  relocateEditorDraft,
  relocateEditorPath,
  renameEditorDraft,
  renameEditorPath,
  settleEditorDraft
} from "../../src/projects/studio/editor-tabs.ts";
import { appendStudioConsole, freshServerLogLines, studioConsoleSourceLabel } from "../../src/projects/studio/preview-console.ts";
import { readStudioShellSources } from "./shell-sources.ts";

const previewA = openEditorFile(createEditorTabs(), "src/App.tsx", "preview");
const replaced = openEditorFile(previewA, "src/main.tsx", "preview");
assert.deepEqual(replaced.openPaths, ["src/main.tsx"]);
assert.equal(replaced.previewPath, "src/main.tsx");
assert.equal(replaced.pinnedPaths.size, 0);

const keptSplit = openEditorFile(previewA, "src/main.tsx", "preview", { keepPath: "src/App.tsx" });
assert.deepEqual(keptSplit.openPaths, ["src/App.tsx", "src/main.tsx"]);
assert.equal(keptSplit.pinnedPaths.has("src/App.tsx"), true);
assert.equal(keptSplit.previewPath, "src/main.tsx");

const pinnedBesidePreview = openEditorFile(replaced, "src/App.tsx", "pin");
assert.deepEqual(pinnedBesidePreview.openPaths, ["src/main.tsx", "src/App.tsx"]);
assert.equal(pinnedBesidePreview.previewPath, "src/main.tsx");
assert.equal(pinnedBesidePreview.pinnedPaths.has("src/App.tsx"), true);

const stillPreview = openEditorFile(pinnedBesidePreview, "src/main.tsx", "activate");
assert.equal(stillPreview, pinnedBesidePreview);

const pinnedPreview = openEditorFile(replaced, "src/main.tsx", "pin");
assert.equal(pinnedPreview.previewPath, undefined);
assert.equal(pinnedPreview.pinnedPaths.has("src/main.tsx"), true);

const renamed = renameEditorPath(pinnedBesidePreview, "src/main.tsx", "src/entry.tsx");
assert.deepEqual(renamed.openPaths, ["src/entry.tsx", "src/App.tsx"]);
assert.equal(renamed.previewPath, "src/entry.tsx");

let drafts = noteEditorDraft(createEditorDraftState(), "src/App.tsx", "one");
drafts = noteEditorDraft(drafts, "src/main.tsx", "two");
const stale = settleEditorDraft(drafts, "src/App.tsx", "old");
assert.equal(stale, drafts);
const settled = settleEditorDraft(drafts, "src/App.tsx", "one");
assert.equal(settled.dirtyPaths.has("src/App.tsx"), false);
assert.equal(settled.pending.has("src/main.tsx"), true);
const moved = renameEditorDraft(settled, "src/main.tsx", "src/entry.tsx");
assert.equal(moved.pending.get("src/entry.tsx"), "two");
const forgotten = forgetEditorDraft(moved, "src/entry.tsx");
assert.equal(forgotten.dirtyPaths.size, 0);

const savedClosed = closeSavedEditorTabs(pinnedBesidePreview, new Set(["src/App.tsx", "src/other.tsx"]));
assert.deepEqual(savedClosed.openPaths, ["src/App.tsx"]);
assert.equal(savedClosed.previewPath, undefined);

const shell = readStudioShellSources();
const tree = fs.readFileSync(new URL("../../src/projects/project-file-tree.tsx", import.meta.url), "utf8");
assert.match(shell, /useUnsavedChangesGuard\(hasUnpublishedChanges \|\| hasUnsavedEditorChange\)/u);
assert.match(shell, /is-preview/u);
assert.match(shell, /onDoubleClick=\{\(\) => selectFile\(path, workspace, "pin"\)\}/u);
assert.match(tree, /onDoubleClick=\{\(\) => onPin\(node\.file\.path\)\}/u);
assert.match(tree, /dirtyPaths\.has\(node\.file\.path\)/u);
assert.match(shell, /onCreateDirectory=\{beginCreateDirectory\}/u);
assert.match(shell, /onMove=\{moveExplorerPath\}/u);
assert.match(shell, /const previewRunLabel = isRunningPreview \? \("미리보기 취소"\) : \("미리보기 실행"\)/u);
assert.match(shell, /aria-label=\{previewRunLabel\}/u);
assert.match(shell, /studioConsoleSourceLabel\(entry\.source\)/u);
assert.equal(studioConsoleSourceLabel("page"), "페이지");
assert.equal(studioConsoleSourceLabel("server"), "개발 서버");

const folderTabs = openEditorFile(createEditorTabs(), "app/empty-notes/note.txt", "pin");
const movedTabs = relocateEditorPath(folderTabs, "app/empty-notes", "relocated-notes");
assert.deepEqual(movedTabs.openPaths, ["relocated-notes/note.txt"]);
let folderDrafts = noteEditorDraft(createEditorDraftState(), "app/empty-notes/note.txt", "hello");
folderDrafts = relocateEditorDraft(folderDrafts, "app/empty-notes", "relocated-notes");
assert.equal(folderDrafts.pending.get("relocated-notes/note.txt"), "hello");
assert.equal(forgetEditorDraftPrefix(folderDrafts, "relocated-notes").pending.size, 0);

const pageEntry = { id: 1, level: "log" as const, message: "page", source: "page" as const, stack: "" };
const serverEntry = { id: 2, level: "info" as const, message: "server", source: "server" as const, stack: "" };
const capped = appendStudioConsole(
  Array.from({ length: 100 }, (_, index) => ({ ...pageEntry, id: index + 1, message: `page-${index}` })),
  { ...pageEntry, id: 101, message: "page-100" }
);
assert.equal(capped.filter((entry) => entry.source === "page").length, 100);
assert.equal(capped.some((entry) => entry.message === "page-0"), false);
assert.equal(appendStudioConsole(capped, serverEntry).some((entry) => entry.source === "server"), true);
assert.deepEqual(freshServerLogLines(["설치됨"], ["설치됨", "dev server ready"]), ["dev server ready"]);
assert.deepEqual(freshServerLogLines(["a", "b"], ["b", "c"]), ["c"]);

console.log("studio editor tabs keep one preview tab and per-file drafts");
