import { Menu } from "@base-ui/react/menu";
import { Menubar } from "@base-ui/react/menubar";
import type { Dispatch, SetStateAction } from "react";
import { IDE_COMMANDS, type CommandId } from "../lib/commands";

interface AppMenuCommandItem {
  kind: "command";
  id: CommandId;
  label?: string;
  requiresFile?: boolean;
  requiresProject?: boolean;
}

interface AppMenuPaletteItem {
  kind: "command-palette";
  label: string;
  shortcut: string;
}

interface AppMenuSeparatorItem {
  kind: "separator";
}

type AppMenuItem = AppMenuCommandItem | AppMenuPaletteItem | AppMenuSeparatorItem;

interface AppMenuDefinition {
  label: string;
  items: AppMenuItem[];
}

const COMMANDS_BY_ID = new Map(IDE_COMMANDS.map((command) => [command.id, command]));

const APP_MENUS: AppMenuDefinition[] = [
  {
    label: "File",
    items: [
      { kind: "command", id: "new-file", requiresProject: true },
      { kind: "command", id: "save", requiresFile: true },
      { kind: "separator" },
      { kind: "command", id: "import" },
      { kind: "command", id: "export-zip", requiresProject: true }
    ]
  },
  {
    label: "Edit",
    items: [
      { kind: "command", id: "format", requiresFile: true },
      { kind: "command", id: "go-to-definition", requiresFile: true },
      { kind: "separator" },
      { kind: "command-palette", label: "Command Palette…", shortcut: "F1" },
      { kind: "command", id: "go-to-file", requiresProject: true },
      { kind: "command", id: "search", requiresProject: true }
    ]
  },
  {
    label: "View",
    items: [
      { kind: "command", id: "explorer" },
      { kind: "command", id: "scm" },
      { kind: "command", id: "outline" },
      { kind: "command", id: "ports" },
      { kind: "separator" },
      { kind: "command", id: "toggle-sidebar" },
      { kind: "command", id: "toggle-terminal" },
      { kind: "command", id: "toggle-preview" },
      { kind: "separator" },
      { kind: "command", id: "split-editor", requiresFile: true },
      { kind: "command", id: "zen" }
    ]
  }
];

interface AppMenuBarProps {
  hasProject: boolean;
  hasSelectedFile: boolean;
  runCommand: (id: CommandId) => void;
  setPaletteMode: Dispatch<SetStateAction<"commands" | "files">>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
}

export function AppMenuBar({
  hasProject,
  hasSelectedFile,
  runCommand,
  setPaletteMode,
  setPaletteOpen
}: AppMenuBarProps) {
  return (
    <Menubar className="flex items-center" aria-label="Application menu">
      {APP_MENUS.map((menu) => (
        <AppMenu
          key={menu.label}
          definition={menu}
          hasProject={hasProject}
          hasSelectedFile={hasSelectedFile}
          runCommand={runCommand}
          setPaletteMode={setPaletteMode}
          setPaletteOpen={setPaletteOpen}
        />
      ))}
    </Menubar>
  );
}

function AppMenu({
  definition,
  hasProject,
  hasSelectedFile,
  runCommand,
  setPaletteMode,
  setPaletteOpen
}: {
  definition: AppMenuDefinition;
} & AppMenuBarProps) {
  return (
    <Menu.Root>
      <Menu.Trigger className="rounded px-2 py-1 text-xs text-nuriteo-muted outline-none hover:bg-nuriteo-panel-2 hover:text-nuriteo-ink focus-visible:ring-2 focus-visible:ring-nuriteo-focus data-[popup-open]:bg-nuriteo-panel-2 data-[popup-open]:text-nuriteo-ink">
        {definition.label}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-[90] outline-none">
          <Menu.Popup className="min-w-56 rounded-lg border border-nuriteo-line bg-nuriteo-panel py-1 shadow-[var(--shadow)] outline-none">
            {definition.items.map((item, index) => {
              if (item.kind === "separator") {
                return <Menu.Separator key={`separator-${index}`} className="my-1 h-px bg-nuriteo-line" />;
              }
              if (item.kind === "command-palette") {
                return (
                  <Menu.Item
                    key={item.kind}
                    className="flex cursor-default items-center justify-between gap-5 px-3 py-1.5 text-xs text-nuriteo-ink outline-none data-[highlighted]:bg-nuriteo-panel-2"
                    onClick={() => {
                      setPaletteMode("commands");
                      setPaletteOpen(true);
                    }}
                  >
                    <span>{item.label}</span>
                    <kbd className="font-mono text-[10px] text-nuriteo-muted">{item.shortcut}</kbd>
                  </Menu.Item>
                );
              }
              const command = COMMANDS_BY_ID.get(item.id);
              const isDisabled = (item.requiresFile && !hasSelectedFile)
                || (item.requiresProject && !hasProject);
              return (
                <Menu.Item
                  key={item.id}
                  disabled={isDisabled}
                  className="flex cursor-default items-center justify-between gap-5 px-3 py-1.5 text-xs text-nuriteo-ink outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-nuriteo-panel-2"
                  onClick={() => runCommand(item.id)}
                >
                  <span>{item.label || command?.label || item.id}</span>
                  {command?.shortcut ? (
                    <kbd className="font-mono text-[10px] text-nuriteo-muted">{command.shortcut}</kbd>
                  ) : null}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
