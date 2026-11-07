import { useState } from "react";

import { runSdkExample } from "../example/run-sdk-example.ts";
import { useDocsPreferences } from "../preferences.tsx";
import { CodeEditor } from "./code-editor.tsx";

const sample = `const container = createContainer(runtime);
const ready = await container.boot({ timeoutMs: 20_000 });
const run = await container.run("", { entrypoint: "fs-smoke", timeoutMs: 20_000 });
if (!run.ok) throw new Error(run.error || "런타임 실행이 실패했습니다.");
return {
  protocolVersion: ready.protocolVersion,
  status: container.status,
  value: run.exports?.value,
  size: run.exports?.size
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
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    if (!window.crossOriginIsolated) return;
    setPending(true);
    setError(null);
    setFinished(false);
    setResult(undefined);
    try {
      setResult(await runSdkExample(source));
      setFinished(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "실행하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  const copy = playgroundCopy[lang];

  return (
    <section className="mt-2 overflow-hidden rounded-lg border border-border bg-surface" aria-label="SDK playground">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="m-0 text-sm font-semibold">{copy.title}</p>
          <p className="m-0 mt-1 text-xs text-muted-foreground">{copy.note}</p>
        </div>
        <button
          className="rounded-lg bg-primary px-3 py-2 text-sm text-on-primary disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={onRun}
          disabled={pending || !isolated}
        >
          {pending ? copy.running : copy.run}
        </button>
      </div>
      <div className="grid min-[801px]:grid-cols-2">
        <div className="border-b border-border min-[801px]:border-r min-[801px]:border-b-0">
          <CodeEditor text={sample} label={copy.editorLabel} onChange={setSource} />
        </div>
        <div className="min-h-64 bg-subtle p-4">
          <p className="m-0 mb-3 text-xs font-semibold text-muted-foreground">{copy.resultLabel}</p>
          {isolated ? null : <p className="m-0 text-sm" role="note">{isolatedLimit[lang]}</p>}
          {error ? <p className="m-0 text-sm text-danger" role="alert">{error}</p> : null}
          {finished && result === undefined ? <p className="m-0 text-sm">{copy.emptyReturn}</p> : null}
          {result !== undefined ? (
            <pre className="m-0 overflow-auto font-mono text-sm leading-relaxed text-foreground"><code>{JSON.stringify(result, null, 2)}</code></pre>
          ) : null}
          {isolated && !pending && !error && result === undefined && !finished ? <p className="m-0 text-sm text-muted-foreground">{copy.idle}</p> : null}
        </div>
      </div>
    </section>
  );
}

const playgroundCopy = {
  ko: {
    title: "이 브라우저에서 실행",
    note: "왼쪽 코드를 고치면 실행 버튼이 그 함수를 이 페이지에서 돌립니다. createContainer와 runtime이 주입됩니다.",
    run: "실행",
    running: "실행 중",
    editorLabel: "SDK 예시 코드",
    resultLabel: "실행 결과",
    idle: "아직 실행하지 않았습니다.",
    emptyReturn: "반환값이 없습니다."
  },
  en: {
    title: "Run in this browser",
    note: "Edit the code on the left. Run evaluates that function in this page, with createContainer and runtime injected.",
    run: "Run",
    running: "Running",
    editorLabel: "SDK sample",
    resultLabel: "Result",
    idle: "Not run yet.",
    emptyReturn: "The sample returned nothing."
  }
} as const;
