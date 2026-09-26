import { useEffect, useRef } from "react";
import type { CommandId } from "../lib/commands";

interface PreviewKeyboardShortcutOptions {
  formatCurrentFile(): Promise<void>;
  goToDefinition(): void;
  openCommandPalette(): void;
  openFilePalette(): void;
  runCommand(id: CommandId): void;
  saveCurrentFile(): void;
}

export function usePreviewKeyboardShortcuts(
  options: PreviewKeyboardShortcutOptions
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const callbacks = optionsRef.current;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (meta && key === "s") {
        event.preventDefault();
        callbacks.saveCurrentFile();
        return;
      }
      if (meta && key === "p") {
        event.preventDefault();
        callbacks.openFilePalette();
        return;
      }
      if (meta && key === "b") {
        event.preventDefault();
        callbacks.runCommand("toggle-sidebar");
        return;
      }
      if (meta && key === "j") {
        event.preventDefault();
        callbacks.runCommand("toggle-preview");
        return;
      }
      if (meta && event.shiftKey && key === "f") {
        event.preventDefault();
        callbacks.runCommand("search");
        return;
      }
      if (meta && event.shiftKey && key === "e") {
        event.preventDefault();
        callbacks.runCommand("explorer");
        return;
      }
      if (meta && key === ",") {
        event.preventDefault();
        callbacks.runCommand("settings");
        return;
      }
      if (meta && event.shiftKey === false && event.altKey && key === "f") {
        event.preventDefault();
        void callbacks.formatCurrentFile();
        return;
      }
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        callbacks.runCommand("toggle-terminal");
        return;
      }
      if (event.key === "F1") {
        event.preventDefault();
        callbacks.openCommandPalette();
      }
      if (event.key === "F12") {
        event.preventDefault();
        callbacks.goToDefinition();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
