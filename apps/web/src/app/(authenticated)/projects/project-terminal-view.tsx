"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

interface Props {
  readonly output: string;
  readonly onClear: () => void;
  readonly onInput: (data: string) => void;
  readonly onInterrupt: () => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onRun: (command: string) => Promise<void>;
  readonly sessionName: string;
}

const PROMPT = "\x1b[1;32m❯\x1b[0m ";

export function ProjectTerminalView(props: Props) {
  const { output } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const propsRef = useRef(props);
  const outputRef = useRef(props.output);
  const renderedOutputLengthRef = useRef(0);
  const commandRef = useRef("");
  const historyRef = useRef<readonly string[]>([]);
  const historyIndexRef = useRef(0);
  const runningRef = useRef(false);
  propsRef.current = props;
  outputRef.current = props.output;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const studioColor = (name: string) => getComputedStyle(document.documentElement)
      .getPropertyValue(`--n-color-studio-${name}`)
      .trim();
    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5_000,
      theme: {
        background: studioColor("editor"),
        black: studioColor("editor"),
        brightBlack: studioColor("fg-subtle"),
        brightGreen: studioColor("success"),
        cursor: studioColor("fg"),
        cursorAccent: studioColor("editor"),
        foreground: studioColor("fg"),
        green: studioColor("success"),
        selectionBackground: studioColor("selected")
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;

    const initialOutput = outputRef.current;
    if (initialOutput) terminal.write(initialOutput);
    renderedOutputLengthRef.current = initialOutput.length;
    terminal.write(PROMPT);
    terminal.focus();

    const dataSubscription = terminal.onData((data) => {
      if (runningRef.current) {
        if (data === "\u0003") propsRef.current.onInterrupt();
        else propsRef.current.onInput(data);
        return;
      }
      handleShellInput(terminal, data, {
        clear() {
          propsRef.current.onClear();
          terminal.clear();
          commandRef.current = "";
          terminal.write(PROMPT);
        },
        history: historyRef,
        historyIndex: historyIndexRef,
        command: commandRef,
        run: executeCommand
      });
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => propsRef.current.onResize(cols, rows));
    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(host);
    fitAddon.fit();

    async function executeCommand(command: string) {
      const nextHistory = [...historyRef.current.filter((item) => item !== command), command];
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length;
      commandRef.current = "";
      runningRef.current = true;
      renderedOutputLengthRef.current += `❯ ${command}\n`.length;
      try {
        await propsRef.current.onRun(command);
      } finally {
        runningRef.current = false;
        terminal.write("\r\n");
        terminal.write(PROMPT);
        terminal.focus();
      }
    }

    return () => {
      resizeObserver.disconnect();
      resizeSubscription.dispose();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const renderedLength = renderedOutputLengthRef.current;
    if (output.length < renderedLength) {
      terminal.reset();
      terminal.write(output);
      if (!runningRef.current) terminal.write(PROMPT);
      renderedOutputLengthRef.current = output.length;
      return;
    }
    const nextOutput = output.slice(renderedLength);
    if (nextOutput) terminal.write(nextOutput);
    renderedOutputLengthRef.current = output.length;
  }, [output]);

  return <div ref={hostRef} className="min-h-0 overflow-hidden bg-[var(--n-color-studio-editor)] px-2 py-2" role="application" aria-label={`${props.sessionName} 콘솔`} />;
}

interface ShellInputState {
  readonly clear: () => void;
  readonly command: { current: string };
  readonly history: { current: readonly string[] };
  readonly historyIndex: { current: number };
  readonly run: (command: string) => void;
}

function handleShellInput(terminal: Terminal, data: string, state: ShellInputState): void {
  if (data === "\r") {
    const command = state.command.current.trim();
    terminal.write("\r\n");
    state.command.current = "";
    if (command) state.run(command);
    else terminal.write(PROMPT);
    return;
  }
  if (data === "\u007f") {
    if (!state.command.current) return;
    state.command.current = state.command.current.slice(0, -1);
    terminal.write("\b \b");
    return;
  }
  if (data === "\u0003") {
    terminal.write("^C\r\n");
    state.command.current = "";
    terminal.write(PROMPT);
    return;
  }
  if (data === "\u000c") {
    state.clear();
    return;
  }
  if (data === "\u001b[A" || data === "\u001b[B") {
    const nextIndex = data === "\u001b[A"
      ? Math.max(0, state.historyIndex.current - 1)
      : Math.min(state.history.current.length, state.historyIndex.current + 1);
    state.historyIndex.current = nextIndex;
    replaceCommand(terminal, state.command, state.history.current[nextIndex] ?? "");
    return;
  }
  if (data.startsWith("\u001b")) return;
  state.command.current += data;
  terminal.write(data);
}

function replaceCommand(terminal: Terminal, command: { current: string }, nextCommand: string): void {
  if (command.current) terminal.write("\b \b".repeat(command.current.length));
  command.current = nextCommand;
  terminal.write(nextCommand);
}
