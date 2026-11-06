import { useState } from "react";

import { runSdkExample } from "../example/run-sdk-example.ts";

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

export function SdkExamplePage() {
  const [source, setSource] = useState(sample);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<unknown>(undefined);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
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
    <main className="page">
      <p className="eyebrow">@nuriteo/sdk</p>
      <h1>브라우저에서 런타임 실행</h1>
      <p className="lead">
        아래 코드를 고친 뒤 실행하면, 그 내용이 이 브라우저에서 `@nuriteo/sdk`를 호출합니다. `createContainer`와 `runtime`은 이미 들어와 있습니다. 런타임 안에서는 임의 JavaScript 평가가 막혀 있어서, 컨테이너 안에서 도는 프로그램은 `fs-smoke`처럼 런타임이 제공하는 입구를 사용합니다.
      </p>
      <textarea
        className="code editor"
        spellCheck={false}
        value={source}
        aria-label="SDK 예시 코드"
        onChange={(event) => setSource(event.target.value)}
      />
      <p>
        <button className="action" type="button" onClick={onRun} disabled={pending}>
          {pending ? "실행 중" : "이 브라우저에서 실행"}
        </button>
      </p>
      {error ? <p className="result error" role="alert">{error}</p> : null}
      {finished && result === undefined ? <p className="result">반환값이 없습니다.</p> : null}
      {result !== undefined ? (
        <pre className="result code"><code>{JSON.stringify(result, null, 2)}</code></pre>
      ) : null}
    </main>
  );
}
