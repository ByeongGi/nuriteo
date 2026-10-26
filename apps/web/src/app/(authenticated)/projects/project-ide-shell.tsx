"use client";

import type { Project } from "@nuriteo/api-client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { MenuGroupLabel, MenuItem, MenuPopup, MenuPortal, MenuPositioner, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuRoot, MenuSeparator, MenuTrigger } from "#src/components/ui/menu.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { EDITOR_THEME_OPTIONS, parseEditorThemePreference, readEditorThemePreference, writeEditorThemePreference } from "#src/app/(authenticated)/projects/project-editor-theme.ts";
import type { EditorThemePreference } from "#src/app/(authenticated)/projects/project-editor-theme.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createRetryableLazyFeature } from "#src/lib/retryable-lazy-feature.ts";
import { useUnsavedChangesGuard } from "#src/lib/use-unsaved-changes-guard.ts";
import type {
  RuntimeAdapter,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceFile,
  RuntimeWorkspaceState
} from "#src/runtime/runtime-adapter.ts";
import { resolveRuntimeAssetRevision } from "#src/runtime/runtime-assets.ts";
import { hotUpdatePreviewBridges } from "#src/runtime/preview-hot-update.ts";
import { previewModuleRefreshPath } from "#src/runtime/preview-import-version.ts";
import { awaitWorkspaceStart } from "#src/runtime/workspace-start.ts";
import { createSubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";
import { createPreviewHistory, movePreviewHistory, normalizePreviewAddress, recordPreviewHistory } from "#src/runtime/preview-address.ts";
import type { PreviewHistory } from "#src/runtime/preview-address.ts";
import { createPreviewWindowUrl } from "#src/runtime/preview-origin-contract.ts";
import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";
import type { PreviewChangeKind, SubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";
import { planProjectContentReplace } from "#src/app/(authenticated)/projects/studio-content-replace.ts";
import { visibleStudioExplorerFiles } from "#src/app/(authenticated)/projects/studio-explorer-files.ts";
import { useProjectContentSearch, useProjectFileSearch } from "#src/app/(authenticated)/projects/use-project-file-search.ts";
import { ProjectFileTree } from "#src/app/(authenticated)/projects/project-file-tree.tsx";
import { ProjectTerminalView } from "#src/app/(authenticated)/projects/project-terminal-view.tsx";
import { useProjectTerminalSessions } from "#src/app/(authenticated)/projects/use-project-terminal-sessions.ts";

const EMPTY_RUNTIME_STATE: RuntimeViewState = {
  generation: 0,
  lifecycle: "idle",
  projectId: null,
  workflowPhase: "idle",
  hmrState: "idle",
  previewUrl: null,
  ports: [],
  processes: [],
  diagnostics: [],
  localDraftAccess: "none",
  terminalProcessCount: 0
};
const MAX_TERMINAL_COMMAND_CHARS = 2_048;
const RUNTIME_BOOT_TIMEOUT_MS = 10_000;
const RUNTIME_RELAY_TIMEOUT_MS = 10_000;
const RUNTIME_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const PREVIEW_WINDOW_CONNECT_TIMEOUT_MS = 3_000;
const PREVIEW_WINDOW_CLOSED_POLL_MS = 1_000;
const FILE_LIST_BATCH_SIZE = 200;
const PREVIEW_APPLY_DELAY_MS = 400;
const EMPTY_WORKSPACE_FILES: readonly RuntimeWorkspaceFile[] = [];
const INITIAL_SERVER_SAVE_STATUS = "이 세션에서 아직 서버에 저장하지 않음";

const ProjectMonacoEditor = dynamic(
  () => import("#src/app/(authenticated)/projects/project-monaco-editor.tsx").then((module) => module.ProjectMonacoEditor),
  {
    loading: () => <div className="grid h-full min-h-0 place-items-center bg-surface text-xs text-muted-foreground" role="status">코드 편집기를 준비하는 중…</div>,
    ssr: false
  }
);

const ideStyles = tv({
  slots: {
    shell: "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface text-foreground",
    header: "flex min-h-12 shrink-0 min-w-0 items-center justify-between gap-4 border-b border-muted-border bg-raised px-3 py-1.5 max-[48rem]:items-start max-[48rem]:flex-col",
    identity: "flex min-w-0 items-center gap-2.5 [&_p]:m-0 [&_p]:text-[0.6875rem] [&_p]:font-semibold [&_p]:uppercase [&_p]:tracking-[0.06em] [&_p]:text-foreground [&_h3]:m-0 [&_h3]:truncate",
    identityCopy: "grid min-w-0 gap-0.5",
    runtimeMeta: "flex items-center gap-2 text-[0.6875rem] text-muted-foreground",
    headerActions: "flex flex-wrap items-center justify-end gap-1.5 max-[48rem]:w-full max-[48rem]:justify-start [&_[data-slot=button]]:min-h-8 [&_[data-slot=button]]:px-2.5 [&_[data-slot=button]]:text-[0.6875rem] [&_[data-slot=button]]:shadow-none",
    access: "rounded-sm border border-primary/25 bg-selected px-1.5 py-0.5 text-[0.625rem] font-semibold text-primary",
    saveState: "flex max-w-80 items-center gap-2 truncate text-[0.6875rem] text-muted-foreground",
    quickOpen: "absolute left-1/2 top-14 z-50 grid w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 grid-rows-[auto_minmax(0,20rem)] overflow-hidden rounded-md border border-muted-border bg-raised shadow-xl [&_input]:h-10 [&_input]:w-full [&_input]:border-0 [&_input]:border-b [&_input]:border-muted-border [&_input]:bg-surface [&_input]:px-3 [&_input]:font-mono [&_input]:text-sm [&_input]:outline-none [&_ul]:m-0 [&_ul]:grid [&_ul]:max-h-80 [&_ul]:list-none [&_ul]:overflow-auto [&_ul]:p-1 [&_button]:grid [&_button]:min-h-9 [&_button]:w-full [&_button]:grid-cols-[minmax(0,1fr)_auto] [&_button]:items-center [&_button]:gap-3 [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-3 [&_button]:text-left [&_button]:hover:bg-hover [&_button]:aria-selected:bg-selected [&_button]:aria-selected:text-primary [&_button_strong]:truncate [&_button_strong]:font-mono [&_button_strong]:text-xs [&_button_small]:truncate [&_button_small]:font-mono [&_button_small]:text-[0.625rem] [&_button_small]:text-muted-foreground",
    message: "mx-2 mt-1.5 flex shrink-0 items-center gap-3 rounded border px-2.5 py-1.5 text-[0.6875rem]",
    panelHeading: "flex min-h-9 items-center justify-between gap-3 border-y border-muted-border bg-subtle px-3 [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&_span]:text-[0.625rem] [&_span]:font-semibold [&_span]:uppercase [&_span]:tracking-[0.08em] [&_span]:text-muted-foreground [&_strong]:text-[0.6875rem] [&_strong]:font-semibold [&_strong]:text-foreground",
    fileActions: "flex items-center gap-px [&_button]:grid [&_button]:size-7 [&_button]:place-items-center [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-sm [&_button]:text-muted-foreground [&_button]:hover:bg-hover [&_button]:hover:text-foreground [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-35",
    fileOperation: "mx-2 mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1 [&_input]:h-8 [&_input]:min-w-0 [&_input]:rounded-sm [&_input]:border [&_input]:border-primary [&_input]:bg-surface [&_input]:px-2.5 [&_input]:font-mono [&_input]:text-[0.6875rem] [&_button]:min-h-8 [&_button]:px-2 [&_button]:text-[0.625rem]",
    workbench: "grid min-h-0 min-w-0 flex-1 grid-cols-[3rem_var(--studio-sidebar-width)_minmax(24rem,1fr)_var(--studio-preview-width)] max-[72rem]:grid-cols-[3rem_14rem_minmax(0,1fr)] max-[72rem]:overflow-auto max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]",
    activity: "flex min-h-0 flex-col items-center gap-1 border-r border-muted-border bg-sidebar py-2 max-[48rem]:max-h-72",
    activityButton: "grid size-10 place-items-center rounded-sm border-0 border-l-2 border-l-transparent bg-transparent p-0 text-muted-foreground hover:bg-hover hover:text-foreground aria-[pressed=true]:border-l-primary aria-[pressed=true]:bg-selected aria-[pressed=true]:text-primary focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary [&_svg]:size-[1.15rem]",
    activityDivider: "my-1 h-px w-6 bg-muted-border",
    files: "relative grid min-h-0 min-w-0 grid-rows-[auto_auto_auto_auto_minmax(0,1fr)] overflow-visible border-r border-muted-border bg-raised max-[48rem]:col-start-2 max-[48rem]:max-h-72 max-[48rem]:border-r-0 max-[48rem]:border-b [&>*:not([role=separator])]:min-w-0",
    projectSummary: "grid gap-1 px-3 py-3 [&_strong]:truncate [&_strong]:text-xs [&_strong]:font-semibold [&_strong]:text-foreground [&_span]:truncate [&_span]:text-[0.6875rem] [&_span]:text-muted-foreground",
    fileList: "min-h-0 overflow-auto px-1.5 pb-3",
    contentResults: "min-h-0 overflow-auto px-1.5 pb-3 [&_ul]:m-0 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-1 [&_ul]:p-0 [&_button]:grid [&_button]:w-full [&_button]:grid-cols-[minmax(0,1fr)_auto] [&_button]:gap-x-2 [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2 [&_button]:py-2 [&_button]:text-left [&_button]:hover:bg-hover [&_button_strong]:truncate [&_button_strong]:font-mono [&_button_strong]:text-[0.6875rem] [&_button_strong]:text-primary [&_button_small]:font-mono [&_button_small]:text-[0.625rem] [&_button_small]:text-muted-foreground [&_button_span]:col-span-2 [&_button_span]:mt-1 [&_button_span]:truncate [&_button_span]:font-mono [&_button_span]:text-[0.625rem] [&_button_span]:text-muted-foreground",
    editorStack: "grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] border-r border-muted-border max-[72rem]:min-h-[30rem] max-[72rem]:border-r-0 max-[48rem]:col-span-2",
    editor: "grid min-h-0 min-w-0 grid-rows-[2.5rem_minmax(0,1fr)_auto] bg-surface data-[path=true]:grid-rows-[2.5rem_auto_minmax(0,1fr)_auto]",
    editorBreadcrumbs: "flex min-h-7 min-w-0 items-center gap-1 overflow-x-auto border-b border-muted-border bg-surface px-3 font-mono text-[0.625rem] text-muted-foreground [&_span]:truncate",
    splitPane: "grid min-h-0 min-w-0 grid-rows-[1.75rem_minmax(0,1fr)]",
    splitPaneBar: "flex min-w-0 items-center justify-between gap-2 border-b border-muted-border bg-subtle px-2 font-mono text-[0.625rem] text-muted-foreground [&_span]:truncate [&_button]:grid [&_button]:size-6 [&_button]:place-items-center [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-muted-foreground [&_button]:hover:bg-hover [&_button]:hover:text-foreground",
    utility: "relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-visible border-l border-muted-border bg-raised max-[72rem]:col-span-3 max-[72rem]:min-h-96 max-[72rem]:border-l-0 max-[72rem]:border-t max-[48rem]:col-span-2 [&>*:not([role=separator])]:min-w-0",
    fileSearch: "relative mx-2 mt-2 block [&_input]:h-8 [&_input]:w-full [&_input]:rounded-sm [&_input]:border [&_input]:border-muted-border [&_input]:bg-surface [&_input]:pl-2.5 [&_input]:pr-7 [&_input]:text-[0.6875rem]",
    searchArea: "grid gap-1",
    replaceRow: "mx-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1 [&_input]:h-8 [&_input]:min-w-0 [&_input]:rounded-sm [&_input]:border [&_input]:border-muted-border [&_input]:bg-surface [&_input]:px-2.5 [&_input]:font-mono [&_input]:text-[0.6875rem] [&_button]:min-h-8 [&_button]:px-2 [&_button]:text-[0.625rem]",
    searchControls: "mx-2 flex items-center justify-end gap-1 [&_button]:grid [&_button]:size-7 [&_button]:place-items-center [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:font-mono [&_button]:text-[0.625rem] [&_button]:font-semibold [&_button]:text-muted-foreground [&_button]:hover:bg-hover [&_button]:hover:text-foreground [&_button[aria-pressed=true]]:bg-selected [&_button[aria-pressed=true]]:text-primary",
    fileCount: "mx-3 mb-1.5 mt-2 text-[0.625rem] uppercase tracking-[0.05em] text-muted-foreground",
    fileIcon: "font-mono text-[0.6875rem] text-primary",
    fileEmpty: "px-2 py-4 text-[0.6875rem] text-muted-foreground",
    fileMore: "mt-2 min-h-8 w-full rounded-sm border border-dashed border-muted-border bg-transparent text-[0.6875rem] font-semibold text-primary hover:border-solid hover:bg-hover",
    editorTabs: "flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-muted-border bg-subtle text-[0.6875rem] text-muted-foreground [&>span]:self-center [&>span]:px-3 [&>div]:flex [&>div]:max-w-64 [&>div]:shrink-0 [&>div]:items-center [&>div]:border-r [&>div]:border-muted-border [&>div.is-active]:border-t-2 [&>div.is-active]:border-t-primary [&>div.is-active]:bg-surface [&>div.is-active]:text-foreground [&_.tab-select]:flex [&_.tab-select]:min-w-0 [&_.tab-select]:items-center [&_.tab-select]:gap-2 [&_.tab-select]:border-0 [&_.tab-select]:bg-transparent [&_.tab-select]:px-3 [&_.tab-select]:py-1 [&_.tab-select]:text-inherit [&_.tab-close]:mr-1 [&_.tab-close]:grid [&_.tab-close]:size-6 [&_.tab-close]:place-items-center [&_.tab-close]:border-0 [&_.tab-close]:bg-transparent [&_.tab-close]:text-muted-foreground [&_.tab-close]:hover:bg-hover [&_strong]:max-w-40 [&_strong]:truncate",
    editorHost: "relative min-h-0 min-w-0 overflow-hidden bg-surface focus-within:shadow-[inset_0_0_0_1px_var(--n-color-border-focus)]",
    editorPanes: "grid h-full min-h-0 min-w-0 grid-cols-1 divide-x divide-muted-border data-[split=true]:grid-cols-2 max-[56rem]:data-[split=true]:grid-cols-1 max-[56rem]:data-[split=true]:grid-rows-2 max-[56rem]:data-[split=true]:divide-x-0 max-[56rem]:data-[split=true]:divide-y [&>div]:min-h-0 [&>div]:min-w-0",
    editorEmpty: "grid place-content-center justify-items-center p-8 text-center text-muted-foreground [&>span]:mb-3 [&>span]:grid [&>span]:size-12 [&>span]:place-items-center [&>span]:rounded-lg [&>span]:border [&>span]:border-muted-border [&>span]:bg-subtle [&>span]:text-xl [&>span]:text-primary [&_p]:mt-2 [&_p]:max-w-md [&_p]:text-xs",
    status: "flex min-h-7 min-w-0 items-center justify-between gap-3 border-t border-muted-border bg-subtle px-2.5 text-[0.625rem] text-muted-foreground max-[48rem]:flex-wrap max-[48rem]:py-2 [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2 [&>span]:truncate [&_button]:min-h-6 [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-[0.625rem]",
    utilityEmpty: "grid place-content-center justify-items-center p-8 text-center text-muted-foreground [&>span]:mb-3 [&>span]:grid [&>span]:size-12 [&>span]:place-items-center [&>span]:rounded-lg [&>span]:border [&>span]:border-muted-border [&>span]:bg-subtle [&>span]:text-xl [&>span]:text-primary [&_p]:mt-2 [&_p]:max-w-md [&_p]:text-xs",
    preview: "grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden [&_iframe]:h-full [&_iframe]:min-h-0 [&_iframe]:w-full [&_iframe]:border-0 [&_iframe]:bg-white",
    previewToolbar: "grid min-h-10 grid-cols-[auto_minmax(8rem,1fr)_auto] items-center gap-1.5 border-b border-muted-border bg-raised px-1.5 text-[0.6875rem] text-muted-foreground",
    previewControls: "flex items-center gap-px [&_button]:grid [&_button]:size-7 [&_button]:place-items-center [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-sm [&_button]:text-muted-foreground [&_button]:hover:bg-hover [&_button]:hover:text-foreground [&_button:disabled]:opacity-35",
    previewAddress: "flex min-w-0 items-center gap-2 rounded-full border border-muted-border bg-surface px-3 py-1 font-mono text-[0.625rem] text-muted-foreground focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:p-0 [&_input]:font-mono [&_input]:text-[0.625rem] [&_input]:text-foreground [&_input]:outline-none disabled:[&_input]:text-muted-foreground",
    previewActions: "flex items-center gap-1 [&_[data-slot=button]]:min-h-7 [&_[data-slot=button]]:px-2 [&_[data-slot=button]]:text-[0.625rem]",
    live: "flex items-center gap-1.5 text-[0.625rem] font-bold text-success",
    start: "grid min-h-[30rem] flex-1 place-content-center justify-items-center gap-4 bg-page p-[clamp(2rem,7vw,4rem)] text-center [&_h4]:m-0 [&_p]:m-0 [&_p]:max-w-lg [&_p]:text-sm [&_p]:leading-6 [&_p]:text-muted-foreground",
    startMark: "mb-6 grid size-12 place-items-center rounded-lg bg-primary text-lg font-bold text-on-primary",
    recoveryActions: "flex flex-wrap gap-2 px-4",
    recovery: "mx-4 grid gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm",
    terminal: "relative grid h-48 min-h-0 grid-rows-[2rem_minmax(0,1fr)] border-t border-white/10 bg-[var(--n-color-studio-editor)] text-[var(--n-color-studio-fg)]",
    terminalToolbar: "flex min-h-8 items-center justify-between gap-3 border-b border-white/10 bg-[var(--n-color-studio-raised)] pl-2 text-[0.6875rem] text-white/70 [&_[role=toolbar]]:flex [&_[role=toolbar]]:h-full [&_[role=toolbar]]:min-w-0 [&_[role=toolbar]]:items-stretch [&_[role=toolbar]_button]:min-w-0 [&_[role=toolbar]_button]:border-0 [&_[role=toolbar]_button]:border-b-2 [&_[role=toolbar]_button]:border-b-transparent [&_[role=toolbar]_button]:bg-transparent [&_[role=toolbar]_button]:px-2.5 [&_[role=toolbar]_button]:text-white/50 [&_[role=toolbar]_button]:hover:text-white/85 [&_[role=toolbar]_button[aria-pressed=true]]:border-b-[var(--n-color-studio-success)] [&_[role=toolbar]_button[aria-pressed=true]]:text-white",
    terminalActions: "flex h-full shrink-0 items-center [&_button]:grid [&_button]:h-full [&_button]:min-w-8 [&_button]:place-items-center [&_button]:border-0 [&_button]:border-l [&_button]:border-white/10 [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-sm [&_button]:text-white/55 [&_button]:hover:bg-white/5 [&_button]:hover:text-white",
    runtimeList: "m-0 grid min-h-0 list-none content-start gap-px overflow-auto p-2 font-mono text-[0.6875rem] text-white/70 [&_li]:grid [&_li]:grid-cols-[minmax(0,1fr)_auto] [&_li]:items-center [&_li]:gap-x-4 [&_li]:rounded-sm [&_li]:px-2.5 [&_li]:py-2 [&_li]:hover:bg-white/5 [&_strong]:truncate [&_strong]:font-medium [&_strong]:text-white/90 [&_span]:truncate [&_span]:text-white/45 [&_button]:rounded-sm [&_button]:border [&_button]:border-white/15 [&_button]:bg-transparent [&_button]:px-2 [&_button]:py-1 [&_button]:font-sans [&_button]:text-[0.625rem] [&_button]:text-white/65 [&_button]:hover:bg-white/10 [&_button]:hover:text-white [&_a]:text-[var(--n-color-studio-success)] [&_a]:no-underline [&_a]:hover:underline"
  },
  variants: {
    sidebarOpen: {
      false: {
        files: "hidden"
      }
    },
    previewOpen: {
      false: { utility: "hidden" }
    },
    focus: {
      true: { workbench: "grid-cols-[minmax(0,1fr)]", activity: "hidden", files: "hidden", utility: "hidden" }
    }
  }
});

const runtimeDot = tv({
  base: "size-2 shrink-0 rounded-full bg-muted-foreground",
  variants: { state: { ready: "bg-success", running: "bg-success", failed: "bg-danger", idle: "bg-muted-foreground", starting: "bg-warning", stopping: "bg-warning" } },
  defaultVariants: { state: "idle" }
});

type RuntimeFeature = typeof import("#src/runtime/runtime-adapter.ts");
const runtimeFeature = createRetryableLazyFeature<RuntimeFeature>(
  () => import("#src/runtime/runtime-adapter.ts")
);
type ResumeFeature = typeof import("#src/resume/project-content.ts");
const resumeFeature = createRetryableLazyFeature<ResumeFeature>(
  () => import("#src/resume/project-content.ts")
);
type SaveFeature = typeof import("#src/save/project-save.ts");
const saveFeature = createRetryableLazyFeature<SaveFeature>(() => import("#src/save/project-save.ts"));
type SidebarPanel = "files" | "search";
type BottomPanel = "console" | "ports" | "problems" | "processes" | "output" | "terminal";
interface PreviewConsoleEntry {
  readonly id: number;
  readonly message: string;
  readonly stack: string;
}
type FileOperation = "create" | "rename";
interface EditorDiagnostic {
  readonly column: number;
  readonly line: number;
  readonly message: string;
  readonly severity: number;
}
interface EditorPositionRequest {
  readonly column: number;
  readonly line: number;
  readonly requestId: number;
}

interface Props {
  readonly assetRevision?: string;
  readonly previewConfiguration: PreviewOriginConfiguration;
  readonly previewBridgeFactory?: typeof createSubdomainPreviewBridge;
  readonly project: Project;
  readonly projectEtag?: string;
  readonly onProjectCommit?: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly onProjectReload?: () => void;
  readonly resumeProjectContentLoader?: () => Promise<Pick<ResumeFeature, "resumeProjectContent">>;
  readonly runtimeFeatureLoader?: () => Promise<RuntimeFeature>;
  readonly workspaceScope: string;
}
export function ProjectIdeShell({ assetRevision, onProjectCommit, onProjectReload, previewBridgeFactory, previewConfiguration, project, projectEtag, resumeProjectContentLoader, runtimeFeatureLoader, workspaceScope }: Props) {
  const adapterRef = useRef<RuntimeAdapter | undefined>(undefined);
  const previewBridgeRef = useRef<SubdomainPreviewBridge | undefined>(undefined);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewBridgeOperationRef = useRef(0);
  const previewRecoveryRef = useRef<Promise<void> | null>(null);
  const previewWindowDisposersRef = useRef(new Set<() => void>());
  const previewWindowBridgesRef = useRef(new Set<SubdomainPreviewBridge>());
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const manifestAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const fileSearchRef = useRef<HTMLInputElement | null>(null);
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const unmountedRef = useRef(false);
  const packageSyncGenerationRef = useRef(0);
  const workspaceStartOperationRef = useRef(0);
  const [workspace, setWorkspace] = useState<RuntimeWorkspaceState>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [openPaths, setOpenPaths] = useState<readonly string[]>([]);
  const [editorContent, setEditorContent] = useState("");
  const [editorDiagnostics, setEditorDiagnostics] = useState<readonly EditorDiagnostic[]>([]);
  const [previewConsole, setPreviewConsole] = useState<readonly PreviewConsoleEntry[]>([]);
  const previewConsoleIdRef = useRef(0);
  const isTerminalOpenRef = useRef(false);
  const [editorPositionRequest, setEditorPositionRequest] = useState<EditorPositionRequest>();
  const [editorFormatRequestId, setEditorFormatRequestId] = useState<number>();
  const [isEditorSplit, setIsEditorSplit] = useState(false);
  const [splitPath, setSplitPath] = useState<string>();
  const [splitContent, setSplitContent] = useState("");
  const [splitDirty, setSplitDirty] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [editorThemePreference, setEditorThemePreference] = useState<EditorThemePreference>("system");
  const terminal = useProjectTerminalSessions();
  const [error, setError] = useState<string>();
  const [isStarting, setIsStarting] = useState(false);
  const [resumeStatus, setResumeStatus] = useState<string>();
  const [isRunningPreview, setIsRunningPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isServerSaving, setIsServerSaving] = useState(false);
  const [serverSaveStatus, setServerSaveStatus] = useState(INITIAL_SERVER_SAVE_STATUS);
  const [serverSaveFailure, setServerSaveFailure] = useState<"retry" | "stale">();
  const [recoveringAction, setRecoveringAction] = useState<RuntimeRecoveryActionKind>();
  const [confirmingWriterTakeover, setConfirmingWriterTakeover] = useState(false);
  const [isolatedPreviewUrl, setIsolatedPreviewUrl] = useState<string>();
  const [previewHistory, setPreviewHistory] = useState<PreviewHistory>(createPreviewHistory);
  const [previewAddress, setPreviewAddress] = useState("/");
  const previewAddressEditingRef = useRef(false);
  const [previewRefreshFailed, setPreviewRefreshFailed] = useState(false);
  const [editorStatus, setEditorStatus] = useState("로컬 초안");
  const [runtime, setRuntime] = useState<RuntimeViewState>(EMPTY_RUNTIME_STATE);
  const [fileQuery, setFileQuery] = useState("");
  const [fileListLimit, setFileListLimit] = useState(FILE_LIST_BATCH_SIZE);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("files");
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);
  const [fileOperation, setFileOperation] = useState<FileOperation>();
  const [fileOperationValue, setFileOperationValue] = useState("");
  const [confirmingFileDelete, setConfirmingFileDelete] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [matchFileCase, setMatchFileCase] = useState(false);
  const [useFileRegularExpression, setUseFileRegularExpression] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  isTerminalOpenRef.current = isTerminalOpen;
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>("terminal");
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [previewWidth, setPreviewWidth] = useState(420);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(192);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false);
  const [confirmingWorkspaceStop, setConfirmingWorkspaceStop] = useState(false);

  useEffect(() => {
    setEditorThemePreference(readEditorThemePreference());
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    const initialUrl = new URL(globalThis.location.href);
    if (initialUrl.searchParams.get("terminal") === "dev") {
      setBottomPanel("terminal");
      setIsTerminalOpen(true);
    }
    if (project.state === "active") void startWorkspace();
    return () => {
      unmountedRef.current = true;
      workspaceStartOperationRef.current += 1;
      previewBridgeOperationRef.current += 1;
      manifestAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      unsubscribeRef.current();
      const bridge = previewBridgeRef.current;
      previewBridgeRef.current = undefined;
      for (const dispose of previewWindowDisposersRef.current) dispose();
      previewWindowDisposersRef.current.clear();
      previewWindowBridgesRef.current.clear();
      void bridge?.dispose();
      void adapterRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (editorStatus !== "저장하지 않은 로컬 변경" || !selectedPath || runtime.localDraftAccess !== "writer") return;
    const path = selectedPath;
    const content = editorContent;
    const timer = window.setTimeout(() => {
      void applyDraftChange(path, content);
    }, PREVIEW_APPLY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [editorContent, editorStatus, runtime.localDraftAccess, selectedPath]);

  useEffect(() => {
    if (!splitDirty || !splitPath || splitPath === selectedPath || runtime.localDraftAccess !== "writer") return;
    const path = splitPath;
    const content = splitContent;
    const timer = window.setTimeout(() => {
      void applyDraftChange(path, content, { clearSplitDirty: true });
    }, PREVIEW_APPLY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [runtime.localDraftAccess, selectedPath, splitContent, splitDirty, splitPath]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setSidebarPanel("files");
        setIsSidebarOpen(true);
        setIsQuickOpenOpen(false);
        return;
      }
      if (command && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSidebarPanel("search");
        setIsSidebarOpen(true);
        setIsQuickOpenOpen(false);
        globalThis.requestAnimationFrame(() => fileSearchRef.current?.focus());
        return;
      }
      if (command && !event.shiftKey && !event.altKey && event.key === "\\") {
        event.preventDefault();
        toggleSplit();
        return;
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveToServer();
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpenQuery("");
        setQuickOpenIndex(0);
        setIsQuickOpenOpen(true);
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setIsSidebarOpen((current) => !current);
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setIsPreviewOpen((current) => !current);
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "`") {
        event.preventDefault();
        setBottomPanel("terminal");
        setIsTerminalOpen((current) => !current);
      }
    };
    globalThis.addEventListener("keydown", saveShortcut);
    return () => globalThis.removeEventListener("keydown", saveShortcut);
  });

  async function startWorkspace() {
    if (adapterRef.current !== undefined) {
      setError("완전히 종료되지 않은 워크스페이스입니다. 프로젝트를 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    const operation = workspaceStartOperationRef.current + 1;
    workspaceStartOperationRef.current = operation;
    setError(undefined);
    setServerSaveFailure(undefined);
    setServerSaveStatus(INITIAL_SERVER_SAVE_STATUS);
    setIsStarting(true);
    setResumeStatus("현재 서버 저장본을 확인하는 중…");
    try {
      manifestAbortRef.current?.abort();
      const manifestAbort = new AbortController();
      manifestAbortRef.current = manifestAbort;
      const runtimePromise = runtimeFeatureLoader?.() ?? runtimeFeature.load();
      const revisionPromise = resolveRuntimeAssetRevision(assetRevision, manifestAbort.signal);
      const savedContentPromise = (resumeProjectContentLoader?.() ?? resumeFeature.load())
        .then(({ resumeProjectContent }) => resumeProjectContent({
            ownerType: project.ownerType,
            ownerId: project.ownerId,
            projectId: project.id,
            storageScopeId: project.storageScopeId
          }, { signal: manifestAbort.signal }))
        .catch((caught: unknown) => {
          if (projectContentErrorCode(caught) === "RESUME_NOT_SAVED") return undefined;
          throw caught;
        });
      const [{ createRuntimeAdapter }, revision, savedContent] = await awaitWorkspaceStart(manifestAbort, {
        runtime: runtimePromise,
        revision: revisionPromise,
        content: savedContentPromise
      });
      if (unmountedRef.current || workspaceStartOperationRef.current !== operation) return;
      const source = savedContent === undefined ? "template" : "saved";
      setResumeStatus(source === "saved" ? "검증 완료. 저장된 프로젝트를 여는 중…" : "저장본이 없어 시작 템플릿을 만드는 중…");
      const adapter = createRuntimeAdapter();
      adapterRef.current = adapter;
      unsubscribeRef.current();
      unsubscribeRef.current = adapter.subscribe(setRuntime);
      const origin = globalThis.location.origin;
      const base = `/runtime/${revision}`;
      await adapter.mount({
        project: {
          id: project.id,
          storageScopeId: project.storageScopeId,
          workspaceScopeId: workspaceScope,
          displayName: project.name
        },
        assets: {
          systemWorkerUrl: new URL(`${base}/system-worker.js`, origin),
          processWorkerUrl: new URL(`${base}/process-worker.js`, origin),
          systemWasmUrl: new URL(`${base}/system.wasm`, origin),
          previewServiceWorkerUrl: new URL(`${base}/preview-sw.js`, origin)
        },
        policy: {
          bootTimeoutMs: RUNTIME_BOOT_TIMEOUT_MS,
          relayTimeoutMs: RUNTIME_RELAY_TIMEOUT_MS,
          memoryLimitBytes: RUNTIME_MEMORY_LIMIT_BYTES
        },
        reportDiagnostic(diagnostic) {
          if (diagnostic.severity === "error") setError(diagnostic.message);
        }
      });
      let materialized: RuntimeWorkspaceState;
      if (source === "template") {
        materialized = await adapter.workspace.materializeTemplate(project.templateId);
      } else {
        if (savedContent === undefined) throw new Error("Saved project content is unavailable.");
        materialized = await adapter.workspace.materializeBundle(savedContent.files);
      }
      const requestedPath = new URL(globalThis.location.href).searchParams.get("file");
      const firstTextFile = materialized.files.find((file) => file.kind === "text" && file.path === requestedPath)
        ?? materialized.files.find((file) => file.kind === "text");
      setWorkspace(materialized);
      setOpenPaths([]);
      if (source === "template") {
        setHasUnpublishedChanges(true);
        setEditorStatus("로컬 초안");
        setResumeStatus("이 브라우저에 시작 템플릿을 준비했습니다.");
      } else {
        if (savedContent === undefined) throw new Error("Saved project content is unavailable.");
        setHasUnpublishedChanges(false);
        setEditorStatus(`서버 저장본 v${savedContent.descriptor.projectVersion} 복원됨`);
        setResumeStatus(`이 브라우저에 서버 저장본 v${savedContent.descriptor.projectVersion}을 준비했습니다.`);
      }
      if (firstTextFile) selectFile(firstTextFile.path, materialized);
      if (previewConfiguration.status === "enabled") void startPreview(adapter);
    } catch (caught) {
      if (workspaceStartOperationRef.current !== operation) return;
      const contentCode = projectContentErrorCode(caught);
      const runtimeCode = runtimeErrorCode(caught);
      setError(contentCode === null
        ? `브라우저 워크스페이스를 안전하게 시작하지 못했습니다.${runtimeCode ? ` (${runtimeCode})` : ""}`
        : resumeErrorMessage(contentCode));
      setResumeStatus(undefined);
      await releaseAdapter();
    } finally {
      if (workspaceStartOperationRef.current === operation) {
        manifestAbortRef.current = null;
        setIsStarting(false);
      }
    }
  }

  function selectFile(path: string, currentWorkspace = workspace) {
    const file = currentWorkspace?.files.find((candidate) => candidate.path === path);
    if (file?.kind !== "text") {
      setEditorContent("");
      setSelectedPath(path);
      setError("바이너리 파일과 지원하지 않는 파일은 텍스트 편집기에서 열 수 없습니다.");
      return;
    }
    try {
      const adapter = adapterRef.current;
      if (!adapter) throw new Error("runtime unavailable");
      const previousPath = selectedPath;
      const previousContent = editorContent;
      const wasMirroring = isEditorSplit && splitPath === previousPath && path !== previousPath;
      persistSelectedEditorToDraft(adapter);
      if (splitPath && splitPath !== previousPath) persistSplitDraft(adapter);
      if (wasMirroring && previousPath) {
        setSplitPath(previousPath);
        setSplitContent(previousContent);
        setSplitDirty(false);
      }
      setEditorContent(adapter.workspace.readText(path));
      setSelectedPath(path);
      setOpenPaths((current) => current.includes(path) ? current : [...current, path]);
      setEditorDiagnostics([]);
      setEditorPositionRequest(undefined);
      setError(undefined);
    } catch {
      setEditorContent("");
      setSelectedPath(path);
      setError("이 파일을 텍스트로 열 수 없습니다.");
    }
  }

  function persistSelectedEditorToDraft(adapter = adapterRef.current): void {
    if (!adapter || !selectedPath || editorStatus !== "저장하지 않은 로컬 변경") return;
    const next = adapter.workspace.writeText(selectedPath, editorContent);
    setRuntime(next);
    setWorkspace(adapter.workspace.getState());
    hotUpdatePreviews(selectedPath);
    setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨");
  }

  function persistSplitDraft(adapter = adapterRef.current): void {
    if (!adapter || !splitPath || splitPath === selectedPath || !splitDirty) return;
    const next = adapter.workspace.writeText(splitPath, splitContent);
    setRuntime(next);
    setWorkspace(adapter.workspace.getState());
    hotUpdatePreviews(splitPath);
    setSplitDirty(false);
  }

  function openInSplit(path: string): void {
    const adapter = adapterRef.current;
    const file = workspace?.files.find((candidate) => candidate.path === path);
    if (!adapter || file?.kind !== "text") {
      setError("바이너리 파일과 지원하지 않는 파일은 분할 편집기에서 열 수 없습니다.");
      return;
    }
    persistSelectedEditorToDraft(adapter);
    persistSplitDraft(adapter);
    try {
      const content = path === selectedPath ? editorContent : adapter.workspace.readText(path);
      setSplitPath(path);
      setSplitContent(content);
      setSplitDirty(false);
      setIsEditorSplit(true);
      setOpenPaths((current) => current.includes(path) ? current : [...current, path]);
      setError(undefined);
    } catch {
      setError("이 파일을 분할 편집기에서 열 수 없습니다.");
    }
  }

  function closeSplit(): void {
    persistSplitDraft();
    setIsEditorSplit(false);
    setSplitPath(undefined);
    setSplitContent("");
    setSplitDirty(false);
  }

  function toggleSplit(): void {
    if (isEditorSplit) {
      closeSplit();
      return;
    }
    if (!selectedPath) return;
    setSplitPath(selectedPath);
    setSplitContent(editorContent);
    setSplitDirty(false);
    setIsEditorSplit(true);
  }

  function copyExplorerPath(path: string): void {
    void navigator.clipboard.writeText(path).catch(() => {
      setError("파일 경로를 복사하지 못했습니다.");
    });
  }

  function beginCreate(directoryPath?: string): void {
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation("create");
    const directory = directoryPath?.replace(/\/$/u, "");
    setFileOperationValue(directory ? `${directory}/` : "src/");
  }

  function beginRename(path: string): void {
    selectFile(path);
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation("rename");
    setFileOperationValue(path);
  }

  function requestDelete(path: string): void {
    selectFile(path);
    setConfirmingFileDelete(true);
  }

  function hotUpdatePreviews(path: string, changeKind: PreviewChangeKind = "content"): void {
    hotUpdatePreviewBridges(previewBridgeRef.current, previewWindowBridgesRef.current, path, changeKind);
  }

  async function applyDraftChange(path: string, content: string, options?: { clearSplitDirty?: boolean }): Promise<void> {
    const adapter = adapterRef.current;
    if (!adapter || unmountedRef.current) return;
    try {
      const next = adapter.workspace.writeText(path, content);
      setRuntime(next);
      const workspaceState = adapter.workspace.getState();
      setWorkspace(workspaceState);
      if (options?.clearSplitDirty) setSplitDirty(false);
      if (path !== "package.json") {
        hotUpdatePreviews(path);
        if (!options?.clearSplitDirty) {
          setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
        }
        setError(undefined);
        return;
      }
      const generation = ++packageSyncGenerationRef.current;
      setEditorStatus("추가한 패키지를 설치하는 중");
      const synced = await adapter.workflow.syncDeclaredPackages();
      if (generation !== packageSyncGenerationRef.current || unmountedRef.current) return;
      if (synced.added.length > 0) {
        hotUpdatePreviews(previewModuleRefreshPath(workspaceState.files.map((file) => file.path)));
        setEditorStatus("패키지 설치됨 · 미리보기에 반영됨");
      } else {
        hotUpdatePreviews(path);
        setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
      }
      setError(undefined);
    } catch {
      if (unmountedRef.current) return;
      setError(path === "package.json" ? "추가한 패키지를 미리보기에 설치하지 못했습니다." : "텍스트 변경사항을 미리보기에 적용하지 못했습니다.");
    }
  }

  function closeFile(path: string): void {
    const currentIndex = openPaths.indexOf(path);
    const remainingPaths = openPaths.filter((candidate) => candidate !== path);
    if (path !== selectedPath) {
      setOpenPaths(remainingPaths);
      return;
    }
    const wasMirroring = isEditorSplit && splitPath === path;
    const previousContent = editorContent;
    persistSelectedEditorToDraft();
    const nextPath = remainingPaths[Math.min(currentIndex, remainingPaths.length - 1)];
    setOpenPaths(remainingPaths);
    setEditorDiagnostics([]);
    setEditorPositionRequest(undefined);
    if (wasMirroring) {
      setSplitContent(previousContent);
      setSplitDirty(false);
    }
    if (nextPath) {
      const adapter = adapterRef.current;
      setSelectedPath(nextPath);
      setEditorContent(adapter?.workspace.readText(nextPath) ?? "");
      return;
    }
    closeSplit();
    setSelectedPath(undefined);
    setEditorContent("");
  }

  function closeAllFiles(): void {
    persistSelectedEditorToDraft();
    persistSplitDraft();
    setIsEditorSplit(false);
    setSplitPath(undefined);
    setSplitContent("");
    setSplitDirty(false);
    setOpenPaths([]);
    setSelectedPath(undefined);
    setEditorContent("");
    setEditorDiagnostics([]);
    setEditorPositionRequest(undefined);
  }

  function closeSavedFiles(): void {
    if (hasUnsavedEditorChange && selectedPath) {
      setOpenPaths([selectedPath]);
      return;
    }
    closeAllFiles();
  }

  function changeEditorThemePreference(value: unknown): void {
    const preference = parseEditorThemePreference(typeof value === "string" ? value : undefined);
    setEditorThemePreference(preference);
    writeEditorThemePreference(preference);
  }

  function beginFileOperation(operation: FileOperation): void {
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation(operation);
    setFileOperationValue(operation === "rename" ? selectedPath ?? "" : "src/");
  }

  function commitFileOperation(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const adapter = adapterRef.current;
    const nextPath = fileOperationValue.trim();
    if (!adapter || !fileOperation || !nextPath) return;
    try {
      persistSelectedEditorToDraft(adapter);
      if (fileOperation === "create") {
        const next = adapter.workspace.createText(nextPath);
        setRuntime(next);
        setWorkspace(adapter.workspace.getState());
        setFileOperation(undefined);
        setFileOperationValue("");
        setHasUnpublishedChanges(true);
        hotUpdatePreviews(nextPath, "create");
        selectFile(nextPath, adapter.workspace.getState());
        return;
      }
      if (!selectedPath || nextPath === selectedPath) {
        setFileOperation(undefined);
        return;
      }
      const previousPath = selectedPath;
      const next = adapter.workspace.renameText(previousPath, nextPath);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      setOpenPaths((current) => current.map((path) => path === previousPath ? nextPath : path));
      setSelectedPath(nextPath);
      setEditorStatus("파일 이름 변경됨 · 로컬 초안");
      setFileOperation(undefined);
      setFileOperationValue("");
      setHasUnpublishedChanges(true);
      hotUpdatePreviews(nextPath, "rename");
    } catch {
      setError(fileOperation === "create" ? "새 파일을 만들지 못했습니다. 경로와 중복 여부를 확인하세요." : "파일 이름을 변경하지 못했습니다. 경로와 중복 여부를 확인하세요.");
    }
  }

  function deleteSelectedFile(): void {
    const adapter = adapterRef.current;
    if (!adapter || !selectedPath) return;
    const deletedPath = selectedPath;
    try {
      const next = adapter.workspace.deleteText(deletedPath);
      const remainingPaths = openPaths.filter((path) => path !== deletedPath);
      const nextPath = remainingPaths.at(-1);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      setOpenPaths(remainingPaths);
      setSelectedPath(nextPath);
      setEditorContent(nextPath ? adapter.workspace.readText(nextPath) : "");
      setEditorDiagnostics([]);
      setEditorPositionRequest(undefined);
      setEditorStatus("파일 삭제됨 · 로컬 초안");
      setHasUnpublishedChanges(true);
      setConfirmingFileDelete(false);
      hotUpdatePreviews(deletedPath, "delete");
    } catch {
      setConfirmingFileDelete(false);
      setError("파일을 삭제하지 못했습니다.");
    }
  }

  function beginHorizontalResize(panel: "files" | "preview", event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "files" ? sidebarWidth : previewWidth;
    const workbenchWidth = workbenchRef.current?.clientWidth ?? globalThis.innerWidth;
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (panel === "files") {
        setSidebarWidth(Math.max(192, Math.min(360, startWidth + delta)));
        return;
      }
      const maximumPreviewWidth = Math.max(320, workbenchWidth - sidebarWidth - 48 - 480);
      setPreviewWidth(Math.max(320, Math.min(maximumPreviewWidth, startWidth - delta)));
    };
    const stop = () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", stop);
    };
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", stop, { once: true });
  }

  function beginBottomPanelResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomPanelHeight;
    const move = (moveEvent: PointerEvent) => setBottomPanelHeight(Math.max(120, Math.min(480, startHeight + startY - moveEvent.clientY)));
    const stop = () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", stop);
    };
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", stop, { once: true });
  }

  async function runCommand(command: string): Promise<void> {
    if (!command) return;
    if (command.length > MAX_TERMINAL_COMMAND_CHARS) {
      setError("터미널 명령어가 너무 깁니다.");
      return;
    }
    setError(undefined);
    const sessionId = terminal.activeSessionId;
    terminal.append(sessionId, `❯ ${command}\n`);
    try {
      const adapter = adapterRef.current;
      if (!adapter) throw new Error("runtime unavailable");
      persistSelectedEditorToDraft(adapter);
      const result = await adapter.terminal.run(command, `ide-terminal-${sessionId}`, (chunk) => terminal.append(sessionId, chunk.data));
      const changedFiles = result.changedFiles ?? [];
      for (const change of changedFiles) {
        hotUpdatePreviews(change.path, change.kind);
      }
      if (/^(?:npm|pnpm|yarn)\s+(?:install|i|add|update|up)(?:\s|$)/u.test(command.trim()) && result.exitCode === 0) {
        hotUpdatePreviews(previewModuleRefreshPath(adapter.workspace.getState().files.map((file) => file.path)));
      }
      if (changedFiles.length > 0) {
        const nextWorkspace = adapter.workspace.getState();
        setWorkspace(nextWorkspace);
        setHasUnpublishedChanges(true);
        const selectedRename = changedFiles.find((change) => change.kind === "rename" && change.previousPath === selectedPath);
        if (selectedRename) {
          setOpenPaths((current) => current.map((path) => path === selectedRename.previousPath ? selectedRename.path : path));
          setSelectedPath(selectedRename.path);
          setEditorContent(adapter.workspace.readText(selectedRename.path));
          setEditorStatus("터미널에서 파일 이름 변경됨 · 로컬 초안");
        } else if (selectedPath && changedFiles.some((change) => change.path === selectedPath && change.kind === "content")) {
          setEditorContent(adapter.workspace.readText(selectedPath));
          setEditorStatus("터미널 변경 반영됨 · 로컬 초안");
        } else if (selectedPath && changedFiles.some((change) => change.path === selectedPath && change.kind === "delete")) {
          const availablePaths = new Set(nextWorkspace.files.filter((file) => file.kind === "text").map((file) => file.path));
          const remainingPaths = openPaths.filter((path) => path !== selectedPath && availablePaths.has(path));
          const nextPath = remainingPaths.at(-1) ?? nextWorkspace.files.find((file) => file.kind === "text")?.path;
          setOpenPaths(nextPath && !remainingPaths.includes(nextPath) ? [...remainingPaths, nextPath] : remainingPaths);
          setSelectedPath(nextPath);
          setEditorContent(nextPath ? adapter.workspace.readText(nextPath) : "");
          setEditorDiagnostics([]);
          setEditorStatus("터미널에서 파일 삭제됨 · 로컬 초안");
        }
      }
    } catch {
      setError("터미널 명령을 완료하지 못했습니다.");
    }
  }

  async function runPreview() {
    const adapter = adapterRef.current;
    if (!adapter) return;
    if (previewConfiguration.status === "disabled") {
      setError(previewConfiguration.message);
      return;
    }
    setError(undefined);
    setPreviewRefreshFailed(false);
    setIsPreviewOpen(true);
    await startPreview(adapter);
  }

  const attachPreviewFrame = useCallback((frame: HTMLIFrameElement | null) => {
    previewFrameRef.current = frame;
    previewBridgeRef.current?.attach(frame?.contentWindow ?? null);
  }, []);

  function refreshPreview(): void {
    const frameWindow = previewFrameRef.current?.contentWindow;
    if (!frameWindow || !isolatedPreviewUrl) return;
    setError(undefined);
    setPreviewRefreshFailed(false);
    frameWindow.postMessage(
      { type: "nuriteo-preview:reload", version: 1 },
      new URL(isolatedPreviewUrl).origin
    );
  }

  function postPreviewNavigation(path: string): void {
    const frameWindow = previewFrameRef.current?.contentWindow;
    if (!frameWindow || !isolatedPreviewUrl) return;
    frameWindow.postMessage(
      { path, type: "nuriteo-preview:navigate", version: 1 },
      new URL(isolatedPreviewUrl).origin
    );
  }

  function submitPreviewAddress(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const path = normalizePreviewAddress(previewAddress);
    if (!path) {
      setError("미리보기 주소는 이 프로젝트의 경로만 사용할 수 있습니다.");
      return;
    }
    setError(undefined);
    setPreviewRefreshFailed(false);
    previewAddressEditingRef.current = false;
    setPreviewAddress(path);
    setPreviewHistory((current) => recordPreviewHistory(current, path));
    postPreviewNavigation(path);
  }

  function movePreview(direction: -1 | 1): void {
    const next = movePreviewHistory(previewHistory, direction);
    if (next === previewHistory) return;
    const path = next.entries[next.index] ?? "/";
    setPreviewHistory(next);
    setPreviewAddress(path);
    previewAddressEditingRef.current = false;
    postPreviewNavigation(path);
  }

  useEffect(() => {
    if (!isolatedPreviewUrl) {
      setPreviewHistory(createPreviewHistory());
      setPreviewAddress("/");
      return;
    }
    const origin = new URL(isolatedPreviewUrl).origin;
    const receiveLocation = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== previewFrameRef.current?.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      const record = data as Record<string, unknown>;
      if (record.type !== "nuriteo-preview:location" || record.version !== 1 || typeof record.path !== "string") return;
      const path = normalizePreviewAddress(record.path);
      if (!path) return;
      setPreviewHistory((current) => recordPreviewHistory(current, path));
      if (!previewAddressEditingRef.current) setPreviewAddress(path);
    };
    globalThis.addEventListener("message", receiveLocation);
    return () => globalThis.removeEventListener("message", receiveLocation);
  }, [isolatedPreviewUrl]);

  async function stopPreviewPort(port: number): Promise<void> {
    const adapter = adapterRef.current;
    if (!adapter) return;
    setError(undefined);
    if (!adapter.workflow.stopPreview(port)) {
      setError(`포트 ${port}의 개발 서버를 찾지 못했습니다.`);
      return;
    }
    previewBridgeOperationRef.current += 1;
    const bridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    setIsolatedPreviewUrl(undefined);
    await bridge?.dispose();
    if (!unmountedRef.current && adapterRef.current === adapter) {
      setRuntime(adapter.getState());
      terminal.append(terminal.activeSessionId, `포트 ${port} 개발 서버를 중지했습니다.\n`);
    }
  }

  function stopTerminalProcess(terminalId: string): void {
    const adapter = adapterRef.current;
    if (!adapter) return;
    setError(undefined);
    if (!adapter.terminal.signal("SIGTERM", terminalId)) {
      setError("이미 종료됐거나 찾을 수 없는 프로세스입니다.");
    }
  }

  async function startPreview(adapter: RuntimeAdapter): Promise<void> {
    const sessionId = terminal.activeSessionId;
    setIsRunningPreview(true);
    setPreviewConsole([]);
    setBottomPanel("terminal");
    setIsTerminalOpen(true);
    terminal.append(sessionId, "❯ npm run dev\n의존성을 확인하고 개발 서버를 시작합니다…\n");
    try {
      const next = await adapter.workflow.start();
      if (!next.previewUrl) throw new Error("Preview URL unavailable");
      terminal.append(sessionId, `개발 서버 준비 완료 · ${next.previewUrl}\n`);
      await swapPreviewBridge(adapter, next.previewUrl);
    } catch {
      if (!unmountedRef.current && adapterRef.current === adapter) {
        terminal.append(sessionId, "개발 서버를 시작하지 못했습니다.\n");
        setError("의존성 설치와 미리보기 실행을 완료하지 못했습니다.");
      }
    } finally {
      if (!unmountedRef.current) setIsRunningPreview(false);
    }
  }

  async function executeRecovery(kind: RuntimeRecoveryActionKind) {
    if (kind === "resolve-writer-conflict" && !confirmingWriterTakeover) {
      setConfirmingWriterTakeover(true);
      return;
    }
    const adapter = adapterRef.current;
    if (!adapter || recoveringAction) return;
    setError(undefined);
    setRecoveringAction(kind);
    try {
      const next = await adapter.recovery.run(kind);
      setRuntime(next);
      setConfirmingWriterTakeover(false);
      if (kind === "clear-cache") {
        setEditorStatus("패키지 캐시 삭제됨 · 로컬 초안 보존됨");
      } else if (kind === "resolve-writer-conflict") {
        setEditorStatus("편집 권한 획득 · 로컬 초안 보존됨");
      }
      if (
        next.previewUrl
        && previewConfiguration.status === "enabled"
        && (kind === "retry" || kind === "reset-runtime" || kind === "restart-dev-server")
      ) {
        await swapPreviewBridge(adapter, next.previewUrl);
      }
    } catch {
      if (!unmountedRef.current && adapterRef.current === adapter) {
        setError("복구를 완료하지 못했습니다. 로컬 초안은 유지되므로 작업을 확인한 뒤 다시 시도하세요.");
      }
    } finally {
      if (!unmountedRef.current) setRecoveringAction(undefined);
    }
  }

  function recordPreviewConsole(entry: { message: string; stack: string }): void {
    if (unmountedRef.current) return;
    const message = entry.message.trim();
    if (!message) return;
    const id = previewConsoleIdRef.current + 1;
    previewConsoleIdRef.current = id;
    setPreviewConsole((current) => [...current, { id, message, stack: entry.stack }].slice(-100));
    if (!isTerminalOpenRef.current) {
      setIsTerminalOpen(true);
      setBottomPanel("console");
    }
  }

  async function createPreviewBridge(internalPreviewUrl: string): Promise<SubdomainPreviewBridge> {
    if (previewConfiguration.status === "disabled") throw new Error("Preview unavailable");
    let created: SubdomainPreviewBridge | undefined;
    created = await (previewBridgeFactory ?? createSubdomainPreviewBridge)({
      configuration: previewConfiguration,
      internalProjectIdentity: `${workspaceScope}:${project.id}`,
      internalPreviewUrl,
      ownerId: project.ownerId,
      ownerType: project.ownerType,
      projectId: project.id,
      onConsole: recordPreviewConsole,
      onDiagnostic() {
        if (!unmountedRef.current) setError("격리된 미리보기 연결을 안전하게 중지했습니다.");
      },
      onReloadResult(ok) {
        if (!unmountedRef.current) setPreviewRefreshFailed(!ok);
      },
      onRecoveryRequired() {
        if (created) recoverPreview(created, internalPreviewUrl);
      }
    });
    return created;
  }

  function openPreviewWindow(): void {
    const internalPreviewUrl = adapterRef.current?.getState().previewUrl;
    if (!internalPreviewUrl || previewConfiguration.status === "disabled") return;
    setError(undefined);
    const previewWindowId = globalThis.crypto.randomUUID();
    const popup = globalThis.open(
      createPreviewWindowUrl(previewConfiguration.applicationOrigin, previewWindowId),
      "_blank"
    );
    if (!popup) {
      setError("새 탭을 열지 못했습니다. 브라우저의 팝업 차단 설정을 확인하세요.");
      return;
    }

    let activeBridge: SubdomainPreviewBridge | undefined;
    let bridgeOperation = 0;
    let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let closedPoll: ReturnType<typeof setInterval> | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      bridgeOperation += 1;
      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (closedPoll) clearInterval(closedPoll);
      globalThis.removeEventListener("message", receive);
      previewWindowDisposersRef.current.delete(dispose);
      if (activeBridge) previewWindowBridgesRef.current.delete(activeBridge);
      void activeBridge?.dispose();
    };
    const reconnect = async () => {
      const operation = bridgeOperation + 1;
      bridgeOperation = operation;
      if (connectionTimeout) clearTimeout(connectionTimeout);
      let createdBridge: SubdomainPreviewBridge | undefined;
      try {
        createdBridge = await (previewBridgeFactory ?? createSubdomainPreviewBridge)({
          configuration: previewConfiguration,
          internalProjectIdentity: `${workspaceScope}:${project.id}`,
          internalPreviewUrl,
          ownerId: project.ownerId,
          ownerType: project.ownerType,
          projectId: project.id,
          onConnected() {
            if (createdBridge === activeBridge && connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = undefined;
            }
          },
          onConsole: recordPreviewConsole,
          onDiagnostic: dispose,
          onRecoveryRequired() {
            if (createdBridge === activeBridge) void reconnect();
          }
        });
        if (disposed || popup.closed || operation !== bridgeOperation) {
          await createdBridge.dispose();
          return;
        }
        const previousBridge = activeBridge;
        activeBridge = createdBridge;
        previewWindowBridgesRef.current.add(createdBridge);
        createdBridge.attach(popup, previewConfiguration.applicationOrigin);
        popup.postMessage({
          type: "nuriteo-preview-window:initialize",
          previewWindowId,
          projectName: project.name,
          url: createdBridge.url,
          version: 1
        }, previewConfiguration.applicationOrigin);
        connectionTimeout = setTimeout(() => {
          if (createdBridge === activeBridge) void reconnect();
        }, PREVIEW_WINDOW_CONNECT_TIMEOUT_MS);
        if (previousBridge) {
          previewWindowBridgesRef.current.delete(previousBridge);
          void previousBridge.dispose();
        }
      } catch {
        dispose();
        popup.close();
        if (!unmountedRef.current) setError("새 탭 미리보기를 연결하지 못했습니다.");
      }
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== previewConfiguration.applicationOrigin || typeof event.data !== "object" || event.data === null) return;
      const type = (event.data as Record<string, unknown>).type;
      const receivedPreviewWindowId = (event.data as Record<string, unknown>).previewWindowId;
      const version = (event.data as Record<string, unknown>).version;
      if (receivedPreviewWindowId !== previewWindowId || version !== 1) return;
      if (type === "nuriteo-preview-window:ready") {
        void reconnect();
      }
    };
    previewWindowDisposersRef.current.add(dispose);
    globalThis.addEventListener("message", receive);
    closedPoll = setInterval(() => {
      if (popup.closed) dispose();
    }, PREVIEW_WINDOW_CLOSED_POLL_MS);
  }

  async function swapPreviewBridge(
    adapter: RuntimeAdapter,
    internalPreviewUrl: string,
    expectedBridge?: SubdomainPreviewBridge
  ): Promise<boolean> {
    if (expectedBridge && previewBridgeRef.current !== expectedBridge) return false;

    const operation = previewBridgeOperationRef.current + 1;
    previewBridgeOperationRef.current = operation;
    const previousBridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    if (!unmountedRef.current) setIsolatedPreviewUrl(undefined);
    await previousBridge?.dispose();

    if (
      unmountedRef.current
      || adapterRef.current !== adapter
      || previewBridgeOperationRef.current !== operation
    ) return false;

    const createdBridge = await createPreviewBridge(internalPreviewUrl);
    if (
      unmountedRef.current
      || adapterRef.current !== adapter
      || previewBridgeOperationRef.current !== operation
    ) {
      await createdBridge.dispose();
      return false;
    }

    previewBridgeRef.current = createdBridge;
    createdBridge.attach(previewFrameRef.current?.contentWindow ?? null);
    setIsolatedPreviewUrl(createdBridge.url);
    setPreviewRefreshFailed(false);
    return true;
  }

  function recoverPreview(staleBridge: SubdomainPreviewBridge, internalPreviewUrl: string): void {
    if (previewRecoveryRef.current || previewBridgeRef.current !== staleBridge || unmountedRef.current) return;
    const adapter = adapterRef.current;
    if (!adapter) return;
    const recovery = (async () => {
      try {
        await swapPreviewBridge(adapter, internalPreviewUrl, staleBridge);
      } catch {
        if (!unmountedRef.current && adapterRef.current === adapter) {
          setError("격리된 미리보기 연결을 복구하지 못했습니다. 미리보기를 다시 실행하세요.");
        }
      }
    })().finally(() => { previewRecoveryRef.current = null; });
    previewRecoveryRef.current = recovery;
  }

  function saveSelectedFile() {
    const adapter = adapterRef.current;
    if (!adapter || !selectedPath) return;
    setError(undefined);
    setIsSaving(true);
    try {
      const next = adapter.workspace.writeText(selectedPath, editorContent);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      hotUpdatePreviews(selectedPath);
      setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
    } catch {
      setError("텍스트 변경사항을 안전하게 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveToServer() {
    const adapter = adapterRef.current;
    if (!adapter || !projectEtag || isServerSaving || runtime.localDraftAccess !== "writer") return;
    const controller = new AbortController();
    saveAbortRef.current?.abort();
    saveAbortRef.current = controller;
    setError(undefined);
    setServerSaveFailure(undefined);
    setIsServerSaving(true);
    setServerSaveStatus("서버 저장 계획을 준비하는 중…");
    try {
      if (selectedPath && editorStatus === "저장하지 않은 로컬 변경") {
        const next = adapter.workspace.writeText(selectedPath, editorContent);
        setRuntime(next);
        setWorkspace(adapter.workspace.getState());
        hotUpdatePreviews(selectedPath);
        setEditorStatus("서버 저장을 위해 로컬 초안에 적용됨");
      }
      const { saveCurrentProject } = await saveFeature.load();
      const result = await saveCurrentProject({
        client: createBrowserApiClient(),
        csrfToken: readCsrfCredential(),
        owner: { ownerType: project.ownerType, ownerId: project.ownerId },
        projectId: project.id,
        storageScopeId: project.storageScopeId,
        projectEtag,
        snapshotCurrentTree: () => adapter.workspace.snapshotBundleFiles(),
        currentRevision: () => adapter.workspace.currentRevision(),
        signal: controller.signal,
        onProgress(progress) {
          if (controller.signal.aborted) return;
          const percentage = progress.totalBytes && progress.uploadedBytes > 0
            ? ` ${Math.floor(progress.uploadedBytes * 100 / progress.totalBytes)}%`
            : "";
          setServerSaveStatus(`${serverSavePhaseLabel(progress.phase)}${percentage} · 로컬 초안 보존됨`);
        }
      });
      onProjectCommit?.({ projectEtag: result.projectEtag, projectVersion: result.projectVersion });
      setServerSaveStatus(result.snapshotCurrent
        ? `서버 저장 v${result.projectVersion} 완료 · 로컬 초안과 일치`
        : `서버 저장 v${result.projectVersion} 완료 · 더 최신 로컬 변경 남음`);
      setHasUnpublishedChanges(!result.snapshotCurrent);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const stale = cause instanceof Error && "status" in cause && (cause as { status?: unknown }).status === 412;
        setServerSaveFailure(stale ? "stale" : "retry");
        setError(stale
          ? "저장 전에 서버 프로젝트가 변경되었습니다. 로컬 초안은 보존되므로 최신 프로젝트를 불러온 뒤 다시 시도하세요."
          : "서버 저장을 완료하지 못했습니다. 로컬 초안은 보존되므로 서비스가 준비되면 다시 시도하세요.");
        setServerSaveStatus("서버 저장 실패 · 로컬 초안 보존됨");
      }
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      if (!unmountedRef.current) setIsServerSaving(false);
    }
  }

  async function stopWorkspace() {
    saveAbortRef.current?.abort();
    const adapter = adapterRef.current;
    await releaseAdapter();
    if (adapter?.getState().lifecycle === "failed") {
      setError("브라우저 워크스페이스가 일부 자원을 종료하지 못했습니다. 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    setWorkspace(undefined);
    setSelectedPath(undefined);
    setOpenPaths([]);
    setEditorContent("");
    setEditorDiagnostics([]);
    setPreviewConsole([]);
    setIsEditorSplit(false);
    setSplitPath(undefined);
    setSplitContent("");
    setSplitDirty(false);
    setReplaceQuery("");
    setEditorPositionRequest(undefined);
    terminal.reset();
    setEditorStatus("로컬 초안");
    setResumeStatus(undefined);
    setFileQuery("");
    setFileListLimit(FILE_LIST_BATCH_SIZE);
    setSidebarPanel("files");
    setFileOperation(undefined);
    setFileOperationValue("");
    setIsSidebarOpen(true);
    setMatchFileCase(false);
    setUseFileRegularExpression(false);
    setIsPreviewOpen(true);
    setIsTerminalOpen(false);
    setBottomPanel("terminal");
    setIsFocusMode(false);
    setHasUnpublishedChanges(false);
    setError(undefined);
    setServerSaveFailure(undefined);
    setServerSaveStatus(INITIAL_SERVER_SAVE_STATUS);
    setConfirmingWorkspaceStop(false);
  }

  function replaceInProject(): void {
    const adapter = adapterRef.current;
    if (!adapter || runtime.localDraftAccess !== "writer" || fileQuery.length === 0) return;
    persistSelectedEditorToDraft(adapter);
    persistSplitDraft(adapter);
    const plan = planProjectContentReplace({
      files: visibleStudioExplorerFiles(adapter.workspace.getState().files),
      matchCase: matchFileCase,
      query: fileQuery,
      readText: (path) => {
        if (path === selectedPath) return editorContent;
        if (path === splitPath && path !== selectedPath) return splitContent;
        return adapter.workspace.readText(path);
      },
      replacement: replaceQuery,
      selectedContent: editorContent,
      selectedPath,
      useRegularExpression: useFileRegularExpression
    });
    if (plan.error) {
      setError(plan.error);
      return;
    }
    if (plan.updates.length === 0) {
      setError("바꿀 코드가 없습니다.");
      return;
    }
    try {
      let next = adapter.getState();
      for (const update of plan.updates) {
        next = adapter.workspace.writeText(update.path, update.content);
        hotUpdatePreviews(update.path);
      }
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      const selectedUpdate = plan.updates.find((update) => update.path === selectedPath);
      if (selectedUpdate) setEditorContent(selectedUpdate.content);
      const splitUpdate = plan.updates.find((update) => update.path === splitPath);
      if (splitUpdate && splitPath !== selectedPath) {
        setSplitContent(splitUpdate.content);
        setSplitDirty(false);
      }
      const count = plan.updates.reduce((total, update) => total + update.replacements, 0);
      setEditorStatus(next.hmrState === "connected" ? `${count}곳을 바꿨습니다 · HMR 적용됨` : `${count}곳을 로컬 초안에서 바꿨습니다`);
      setHasUnpublishedChanges(true);
      setError(undefined);
    } catch {
      setError("코드 바꾸기를 완료하지 못했습니다.");
    }
  }

  async function releaseAdapter() {
    previewBridgeOperationRef.current += 1;
    const bridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    if (!unmountedRef.current) setIsolatedPreviewUrl(undefined);
    await bridge?.dispose();
    const adapter = adapterRef.current;
    if (!adapter) return;
    await adapter.dispose();
    if (adapter.getState().lifecycle !== "failed") {
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      adapterRef.current = undefined;
      setRuntime(EMPTY_RUNTIME_STATE);
    }
  }

  const hasWorkspace = workspace?.status === "ready";
  const hasIsolatedPreview = isolatedPreviewUrl !== undefined;
  const canWriteLocalDraft = runtime.localDraftAccess === "writer";
  const recoveryDiagnostics = runtime.diagnostics.filter((diagnostic) => diagnostic.actions.length > 0);
  const readWorkspaceText = useCallback((path: string) => adapterRef.current?.workspace.readText(path) ?? "", []);
  const explorerFiles = useMemo(
    () => visibleStudioExplorerFiles(workspace?.files ?? EMPTY_WORKSPACE_FILES),
    [workspace]
  );
  const {
    hasMoreFiles,
    matchingFiles,
    visibleFiles
  } = useProjectFileSearch({
    files: explorerFiles,
    limit: fileListLimit,
    matchCase: matchFileCase,
    query: isQuickOpenOpen ? quickOpenQuery : "",
    useRegularExpression: useFileRegularExpression,
    selectedPath
  });
  const {
    isSearchPending: isContentSearchPending,
    matches: contentSearchMatches,
    searchError: contentSearchError,
    totalMatches: totalContentSearchMatches
  } = useProjectContentSearch({
    files: explorerFiles,
    limit: fileListLimit,
    matchCase: matchFileCase,
    query: sidebarPanel === "search" ? fileQuery : "",
    readText: readWorkspaceText,
    selectedContent: editorContent,
    selectedPath,
    useRegularExpression: useFileRegularExpression
  });
  const hasUnsavedEditorChange = editorStatus === "저장하지 않은 로컬 변경";
  const selectedFileName = selectedPath?.split("/").at(-1);
  const editorLineCount = editorContent.length === 0 ? 1 : editorContent.split("\n").length;
  useUnsavedChangesGuard(hasUnpublishedChanges || hasUnsavedEditorChange);

  useEffect(() => {
    if (!hasWorkspace) return;
    const nextUrl = new URL(globalThis.location.href);
    if (selectedPath) nextUrl.searchParams.set("file", selectedPath);
    else nextUrl.searchParams.delete("file");
    if (isTerminalOpen && bottomPanel === "terminal") nextUrl.searchParams.set("terminal", "dev");
    else nextUrl.searchParams.delete("terminal");
    globalThis.history.replaceState(globalThis.history.state, "", nextUrl);
  }, [bottomPanel, hasWorkspace, isTerminalOpen, selectedPath]);

  const css = ideStyles({ focus: isFocusMode, previewOpen: isPreviewOpen, sidebarOpen: isSidebarOpen });
  const workbenchLayout = workbenchLayoutClass({
    focusMode: isFocusMode,
    previewOpen: isPreviewOpen,
    sidebarOpen: isSidebarOpen
  });
  const utilityLayout = isSidebarOpen ? undefined : "max-[72rem]:col-span-2";
  const workbenchStyle = {
    "--studio-preview-width": `${previewWidth}px`,
    "--studio-sidebar-width": `${sidebarWidth}px`
  } as CSSProperties;
  return (
    <section className={css.shell()} aria-labelledby="project-ide-title">
      <header className={css.header()}>
        <div className={css.identity()}>
          <span className={runtimeDot({ state: runtime.lifecycle === "ready" || runtime.lifecycle === "failed" ? runtime.lifecycle : "idle" })} aria-hidden="true" />
          <div className={css.identityCopy()}>
            <p>개발 워크스페이스</p>
            <div className={css.runtimeMeta()}>
              <span>{runtimeLifecycleLabel(runtime.lifecycle)}</span>
              {hasWorkspace ? <span className={css.access()}>{canWriteLocalDraft ? "편집 가능" : "읽기 전용"}</span> : null}
            </div>
          </div>
          <h3 className="sr-only" id="project-ide-title">{project.name} 개발 편집기</h3>
        </div>
        {hasWorkspace ? <div className={css.headerActions()}>
          <span className={css.saveState()} role="status" aria-live="polite"><i className={hasUnsavedEditorChange ? "is-dirty" : ""} aria-hidden="true" />{serverSaveStatus}</span>
          <Button type="button" size="sm" aria-pressed={isPreviewOpen} onClick={() => setIsPreviewOpen((current) => !current)}>미리보기</Button>
          <Button type="button" size="sm" aria-pressed={isTerminalOpen} onClick={() => setIsTerminalOpen((current) => !current)}>하단 패널</Button>
          <Button type="button" size="sm" aria-pressed={isFocusMode} onClick={() => setIsFocusMode((current) => !current)}>{isFocusMode ? "패널 표시" : "집중 모드"}</Button>
          <Button aria-label="서버에 저장" type="button" size="sm" variant="primary" disabled={isServerSaving || !projectEtag || !canWriteLocalDraft} onClick={() => void saveToServer()}>{isServerSaving ? "저장 중…" : "서버에 저장"}<kbd>⌘S</kbd></Button>
          <Button aria-label="워크스페이스 종료" type="button" size="sm" onClick={() => {
            if (hasUnpublishedChanges || hasUnsavedEditorChange) setConfirmingWorkspaceStop(true);
            else void stopWorkspace();
          }}>종료</Button>
        </div> : null}
      </header>
      {isQuickOpenOpen ? <section className={css.quickOpen()} aria-label="빠른 파일 열기"><label className="sr-only" htmlFor={`quick-open-${project.id}`}>빠른 파일 열기</label><Input id={`quick-open-${project.id}`} autoFocus value={quickOpenQuery} placeholder="파일 이름을 입력하세요" onChange={(event) => { setQuickOpenQuery(event.currentTarget.value); setQuickOpenIndex(0); }} onKeyDown={(event) => {
        const resultCount = Math.min(matchingFiles.length, 40);
        if (event.key === "Escape") setIsQuickOpenOpen(false);
        if (event.key === "ArrowDown" && resultCount > 0) { event.preventDefault(); setQuickOpenIndex((current) => (current + 1) % resultCount); }
        if (event.key === "ArrowUp" && resultCount > 0) { event.preventDefault(); setQuickOpenIndex((current) => (current - 1 + resultCount) % resultCount); }
        if (event.key === "Enter" && matchingFiles[quickOpenIndex]) { selectFile(matchingFiles[quickOpenIndex].path); setIsQuickOpenOpen(false); }
      }} /><ul>{matchingFiles.slice(0, 40).map((file, index) => <li key={file.path}><Button type="button" size="sm" variant="ghost" aria-selected={index === quickOpenIndex} onMouseEnter={() => setQuickOpenIndex(index)} onClick={() => { selectFile(file.path); setIsQuickOpenOpen(false); }}><strong>{file.name}</strong><small>{file.path}</small></Button></li>)}</ul></section> : null}
      {error ? <div className={css.message({ className: "border-danger/30 bg-danger/10 text-danger" })} role="alert"><strong>작업을 완료하지 못했습니다.</strong><span>{error}</span></div> : null}
      {serverSaveFailure ? <div className={css.recoveryActions()} aria-label="서버 저장 복구">{serverSaveFailure === "retry" ? <Button type="button" size="sm" disabled={isServerSaving || !canWriteLocalDraft} onClick={() => void saveToServer()}>서버 저장 다시 시도</Button> : <Button type="button" size="sm" onClick={() => onProjectReload?.()}>최신 프로젝트 다시 불러오기</Button>}</div> : null}
      {resumeStatus ? <p className={css.message({ className: "border-primary/20 bg-selected text-foreground" })} role="status" aria-live="polite">{resumeStatus}</p> : null}
      {recoveryDiagnostics.length > 0 ? (
        <section className={css.recovery()} aria-label="워크스페이스 복구">
          <h4 className="m-0 text-sm font-semibold">워크스페이스 확인이 필요합니다</h4>
          {recoveryDiagnostics.map((diagnostic) => (
            <div className="mt-2" key={diagnostic.code}>
              <p className="m-0 text-sm"><span className="font-mono text-xs">{diagnostic.code}</span> · {diagnostic.message}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {diagnostic.actions.map((action) => (
                  <Button
                    type="button"
                    size="sm"
                    key={`${diagnostic.code}:${action.kind}`}
                    disabled={recoveringAction !== undefined}
                    onClick={() => void executeRecovery(action.kind)}
                  >
                    {recoveringAction === action.kind ? "복구 중…" : recoveryActionLabel(action.kind)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {confirmingWriterTakeover ? (
            <div className="mt-3 rounded-md border border-danger p-3" role="alertdialog" aria-labelledby="writer-takeover-title">
              <p id="writer-takeover-title" className="m-0 text-sm font-semibold">다른 탭의 편집 권한을 가져올까요?</p>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">다른 탭은 읽기 전용으로 전환됩니다. 저장하지 않은 편집 내용은 그대로 보이지만 이 탭에서만 로컬 초안을 쓸 수 있습니다.</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="primary" onClick={() => void executeRecovery("resolve-writer-conflict")}>이 탭에서 편집 시작</Button>
                <Button type="button" size="sm" onClick={() => setConfirmingWriterTakeover(false)}>취소</Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {project.state !== "active" ? <p className="m-3 text-sm text-muted-foreground">보관된 프로젝트는 읽기 전용입니다. 버전과 복구 지점은 계속 확인할 수 있으며, 기록을 변경하거나 워크스페이스를 시작하려면 먼저 프로젝트를 복원하세요.</p> : null}
      {hasWorkspace ? (
        <div className={css.workbench({ className: workbenchLayout })} ref={workbenchRef} style={workbenchStyle}>
          <aside className={css.activity()} aria-label="Studio 도구">
            <Button
              className={css.activityButton()}
              type="button"
              size="icon"
              variant="ghost"
              aria-label="프로젝트 파일"
              aria-pressed={isSidebarOpen && sidebarPanel === "files"}
              onClick={() => {
                setIsSidebarOpen((current) => sidebarPanel === "files" ? !current : true);
                setSidebarPanel("files");
                setFileListLimit(FILE_LIST_BATCH_SIZE);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3.5 5.5h6l2 2h9v12h-17z"/><path d="M3.5 9.5h17"/></svg>
            </Button>
            <Button
              className={css.activityButton()}
              type="button"
              size="icon"
              variant="ghost"
              aria-label="프로젝트 파일 검색"
              aria-pressed={isSidebarOpen && sidebarPanel === "search"}
              onClick={() => {
                setIsSidebarOpen((current) => sidebarPanel === "search" ? !current : true);
                setSidebarPanel("search");
                setFileListLimit(FILE_LIST_BATCH_SIZE);
                globalThis.requestAnimationFrame(() => fileSearchRef.current?.focus());
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></svg>
            </Button>
            <span className={css.activityDivider()} aria-hidden="true" />
            <Button
              className={css.activityButton()}
              type="button"
              size="icon"
              variant="ghost"
              aria-label={isFocusMode ? "전체 패널 표시" : "편집기에 집중"}
              aria-pressed={isFocusMode}
              onClick={() => setIsFocusMode((current) => !current)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/></svg>
            </Button>
          </aside>
          <nav className={css.files()} aria-label="프로젝트 파일">
            <div className="absolute inset-y-0 right-[-0.25rem] z-20 w-2 cursor-col-resize touch-none max-[72rem]:hidden" role="separator" aria-label="파일 패널 너비 조절" aria-orientation="vertical" aria-valuemin={192} aria-valuemax={360} aria-valuenow={sidebarWidth} onPointerDown={(event) => beginHorizontalResize("files", event)} />
            <div className={css.projectSummary()}>
              <strong>{project.name}</strong>
              <span>{project.slug} · v{project.version}</span>
            </div>
            <div className={css.panelHeading()}>
              <div>
                <span>{sidebarPanel === "search" ? "검색" : "프로젝트"}</span>
                <strong>{sidebarPanel === "search" ? "코드 검색" : "파일"}</strong>
              </div>
              <div className={css.fileActions()}>
                <Button type="button" size="icon" variant="ghost" aria-label="새 파일" title="새 파일" disabled={!canWriteLocalDraft} onClick={() => beginCreate()}>＋</Button>
                <Button type="button" size="icon" variant="ghost" aria-label="선택한 파일 이름 변경" title="이름 변경" disabled={!selectedPath || !canWriteLocalDraft} onClick={() => beginFileOperation("rename")}>✎</Button>
                <Button type="button" size="icon" variant="ghost" aria-label="선택한 파일 삭제" title="삭제" disabled={!selectedPath || !canWriteLocalDraft} onClick={() => setConfirmingFileDelete(true)}>⌫</Button>
                <kbd>⌘P</kbd>
              </div>
            </div>
            {fileOperation ? <form className={css.fileOperation()} onSubmit={commitFileOperation}><label className="sr-only" htmlFor={`file-operation-${project.id}`}>{fileOperation === "create" ? "새 파일 경로" : "변경할 파일 경로"}</label><Input id={`file-operation-${project.id}`} autoFocus value={fileOperationValue} onChange={(event) => setFileOperationValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") setFileOperation(undefined); }} /><Button type="submit" size="sm">{fileOperation === "create" ? "생성" : "변경"}</Button></form> : sidebarPanel === "search" ? (
              <div className={css.searchArea()}>
                <SearchField className={css.fileSearch()} label="코드 검색" aria-busy={isContentSearchPending} aria-invalid={contentSearchError !== undefined} ref={fileSearchRef} value={fileQuery} onChange={(event) => { setFileQuery(event.currentTarget.value); setFileListLimit(FILE_LIST_BATCH_SIZE); }} placeholder="프로젝트 코드 검색" autoComplete="off" />
                <div className={css.searchControls()} aria-label="파일 검색 옵션">
                  <Button type="button" size="icon" variant="ghost" aria-label="대소문자 구분" aria-pressed={matchFileCase} onClick={() => setMatchFileCase((current) => !current)}>Aa</Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="정규식 사용" aria-pressed={useFileRegularExpression} onClick={() => setUseFileRegularExpression((current) => !current)}>.*</Button>
                </div>
                <form className={css.replaceRow()} onSubmit={(event) => { event.preventDefault(); replaceInProject(); }}>
                  <Input aria-label="바꿀 내용" value={replaceQuery} onChange={(event) => setReplaceQuery(event.currentTarget.value)} placeholder="바꿀 내용" autoComplete="off" />
                  <Button type="submit" size="sm" disabled={!canWriteLocalDraft || fileQuery.length === 0 || totalContentSearchMatches === 0}>모두 바꾸기</Button>
                </form>
              </div>
            ) : <span aria-hidden="true" />}
            <p className={css.fileCount()} aria-live="polite">
              {sidebarPanel === "search" ? contentSearchError ?? `${totalContentSearchMatches}개 코드 검색 결과` : `파일 ${explorerFiles.length}개`}
            </p>
            {sidebarPanel === "search" ? <div className={css.contentResults()}>
              {contentSearchMatches.length > 0 ? <ul>{contentSearchMatches.map((match, index) => <li key={`${match.path}:${match.line}:${match.column}:${index}`}><Button type="button" size="sm" variant="ghost" onClick={() => { selectFile(match.path); setEditorPositionRequest({ column: match.column, line: match.line, requestId: Date.now() }); }}><strong>{match.path}</strong><small>{match.line}:{match.column}</small><span>{match.snippet || "빈 줄"}</span></Button></li>)}</ul> : <p className={css.fileEmpty()}>{fileQuery.trim() ? "일치하는 코드를 찾지 못했습니다." : "검색어를 입력하면 프로젝트 전체 코드를 찾습니다."}</p>}
              {contentSearchMatches.length < totalContentSearchMatches ? <Button className={css.fileMore()} variant="ghost" type="button" onClick={() => setFileListLimit((current) => current + FILE_LIST_BATCH_SIZE)}>검색 결과 더 보기</Button> : null}
            </div> : <div className={css.fileList()}>
              {visibleFiles.length > 0 ? <ProjectFileTree canWrite={canWriteLocalDraft} files={visibleFiles} hasUnsavedEditorChange={hasUnsavedEditorChange} onCopyPath={copyExplorerPath} onCreateInDirectory={beginCreate} onDelete={requestDelete} onOpenInSplit={openInSplit} onRename={beginRename} onSelect={selectFile} selectedPath={selectedPath} /> : <p className={css.fileEmpty()}>프로젝트 파일이 없습니다.</p>}
              {hasMoreFiles ? <Button className={css.fileMore()} variant="ghost" type="button" onClick={() => setFileListLimit((current) => current + FILE_LIST_BATCH_SIZE)}>다음 {Math.min(FILE_LIST_BATCH_SIZE, matchingFiles.length - visibleFiles.length)}개 보기</Button> : null}
            </div>}
          </nav>
          <div className={css.editorStack()}>
            <section className={css.editor()} aria-label="텍스트 편집기" data-path={selectedPath ? true : undefined}>
              <div className={css.editorTabs()} role="toolbar" aria-label="열린 파일">
                {openPaths.length > 0 ? openPaths.map((path) => {
                  const fileName = path.split("/").at(-1) ?? path;
                  const isActive = path === selectedPath;
                  return <div className={isActive ? "is-active" : undefined} key={path}>
                    <Button className="tab-select" type="button" size="sm" variant="ghost" aria-pressed={isActive} title={path} onClick={() => selectFile(path)}><span className={css.fileIcon()} aria-hidden="true">#</span><strong>{fileName}</strong>{isActive && hasUnsavedEditorChange ? <i aria-label="저장하지 않은 변경 사항" /> : null}</Button>
                    <Button className="tab-close" type="button" size="icon" variant="ghost" aria-label={`${fileName} 닫기`} onClick={() => closeFile(path)}>×</Button>
                  </div>;
                }) : <span>파일을 선택하세요</span>}
                <div className="sticky right-0 ml-auto !max-w-none !gap-0 !border-l !border-r-0 !border-muted-border bg-subtle !px-1" role="group" aria-label="편집기 작업">
                  <Button className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground" type="button" size="icon" variant="ghost" aria-label="문서 서식 정리" disabled={!selectedPath || !canWriteLocalDraft} onClick={() => setEditorFormatRequestId(Date.now())}>↹</Button>
                  <Button className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground" type="button" size="icon" variant="ghost" aria-label={isEditorSplit ? "편집기 분할 닫기" : "편집기 분할"} disabled={!selectedPath} onClick={toggleSplit}>◫</Button>
                  <MenuRoot>
                    <MenuTrigger className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground" type="button" aria-label="편집기 작업 더 보기">•••</MenuTrigger>
                    <MenuPortal>
                      <MenuPositioner align="end" side="bottom" sideOffset={4}>
                        <MenuPopup className="w-56 text-xs">
                          <MenuRadioGroup value={editorThemePreference} onValueChange={changeEditorThemePreference}>
                            <MenuGroupLabel>에디터 테마</MenuGroupLabel>
                            {EDITOR_THEME_OPTIONS.map((option) => (
                              <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                                <MenuRadioItemIndicator className="data-[unchecked]:invisible" keepMounted aria-hidden="true">✓</MenuRadioItemIndicator>
                                <span>{option.label}</span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                          <MenuSeparator />
                          <MenuItem disabled={openPaths.length === 0} onClick={closeSavedFiles}><span aria-hidden="true" /><span>저장된 편집기 닫기</span></MenuItem>
                          <MenuItem disabled={openPaths.length === 0} onClick={closeAllFiles}><span aria-hidden="true" /><span>모든 편집기 닫기</span></MenuItem>
                        </MenuPopup>
                      </MenuPositioner>
                    </MenuPortal>
                  </MenuRoot>
                </div>
              </div>
              {selectedPath ? <EditorBreadcrumbs className={css.editorBreadcrumbs()} path={selectedPath} /> : null}
              {selectedPath ? <div className={css.editorHost()}><div className={css.editorPanes()} data-split={isEditorSplit}><ProjectMonacoEditor formatRequestId={editorFormatRequestId} path={selectedPath} priorityPaths={splitPath ? [...openPaths, splitPath] : openPaths} projectKey={`${workspaceScope}:${project.id}`} readOnly={!canWriteLocalDraft} readWorkspaceText={readWorkspaceText} revealPosition={editorPositionRequest} themePreference={editorThemePreference} value={editorContent} workspaceFiles={workspace?.files} onDiagnosticsChange={setEditorDiagnostics} onChange={(nextValue) => { setEditorContent(nextValue); setEditorStatus("저장하지 않은 로컬 변경"); setHasUnpublishedChanges(true); }} />{isEditorSplit && splitPath ? <div className={css.splitPane()}><div className={css.splitPaneBar()}><span title={splitPath}>{splitPath}</span><Button type="button" size="icon" variant="ghost" aria-label="분할 편집기 닫기" onClick={closeSplit}>×</Button></div><ProjectMonacoEditor path={splitPath} projectKey={`${workspaceScope}:${project.id}`} readOnly={!canWriteLocalDraft} themePreference={editorThemePreference} value={splitPath === selectedPath ? editorContent : splitContent} onChange={(nextValue) => { if (splitPath === selectedPath) { setEditorContent(nextValue); setEditorStatus("저장하지 않은 로컬 변경"); } else { setSplitContent(nextValue); setSplitDirty(true); } setHasUnpublishedChanges(true); }} /></div> : null}</div></div> : <div className={css.editorEmpty()}><span aria-hidden="true">⌘</span><strong>편집할 파일을 선택하세요</strong><p>왼쪽 파일 목록에서 선택하거나 <kbd>⌘P</kbd>로 빠르게 찾을 수 있습니다.</p></div>}
              <div className={css.status()}><span><i className={hasUnsavedEditorChange ? "is-dirty" : ""} aria-hidden="true" />{editorStatus}</span><span>{editorLineCount}줄 · {editorContent.length}자 · UTF-8</span><Button aria-label="로컬 초안에 적용" type="button" size="sm" disabled={!selectedPath || isSaving || !canWriteLocalDraft} onClick={saveSelectedFile}>{isSaving ? "적용 중…" : "로컬 초안에 적용"}</Button></div>
            </section>
            {isTerminalOpen ? <section className={css.terminal()} aria-label="하단 도구 패널" style={{ height: bottomPanelHeight }}>
              <div className="absolute inset-x-0 top-[-0.25rem] z-20 h-2 cursor-row-resize touch-none" role="separator" aria-label="하단 패널 높이 조절" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={480} aria-valuenow={bottomPanelHeight} onPointerDown={beginBottomPanelResize} />
              <div className={css.terminalToolbar()}>
                <div role="toolbar" aria-label="하단 패널">
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "problems"} onClick={() => setBottomPanel("problems")}>문제{editorDiagnostics.length > 0 ? ` ${editorDiagnostics.length}` : ""}</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "console"} onClick={() => setBottomPanel("console")}>콘솔{previewConsole.length > 0 ? ` ${previewConsole.length}` : ""}</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "output"} onClick={() => setBottomPanel("output")}>출력</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "ports"} onClick={() => setBottomPanel("ports")}>포트{runtime.ports.length > 0 ? ` ${runtime.ports.length}` : ""}</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "processes"} onClick={() => setBottomPanel("processes")}>프로세스{runtime.processes.length > 0 ? ` ${runtime.processes.length}` : ""}</Button>
                  {terminal.sessions.map((session) => <Button key={session.id} type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "terminal" && terminal.activeSessionId === session.id} title={session.name} onClick={() => { terminal.setActiveSessionId(session.id); setBottomPanel("terminal"); }}>{session.name}</Button>)}
                </div>
                <div className={css.terminalActions()}>
                  {bottomPanel === "terminal" ? <>
                    <Button type="button" size="icon" variant="ghost" aria-label="새 터미널" title="새 터미널" onClick={() => { terminal.create(); setBottomPanel("terminal"); }}>＋</Button>
                    <Button type="button" size="icon" variant="ghost" aria-label="터미널 내용 지우기" title="터미널 내용 지우기 (Ctrl+L)" onClick={() => terminal.clear()}>⌫</Button>
                  </> : null}
                  {bottomPanel === "console" ? <Button type="button" size="icon" variant="ghost" aria-label="콘솔 내용 지우기" title="콘솔 내용 지우기" onClick={() => setPreviewConsole([])}>⌫</Button> : null}
                  <Button type="button" size="icon" variant="ghost" aria-label="하단 패널 닫기" title="하단 패널 닫기" onClick={() => setIsTerminalOpen(false)}>×</Button>
                </div>
              </div>
              {bottomPanel === "problems" ? <div className="min-h-0 overflow-auto p-3 text-xs text-white/75">{editorDiagnostics.length > 0 ? <ul className="m-0 grid list-none gap-2 p-0">{editorDiagnostics.map((diagnostic, index) => <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2" key={`${diagnostic.line}:${diagnostic.column}:${index}`}><span aria-hidden="true">{diagnostic.severity >= 8 ? "●" : "▲"}</span><span>{diagnostic.message}</span><Button className="border-0 bg-transparent font-mono text-white/55 hover:text-white" type="button" size="sm" variant="ghost" onClick={() => setEditorPositionRequest({ column: diagnostic.column, line: diagnostic.line, requestId: Date.now() })}>{selectedFileName}:{diagnostic.line}:{diagnostic.column}</Button></li>)}</ul> : <p className="m-0 text-white/55">현재 파일에서 발견된 문제가 없습니다.</p>}</div> : null}
              {bottomPanel === "console" ? <div className="min-h-0 overflow-auto p-3 font-mono text-xs text-white/75" role="log" aria-label="미리보기 콘솔">{previewConsole.length > 0 ? <ul className="m-0 grid list-none gap-3 p-0">{previewConsole.map((entry) => <li className="grid gap-1 border-b border-white/10 pb-2" key={entry.id}><p className="m-0 whitespace-pre-wrap text-[var(--n-color-studio-danger)]">{entry.message}</p>{entry.stack && entry.stack !== entry.message ? <pre className="m-0 whitespace-pre-wrap text-white/45">{entry.stack}</pre> : null}</li>)}</ul> : <p className="m-0 text-white/55">미리보기 콘솔 에러가 없습니다.</p>}</div> : null}
              {bottomPanel === "output" ? <pre className="m-0 min-h-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-white/70" aria-live="polite">{terminal.activeSession.output || "실행 출력을 기다리고 있습니다."}</pre> : null}
              {bottomPanel === "ports" ? runtime.ports.length > 0 ? <ul className={css.runtimeList()} aria-label="열린 포트">{runtime.ports.map((port) => <li key={port.port}><div className="grid min-w-0 gap-0.5"><strong>{port.label} · localhost:{port.port}</strong><span>{port.status === "running" ? "실행 중" : "중지됨"} · <Button className="border-0 bg-transparent p-0 font-inherit text-[var(--n-color-studio-success)] hover:underline" type="button" size="sm" variant="ghost" onClick={openPreviewWindow}>브라우저에서 열기</Button></span></div><Button type="button" size="sm" variant="ghost" aria-label={`포트 ${port.port} 중지`} onClick={() => void stopPreviewPort(port.port)}>중지</Button></li>)}</ul> : <p className="m-0 p-3 text-xs text-white/55">열린 개발 서버 포트가 없습니다.</p> : null}
              {bottomPanel === "processes" ? runtime.processes.length > 0 ? <ul className={css.runtimeList()} aria-label="실행 중 프로세스">{runtime.processes.map((process) => <li key={`${process.terminalId}:${process.pid}:${process.generation ?? 0}`}><div className="grid min-w-0 gap-0.5"><strong>{process.command}</strong><span>PID {process.pid} · {process.terminalId} · {process.cwd}{process.terminalSize ? ` · ${process.terminalSize.cols}×${process.terminalSize.rows}` : ""}</span></div><Button type="button" size="sm" variant="ghost" aria-label={`${process.command} 프로세스 종료`} onClick={() => stopTerminalProcess(process.terminalId)}>종료</Button></li>)}</ul> : <p className="m-0 p-3 text-xs text-white/55">실행 중인 터미널 프로세스가 없습니다.</p> : null}
              {bottomPanel === "terminal" ? <ProjectTerminalView
                key={terminal.activeSession.id}
                output={terminal.activeSession.output}
                sessionName={terminal.activeSession.name}
                onClear={() => terminal.clear()}
                onInput={(data) => { adapterRef.current?.terminal.input(data, `ide-terminal-${terminal.activeSessionId}`); }}
                onInterrupt={() => { adapterRef.current?.terminal.signal("SIGINT", `ide-terminal-${terminal.activeSessionId}`); }}
                onResize={(cols, rows) => { adapterRef.current?.terminal.resize(cols, rows, `ide-terminal-${terminal.activeSessionId}`); }}
                onRun={runCommand}
              /> : null}
            </section> : null}
          </div>
          <section className={css.utility({ className: utilityLayout })} aria-label="미리보기 패널">
            <div className="absolute inset-y-0 left-[-0.25rem] z-20 w-2 cursor-col-resize touch-none max-[72rem]:hidden" role="separator" aria-label="미리보기 너비 조절" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={previewWidth} onPointerDown={(event) => beginHorizontalResize("preview", event)} />
            <section className={css.preview()} aria-label="미리보기" data-preview-url={isolatedPreviewUrl}>
              <div className={css.previewToolbar()}>
                <div className={css.previewControls()}>
                  <Button type="button" size="icon" variant="ghost" aria-label="미리보기 뒤로" disabled={!hasIsolatedPreview || previewHistory.index === 0} onClick={() => movePreview(-1)}>←</Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="미리보기 앞으로" disabled={!hasIsolatedPreview || previewHistory.index >= previewHistory.entries.length - 1} onClick={() => movePreview(1)}>→</Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="미리보기 새로고침" disabled={isRunningPreview || !hasIsolatedPreview} onClick={refreshPreview}>↻</Button>
                </div>
                <form className={css.previewAddress()} title={isolatedPreviewUrl ?? runtime.previewUrl ?? undefined} onSubmit={submitPreviewAddress}>
                  <span aria-hidden="true">▣</span>
                  <input aria-label="미리보기 주소" value={previewAddress} disabled={!hasIsolatedPreview} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={hasIsolatedPreview ? "/" : "미리보기를 실행하세요"} onFocus={() => { previewAddressEditingRef.current = true; }} onBlur={() => { previewAddressEditingRef.current = false; setPreviewAddress(previewHistory.entries[previewHistory.index] ?? "/"); }} onChange={(event) => setPreviewAddress(event.currentTarget.value)} />
                </form>
                <div className={css.previewActions()}>{hasIsolatedPreview ? <><span className={css.live()}><i aria-hidden="true" /> 실행 중</span><Button className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-xs text-muted-foreground hover:bg-hover hover:text-foreground" type="button" size="icon" variant="ghost" onClick={openPreviewWindow} aria-label="미리보기를 새 탭에서 열기" title="새 탭에서 열기">↗</Button></> : <Button aria-label="미리보기 실행" type="button" size="sm" variant="primary" disabled={isRunningPreview} onClick={() => void runPreview()}>{isRunningPreview ? "설치 중…" : "실행"}</Button>}<Button aria-label="미리보기 닫기" type="button" size="sm" variant="ghost" onClick={() => setIsPreviewOpen(false)}>×</Button></div>
              </div>
              {hasIsolatedPreview ? <div className="relative min-h-0 overflow-hidden"><iframe className="block size-full" ref={attachPreviewFrame} title={`${project.name} 미리보기`} src={isolatedPreviewUrl} sandbox="allow-scripts allow-same-origin" allow="cross-origin-isolated" referrerPolicy="no-referrer" />{previewRefreshFailed ? <div className="absolute inset-0 grid place-content-center justify-items-center bg-raised/95 p-8 text-center" role="alert"><strong className="text-sm text-foreground">개발 서버가 중지되었습니다.</strong><p className="mb-4 mt-2 max-w-sm text-xs text-muted-foreground">새로고침할 수 없습니다. 개발 서버를 다시 실행하면 현재 로컬 초안으로 미리보기를 복구합니다.</p><Button type="button" size="sm" variant="primary" disabled={isRunningPreview} onClick={() => void runPreview()}>{isRunningPreview ? "다시 실행 중…" : "개발 서버 다시 실행"}</Button></div> : null}</div> : previewConfiguration.status === "disabled" ? <div className={css.utilityEmpty()} role="status"><strong>미리보기를 사용할 수 없습니다.</strong><p>{previewConfiguration.message} 동일 출처 미리보기는 보안을 위해 비활성화되어 있습니다.</p></div> : runtime.previewUrl ? <div className={css.utilityEmpty()} role="status"><strong>격리된 연결을 준비하고 있습니다.</strong><p>격리된 미리보기 연결이 아직 준비되지 않았습니다. 동일 출처 미리보기는 비활성화되어 있습니다.</p></div> : <div className={css.utilityEmpty()}><span aria-hidden="true">▷</span><strong>실행 결과를 바로 확인하세요</strong><p>의존성을 설치하고 개발 서버를 시작합니다.</p></div>}
            </section>
          </section>
        </div>
      ) : <div className={css.start()} role="status"><span className={css.startMark()} aria-hidden="true">N</span><h4>{isStarting ? "Studio를 준비하고 있습니다" : project.state === "active" ? error ? "Studio를 준비하지 못했습니다" : "Studio가 종료되었습니다" : "보관된 프로젝트입니다"}</h4><p>{isStarting ? `저장본을 확인한 뒤, 저장본이 없으면 프로젝트에 고정된 ${projectTemplateLabel(project.templateId)} 템플릿을 자동으로 엽니다.` : error ?? (project.state === "active" ? "프로젝트에 고정된 시작 템플릿으로 Studio를 다시 열 수 있습니다." : "활성 프로젝트만 Studio에서 열 수 있습니다.")}</p>{!isStarting && project.state === "active" ? <Button type="button" variant="primary" onClick={() => void startWorkspace()}>{error ? "다시 시도" : "Studio 열기"}</Button> : null}</div>}
      <ConfirmationDialog
        confirmLabel="파일 삭제"
        description={`${selectedPath ?? "선택한 파일"}을 로컬 초안에서 삭제합니다. 서버에 저장하기 전에는 기존 서버 버전에 영향을 주지 않습니다.`}
        open={confirmingFileDelete}
        title="이 파일을 삭제할까요?"
        onCancel={() => setConfirmingFileDelete(false)}
        onConfirm={deleteSelectedFile}
      />
      <ConfirmationDialog
        confirmLabel="초안을 버리고 종료"
        description="서버에 저장하지 않은 로컬 초안과 편집 중인 내용이 사라집니다. 필요한 변경은 먼저 서버에 저장하세요."
        open={confirmingWorkspaceStop}
        title="브라우저 워크스페이스를 종료할까요?"
        onCancel={() => setConfirmingWorkspaceStop(false)}
        onConfirm={() => void stopWorkspace()}
      />
    </section>
  );
}

function EditorBreadcrumbs({ className, path }: Readonly<{ className: string; path: string }>) {
  const parts = path.split("/");
  return <nav aria-label="파일 경로" className={className}>{parts.map((part, index) => {
    const crumb = parts.slice(0, index + 1).join("/");
    const isFile = index === parts.length - 1;
    return <span className="flex min-w-0 items-center gap-1" key={crumb}>{index > 0 ? <span aria-hidden="true">/</span> : null}<span className={isFile ? "truncate text-foreground" : "truncate"}>{part}</span></span>;
  })}</nav>;
}

function workbenchLayoutClass({ focusMode, previewOpen, sidebarOpen }: Readonly<{
  focusMode: boolean;
  previewOpen: boolean;
  sidebarOpen: boolean;
}>): string | undefined {
  if (focusMode) {
    return "grid-cols-[minmax(0,1fr)]";
  }
  if (!sidebarOpen && !previewOpen) {
    return "grid-cols-[3rem_minmax(24rem,1fr)] max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]";
  }
  if (!sidebarOpen) {
    return "grid-cols-[3rem_minmax(24rem,1fr)_var(--studio-preview-width)] max-[72rem]:grid-cols-[3rem_minmax(0,1fr)] max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]";
  }
  if (!previewOpen) {
    return "grid-cols-[3rem_var(--studio-sidebar-width)_minmax(24rem,1fr)] max-[72rem]:grid-cols-[3rem_14rem_minmax(0,1fr)] max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]";
  }
  return undefined;
}

function projectTemplateLabel(templateId: Project["templateId"]): string {
  return templateId === "next-app" ? "Next.js" : "Vite + React";
}

function runtimeLifecycleLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    idle: "대기",
    booting: "시작 중",
    ready: "준비됨",
    stopping: "종료 중",
    stopped: "종료됨",
    failed: "오류"
  };
  return labels[value] ?? value;
}

function serverSavePhaseLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    planning: "저장 계획 수립 중",
    creating: "저장본 생성 중",
    uploading: "업로드 중",
    committing: "서버에 반영 중",
    reconciling: "처리 결과 확인 중"
  };
  return labels[value] ?? value;
}

function recoveryActionLabel(kind: RuntimeRecoveryActionKind): string {
  if (kind === "clear-cache") return "패키지 캐시 비우기";
  if (kind === "reset-runtime") return "런타임 초기화";
  if (kind === "resolve-writer-conflict") return "편집 권한 가져오기";
  if (kind === "restart-dev-server") return "개발 서버 다시 시작";
  return "미리보기 다시 시도";
}

function runtimeErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^RUNTIME_[A-Z0-9_]{1,56}$/u.test(code) ? code : null;
}

function projectContentErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^RESUME_[A-Z_]{1,48}$/u.test(code) ? code : null;
}

function resumeErrorMessage(code: string): string {
  if (code === "RESUME_AUTHENTICATION_REQUIRED") {
    return "세션이 만료되었습니다. 다시 로그인한 뒤 프로젝트를 여세요. 로컬 초안은 교체하지 않았습니다.";
  }
  if (code === "RESUME_NOT_SAVED") {
    return "이 프로젝트에는 현재 서버 저장본이 없습니다. 템플릿에서 시작해 첫 로컬 초안을 만드세요.";
  }
  if (code === "RESUME_CONTENT_UNAVAILABLE") {
    return "현재 서버 저장본을 이 계정에서 더 이상 사용할 수 없습니다. 로컬 초안은 교체하지 않았습니다.";
  }
  if (code === "RESUME_LIMIT_EXCEEDED") {
    return "현재 서버 저장본이 브라우저 워크스페이스 제한을 초과합니다. 어떤 파일도 열지 않았습니다.";
  }
  if (code === "RESUME_INTEGRITY_FAILED") {
    return "현재 서버 저장본의 무결성 검증에 실패했습니다. 파일은 열지 않았으므로 다시 시도하거나 관리자에게 저장소 점검을 요청하세요.";
  }
  if (code === "RESUME_ABORTED") return "프로젝트 열기를 취소했습니다. 로컬 초안은 교체하지 않았습니다.";
  return "현재 서버 저장본을 열지 못했습니다. 로컬 초안은 교체하지 않았으므로 서비스가 준비되면 다시 시도하세요.";
}
