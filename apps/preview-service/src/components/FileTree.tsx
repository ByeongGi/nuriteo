import { useMemo, useState, type DragEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { Braces, ChevronDown, ChevronRight, File, FileCode2, FileJson, FilePlus2, FileText, Folder, FolderPlus, Copy, Eye, EyeOff, FoldVertical, Palette, RefreshCw } from "lucide-react";
import type { ProjectWorkspaceTreeNode } from "@nuriteo/browser-host";
import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { createGitignoreMatcher, type GitignoreMatcher } from "../lib/gitignore";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { fileIconKind, type FileIconKind } from "../lib/fileIcons";

type MenuTarget =
  | { kind: "blank" }
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string };

type DragPayload = {
  path: string;
  isDirectory: boolean;
};

const DRAG_MIME = "application/x-nuriteo-path";

function filterTree(nodes: ProjectWorkspaceTreeNode[], query: string): ProjectWorkspaceTreeNode[] {
  if (!query) return nodes;
  const needle = query.toLowerCase();
  const walk = (list: ProjectWorkspaceTreeNode[]): ProjectWorkspaceTreeNode[] => {
    const out: ProjectWorkspaceTreeNode[] = [];
    for (const node of list) {
      if (node.type === "directory") {
        const children = walk(node.children || []);
        if (children.length || node.name.toLowerCase().includes(needle)) {
          out.push({ ...node, children });
        }
      } else if (node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)) {
        out.push(node);
      }
    }
    return out;
  };
  return walk(nodes);
}

function projectRelativePath(path: string, projectRoot: string): string {
  const normalizedRoot = projectRoot.replace(/\/+$/u, "");
  if (path === normalizedRoot) return "";
  if (path.startsWith(`${normalizedRoot}/`)) return path.slice(normalizedRoot.length + 1);
  return path.replace(/^\/+/, "");
}

function filterIgnoredTree(
  nodes: ProjectWorkspaceTreeNode[],
  projectRoot: string,
  matcher: GitignoreMatcher,
  ignoredPaths: Map<string, boolean>
): ProjectWorkspaceTreeNode[] {
  const visibleNodes: ProjectWorkspaceTreeNode[] = [];
  for (const node of nodes) {
    const cacheKey = `${node.type}:${node.path}`;
    let ignored = ignoredPaths.get(cacheKey);
    if (ignored === undefined) {
      ignored = matcher.isIgnored(projectRelativePath(node.path, projectRoot), node.type === "directory");
      ignoredPaths.set(cacheKey, ignored);
    }
    if (ignored) continue;

    if (node.type === "directory") {
      visibleNodes.push({
        ...node,
        children: filterIgnoredTree(node.children || [], projectRoot, matcher, ignoredPaths)
      });
    } else {
      visibleNodes.push(node);
    }
  }
  return visibleNodes;
}

function TreeNodes({
  nodes,
  selectedPath,
  selectedPaths,
  dropTarget,
  collapseToken,
  onOpen,
  onContext,
  onDragStartNode,
  onDragOverNode,
  onDropNode,
  depth = 0
}: {
  nodes: ProjectWorkspaceTreeNode[];
  selectedPath: string;
  selectedPaths: string[];
  dropTarget: string | null;
  collapseToken: number;
  onOpen: (path: string, event: MouseEvent) => void;
  onContext: (event: MouseEvent, target: MenuTarget) => void;
  onDragStartNode: (event: DragEvent, payload: DragPayload) => void;
  onDragOverNode: (event: DragEvent, path: string) => void;
  onDropNode: (event: DragEvent, path: string) => void;
  depth?: number;
}) {
  return (
    <ul className={clsx("space-y-0.5", depth === 0 ? "" : "ml-3 border-l border-nuriteo-line/70 pl-2")}>
      {nodes.map((node) => (
        <TreeNode
          key={`${node.path}:${collapseToken}`}
          node={node}
          selectedPath={selectedPath}
          selectedPaths={selectedPaths}
          dropTarget={dropTarget}
          collapseToken={collapseToken}
          onOpen={onOpen}
          onContext={onContext}
          onDragStartNode={onDragStartNode}
          onDragOverNode={onDragOverNode}
          onDropNode={onDropNode}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  selectedPath,
  selectedPaths,
  dropTarget,
  collapseToken,
  onOpen,
  onContext,
  onDragStartNode,
  onDragOverNode,
  onDropNode,
  depth
}: {
  node: ProjectWorkspaceTreeNode;
  selectedPath: string;
  selectedPaths: string[];
  dropTarget: string | null;
  collapseToken: number;
  onOpen: (path: string, event: MouseEvent) => void;
  onContext: (event: MouseEvent, target: MenuTarget) => void;
  onDragStartNode: (event: DragEvent, payload: DragPayload) => void;
  onDragOverNode: (event: DragEvent, path: string) => void;
  onDropNode: (event: DragEvent, path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(collapseToken === 0 ? depth < 2 : false);
  const isDrop = dropTarget === node.path;
  const multiSelected = selectedPaths.includes(node.path);

  if (node.type === "directory") {
    return (
      <li>
        <div
          className={clsx(
            "group flex items-center gap-0.5 rounded-md",
            isDrop && "bg-nuriteo-accent/20 ring-1 ring-nuriteo-accent/50",
            multiSelected && "bg-nuriteo-accent/10"
          )}
          draggable
          onDragStart={(event) => onDragStartNode(event, { path: node.path, isDirectory: true })}
          onDragOver={(event) => onDragOverNode(event, node.path)}
          onDrop={(event) => onDropNode(event, node.path)}
          onContextMenu={(event) => onContext(event, { kind: "directory", path: node.path })}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-nuriteo-muted hover:bg-nuriteo-panel-2 hover:text-nuriteo-ink"
            onClick={(event) => {
              onOpen(node.path, event);
              setOpen((value) => !value);
            }}
          >
            {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            <Folder className="folder-icon size-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        {open ? (
          <TreeNodes
            nodes={node.children || []}
            selectedPath={selectedPath}
            selectedPaths={selectedPaths}
            dropTarget={dropTarget}
            collapseToken={collapseToken}
            onOpen={onOpen}
            onContext={onContext}
            onDragStartNode={onDragStartNode}
            onDragOverNode={onDragOverNode}
            onDropNode={onDropNode}
            depth={depth + 1}
          />
        ) : null}
      </li>
    );
  }

  const active = node.path === selectedPath || multiSelected;
  return (
    <li>
      <div
        className="group flex items-center gap-0.5"
        draggable
        onDragStart={(event) => onDragStartNode(event, { path: node.path, isDirectory: false })}
        onContextMenu={(event) => onContext(event, { kind: "file", path: node.path })}
      >
        <button
          type="button"
          data-path={node.path}
          aria-current={node.path === selectedPath ? "true" : undefined}
          className={clsx(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-nuriteo-panel-2",
            active ? "bg-nuriteo-accent/15 text-nuriteo-accent-strong" : "text-nuriteo-ink"
          )}
          onClick={(event) => onOpen(node.path, event)}
          onDoubleClick={(event) => onOpen(node.path, event)}
        >
          <FileTypeIcon path={node.path} />
          <span className="truncate">{node.name}{node.dirty ? " •" : ""}</span>
        </button>
      </div>
    </li>
  );
}

const FILE_ICONS = {
  code: Braces,
  data: FileJson,
  style: Palette,
  markup: FileCode2,
  document: FileText,
  file: File
} satisfies Record<FileIconKind, typeof File>;

function FileTypeIcon({ path }: { path: string }) {
  const kind = fileIconKind(path);
  const Icon = FILE_ICONS[kind];
  return <Icon className={`file-icon file-icon-${kind} size-3.5 shrink-0`} aria-hidden />;
}

export function FileTree({ model }: { model: PreviewControllerModel }) {
  const [filter, setFilter] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [collapseToken, setCollapseToken] = useState(0);
  const disabled = !model.snapshot.editor;
  const projectRoot = model.snapshot.project?.root || "";
  const tree = useMemo(() => {
    const nodes = model.snapshot.editor?.tree() || [];
    if (showIgnored || !model.snapshot.project || !projectRoot) {
      return filterTree(nodes, filter.trim());
    }

    const gitignorePath = `${projectRoot.replace(/\/+$/u, "")}/.gitignore`;
    const gitignoreFile = model.snapshot.project.listFiles().find((file) => file.path === gitignorePath);
    let gitignoreSource = gitignoreFile?.data || "";
    if (gitignoreFile && model.snapshot.editor) {
      try {
        gitignoreSource = model.snapshot.editor.openFile(gitignorePath).data;
      } catch {
        // The project snapshot remains the source of truth if the editor cannot open the file.
      }
    }

    const matcher = createGitignoreMatcher(gitignoreSource);
    const visibleNodes = filterIgnoredTree(nodes, projectRoot, matcher, new Map());
    return filterTree(visibleNodes, filter.trim());
  }, [filter, model.snapshot, projectRoot, showIgnored]);

  const openContext = (event: MouseEvent, target: MenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  };

  const onDragStartNode = (event: DragEvent, payload: DragPayload) => {
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOverNode = (event: DragEvent, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(DRAG_MIME) ? "move" : "copy";
    setDropTarget(path);
  };

  const onDropNode = (event: DragEvent, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (raw) {
      try {
        const payload = JSON.parse(raw) as DragPayload;
        model.movePath(payload.path, path, payload.isDirectory);
      } catch {
        /* ignore bad payload */
      }
      return;
    }
    if (event.dataTransfer.items?.length || event.dataTransfer.files?.length) {
      void model.importDroppedEntries(event.dataTransfer, path);
    }
  };

  const onRootDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(DRAG_MIME) ? "move" : "copy";
    setDropTarget(projectRoot || "__root__");
  };

  const onRootDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (raw && projectRoot) {
      try {
        const payload = JSON.parse(raw) as DragPayload;
        model.movePath(payload.path, projectRoot, payload.isDirectory);
      } catch {
        /* ignore */
      }
      return;
    }
    if (event.dataTransfer.items?.length || event.dataTransfer.files?.length) {
      void model.importDroppedEntries(event.dataTransfer, projectRoot || null);
    }
  };

  const itemsForTarget = (target: MenuTarget): ContextMenuItem[] => {
    if (target.kind === "blank") {
      return [
        { id: "new-file", label: "New File…" },
        { id: "new-folder", label: "New Folder…" },
        { id: "sep-0", label: "", separator: true },
        { id: "paste", label: "Paste", disabled: !model.clipboard }
      ];
    }
    if (target.kind === "directory") {
      return [
        { id: "new-file", label: "New File…" },
        { id: "new-folder", label: "New Folder…" },
        { id: "sep-1", label: "", separator: true },
        { id: "cut", label: "Cut" },
        { id: "copy", label: "Copy" },
        { id: "paste", label: "Paste", disabled: !model.clipboard },
        { id: "sep-2", label: "", separator: true },
        { id: "rename", label: "Rename…" },
        { id: "delete", label: "Delete", danger: true }
      ];
    }
    return [
      { id: "open", label: "Open" },
      { id: "sep-1", label: "", separator: true },
      { id: "cut", label: "Cut" },
      { id: "copy", label: "Copy" },
      { id: "paste", label: "Paste", disabled: !model.clipboard },
      { id: "sep-2", label: "", separator: true },
      { id: "rename", label: "Rename…" },
      { id: "delete", label: "Delete", danger: true }
    ];
  };

  const runMenu = (id: string) => {
    if (!menu) return;
    const { target } = menu;
    if (id === "new-file") {
      if (target.kind === "directory") {
        model.createFile(`${model.displayPath(target.path)}/untitled.ts`);
      } else {
        model.createFile();
      }
      return;
    }
    if (id === "new-folder") {
      if (target.kind === "directory") {
        model.createFolder(`${model.displayPath(target.path)}/new-folder`);
      } else {
        model.createFolder();
      }
      return;
    }
    if (id === "open" && target.kind === "file") {
      model.openFile(target.path);
      return;
    }
    if (id === "cut" && target.kind !== "blank") {
      const paths = model.selectedPaths.includes(target.path) ? model.selectedPaths : [target.path];
      model.cutPaths(paths);
      return;
    }
    if (id === "copy" && target.kind !== "blank") {
      const paths = model.selectedPaths.includes(target.path) ? model.selectedPaths : [target.path];
      model.copyPaths(paths);
      return;
    }
    if (id === "paste") {
      const targetDir = target.kind === "directory"
        ? target.path
        : target.kind === "file"
          ? target.path.slice(0, target.path.lastIndexOf("/"))
          : model.snapshot.project?.root || null;
      model.pastePaths(targetDir);
      return;
    }
    if (id === "rename" && target.kind !== "blank") {
      model.renamePath(target.path, target.kind === "directory");
      return;
    }
    if (id === "delete" && target.kind !== "blank") {
      model.deletePath(target.path, target.kind === "directory");
    }
  };

  return (
    <aside
      className={clsx(
        "flex h-full min-h-0 min-w-0 flex-col border-r border-nuriteo-line bg-nuriteo-elevated/60",
        dropTarget === (projectRoot || "__root__") && "ring-1 ring-inset ring-nuriteo-accent/40"
      )}
      aria-label="Project files"
      onContextMenu={(event) => openContext(event, { kind: "blank" })}
      onDragOver={onRootDragOver}
      onDragLeave={() => setDropTarget(null)}
      onDrop={onRootDrop}
    >
      <div className="flex items-center justify-between gap-2 border-b border-nuriteo-line px-2 py-2">
        <h2 className="px-1 text-[11px] font-semibold tracking-[0.14em] text-nuriteo-muted uppercase">Explorer</h2>
        <div className="flex items-center gap-0.5">
          <button
            id="file-new"
            type="button"
            className="icon-btn size-7"
            title="New file"
            disabled={disabled}
            onClick={() => model.createFile()}
          >
            <FilePlus2 className="size-3.5" />
          </button>
          <button
            id="folder-new"
            type="button"
            className="icon-btn size-7"
            title="New folder"
            disabled={disabled}
            onClick={() => model.createFolder()}
          >
            <FolderPlus className="size-3.5" />
          </button>
          <button
            id="file-toggle-ignored"
            type="button"
            className="icon-btn size-7"
            title={showIgnored ? "Hide ignored files" : "Show ignored files"}
            aria-label={showIgnored ? "Hide ignored files" : "Show ignored files"}
            aria-pressed={showIgnored}
            disabled={disabled}
            onClick={() => setShowIgnored((value) => !value)}
          >
            {showIgnored ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            className="icon-btn size-7"
            title="Copy path"
            disabled={!model.selectedPath}
            onClick={async () => {
              if (!model.selectedPath) return;
              const text = model.displayPath(model.selectedPath);
              try {
                await navigator.clipboard.writeText(text);
              } catch {
                window.prompt("Copy path", text);
              }
            }}
          >
            <Copy className="size-3.5" />
          </button>
          <button
            type="button"
            className="icon-btn size-7"
            title="Collapse folders"
            disabled={disabled}
            onClick={() => setCollapseToken((value) => value + 1)}
          >
            <FoldVertical className="size-3.5" />
          </button>
          <button
            type="button"
            className="icon-btn size-7"
            title="Refresh explorer"
            disabled={disabled}
            onClick={() => {
              model.refreshPreview();
              setCollapseToken((value) => value);
              setFilter((value) => value);
            }}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="border-b border-nuriteo-line px-2 py-2">
        <input
          id="file-filter"
          type="search"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="w-full rounded-md border border-nuriteo-line bg-nuriteo-panel px-2.5 py-1.5 text-xs text-nuriteo-ink outline-none placeholder:text-nuriteo-muted focus:border-nuriteo-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {tree.length === 0 ? (
          <p className="px-2 py-3 text-xs text-nuriteo-muted">
            No project files yet. Right-click to create one, or drop files here.
          </p>
        ) : (
          <TreeNodes
            nodes={tree}
            selectedPath={model.selectedPath}
            selectedPaths={model.selectedPaths}
            dropTarget={dropTarget}
            collapseToken={collapseToken}
            onOpen={(path, event) => {
              const additive = event.metaKey || event.ctrlKey;
              if (path === model.selectedPath || model.selectedPaths.includes(path) || !/\.[^/]+$/.test(path)) {
                model.selectExplorerPath(path, additive);
              }
              if (/\.[^/]+$/.test(path)) {
                model.openFile(path, { additive });
              } else {
                model.selectExplorerPath(path, additive);
              }
            }}
            onContext={openContext}
            onDragStartNode={onDragStartNode}
            onDragOverNode={onDragOverNode}
            onDropNode={onDropNode}
          />
        )}
      </div>

      <ContextMenu
        open={Boolean(menu)}
        x={menu?.x || 0}
        y={menu?.y || 0}
        items={menu ? itemsForTarget(menu.target) : []}
        onClose={() => setMenu(null)}
        onSelect={runMenu}
      />
    </aside>
  );
}
