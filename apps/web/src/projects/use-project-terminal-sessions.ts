"use client";

import { useRef, useState } from "react";

const MAX_TERMINAL_OUTPUT_CHARS = 64 * 1024;

export interface ProjectTerminalSession {
  readonly id: number;
  readonly name: string;
  readonly output: string;
  readonly wasTruncated: boolean;
}

const FIRST_SESSION: ProjectTerminalSession = {
  id: 1,
  name: "Terminal 1",
  output: "",
  wasTruncated: false
};

export function useProjectTerminalSessions() {
  const nextSessionIdRef = useRef(2);
  const [sessions, setSessions] = useState<readonly ProjectTerminalSession[]>([FIRST_SESSION]);
  const [activeSessionId, setActiveSessionId] = useState(FIRST_SESSION.id);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? FIRST_SESSION;

  function append(sessionId: number, value: string): void {
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) return session;
      const combined = `${session.output}${value}`;
      return {
        ...session,
        output: combined.slice(-MAX_TERMINAL_OUTPUT_CHARS),
        wasTruncated: session.wasTruncated || combined.length > MAX_TERMINAL_OUTPUT_CHARS
      };
    }));
  }

  function clear(sessionId = activeSessionId): void {
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, output: "", wasTruncated: false }
      : session));
  }

  function create(): number {
    const id = nextSessionIdRef.current;
    nextSessionIdRef.current += 1;
    setSessions((current) => [...current, { id, name: `Terminal ${id}`, output: "", wasTruncated: false }]);
    setActiveSessionId(id);
    return id;
  }

  function reset(): void {
    nextSessionIdRef.current = 2;
    setSessions([FIRST_SESSION]);
    setActiveSessionId(FIRST_SESSION.id);
  }

  return { activeSession, activeSessionId, append, clear, create, reset, sessions, setActiveSessionId };
}
