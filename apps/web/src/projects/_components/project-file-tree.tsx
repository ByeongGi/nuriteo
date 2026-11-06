"use client";

import { useMemo, useState } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { ContextMenuItem, ContextMenuPopup, ContextMenuPortal, ContextMenuPositioner, ContextMenuRoot, ContextMenuSeparator, ContextMenuTrigger } from "#src/components/ui/context-menu.tsx";
import type { RuntimeWorkspaceFile } from "#src/runtime/runtime-adapter.ts";

interface FileNode {
  readonly file: RuntimeWorkspaceFile;
  readonly type: "file";
}

interface DirectoryNode {
  readonly children: readonly TreeNode[];
  readonly name: string;
  readonly path: string;
  readonly type: "directory";
}

type TreeNode = DirectoryNode | FileNode;

interface Props {
  readonly canWrite: boolean;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly directories: readonly string[];
  readonly files: readonly RuntimeWorkspaceFile[];
  readonly onCopyPath: (path: string) => void;
  readonly onCreateDirectory: (directoryPath: string) => void;
  readonly onCreateInDirectory: (directoryPath: string) => void;
  readonly onDelete: (path: string) => void;
  readonly onMove: (from: string, targetDirectory: string) => void;
  readonly onOpenInSplit: (path: string) => void;
  readonly onPin: (path: string) => void;
  readonly onRename: (path: string) => void;
  readonly onSelect: (path: string) => void;
  readonly selectedPath?: string | undefined;
}

export function ProjectFileTree({ canWrite, directories, dirtyPaths, files, onCopyPath, onCreateDirectory, onCreateInDirectory, onDelete, onMove, onOpenInSplit, onPin, onRename, onSelect, selectedPath }: Props) {
  const tree = useMemo(() => buildTree(files, directories), [directories, files]);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const toggleDirectory = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return <ul className="m-0 grid list-none gap-px p-0" onDragOver={allowDrop} onDrop={(event) => dropOnDirectory(event, "", onMove)}>{tree.map((node) => <TreeItem canWrite={canWrite} collapsedPaths={collapsedPaths} dirtyPaths={dirtyPaths} key={node.type === "file" ? node.file.path : node.path} node={node} onCopyPath={onCopyPath} onCreateDirectory={onCreateDirectory} onCreateInDirectory={onCreateInDirectory} onDelete={onDelete} onMove={onMove} onOpenInSplit={onOpenInSplit} onPin={onPin} onRename={onRename} onSelect={onSelect} selectedPath={selectedPath} toggleDirectory={toggleDirectory} />)}</ul>;
}

function TreeItem({ canWrite, collapsedPaths, dirtyPaths, node, onCopyPath, onCreateDirectory, onCreateInDirectory, onDelete, onMove, onOpenInSplit, onPin, onRename, onSelect, selectedPath, toggleDirectory }: Readonly<{
  canWrite: boolean;
  collapsedPaths: ReadonlySet<string>;
  dirtyPaths: ReadonlySet<string>;
  node: TreeNode;
  onCopyPath: (path: string) => void;
  onCreateDirectory: (directoryPath: string) => void;
  onCreateInDirectory: (directoryPath: string) => void;
  onDelete: (path: string) => void;
  onMove: (from: string, targetDirectory: string) => void;
  onOpenInSplit: (path: string) => void;
  onPin: (path: string) => void;
  onRename: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath?: string | undefined;
  toggleDirectory: (path: string) => void;
}>) {
  if (node.type === "file") {
    const isSelected = selectedPath === node.file.path;
    return <li><ContextMenuRoot><ContextMenuTrigger className="block w-full text-left"><Button className="grid min-h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center justify-normal gap-1.5 rounded-sm border-0 bg-transparent px-2 text-left font-mono text-[0.6875rem] text-muted-foreground hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-primary" type="button" variant="ghost" size="sm" title={node.file.path} aria-current={isSelected ? "page" : undefined} draggable={canWrite} onDragStart={(event) => event.dataTransfer.setData("text/plain", node.file.path)} onClick={() => onSelect(node.file.path)} onDoubleClick={() => onPin(node.file.path)}><span className="text-primary" aria-hidden="true">{fileIcon(node.file.path)}</span><span className="truncate">{node.file.name}</span>{dirtyPaths.has(node.file.path) ? <i className="size-1.5 rounded-full bg-primary" aria-label="저장하지 않은 변경 사항" /> : null}</Button></ContextMenuTrigger><ContextMenuPortal><ContextMenuPositioner><ContextMenuPopup className="w-52 text-xs"><ContextMenuItem onClick={() => onPin(node.file.path)}><span aria-hidden="true" /><span>열기</span></ContextMenuItem><ContextMenuItem disabled={node.file.kind !== "text"} onClick={() => onOpenInSplit(node.file.path)}><span aria-hidden="true" /><span>분할 편집기에서 열기</span></ContextMenuItem><ContextMenuSeparator /><ContextMenuItem disabled={!canWrite} onClick={() => onRename(node.file.path)}><span aria-hidden="true" /><span>이름 변경</span></ContextMenuItem><ContextMenuItem onClick={() => onCopyPath(node.file.path)}><span aria-hidden="true" /><span>경로 복사</span></ContextMenuItem><ContextMenuItem disabled={!canWrite} onClick={() => onDelete(node.file.path)}><span aria-hidden="true" /><span>삭제</span></ContextMenuItem></ContextMenuPopup></ContextMenuPositioner></ContextMenuPortal></ContextMenuRoot></li>;
  }

  const collapsed = collapsedPaths.has(node.path);
  return <li><ContextMenuRoot><ContextMenuTrigger className="block w-full text-left"><Button className="flex min-h-8 w-full items-center justify-start gap-1.5 rounded-sm border-0 bg-transparent px-2 text-left text-[0.6875rem] font-semibold text-foreground hover:bg-hover" type="button" variant="ghost" size="sm" aria-expanded={!collapsed} draggable={canWrite} onDragStart={(event) => event.dataTransfer.setData("text/plain", node.path)} onDragOver={allowDrop} onDrop={(event) => dropOnDirectory(event, node.path, onMove)} onClick={() => toggleDirectory(node.path)}><span className="w-3 text-muted-foreground" aria-hidden="true">{collapsed ? "›" : "⌄"}</span><span aria-hidden="true">▰</span><span className="truncate">{node.name}</span></Button></ContextMenuTrigger><ContextMenuPortal><ContextMenuPositioner><ContextMenuPopup className="w-52 text-xs"><ContextMenuItem disabled={!canWrite} onClick={() => onCreateInDirectory(node.path)}><span aria-hidden="true" /><span>이 폴더에 새 파일</span></ContextMenuItem><ContextMenuItem disabled={!canWrite} onClick={() => onCreateDirectory(node.path)}><span aria-hidden="true" /><span>새 폴더</span></ContextMenuItem><ContextMenuItem onClick={() => onCopyPath(node.path)}><span aria-hidden="true" /><span>경로 복사</span></ContextMenuItem><ContextMenuItem disabled={!canWrite} onClick={() => onDelete(node.path)}><span aria-hidden="true" /><span>삭제</span></ContextMenuItem></ContextMenuPopup></ContextMenuPositioner></ContextMenuPortal></ContextMenuRoot>{collapsed ? null : <ul className="m-0 ml-3 grid list-none gap-px border-l border-muted-border pl-1 p-0">{node.children.map((child) => <TreeItem canWrite={canWrite} collapsedPaths={collapsedPaths} dirtyPaths={dirtyPaths} key={(function () {
    if (child.type === "file") {
        return (child.file.path);
    }
    return (child.path);
})()} node={child} onCopyPath={onCopyPath} onCreateDirectory={onCreateDirectory} onCreateInDirectory={onCreateInDirectory} onDelete={onDelete} onMove={onMove} onOpenInSplit={onOpenInSplit} onPin={onPin} onRename={onRename} onSelect={onSelect} selectedPath={selectedPath} toggleDirectory={toggleDirectory} />)}</ul>}</li>;
}

function allowDrop(event: { preventDefault(): void }): void {
  event.preventDefault();
}

function dropOnDirectory(event: { preventDefault(): void; stopPropagation(): void; dataTransfer: DataTransfer }, targetDirectory: string, onMove: (from: string, targetDirectory: string) => void): void {
  event.preventDefault();
  event.stopPropagation();
  const from = event.dataTransfer.getData("text/plain");
  if (!from || from === targetDirectory || targetDirectory.startsWith(`${from}/`)) return;
  onMove(from, targetDirectory);
}

function buildTree(files: readonly RuntimeWorkspaceFile[], directories: readonly string[]): readonly TreeNode[] {
  const root: MutableDirectory = { directories: new Map(), files: [] };
  for (const directory of directories) {
    let current = root;
    for (const segment of directory.split("/")) {
      let child = current.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: [] };
        current.directories.set(segment, child);
      }
      current = child;
    }
  }
  for (const file of files) {
    const segments = file.path.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      let child = directory.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }
  return materializeDirectory(root);
}

interface MutableDirectory {
  readonly directories: Map<string, MutableDirectory>;
  readonly files: RuntimeWorkspaceFile[];
}

function materializeDirectory(directory: MutableDirectory, parent = ""): readonly TreeNode[] {
  const directories: DirectoryNode[] = [...directory.directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => {
      const path = parent ? `${parent}/${name}` : name;
      return { children: materializeDirectory(child, path), name, path, type: "directory" };
    });
  const files: FileNode[] = [...directory.files]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((file) => ({ file, type: "file" }));
  return [...directories, ...files];
}

function fileIcon(path: string): string {
  if (/\.(?:tsx?|jsx?)$/iu.test(path)) return "⚛";
  if (/\.css$/iu.test(path)) return "≋";
  if (/\.json$/iu.test(path)) return "{}";
  if (/\.md$/iu.test(path)) return "¶";
  return "#";
}
