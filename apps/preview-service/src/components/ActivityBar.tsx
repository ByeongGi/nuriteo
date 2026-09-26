import clsx from "clsx";
import { Files, Search, Cable, Settings2, GitBranch, ListTree, History, Bug } from "lucide-react";
import type { SidebarView } from "../lib/uiState";

const ITEMS: Array<{ id: SidebarView; label: string; icon: typeof Files }> = [
  { id: "explorer", label: "Explorer", icon: Files },
  { id: "search", label: "Search", icon: Search },
  { id: "scm", label: "Source Control", icon: GitBranch },
  { id: "outline", label: "Outline", icon: ListTree },
  { id: "timeline", label: "Timeline", icon: History },
  { id: "ports", label: "Ports", icon: Cable },
  { id: "developer-tools", label: "Run and Extensions", icon: Bug },
  { id: "settings", label: "Settings", icon: Settings2 }
];

export function ActivityBar({
  active,
  onSelect
}: {
  active: SidebarView;
  onSelect: (view: SidebarView) => void;
}) {
  return (
    <nav
      id="activity-bar"
      aria-label="Activity bar"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-cargo-line bg-cargo-elevated/80 py-2"
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const selected = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-pressed={selected}
            data-view={item.id}
            className={clsx(
              "flex size-9 items-center justify-center rounded-md border",
              selected
                ? "border-cargo-accent/50 bg-cargo-accent/15 text-cargo-accent-strong"
                : "border-transparent text-cargo-muted hover:bg-cargo-panel-2 hover:text-cargo-ink"
            )}
            onClick={() => onSelect(item.id)}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </nav>
  );
}
