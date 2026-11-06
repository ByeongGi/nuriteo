import { tv } from "tailwind-variants";

export const ideStyles = tv({
  slots: {
    shell: "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface text-foreground",
    header: "flex min-h-12 shrink-0 min-w-0 items-center justify-between gap-4 border-b border-muted-border bg-raised px-3 py-1.5 max-[48rem]:items-start max-[48rem]:flex-col",
    identity: "flex min-w-0 items-center gap-2.5 [&_p]:m-0 [&_p]:text-[0.6875rem] [&_p]:font-semibold [&_p]:uppercase [&_p]:tracking-[0.06em] [&_p]:text-foreground [&_h3]:m-0 [&_h3]:truncate",
    identityCopy: "grid min-w-0 gap-0.5",
    runtimeMeta: "flex items-center gap-2 text-[0.6875rem] text-muted-foreground",
    headerActions: "flex flex-wrap items-center justify-end gap-1.5 max-[48rem]:w-full max-[48rem]:justify-start [&_[data-slot=button]]:min-h-8 [&_[data-slot=button]]:px-2.5 [&_[data-slot=button]]:text-[0.6875rem] [&_[data-slot=button]]:shadow-none",
    access: "rounded-sm border border-primary/25 bg-selected px-1.5 py-0.5 text-[0.625rem] font-semibold text-primary",
    saveState: "flex max-w-80 items-center gap-2 truncate text-[0.6875rem] text-muted-foreground [&_i.is-dirty]:inline-block [&_i.is-dirty]:size-1.5 [&_i.is-dirty]:shrink-0 [&_i.is-dirty]:rounded-full [&_i.is-dirty]:bg-primary",
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
    editorTabs: "flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-muted-border bg-subtle text-[0.6875rem] text-muted-foreground [&>span]:self-center [&>span]:px-3 [&>div]:flex [&>div]:max-w-64 [&>div]:shrink-0 [&>div]:items-center [&>div]:border-r [&>div]:border-muted-border [&>div.is-active]:border-t-2 [&>div.is-active]:border-t-primary [&>div.is-active]:bg-surface [&>div.is-active]:text-foreground [&>div.is-preview_strong]:italic [&>div.is-preview_strong]:font-normal [&_.tab-select]:flex [&_.tab-select]:min-w-0 [&_.tab-select]:items-center [&_.tab-select]:gap-2 [&_.tab-select]:border-0 [&_.tab-select]:bg-transparent [&_.tab-select]:px-3 [&_.tab-select]:py-1 [&_.tab-select]:text-inherit [&_.tab-close]:mr-1 [&_.tab-close]:grid [&_.tab-close]:size-6 [&_.tab-close]:place-items-center [&_.tab-close]:border-0 [&_.tab-close]:bg-transparent [&_.tab-close]:text-muted-foreground [&_.tab-close]:hover:bg-hover [&_strong]:max-w-40 [&_strong]:truncate [&_i.is-dirty]:inline-block [&_i.is-dirty]:size-1.5 [&_i.is-dirty]:shrink-0 [&_i.is-dirty]:rounded-full [&_i.is-dirty]:bg-primary",
    editorHost: "relative min-h-0 min-w-0 overflow-hidden bg-surface focus-within:shadow-[inset_0_0_0_1px_var(--n-color-border-focus)]",
    editorPanes: "grid h-full min-h-0 min-w-0 grid-cols-1 divide-x divide-muted-border data-[split=true]:grid-cols-2 max-[56rem]:data-[split=true]:grid-cols-1 max-[56rem]:data-[split=true]:grid-rows-2 max-[56rem]:data-[split=true]:divide-x-0 max-[56rem]:data-[split=true]:divide-y [&>div]:min-h-0 [&>div]:min-w-0",
    editorEmpty: "grid place-content-center justify-items-center p-8 text-center text-muted-foreground [&>span]:mb-3 [&>span]:grid [&>span]:size-12 [&>span]:place-items-center [&>span]:rounded-lg [&>span]:border [&>span]:border-muted-border [&>span]:bg-subtle [&>span]:text-xl [&>span]:text-primary [&_p]:mt-2 [&_p]:max-w-md [&_p]:text-xs",
    status: "flex min-h-7 min-w-0 items-center justify-between gap-3 border-t border-muted-border bg-subtle px-2.5 text-[0.625rem] text-muted-foreground max-[48rem]:flex-wrap max-[48rem]:py-2 [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2 [&>span]:truncate [&_button]:min-h-6 [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-[0.625rem] [&_i.is-dirty]:inline-block [&_i.is-dirty]:size-1.5 [&_i.is-dirty]:shrink-0 [&_i.is-dirty]:rounded-full [&_i.is-dirty]:bg-primary",
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

export const runtimeDot = tv({
  base: "size-2 shrink-0 rounded-full bg-muted-foreground",
  variants: { state: { ready: "bg-success", running: "bg-success", failed: "bg-danger", idle: "bg-muted-foreground", starting: "bg-warning", stopping: "bg-warning" } },
  defaultVariants: { state: "idle" }
});
