export type CommandId =
  | "save"
  | "format"
  | "go-to-file"
  | "go-to-definition"
  | "search"
  | "toggle-sidebar"
  | "toggle-terminal"
  | "toggle-preview"
  | "zen"
  | "run-preview"
  | "run-build"
  | "restart"
  | "settings"
  | "ports"
  | "scm"
  | "outline"
  | "explorer"
  | "new-file"
  | "export-zip"
  | "import"
  | "start-vite-react"
  | "split-editor"
  | "help-terminal";

export interface IdeCommand {
  id: CommandId;
  label: string;
  shortcut?: string;
  unsupported?: boolean;
}

export const IDE_COMMANDS: IdeCommand[] = [
  { id: "save", label: "Save File", shortcut: "⌘S" },
  { id: "format", label: "Format Document", shortcut: "⇧⌥F" },
  { id: "go-to-file", label: "Go to File…", shortcut: "⌘P" },
  { id: "go-to-definition", label: "Go to Definition", shortcut: "F12" },
  { id: "search", label: "Search in Files", shortcut: "⌘⇧F" },
  { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌘B" },
  { id: "toggle-terminal", label: "Toggle Terminal", shortcut: "⌃`" },
  { id: "toggle-preview", label: "Toggle Preview", shortcut: "⌘J" },
  { id: "zen", label: "Toggle Zen Mode" },
  { id: "explorer", label: "Show Explorer", shortcut: "⌘⇧E" },
  { id: "scm", label: "Show Source Control" },
  { id: "outline", label: "Show Outline" },
  { id: "settings", label: "Open Settings", shortcut: "⌘," },
  { id: "ports", label: "Show Ports in Use" },
  { id: "run-preview", label: "Run Preview" },
  { id: "run-build", label: "Run Build" },
  { id: "restart", label: "Restart Dev Server" },
  { id: "new-file", label: "New File" },
  { id: "export-zip", label: "Export ZIP" },
  { id: "import", label: "Import Project…" },
  { id: "start-vite-react", label: "Start Vite + React + TS" },
  { id: "split-editor", label: "Split Editor" },
  { id: "help-terminal", label: "Focus Terminal & Show Help" }
];
