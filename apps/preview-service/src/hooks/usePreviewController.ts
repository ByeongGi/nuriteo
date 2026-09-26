import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPreviewWorkflowController,
  PHASES,
  type PreviewWorkflowController,
  type PreviewWorkflowSnapshot
} from "@cargo-container/preview-service";
import type { SupportedPackageManager, TemplateId } from "@cargo-container/browser-host";
import type { DockTab, PreviewServiceApi } from "../lib/types";
import type { CommandId } from "../lib/commands";
import { applySettingsToDocument, loadSettings, saveSettings, type IdeSettings } from "../lib/settings";
import { clearDeepLinkParams, hasDeepLinkIntent, parseDeepLink } from "../lib/deepLink";
import type { PreviewPortEntry, SidebarView, TerminalSessionTab } from "../lib/uiState";
import { findSymbolDefinition, indexProjectSymbols, wordAt } from "../lib/symbols";
import type { LanguageProblem } from "../lib/monacoLanguageService";
import { collectDroppedEntries, type DroppedEntrySource } from "../lib/droppedEntries";
import {
  listLocalHistoryRevisions,
  loadLocalHistory,
  persistLocalHistory,
  recordLocalHistoryRevision,
  type LocalHistoryRevision,
  type LocalHistoryRevisionKind
} from "../lib/localHistory";
import { useNotificationCenter } from "./useNotificationCenter";
import { notificationForWorkflowEvent } from "../lib/notifications";
import { CloudProjectsClient } from "../lib/cloudProjects";

const AUTOSAVE_MS = 800;

function displayPath(path: string): string {
  return path.replace(/^\/workspace\/[^/]+\//, "");
}

function pickFirstFile(snapshot: PreviewWorkflowSnapshot): string | null {
  const files = snapshot.project?.listFiles() || [];
  const preferred =
    files.find((file) => /main\.(jsx|tsx|js|ts)$/.test(file.path)) ||
    files.find((file) => /page\.(jsx|tsx|js|ts)$/.test(file.path)) ||
    files.find((file) => file.path.endsWith("package.json")) ||
    files[0];
  return preferred?.path ?? null;
}

function resolveProjectFile(snapshot: PreviewWorkflowSnapshot, relativeOrAbs: string): string | null {
  const files = snapshot.project?.listFiles() || [];
  if (files.length === 0) return null;
  const needle = relativeOrAbs.replace(/^\.\//, "").replace(/^\/+/, "");
  const exact = files.find(
    (file) => file.path === relativeOrAbs || file.path.endsWith(`/${needle}`) || displayPath(file.path) === needle
  );
  return exact?.path ?? null;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function isDescendantPath(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(prefix);
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? path : path.slice(0, index);
}

function joinPath(root: string, relative: string): string {
  const cleaned = relative.replace(/^\/+/, "").replaceAll("\\", "/");
  return `${root.replace(/\/+$/, "")}/${cleaned}`.replace(/\/+/g, "/");
}

function portFromSnapshot(snapshot: PreviewWorkflowSnapshot): number {
  return snapshot.session?.port || 5173;
}

export function usePreviewController() {
  const controllerRef = useRef<PreviewWorkflowController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createPreviewWorkflowController();
  }
  const controller = controllerRef.current;

  const [snapshot, setSnapshot] = useState<PreviewWorkflowSnapshot>(() => controller.getSnapshot());
  const [selectedPath, setSelectedPath] = useState("");
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [splitPath, setSplitPath] = useState<string | null>(null);
  const [editorTick, setEditorTick] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>("terminal");
  const [frameNonce, setFrameNonce] = useState(0);
  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"commands" | "files">("commands");
  const [settings, setSettings] = useState<IdeSettings>(() => loadSettings());
  const [ports, setPorts] = useState<PreviewPortEntry[]>([]);
  const [activePortId, setActivePortId] = useState<string | null>(null);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [terminals, setTerminals] = useState<TerminalSessionTab[]>([{ id: "term-1", title: "Terminal 1" }]);
  const [activeTerminalId, setActiveTerminalId] = useState("term-1");
  const terminalSeqRef = useRef(1);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<{
    mode: "copy" | "cut";
    paths: string[];
  } | null>(null);
  const [zenMode, setZenMode] = useState(false);
  const [diffView, setDiffView] = useState<{
    path: string;
    original: string;
    modified: string;
    language: string;
  } | null>(null);
  const [softRefreshToken, setSoftRefreshToken] = useState(0);
  const [languageProblems, setLanguageProblems] = useState<LanguageProblem[]>([]);
  const [editorLocation, setEditorLocation] = useState<{
    path: string;
    line: number;
    column: number;
    requestId: number;
  } | null>(null);
  const [localHistory, setLocalHistory] = useState(loadLocalHistory);
  const [localHistoryPersistent, setLocalHistoryPersistent] = useState(true);
  const notificationCenter = useNotificationCenter();
  const localHistoryRef = useRef(localHistory);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const autosaveTimersRef = useRef(new Map<string, number>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const deepLinkDoneRef = useRef(false);
  const cloudRuntimeStartedAtRef = useRef<number | null>(null);

  const refreshSnapshot = useCallback(() => {
    setSnapshot(controller.getSnapshot());
  }, [controller]);

  const bumpEditor = useCallback(() => {
    setEditorTick((value) => value + 1);
  }, []);

  const recordHistoryCheckpoint = useCallback(
    (path: string, content: string, kind: LocalHistoryRevisionKind, force = false) => {
      const projectId = controller.getSnapshot().project?.root;
      if (!projectId) return;
      const next = recordLocalHistoryRevision(localHistoryRef.current, {
        projectId,
        path,
        content,
        kind,
        force
      });
      if (next === localHistoryRef.current) return;
      localHistoryRef.current = next;
      setLocalHistory(next);
      setLocalHistoryPersistent(persistLocalHistory(next));
    },
    [controller]
  );

  const clearAutosave = useCallback((path?: string) => {
    if (path) {
      const timer = autosaveTimersRef.current.get(path);
      if (timer !== undefined) window.clearTimeout(timer);
      autosaveTimersRef.current.delete(path);
      return;
    }
    for (const timer of autosaveTimersRef.current.values()) window.clearTimeout(timer);
    autosaveTimersRef.current.clear();
  }, []);

  const updateSettings = useCallback((patch: Partial<IdeSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const openFile = useCallback(
    (path: string, options?: { additive?: boolean }) => {
      const current = controller.getSnapshot();
      if (!current.editor) return;
      const file = current.editor.openFile(path);
      selectedPathRef.current = file.path;
      setSelectedPath(file.path);
      setOpenPaths((paths) => (paths.includes(file.path) ? paths : [...paths, file.path]));
      setSelectedPaths((paths) => {
        if (options?.additive) {
          return paths.includes(file.path) ? paths.filter((entry) => entry !== file.path) : [...paths, file.path];
        }
        return [file.path];
      });
      bumpEditor();
      refreshSnapshot();
    },
    [bumpEditor, controller, refreshSnapshot]
  );

  const openFirstProjectFile = useCallback(() => {
    const path = pickFirstFile(controller.getSnapshot());
    if (path) openFile(path);
  }, [controller, openFile]);

  const openLanguageProblem = useCallback(
    (problem: LanguageProblem) => {
      openFile(problem.path);
      setEditorLocation((current) => ({
        path: problem.path,
        line: problem.line,
        column: problem.column,
        requestId: (current?.requestId || 0) + 1
      }));
    },
    [openFile]
  );

  const focusTerminal = useCallback(() => {
    updateSettings({ showTerminal: true });
    setDockTab("terminal");
    setTerminalFocusRequest((value) => value + 1);
  }, [updateSettings]);

  const addTerminal = useCallback(() => {
    terminalSeqRef.current += 1;
    const id = `term-${terminalSeqRef.current}`;
    setTerminals((current) => [...current, { id, title: `Terminal ${terminalSeqRef.current}` }]);
    setActiveTerminalId(id);
    focusTerminal();
  }, [focusTerminal]);

  const closeTerminal = useCallback(
    (id: string) => {
      setTerminals((current) => {
        if (current.length <= 1) return current;
        const next = current.filter((entry) => entry.id !== id);
        if (activeTerminalId === id) setActiveTerminalId(next[0]?.id || "term-1");
        return next;
      });
      controller.closeShell(id);
    },
    [activeTerminalId, controller]
  );

  const reorderOpenPaths = useCallback((fromPath: string, beforePath: string) => {
    setOpenPaths((paths) => {
      const without = paths.filter((path) => path !== fromPath);
      const index = without.indexOf(beforePath);
      if (index < 0) return [...without, fromPath];
      const next = [...without];
      next.splice(index, 0, fromPath);
      return next;
    });
  }, []);

  const replaceInFiles = useCallback(
    (options: {
      query: string;
      replace: string;
      caseSensitive?: boolean;
      useRegex?: boolean;
      includeGlob?: string;
      excludeGlob?: string;
    }) => {
      const current = controller.getSnapshot();
      if (!current.editor || !options.query) return 0;
      let pattern: RegExp;
      try {
        pattern = new RegExp(
          options.useRegex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          options.caseSensitive ? "g" : "gi"
        );
      } catch {
        return 0;
      }

      const include = options.includeGlob || "**/*";
      const exclude = options.excludeGlob || "";
      let count = 0;
      for (const file of current.editor.store.listFiles()) {
        const relative = displayPath(file.path);
        if (!simpleGlobMatch(relative, include) || (exclude && simpleGlobMatch(relative, exclude))) continue;
        const next = file.data.replace(pattern, () => {
          count += 1;
          return options.replace;
        });
        if (next === file.data) continue;
        recordHistoryCheckpoint(file.path, file.data, "edit");
        current.editor.editText(file.path, next);
        current.editor.saveFile(file.path);
        recordHistoryCheckpoint(file.path, next, "save");
      }
      bumpEditor();
      refreshSnapshot();
      setFrameNonce((value) => value + 1);
      return count;
    },
    [bumpEditor, controller, recordHistoryCheckpoint, refreshSnapshot]
  );

  const openPreferredFile = useCallback(
    (preferred?: string | null) => {
      const snap = controller.getSnapshot();
      if (preferred) {
        const resolved = resolveProjectFile(snap, preferred);
        if (resolved) {
          openFile(resolved);
          return;
        }
      }
      openFirstProjectFile();
    },
    [controller, openFile, openFirstProjectFile]
  );

  const toggleZenMode = useCallback(() => {
    setZenMode((value) => {
      const next = !value;
      if (next) {
        updateSettings({ showSidebar: false, showTerminal: false });
      } else {
        updateSettings({
          showSidebar: true,
          showTerminal: true,
          showPreview: true
        });
      }
      return next;
    });
  }, [updateSettings]);

  const openDiffView = useCallback(
    (path: string, originalOverride?: string) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const file = current.editor.openFile(path);
      let original = originalOverride || "";
      if (originalOverride === undefined) {
        try {
          original = current.project.readText(path);
        } catch {
          original = "";
        }
      }
      // If dirty, original is saved store content; modified is buffer.
      // If not dirty, compare against empty baseline marker for visibility.
      const modified = file.data;
      if (!file.dirty && originalOverride === undefined) {
        // Still allow viewing file against itself as a no-op diff entry point from SCM after edits saved.
        original = modified;
      }
      const language =
        path.endsWith(".tsx") || path.endsWith(".ts")
          ? "typescript"
          : path.endsWith(".css")
            ? "css"
            : path.endsWith(".json")
              ? "json"
              : "javascript";
      setDiffView({ path, original, modified, language });
      openFile(path);
    },
    [controller, openFile]
  );

  const openHistoryDiff = useCallback(
    (revision: LocalHistoryRevision) => openDiffView(revision.path, revision.content),
    [openDiffView]
  );

  const restoreHistoryRevision = useCallback(
    (revision: LocalHistoryRevision) => {
      const current = controller.getSnapshot();
      if (!current.editor) return;
      const file = current.editor.openFile(revision.path);
      recordHistoryCheckpoint(revision.path, file.data, "edit", true);
      current.editor.editText(revision.path, revision.content);
      openFile(revision.path);
      bumpEditor();
      refreshSnapshot();
    },
    [bumpEditor, controller, openFile, recordHistoryCheckpoint, refreshSnapshot]
  );

  const closeDiffView = useCallback(() => setDiffView(null), []);

  const goToDefinition = useCallback(
    (nameHint?: string, position?: { line: number; column: number }) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return false;
      const path = selectedPathRef.current;
      if (!path) return false;
      const file = current.editor.openFile(path);
      const name = nameHint || (position ? wordAt(file.data, position.line, position.column) : "");
      if (!name) return false;
      const symbols = indexProjectSymbols(
        current.project.listFiles().map((entry) => ({
          path: entry.path,
          data: current.editor?.openFile(entry.path).data || entry.data
        }))
      );
      const hit = findSymbolDefinition(symbols, name, path);
      if (!hit) return false;
      openFile(hit.path);
      return true;
    },
    [controller, openFile]
  );

  const copyPaths = useCallback(
    (paths?: string[]) => {
      const targets =
        paths && paths.length > 0
          ? paths
          : selectedPaths.length > 0
            ? selectedPaths
            : selectedPathRef.current
              ? [selectedPathRef.current]
              : [];
      if (targets.length === 0) return;
      setClipboard({ mode: "copy", paths: targets });
    },
    [selectedPaths]
  );

  const cutPaths = useCallback(
    (paths?: string[]) => {
      const targets =
        paths && paths.length > 0
          ? paths
          : selectedPaths.length > 0
            ? selectedPaths
            : selectedPathRef.current
              ? [selectedPathRef.current]
              : [];
      if (targets.length === 0) return;
      setClipboard({ mode: "cut", paths: targets });
    },
    [selectedPaths]
  );

  const selectExplorerPath = useCallback((path: string, additive = false) => {
    setSelectedPaths((paths) => {
      if (additive) {
        return paths.includes(path) ? paths.filter((entry) => entry !== path) : [...paths, path];
      }
      return [path];
    });
  }, []);

  const saveCurrentFile = useCallback(() => {
    const current = controller.getSnapshot();
    const path = selectedPathRef.current;
    if (!current.editor || !path) return;
    clearAutosave(path);
    const file = current.editor.openFile(path);
    current.editor.saveFile(path);
    recordHistoryCheckpoint(path, file.data, "save");
    bumpEditor();
    refreshSnapshot();
    setFrameNonce((value) => value + 1);
  }, [bumpEditor, clearAutosave, controller, recordHistoryCheckpoint, refreshSnapshot]);

  const saveFile = useCallback((path: string) => {
    const current = controller.getSnapshot();
    if (!current.editor) return;
    clearAutosave(path);
    const file = current.editor.openFile(path);
    current.editor.saveFile(path);
    recordHistoryCheckpoint(path, file.data, "save");
    bumpEditor();
    refreshSnapshot();
    setFrameNonce((value) => value + 1);
  }, [bumpEditor, clearAutosave, controller, recordHistoryCheckpoint, refreshSnapshot]);

  const closeTab = useCallback(
    (path: string) => {
      setOpenPaths((paths) => {
        const next = paths.filter((entry) => entry !== path);
        if (selectedPathRef.current === path) {
          const fallback = next.at(-1) || "";
          selectedPathRef.current = fallback;
          setSelectedPath(fallback);
        }
        return next;
      });
      setSplitPath((current) => (current === path ? null : current));
      bumpEditor();
    },
    [bumpEditor]
  );

  const editFile = useCallback(
    (path: string, value: string) => {
      const current = controller.getSnapshot();
      if (!current.editor) return;
      const previous = current.editor.openFile(path).data;
      recordHistoryCheckpoint(path, previous, "edit");
      current.editor.editText(path, value);
      bumpEditor();
      refreshSnapshot();
      clearAutosave(path);
      if (settingsRef.current.saveTrigger !== "autosave") return;
      const timer = window.setTimeout(() => {
        autosaveTimersRef.current.delete(path);
        const latest = controller.getSnapshot();
        if (!latest.editor) return;
        const file = latest.editor.openFile(path);
        if (!file.dirty) return;
        latest.editor.saveFile(path);
        recordHistoryCheckpoint(path, file.data, "save");
        bumpEditor();
        refreshSnapshot();
        setFrameNonce((value) => value + 1);
      }, AUTOSAVE_MS);
      autosaveTimersRef.current.set(path, timer);
    },
    [bumpEditor, clearAutosave, controller, recordHistoryCheckpoint, refreshSnapshot]
  );

  const editSelected = useCallback(
    (value: string) => {
      const path = selectedPathRef.current;
      if (path) editFile(path, value);
    },
    [editFile]
  );

  const editCurrentFile = editSelected;

  const formatCurrentFile = useCallback(async () => {
    const current = controller.getSnapshot();
    const path = selectedPathRef.current;
    if (!current.editor || !path) return;
    const file = current.editor.openFile(path);
    try {
      const { formatDocument } = await import("../lib/formatDocument");
      const formatted = await formatDocument(path, file.data);
      if (formatted === file.data) return;
      recordHistoryCheckpoint(path, file.data, "edit");
      current.editor.editText(path, formatted);
      current.editor.saveFile(path);
      recordHistoryCheckpoint(path, formatted, "save");
      bumpEditor();
      refreshSnapshot();
      setFrameNonce((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller.log(`format failed: ${message}`);
      notificationCenter.pushNotification({
        title: "Format unavailable",
        message: `${message} Reload the application and try again.`,
        level: "error"
      });
    }
  }, [bumpEditor, controller, notificationCenter.pushNotification, recordHistoryCheckpoint, refreshSnapshot]);

  const createFile = useCallback(
    (relativePath?: string) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const root = current.project.root;
      const baseDir = selectedPathRef.current ? parentDir(selectedPathRef.current) : root;
      const suggested = displayPath(`${baseDir}/untitled.ts`).replace(/^[^/]+\//, "") || "untitled.ts";
      const input = relativePath || window.prompt("New file path (relative to project root)", suggested);
      if (!input) return;
      try {
        const fullPath = joinPath(root, input);
        const file = current.editor.createFile(fullPath, "");
        openFile(file.path);
        refreshSnapshot();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    },
    [controller, openFile, refreshSnapshot]
  );

  const createFolder = useCallback(
    (relativePath?: string) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const root = current.project.root;
      const input = relativePath || window.prompt("New folder path (relative to project root)", "src/components");
      if (!input) return;
      try {
        const folder = joinPath(root, input);
        current.editor.createFile(`${folder}/.gitkeep`, "");
        refreshSnapshot();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    },
    [controller, refreshSnapshot]
  );

  const renamePath = useCallback(
    (path: string, isDirectory: boolean) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const root = current.project.root;
      const relative = displayPath(path);
      const nextRelative = window.prompt(isDirectory ? "Rename folder to" : "Rename file to", relative);
      if (!nextRelative || nextRelative === relative) return;
      const toPath = joinPath(root, nextRelative);
      try {
        if (isDirectory) {
          const prefix = path.endsWith("/") ? path : `${path}/`;
          const files = current.project
            .listFiles()
            .filter((file) => file.path === path || file.path.startsWith(prefix));
          for (const file of files) {
            const renamed = `${toPath}${file.path.slice(path.length)}`;
            current.editor.renameFile(file.path, renamed);
            setOpenPaths((paths) => paths.map((entry) => (entry === file.path ? renamed : entry)));
            if (selectedPathRef.current === file.path) {
              selectedPathRef.current = renamed;
              setSelectedPath(renamed);
            }
          }
        } else {
          current.editor.renameFile(path, toPath);
          setOpenPaths((paths) => paths.map((entry) => (entry === path ? toPath : entry)));
          if (selectedPathRef.current === path) {
            selectedPathRef.current = toPath;
            setSelectedPath(toPath);
          }
        }
        bumpEditor();
        refreshSnapshot();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    },
    [bumpEditor, controller, refreshSnapshot]
  );

  const deletePath = useCallback(
    (path: string, isDirectory: boolean) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const label = displayPath(path);
      if (!window.confirm(`Delete ${isDirectory ? "folder" : "file"} "${label}"?`)) return;
      try {
        if (isDirectory) {
          const prefix = path.endsWith("/") ? path : `${path}/`;
          const files = current.project
            .listFiles()
            .filter((file) => file.path === path || file.path.startsWith(prefix));
          for (const file of files) {
            current.editor.deleteFile(file.path);
            setOpenPaths((paths) => paths.filter((entry) => entry !== file.path));
            if (selectedPathRef.current === file.path) {
              selectedPathRef.current = "";
              setSelectedPath("");
            }
          }
        } else {
          current.editor.deleteFile(path);
          setOpenPaths((paths) => paths.filter((entry) => entry !== path));
          if (selectedPathRef.current === path) {
            selectedPathRef.current = "";
            setSelectedPath("");
          }
        }
        bumpEditor();
        refreshSnapshot();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    },
    [bumpEditor, controller, refreshSnapshot]
  );

  const movePath = useCallback(
    (fromPath: string, toDirAbs: string, isDirectory: boolean) => {
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const root = current.project.root;
      const targetDir = toDirAbs === root || toDirAbs === "." ? root : toDirAbs;
      if (isDescendantPath(fromPath, targetDir) || fromPath === targetDir) return;

      const name = basename(fromPath);
      const toPath = joinPath(targetDir, name);
      if (fromPath === toPath) return;

      try {
        if (isDirectory) {
          if (isDescendantPath(fromPath, toPath)) return;
          const prefix = fromPath.endsWith("/") ? fromPath : `${fromPath}/`;
          const files = current.project
            .listFiles()
            .filter((file) => file.path === fromPath || file.path.startsWith(prefix));
          for (const file of files) {
            const renamed = `${toPath}${file.path.slice(fromPath.length)}`;
            if (current.project.listFiles().some((entry) => entry.path === renamed)) {
              throw new Error(`Target already exists: ${displayPath(renamed)}`);
            }
          }
          for (const file of files) {
            const renamed = `${toPath}${file.path.slice(fromPath.length)}`;
            current.editor.renameFile(file.path, renamed);
            setOpenPaths((paths) => paths.map((entry) => (entry === file.path ? renamed : entry)));
            if (selectedPathRef.current === file.path) {
              selectedPathRef.current = renamed;
              setSelectedPath(renamed);
            }
          }
        } else {
          if (current.project.listFiles().some((entry) => entry.path === toPath)) {
            throw new Error(`Target already exists: ${displayPath(toPath)}`);
          }
          current.editor.renameFile(fromPath, toPath);
          setOpenPaths((paths) => paths.map((entry) => (entry === fromPath ? toPath : entry)));
          if (selectedPathRef.current === fromPath) {
            selectedPathRef.current = toPath;
            setSelectedPath(toPath);
          }
        }
        bumpEditor();
        refreshSnapshot();
        setFrameNonce((value) => value + 1);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    },
    [bumpEditor, controller, refreshSnapshot]
  );

  const pastePaths = useCallback(
    (targetDirAbs?: string | null) => {
      if (!clipboard || clipboard.paths.length === 0) return;
      const current = controller.getSnapshot();
      if (!current.editor || !current.project) return;
      const root = current.project.root;
      const targetDir = targetDirAbs || (selectedPathRef.current ? parentDir(selectedPathRef.current) : root);
      for (const from of clipboard.paths) {
        try {
          if (clipboard.mode === "cut") {
            const isDirectory = current.project.listFiles().some((file) => file.path.startsWith(`${from}/`));
            movePath(from, targetDir, isDirectory);
          } else {
            const name = basename(from);
            const to = joinPath(targetDir, name);
            if (from === to) continue;
            const data = current.editor.openFile(from).data;
            current.editor.createFile(to, data);
          }
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
        }
      }
      if (clipboard.mode === "cut") setClipboard(null);
      bumpEditor();
      refreshSnapshot();
    },
    [bumpEditor, clipboard, controller, movePath, refreshSnapshot]
  );

  const setPackageManagerOverride = useCallback(
    (value: SupportedPackageManager | null) => {
      controller.setPackageManagerOverride(value);
      refreshSnapshot();
    },
    [controller, refreshSnapshot]
  );

  const syncPortsFromSnapshot = useCallback((next: PreviewWorkflowSnapshot) => {
    if (!next.previewUrl || !next.session) {
      setPorts([]);
      setActivePortId(null);
      return;
    }
    const port = portFromSnapshot(next);
    setPorts((current) => {
      if (current.length === 0) {
        const entry: PreviewPortEntry = {
          id: `port-${port}-root`,
          port,
          label: "Dev server",
          path: "/",
          url: next.previewUrl
        };
        setActivePortId(entry.id);
        return [entry];
      }
      return current.map((entry) =>
        entry.port === port ? { ...entry, url: buildPreviewUrl(next.previewUrl!, entry.path) } : entry
      );
    });
  }, []);

  const loadTemplate = useCallback(
    (id?: TemplateId) => {
      const next = controller.loadTemplate(id || "vite-react");
      setImportOpen(false);
      openFirstProjectFile();
      refreshSnapshot();
      return next;
    },
    [controller, openFirstProjectFile, refreshSnapshot]
  );

  const importZipFile = useCallback(
    async (file: Blob) => {
      const next = await controller.importZipFile(file);
      setImportOpen(false);
      openFirstProjectFile();
      refreshSnapshot();
      return next;
    },
    [controller, openFirstProjectFile, refreshSnapshot]
  );

  const importGitHub = useCallback(
    async (url: string) => {
      const next = await controller.importGitHub(url);
      setImportOpen(false);
      openFirstProjectFile();
      refreshSnapshot();
      return next;
    },
    [controller, openFirstProjectFile, refreshSnapshot]
  );

  const importDroppedEntries = useCallback(
    async (source: DroppedEntrySource | null, targetDirAbs?: string | null) => {
      const dropped = await collectDroppedEntries(source);
      if (dropped.files.length === 0 && dropped.directories.length === 0) {
        if (dropped.errors.length > 0) {
          window.alert(`Dropped entries could not be imported:\n${dropped.errors.join("\n")}`);
        }
        return;
      }
      const zipEntry = dropped.files.find(
        ({ file, relativePath }) =>
          !relativePath.includes("/") && (file.name.endsWith(".zip") || file.type.includes("zip"))
      );
      const zip = zipEntry?.file;
      if (zip && (dropped.files.length === 1 || !controller.getSnapshot().project)) {
        await importZipFile(zip);
        return;
      }

      const current = controller.getSnapshot();
      if (!current.editor || !current.project) {
        if (zip) {
          await importZipFile(zip);
          return;
        }
        window.alert("Load a project before dropping individual files.");
        return;
      }

      const root = current.project.root;
      const targetDir = targetDirAbs && targetDirAbs !== "." ? targetDirAbs : root;
      const existingPaths = new Set(current.project.listFiles().map((entry) => entry.path));
      let created = 0;
      for (const { file, relativePath } of dropped.files) {
        if (file.name.endsWith(".zip") || file.type.includes("zip")) continue;
        const fullPath = joinPath(targetDir, relativePath);
        try {
          const text = await file.text();
          if (existingPaths.has(fullPath)) {
            current.editor.editText(fullPath, text);
            current.editor.saveFile(fullPath);
          } else {
            current.editor.createFile(fullPath, text);
            existingPaths.add(fullPath);
          }
          created += 1;
        } catch (error) {
          window.alert(`Failed to import ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const importedPaths = dropped.files.map(({ relativePath }) => relativePath);
      for (const relativePath of dropped.directories) {
        const hasImportedChild = importedPaths.some((path) => path.startsWith(`${relativePath}/`));
        if (hasImportedChild) continue;
        const markerPath = joinPath(targetDir, `${relativePath}/.gitkeep`);
        if (existingPaths.has(markerPath)) continue;
        current.editor.createFile(markerPath, "");
        existingPaths.add(markerPath);
        created += 1;
      }
      if (dropped.errors.length > 0) {
        window.alert(`Some dropped entries could not be imported:\n${dropped.errors.join("\n")}`);
      }
      if (created > 0) {
        bumpEditor();
        refreshSnapshot();
        setFrameNonce((value) => value + 1);
      } else if (zip) {
        await importZipFile(zip);
      } else {
        window.alert("No importable text files found in the drop.");
      }
    },
    [bumpEditor, controller, importZipFile, refreshSnapshot]
  );

  const handleDroppedFiles = useCallback(
    async (fileList: FileList | null) => {
      await importDroppedEntries(fileList, null);
    },
    [importDroppedEntries]
  );

  const runPreview = useCallback(async () => {
    const current = controller.getSnapshot();
    if (!current.workflow) loadTemplate("vite-react");
    const next = await controller.runPreview();
    if (!selectedPathRef.current) openFirstProjectFile();
    setFrameNonce((value) => value + 1);
    refreshSnapshot();
    syncPortsFromSnapshot(next);
    return next;
  }, [controller, loadTemplate, openFirstProjectFile, refreshSnapshot, syncPortsFromSnapshot]);

  const restartDev = useCallback(async () => {
    const next = await controller.restartDev();
    setFrameNonce((value) => value + 1);
    refreshSnapshot();
    syncPortsFromSnapshot(next);
    return next;
  }, [controller, refreshSnapshot, syncPortsFromSnapshot]);

  const reconnectHmr = useCallback(async () => {
    const next = await controller.reconnectHmr();
    refreshSnapshot();
    return next;
  }, [controller, refreshSnapshot]);

  const runBuild = useCallback(async () => {
    const next = await controller.runBuild();
    refreshSnapshot();
    return next;
  }, [controller, refreshSnapshot]);

  const exportZip = useCallback(() => controller.exportZip(), [controller]);

  const startViteReact = useCallback(async () => {
    loadTemplate("vite-react");
    openPreferredFile("src/main.tsx");
    focusTerminal();
    await runPreview();
  }, [focusTerminal, loadTemplate, openPreferredFile, runPreview]);

  const selectPort = useCallback((id: string) => {
    setActivePortId(id);
  }, []);

  const stopPort = useCallback(
    (port: number) => {
      controller.stopPreviewPort(port);
      setPorts((entries) => entries.filter((entry) => entry.port !== port));
      setActivePortId((current) => {
        const remaining = ports.filter((entry) => entry.port !== port);
        return remaining.some((entry) => entry.id === current) ? current : remaining[0]?.id || null;
      });
      refreshSnapshot();
    },
    [controller, ports, refreshSnapshot]
  );

  const addPreviewPathTab = useCallback(
    (pathInput = "/") => {
      const current = controller.getSnapshot();
      if (!current.previewUrl) return;
      const path = pathInput.startsWith("/") ? pathInput : `/${pathInput}`;
      const port = portFromSnapshot(current);
      const id = `port-${port}-${path}`;
      setPorts((entries) => {
        if (entries.some((entry) => entry.id === id)) return entries;
        return [
          ...entries,
          {
            id,
            port,
            label: `Preview ${path}`,
            path,
            url: buildPreviewUrl(current.previewUrl!, path)
          }
        ];
      });
      setActivePortId(id);
    },
    [controller]
  );

  const navigatePreviewPath = useCallback(
    (pathInput: string) => {
      const path = pathInput.startsWith("/") ? pathInput : `/${pathInput}`;
      const current = controller.getSnapshot();
      if (!current.previewUrl) return;
      const port = portFromSnapshot(current);
      const id = activePortId || `port-${port}-root`;
      setPorts((entries) => {
        const exists = entries.some((entry) => entry.id === id);
        if (!exists) {
          return [
            {
              id,
              port,
              label: path === "/" ? "Dev server" : `Preview ${path}`,
              path,
              url: buildPreviewUrl(current.previewUrl!, path)
            }
          ];
        }
        return entries.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                path,
                url: buildPreviewUrl(current.previewUrl!, path),
                label: path === "/" ? "Dev server" : `Preview ${path}`
              }
            : entry
        );
      });
      setActivePortId(id);
    },
    [activePortId, controller]
  );

  const runRecoveryAction = useCallback(
    async (kind: string) => {
      if (kind === "restart-dev-server" || kind === "reset-runtime") return restartDev();
      if (kind === "rerun-build") return runBuild();
      if (kind === "show-terminal") {
        setDockTab("terminal");
        updateSettings({ showTerminal: true });
        return;
      }
      if (kind === "open-file" && selectedPathRef.current) {
        openFile(selectedPathRef.current);
        return;
      }
      const next = await controller.runRecoveryAction(kind);
      refreshSnapshot();
      return next;
    },
    [controller, openFile, refreshSnapshot, restartDev, runBuild, updateSettings]
  );

  const runCommand = useCallback(
    (id: CommandId) => {
      switch (id) {
        case "save":
          saveCurrentFile();
          break;
        case "format":
          void formatCurrentFile();
          break;
        case "go-to-file":
          setPaletteMode("files");
          setPaletteOpen(true);
          break;
        case "search":
          updateSettings({ showSidebar: true });
          setSidebarView("search");
          break;
        case "toggle-sidebar":
          updateSettings({ showSidebar: !settingsRef.current.showSidebar });
          break;
        case "toggle-terminal":
          updateSettings({ showTerminal: !settingsRef.current.showTerminal });
          break;
        case "toggle-preview":
          updateSettings({ showPreview: !settingsRef.current.showPreview });
          break;
        case "explorer":
          updateSettings({ showSidebar: true });
          setSidebarView("explorer");
          break;
        case "settings":
          updateSettings({ showSidebar: true });
          setSidebarView("settings");
          break;
        case "ports":
          updateSettings({ showSidebar: true });
          setSidebarView("ports");
          break;
        case "scm":
          updateSettings({ showSidebar: true });
          setSidebarView("scm");
          break;
        case "outline":
          updateSettings({ showSidebar: true });
          setSidebarView("outline");
          break;
        case "zen":
          toggleZenMode();
          break;
        case "go-to-definition":
          goToDefinition();
          break;
        case "run-preview":
          void runPreview().catch(() => undefined);
          break;
        case "run-build":
          void runBuild().catch(() => undefined);
          break;
        case "restart":
          void restartDev().catch(() => undefined);
          break;
        case "new-file":
          createFile();
          break;
        case "export-zip":
          try {
            const bytes = exportZip();
            const blob = new Blob([Uint8Array.from(bytes)], {
              type: "application/zip"
            });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${controller.getSnapshot().projectId || "project"}.zip`;
            anchor.click();
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
          break;
        case "import":
          setImportOpen(true);
          break;
        case "start-vite-react":
          void startViteReact();
          break;
        case "split-editor":
          if (selectedPathRef.current) setSplitPath(selectedPathRef.current);
          break;
        case "help-terminal":
          updateSettings({ showTerminal: true });
          setDockTab("terminal");
          void controller.runShellCommand("help").catch(() => undefined);
          break;
        default:
          break;
      }
    },
    [
      controller,
      createFile,
      exportZip,
      formatCurrentFile,
      goToDefinition,
      restartDev,
      runBuild,
      runPreview,
      saveCurrentFile,
      startViteReact,
      toggleZenMode,
      updateSettings
    ]
  );

  const changeStatus = useMemo(() => {
    try {
      return controller.getChangeStatus();
    } catch {
      const dirty = snapshot.editor?.dirtyFiles().map((file) => file.path) || [];
      return {
        dirty,
        hasGitMarker: false,
        untrackedHint: "local editor dirty set"
      };
    }
  }, [controller, snapshot.editor, snapshot.project, editorTick]);

  const activePort = ports.find((entry) => entry.id === activePortId) || ports[0] || null;
  const activePreviewUrl = activePort?.url || snapshot.previewUrl;

  useEffect(() => {
    applySettingsToDocument(settings);
  }, [settings]);

  useEffect(() => {
    const unsubscribe = controller.on((event) => {
      const notification = notificationForWorkflowEvent(event);
      if (notification) notificationCenter.pushNotification(notification);
      const cloudToken = localStorage.getItem("cargo-container.cloud-session") || "";
      if (cloudToken && event.type === "phase" && event.detail.phase === PHASES.installed) {
        void new CloudProjectsClient({ token: () => cloudToken }).ingestUsage({
          id: `install:${event.snapshot.projectId || "project"}:${crypto.randomUUID()}`,
          kind: "install",
          quantity: 1,
          occurredAt: new Date().toISOString()
        }).catch(() => undefined);
      }
      if (event.type === "preview-ready") {
        cloudRuntimeStartedAtRef.current = Date.now();
        setFrameNonce((value) => value + 1);
        syncPortsFromSnapshot(event.snapshot);
      } else if (event.type === "hmr-update") {
        // Soft refresh keeps the session URL and avoids full SW rebind churn.
        setSoftRefreshToken((value) => value + 1);
      }
      if (cloudToken && event.type === "phase" && event.detail.stopped === true && cloudRuntimeStartedAtRef.current !== null) {
        const minutes = Math.max(0, (Date.now() - cloudRuntimeStartedAtRef.current) / 60_000);
        cloudRuntimeStartedAtRef.current = null;
        void new CloudProjectsClient({ token: () => cloudToken }).ingestUsage({
          id: `runtime:${event.snapshot.projectId || "project"}:${crypto.randomUUID()}`,
          kind: "runtime_minutes",
          quantity: minutes,
          occurredAt: new Date().toISOString()
        }).catch(() => undefined);
      }
      if (event.snapshot.diagnostics.length > 0 || event.snapshot.phase === PHASES.failed) {
        setDockTab("diagnostics");
      }
      setSnapshot(event.snapshot);
    });
    return () => {
      unsubscribe();
    };
  }, [controller, notificationCenter.pushNotification, syncPortsFromSnapshot]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        message?: string;
        stack?: string;
      } | null;
      if (!data || data.type !== "cargo-preview-error") return;
      const message = data.message || "unknown";
      controller.log(`preview error: ${message}`);
      notificationCenter.pushNotification({
        title: "Preview runtime error",
        message,
        level: "error"
      });
      setDockTab("diagnostics");
      refreshSnapshot();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [controller, notificationCenter.pushNotification, refreshSnapshot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (meta && key === "s") {
        event.preventDefault();
        saveCurrentFile();
        return;
      }
      if (meta && key === "p") {
        event.preventDefault();
        setPaletteMode("files");
        setPaletteOpen(true);
        return;
      }
      if (meta && key === "b") {
        event.preventDefault();
        runCommand("toggle-sidebar");
        return;
      }
      if (meta && key === "j") {
        event.preventDefault();
        runCommand("toggle-preview");
        return;
      }
      if (meta && event.shiftKey && key === "f") {
        event.preventDefault();
        runCommand("search");
        return;
      }
      if (meta && event.shiftKey && key === "e") {
        event.preventDefault();
        runCommand("explorer");
        return;
      }
      if (meta && key === ",") {
        event.preventDefault();
        runCommand("settings");
        return;
      }
      if (meta && event.shiftKey === false && event.altKey && key === "f") {
        event.preventDefault();
        void formatCurrentFile();
        return;
      }
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        runCommand("toggle-terminal");
        return;
      }
      if (event.key === "F1") {
        event.preventDefault();
        setPaletteMode("commands");
        setPaletteOpen(true);
      }
      if (event.key === "F12") {
        event.preventDefault();
        goToDefinition();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && !event.shiftKey) {
        // Allow normal copy in inputs/editors; explorer cut/copy uses explicit commands.
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [formatCurrentFile, goToDefinition, runCommand, saveCurrentFile]);

  useEffect(() => () => clearAutosave(), [clearAutosave]);

  useEffect(() => {
    if (deepLinkDoneRef.current) return;
    deepLinkDoneRef.current = true;
    const intent = parseDeepLink();
    if (!hasDeepLinkIntent(intent)) return;
    void (async () => {
      try {
        if (intent.github) {
          const url = intent.github.includes("github.com") ? intent.github : `https://github.com/${intent.github}`;
          await importGitHub(url);
        } else if (intent.template) {
          loadTemplate(intent.template);
        } else if (intent.file || intent.startScript) {
          loadTemplate("vite-react");
        }

        openPreferredFile(intent.file || null);

        const shouldPreview =
          intent.startScript === "dev" ||
          intent.startScript === "start" ||
          (!intent.startScript && Boolean(intent.file || intent.template === "vite-react" || intent.github));
        if (intent.startScript === "build") {
          await runBuild();
        } else if (shouldPreview) {
          focusTerminal();
          await runPreview();
        } else if (intent.startScript) {
          focusTerminal();
        }

        if (intent.openPalette) {
          setPaletteMode("commands");
          setPaletteOpen(true);
        }
      } catch {
        /* welcome remains if deep link fails */
      } finally {
        clearDeepLinkParams();
      }
    })();
  }, [focusTerminal, importGitHub, loadTemplate, openPreferredFile, runBuild, runPreview]);

  useEffect(() => {
    const maybeEnable = controller as PreviewWorkflowController & {
      setPreviewErrorBridge?: (enabled: boolean) => void;
    };
    maybeEnable.setPreviewErrorBridge?.(true);
  }, [controller]);

  const api = useMemo<PreviewServiceApi>(
    () => ({
      controller,
      loadTemplate,
      importZipFile,
      importGitHub,
      exportZip,
      setPackageManagerOverride,
      runPreview,
      restartDev,
      reconnectHmr,
      runBuild,
      clearPackageCache: () => controller.clearPackageCache(),
      resolveWriterConflict: () => controller.resolveWriterConflict(),
      runRecoveryAction,
      simulateQuotaPressure: (bytes) => controller.simulateQuotaPressure(bytes),
      snapshot: () => controller.getSnapshot(),
      openFile,
      editCurrentFile,
      saveCurrentFile
    }),
    [
      controller,
      editCurrentFile,
      exportZip,
      importGitHub,
      importZipFile,
      loadTemplate,
      openFile,
      reconnectHmr,
      restartDev,
      runBuild,
      runPreview,
      runRecoveryAction,
      saveCurrentFile,
      setPackageManagerOverride
    ]
  );

  useEffect(() => {
    globalThis.__previewService = api;
  }, [api]);
  globalThis.__previewService = api;

  const hasProject = Boolean(snapshot.project || snapshot.workflow);
  const showWelcome = !hasProject && snapshot.phase === PHASES.idle;
  const previewLive =
    snapshot.phase === PHASES.previewReady || snapshot.phase === PHASES.hmrConnected || snapshot.phase === PHASES.built;

  const editorFile = selectedPath && snapshot.editor ? snapshot.editor.openFile(selectedPath) : null;
  const splitFile = splitPath && snapshot.editor ? snapshot.editor.openFile(splitPath) : null;

  void editorTick;

  const filePaths = useMemo(() => (snapshot.project?.listFiles() || []).map((file) => file.path), [snapshot.project]);
  const localHistoryRevisions = useMemo(
    () => listLocalHistoryRevisions(localHistory, snapshot.project?.root || ""),
    [localHistory, snapshot.project?.root]
  );

  return {
    ...notificationCenter,
    controller,
    snapshot,
    selectedPath,
    openPaths,
    splitPath,
    setSplitPath,
    editorFile,
    splitFile,
    displayPath,
    importOpen,
    setImportOpen,
    cloudOpen,
    setCloudOpen,
    dockTab,
    setDockTab,
    frameNonce,
    softRefreshToken,
    showWelcome,
    hasProject,
    previewLive,
    sidebarView,
    setSidebarView,
    paletteOpen,
    setPaletteOpen,
    paletteMode,
    setPaletteMode,
    settings,
    updateSettings,
    ports,
    processes: controller.listShellProcesses(),
    activePortId,
    activePreviewUrl,
    selectPort,
    stopPort,
    addPreviewPathTab,
    navigatePreviewPath,
    changeStatus,
    filePaths,
    openFile,
    closeTab,
    editSelected,
    editFile,
    saveFile,
    saveCurrentFile,
    formatCurrentFile,
    createFile,
    createFolder,
    renamePath,
    deletePath,
    movePath,
    reorderOpenPaths,
    replaceInFiles,
    loadTemplate,
    importZipFile,
    importGitHub,
    handleDroppedFiles,
    importDroppedEntries,
    exportZip,
    setPackageManagerOverride,
    runPreview,
    restartDev,
    reconnectHmr,
    runBuild,
    startViteReact,
    focusTerminal,
    terminalFocusRequest,
    terminals,
    activeTerminalId,
    setActiveTerminalId,
    addTerminal,
    closeTerminal,
    selectedPaths,
    selectExplorerPath,
    clipboard,
    copyPaths,
    cutPaths,
    pastePaths,
    zenMode,
    toggleZenMode,
    diffView,
    openDiffView,
    closeDiffView,
    localHistoryRevisions,
    localHistoryPersistent,
    openHistoryDiff,
    restoreHistoryRevision,
    languageProblems,
    setLanguageProblems,
    editorLocation,
    openLanguageProblem,
    goToDefinition,
    runRecoveryAction,
    runCommand,
    refreshPreview: () => setFrameNonce((value) => value + 1)
  };
}

function simpleGlobMatch(path: string, glob: string): boolean {
  const patterns = glob
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ":::DOUBLE_STAR:::")
      .replace(/\*/g, "[^/]*")
      .replace(/:::DOUBLE_STAR:::/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(path);
  });
}

export type PreviewControllerModel = ReturnType<typeof usePreviewController>;

function buildPreviewUrl(basePreviewUrl: string, path: string): string {
  try {
    const url = new URL(basePreviewUrl, window.location.origin);
    const marker = "/__preview/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return basePreviewUrl;
    const parts = url.pathname.slice(index + marker.length).split("/");
    const projectId = parts[0] || "preview-service";
    const port = parts[1] || "5173";
    const normalized = path.startsWith("/") ? path : `/${path}`;
    url.pathname = `${marker}${projectId}/${port}${normalized === "/" ? "/" : normalized}`;
    return `${url.pathname}${url.search}`;
  } catch {
    return basePreviewUrl;
  }
}
