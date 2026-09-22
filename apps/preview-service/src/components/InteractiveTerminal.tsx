import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

const PROMPT = "$ ";

export function InteractiveTerminal({
  model,
  terminalId = "default"
}: {
  model: PreviewControllerModel;
  terminalId?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lineRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const busyRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "var(--mono)",
      fontSize: 12,
      theme: {
        background: "#0f141c",
        foreground: "#d7dee8",
        cursor: "#e09a45",
        selectionBackground: "#3a4658"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    fit.fit();
    term.writeln(`Cargo terminal (${terminalId}) — type \x1b[33mhelp\x1b[0m, then \x1b[33mpnpm install\x1b[0m / \x1b[33mpnpm run dev\x1b[0m`);
    term.write(PROMPT);

    termRef.current = term;
    fitRef.current = fit;

    const onData = (data: string) => {
      if (busyRef.current) {
        if (data === "\u0003") {
          modelRef.current.controller.cancelShellCommand();
          term.write("^C\r\n");
          busyRef.current = false;
          lineRef.current = "";
          term.write(PROMPT);
        }
        return;
      }

      if (data === "\x1b[A") {
        recallHistory(term, -1);
        return;
      }
      if (data === "\x1b[B") {
        recallHistory(term, 1);
        return;
      }
      if (data.startsWith("\x1b")) return;

      for (const char of data) {
        if (char === "\r") {
          void submitLine(term);
          continue;
        }
        if (char === "\u007f") {
          if (lineRef.current.length === 0) continue;
          lineRef.current = lineRef.current.slice(0, -1);
          term.write("\b \b");
          continue;
        }
        if (char === "\u0003") {
          term.write("^C\r\n");
          lineRef.current = "";
          term.write(PROMPT);
          continue;
        }
        if (char < " " && char !== "\t") continue;
        lineRef.current += char;
        term.write(char);
      }
    };

    term.onData(onData);

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    observer.observe(hostRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  useEffect(() => {
    if (!model.terminalFocusRequest) return;
    const timer = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        termRef.current?.focus();
      } catch {
        /* ignore */
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [model.terminalFocusRequest]);

  function recallHistory(term: Terminal, direction: -1 | 1): void {
    const history = historyRef.current;
    if (history.length === 0) return;
    let next = historyIndexRef.current + direction;
    if (next < -1) next = -1;
    if (next >= history.length) next = history.length - 1;
    historyIndexRef.current = next;
    const value = next < 0 ? "" : history[history.length - 1 - next] || "";
    term.write(`\r\x1b[K${PROMPT}`);
    lineRef.current = value;
    term.write(value);
  }

  async function submitLine(term: Terminal): Promise<void> {
    const command = lineRef.current;
    term.write("\r\n");
    lineRef.current = "";
    historyIndexRef.current = -1;
    if (!command.trim()) {
      term.write(PROMPT);
      return;
    }
    historyRef.current.push(command);
    if (historyRef.current.length > 100) historyRef.current.shift();

    if (command.trim() === "clear") {
      term.clear();
      term.write(PROMPT);
      return;
    }

    busyRef.current = true;
    try {
      const result = await modelRef.current.controller.runShellCommand(command);
      if (result.stdout) term.write(result.stdout.replace(/\n/g, "\r\n"));
      if (result.stderr) term.write(`\x1b[31m${result.stderr.replace(/\n/g, "\r\n")}\x1b[0m`);
      if (result.exitCode !== 0) {
        term.writeln(`\x1b[90mexit ${result.exitCode}\x1b[0m`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      term.writeln(`\x1b[31m${message}\x1b[0m`);
    } finally {
      busyRef.current = false;
      term.write(PROMPT);
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div
      id="terminal-xterm"
      ref={hostRef}
      className="h-full min-h-0 w-full overflow-hidden bg-[#0f141c] px-2 py-1"
      aria-label="Interactive terminal"
    />
  );
}
