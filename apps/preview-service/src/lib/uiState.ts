export type SidebarView = "explorer" | "search" | "ports" | "scm" | "outline" | "timeline" | "settings";

export interface PreviewPortEntry {
  id: string;
  port: number;
  label: string;
  path: string;
  url: string | null;
}

export interface TerminalSessionTab {
  id: string;
  title: string;
}
