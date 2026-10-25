"use client";

import { useMemo, useState } from "react";

import { Button } from "#src/components/ui/button.tsx";
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
  readonly files: readonly RuntimeWorkspaceFile[];
  readonly hasUnsavedEditorChange: boolean;
  readonly onSelect: (path: string) => void;
  readonly selectedPath?: string | undefined;
}

export function ProjectFileTree({ files, hasUnsavedEditorChange, onSelect, selectedPath }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const toggleDirectory = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return <ul className="m-0 grid list-none gap-px p-0">{tree.map((node) => <TreeItem collapsedPaths={collapsedPaths} hasUnsavedEditorChange={hasUnsavedEditorChange} key={node.type === "file" ? node.file.path : node.path} node={node} onSelect={onSelect} selectedPath={selectedPath} toggleDirectory={toggleDirectory} />)}</ul>;
}

function TreeItem({ collapsedPaths, hasUnsavedEditorChange, node, onSelect, selectedPath, toggleDirectory }: Readonly<{
  collapsedPaths: ReadonlySet<string>;
  hasUnsavedEditorChange: boolean;
  node: TreeNode;
  onSelect: (path: string) => void;
  selectedPath?: string | undefined;
  toggleDirectory: (path: string) => void;
}>) {
  if (node.type === "file") {
    const isSelected = selectedPath === node.file.path;
    return <li><Button className="grid min-h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center justify-normal gap-1.5 rounded-sm border-0 bg-transparent px-2 text-left font-mono text-[0.6875rem] text-muted-foreground hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-primary" type="button" variant="ghost" size="sm" title={node.file.path} aria-current={isSelected ? "page" : undefined} onClick={() => onSelect(node.file.path)}><span className="text-primary" aria-hidden="true">{fileIcon(node.file.path)}</span><span className="truncate">{node.file.name}</span>{isSelected && hasUnsavedEditorChange ? <i className="size-1.5 rounded-full bg-primary" aria-label="저장하지 않은 변경 사항" /> : null}</Button></li>;
  }

  const collapsed = collapsedPaths.has(node.path);
  return <li><Button className="flex min-h-8 w-full items-center justify-start gap-1.5 rounded-sm border-0 bg-transparent px-2 text-left text-[0.6875rem] font-semibold text-foreground hover:bg-hover" type="button" variant="ghost" size="sm" aria-expanded={!collapsed} onClick={() => toggleDirectory(node.path)}><span className="w-3 text-muted-foreground" aria-hidden="true">{collapsed ? "›" : "⌄"}</span><span aria-hidden="true">▰</span><span className="truncate">{node.name}</span></Button>{collapsed ? null : <ul className="m-0 ml-3 grid list-none gap-px border-l border-muted-border pl-1 p-0">{node.children.map((child) => <TreeItem collapsedPaths={collapsedPaths} hasUnsavedEditorChange={hasUnsavedEditorChange} key={child.type === "file" ? child.file.path : child.path} node={child} onSelect={onSelect} selectedPath={selectedPath} toggleDirectory={toggleDirectory} />)}</ul>}</li>;
}

function buildTree(files: readonly RuntimeWorkspaceFile[]): readonly TreeNode[] {
  const root: MutableDirectory = { directories: new Map(), files: [] };
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
