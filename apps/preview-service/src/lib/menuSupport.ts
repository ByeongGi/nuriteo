export const MENU_SUPPORT_SCOPE = {
  File: ["create file", "save active file", "import project", "export ZIP"],
  Edit: ["Monaco native undo/redo/cut/copy/paste", "format", "definition navigation", "file/search palette"],
  View: ["sidebar views", "panel visibility", "split editor", "Zen mode"]
} as const;

export const MENU_EXCLUDED_SCOPE = [
  "native filesystem open/save dialogs",
  "multi-root workspace management",
  "VS Code extension-contributed commands",
  "window and process menus"
] as const;
