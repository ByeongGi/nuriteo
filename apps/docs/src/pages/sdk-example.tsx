import { useEffect, useRef, useState } from "react";

import { runSdkExample } from "../example/run-sdk-example.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { useDocsPreferences } from "../preferences.tsx";
import { CodeEditor } from "./code-editor.tsx";

const sample = `const note = "hello";
const container = createContainer(runtime);
const ready = await container.boot({ timeoutMs: 20_000 });
const run = await container.run("", { entrypoint: "fs-smoke", timeoutMs: 20_000 });
if (!run.ok) throw new Error(run.error || "런타임 실행이 실패했습니다.");
return {
  protocolVersion: ready.protocolVersion,
  status: container.status,
  file: "/workspace/result.txt",
  value: run.exports?.value,
  size: run.exports?.size,
  note
};`;

const isolatedLimit = {
  ko: "이 호스트는 Cross-Origin-Embedder-Policy: require-corp 와 Cross-Origin-Opener-Policy: same-origin 을 보내지 않습니다. 예시는 복사할 수 있습니다. 부팅은 실행하지 않으며, 성공한 것으로 표시하지 않습니다.",
  en: "This host does not send Cross-Origin-Embedder-Policy: require-corp and Cross-Origin-Opener-Policy: same-origin. The sample can be copied. Boot does not run, and this page does not report success."
};

export function SdkPlayground() {
  const { lang } = useDocsPreferences();
  const isolated = window.crossOriginIsolated;
  const [source, setSource] = useState(sample);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const chain = useRef(Promise.resolve());
  const timer = useRef(0);

  function execute(code: string) {
    const id = ++token.current;
    setPending(true);
    setError(null);
    chain.current = chain.current.then(async () => {
      if (id !== token.current) return;
      try {
        const value = await runSdkExample(code);
        if (id !== token.current) return;
        setResult(value);
      } catch (caught) {
        if (id !== token.current) return;
        setResult(undefined);
        setError(caught instanceof Error ? caught.message : "실행하지 못했습니다.");
      } finally {
        if (id === token.current) setPending(false);
      }
    });
  }

  function schedule(code: string, delay: number) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => execute(code), delay);
  }

  useEffect(() => {
    if (!window.crossOriginIsolated) return;
    schedule(source, 500);
    return () => window.clearTimeout(timer.current);
  }, [source]);

  const copy = playgroundCopy[lang];

  return (
    <Card className="mt-2 gap-0 overflow-hidden py-0 shadow-none" aria-label="SDK playground">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="text-sm">{copy.title}</CardTitle>
          <CardDescription className="mt-1 text-xs">{copy.note}</CardDescription>
        </div>
        <Button
          type="button"
          onClick={() => {
            if (!isolated) return;
            window.clearTimeout(timer.current);
            execute(source);
          }}
          disabled={pending || !isolated}
        >
          {pending ? copy.running : copy.run}
        </Button>
      </CardHeader>
      <div className="grid min-[801px]:grid-cols-2">
        <div className="border-b min-[801px]:border-r min-[801px]:border-b-0">
          <CodeEditor text={sample} label={copy.editorLabel} onChange={setSource} />
        </div>
        <Workspace copy={copy} error={error} isolated={isolated} isolatedNote={isolatedLimit[lang]} pending={pending} result={result} />
      </div>
    </Card>
  );
}

const playgroundCopy = {
  ko: {
    title: "이 브라우저의 런타임",
    note: "코드를 고치면 잠시 뒤 이 페이지가 그 함수를 다시 실행하고 오른쪽 워크스페이스를 갱신합니다. createContainer와 runtime이 주입됩니다.",
    run: "다시 실행",
    running: "갱신 중",
    editorLabel: "SDK 예시 코드",
    workspace: "워크스페이스",
    updating: "런타임을 갱신하는 중",
    idle: "런타임을 부팅하는 중",
    fileLabel: "런타임이 쓴 파일",
    returned: "페이지가 돌려준 값",
    emptyReturn: "반환값이 없습니다."
  },
  en: {
    title: "Runtime in this browser",
    note: "Editing the code runs that function again in this page and refreshes the workspace. createContainer and runtime are injected.",
    run: "Run again",
    running: "Updating",
    editorLabel: "SDK sample",
    workspace: "Workspace",
    updating: "Updating the runtime",
    idle: "Booting the runtime",
    fileLabel: "File written by the runtime",
    returned: "Value returned to the page",
    emptyReturn: "The sample returned nothing."
  }
} as const;

function Workspace({
  copy,
  error,
  isolated,
  isolatedNote,
  pending,
  result
}: {
  copy: (typeof playgroundCopy)[keyof typeof playgroundCopy];
  error: string | null;
  isolated: boolean;
  isolatedNote: string;
  pending: boolean;
  result: unknown;
}) {
  const record = isRecord(result) ? result : null;
  const file = typeof record?.file === "string" ? record.file : null;
  const value = typeof record?.value === "string" ? record.value : null;
  const size = typeof record?.size === "number" ? record.size : null;
  const status = typeof record?.status === "string" ? record.status : null;
  const note = typeof record?.note === "string" ? record.note : null;

  return (
    <div className="min-h-64 bg-subtle p-4" aria-live="polite">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="m-0 text-xs font-semibold text-muted-foreground">{copy.workspace}</p>
        <p className="m-0 text-xs text-muted-foreground">{pending ? copy.updating : status}</p>
      </div>
      {isolated ? null : <Alert className="mb-3"><AlertDescription>{isolatedNote}</AlertDescription></Alert>}
      {error ? <Alert className="mb-3" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {note !== null ? <p className="m-0 mb-3 text-sm">{note}</p> : null}
      {file && value !== null ? (
        <Card className="mb-4 gap-0 overflow-hidden py-0 shadow-none">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <p className="m-0 font-mono text-xs">{file}</p>
            {size !== null ? <p className="m-0 text-xs text-muted-foreground">{size} B</p> : null}
          </div>
          <Separator />
          <pre className="m-0 px-3 py-3 font-mono text-sm leading-relaxed"><code>{value}</code></pre>
          <Separator />
          <p className="m-0 px-3 py-2 text-xs text-muted-foreground">{copy.fileLabel}</p>
        </Card>
      ) : null}
      {result !== undefined ? (
        <>
          <p className="m-0 mb-2 text-xs font-semibold text-muted-foreground">{copy.returned}</p>
          <pre className="m-0 overflow-auto font-mono text-sm leading-relaxed text-foreground"><code>{JSON.stringify(result, null, 2)}</code></pre>
        </>
      ) : null}
      {isolated && !error && result === undefined ? <p className="m-0 text-sm text-muted-foreground">{copy.idle}</p> : null}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
