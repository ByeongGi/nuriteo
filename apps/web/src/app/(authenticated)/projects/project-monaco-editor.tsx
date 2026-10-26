"use client";

import Editor, { loader } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import "../../../../node_modules/monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "../../../../node_modules/monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "../../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "../../../../node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import { useEffect, useRef, useState } from "react";

import { EDITOR_THEME_CHANGE_EVENT, parseEditorThemePreference } from "#src/app/(authenticated)/projects/project-editor-theme.ts";
import type { EditorThemePreference } from "#src/app/(authenticated)/projects/project-editor-theme.ts";
import { defineProjectMonacoThemes, resolveProjectMonacoTheme } from "#src/app/(authenticated)/projects/project-monaco-theme.ts";
import { configureMonacoTypeScript, disposeProjectMonacoWorkspace, monacoModelPath, syncProjectMonacoWorkspace } from "#src/app/(authenticated)/projects/project-monaco-workspace.ts";
import type { RuntimeWorkspaceFile } from "#src/runtime/runtime-adapter.ts";

loader.config({ monaco });
configureMonacoTypeScript();
defineProjectMonacoThemes(monaco);

const EDITOR_PADDING = {
  bottom: 12,
  top: 12
} as const;
const MIN_LINE_NUMBER_CHARACTERS = 3;

if (typeof globalThis.Worker !== "undefined") {
  globalThis.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === "json") {
        return new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
      }
      return new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
    }
  };
}

interface Props {
  readonly formatRequestId?: number | undefined;
  readonly path: string;
  readonly priorityPaths?: readonly string[] | undefined;
  readonly projectKey: string;
  readonly readOnly: boolean;
  readonly readWorkspaceText?: ((path: string) => string) | undefined;
  readonly revealPosition?: EditorPositionRequest | undefined;
  readonly themePreference: EditorThemePreference;
  readonly value: string;
  readonly workspaceFiles?: readonly RuntimeWorkspaceFile[] | undefined;
  readonly onChange: (value: string) => void;
  readonly onDiagnosticsChange?: (diagnostics: readonly EditorDiagnostic[]) => void;
}

export interface EditorDiagnostic {
  readonly column: number;
  readonly line: number;
  readonly message: string;
  readonly severity: number;
}

export interface EditorPositionRequest {
  readonly column: number;
  readonly line: number;
  readonly requestId: number;
}

export function ProjectMonacoEditor({ formatRequestId, onChange, onDiagnosticsChange, path, priorityPaths = [], projectKey, readOnly, readWorkspaceText, revealPosition, themePreference, value, workspaceFiles }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const mountedMonacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const synchronizesWorkspace = workspaceFiles !== undefined;
  const [isCompact, setIsCompact] = useState(false);
  const [theme, setTheme] = useState(() => resolveProjectMonacoTheme(themePreference));

  useEffect(() => {
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => setTheme(resolveProjectMonacoTheme(themePreference));
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });
    media.addEventListener("change", updateTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", updateTheme);
    };
  }, [themePreference]);

  useEffect(() => {
    mountedMonacoRef.current?.editor.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const applySelectedTheme = (event: Event) => {
      const preference = event instanceof CustomEvent
        ? parseEditorThemePreference(typeof event.detail === "string" ? event.detail : undefined)
        : themePreference;
      const selectedTheme = resolveProjectMonacoTheme(preference);
      setTheme(selectedTheme);
      mountedMonacoRef.current?.editor.setTheme(selectedTheme);
    };
    globalThis.addEventListener(EDITOR_THEME_CHANGE_EVENT, applySelectedTheme);
    return () => globalThis.removeEventListener(EDITOR_THEME_CHANGE_EVENT, applySelectedTheme);
  }, [themePreference]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateLayout = () => setIsCompact(host.clientWidth < 520);
    const observer = new ResizeObserver(updateLayout);
    observer.observe(host);
    updateLayout();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!revealPosition || !editorRef.current) return;
    const position = { column: revealPosition.column, lineNumber: revealPosition.line };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
  }, [revealPosition]);

  useEffect(() => {
    if (formatRequestId === undefined || !editorRef.current) return;
    void editorRef.current.getAction("editor.action.formatDocument")?.run();
    editorRef.current.focus();
  }, [formatRequestId]);

  useEffect(() => {
    if (workspaceFiles === undefined || readWorkspaceText === undefined) return;
    syncProjectMonacoWorkspace({
      files: workspaceFiles,
      priorityPaths,
      projectKey,
      readText: readWorkspaceText
    });
  }, [priorityPaths, projectKey, readWorkspaceText, workspaceFiles]);

  useEffect(() => () => {
    if (synchronizesWorkspace) disposeProjectMonacoWorkspace(projectKey);
  }, [projectKey, synchronizesWorkspace]);

  const onMount: OnMount = (editor, mountedMonaco) => {
    editorRef.current = editor;
    mountedMonacoRef.current = mountedMonaco;
    mountedMonaco.editor.setTheme(theme);
    editor.focus();
  };

  return (
    <div className="h-full min-h-0 min-w-0 overflow-hidden" ref={hostRef}>
      <Editor
        height="100%"
        language={languageForPath(path)}
        loading={<div className="grid h-full place-items-center bg-surface text-xs text-muted-foreground" role="status">코드 편집기를 준비하는 중…</div>}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        onValidate={(markers) => onDiagnosticsChange?.(markers.map((marker) => ({
          column: marker.startColumn,
          line: marker.startLineNumber,
          message: marker.message,
          severity: marker.severity
        })))}
        onMount={onMount}
        options={{
          accessibilitySupport: "auto",
          ariaLabel: `${path} 편집기`,
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          contextmenu: true,
          cursorBlinking: "smooth",
          fixedOverflowWidgets: true,
          folding: true,
          fontFamily: "var(--n-font-family-mono)",
          fontSize: 13,
          formatOnPaste: true,
          glyphMargin: !isCompact,
          lineHeight: 22,
          lineNumbersMinChars: MIN_LINE_NUMBER_CHARACTERS,
          minimap: { enabled: !isCompact, maxColumn: 80, renderCharacters: false },
          padding: EDITOR_PADDING,
          readOnly,
          renderWhitespace: "selection",
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          useShadowDOM: false,
          wordWrap: "off"
        }}
        keepCurrentModel
        path={monacoModelPath(projectKey, path)}
        saveViewState
        theme={theme}
        value={value}
      />
    </div>
  );
}

function languageForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase();
  const languages: Readonly<Record<string, string>> = {
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    less: "less",
    md: "markdown",
    scss: "scss",
    ts: "typescript",
    tsx: "typescript"
  };
  return extension === undefined ? "plaintext" : languages[extension] ?? "plaintext";
}
