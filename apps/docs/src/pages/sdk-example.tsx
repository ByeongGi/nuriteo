import { useState } from "react";

import { runSdkExample } from "../example/run-sdk-example.ts";
import { useDocsPreferences } from "../preferences.tsx";

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

  return (
    <section className="playground" aria-label="SDK playground">
      <textarea
        className="code editor"
        spellCheck={false}
        value={source}
        aria-label="SDK 예시 코드"
        onChange={(event) => setSource(event.target.value)}
      />
      {isolated ? null : <p className="result" role="note">{isolatedLimit[lang]}</p>}
      <p>
        <button className="action" type="button" onClick={onRun} disabled={pending || !isolated}>
          {pending ? "실행 중" : "이 브라우저에서 실행"}
        </button>
      </p>
      {error ? <p className="result error" role="alert">{error}</p> : null}
      {finished && result === undefined ? <p className="result">반환값이 없습니다.</p> : null}
      {result !== undefined ? (
        <pre className="result code"><code>{JSON.stringify(result, null, 2)}</code></pre>
      ) : null}
    </section>
  );
}
