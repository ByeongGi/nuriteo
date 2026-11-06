import { useState } from "react";

import { runSdkExample, type SdkExampleResult } from "../example/run-sdk-example.ts";

const sample = `import { createContainer } from "@nuriteo/sdk";

const container = createContainer({
  systemWorkerUrl,
  processWorkerUrl,
  systemWasmUrl
});
const ready = await container.boot();
const run = await container.run("", { entrypoint: "fs-smoke" });
await container.teardown();`;

export function SdkExamplePage() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SdkExampleResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setPending(true);
    setError(null);
    try {
      setResult(await runSdkExample());
    } catch (caught) {
      setResult(null);
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
        이 페이지는 문서 안에 올라간 SDK로 시스템 워커와 프로세스 워커를 부팅합니다. 실행은 워크스페이스 파일에 hello를 쓰고 다시 읽습니다.
      </p>
      <pre className="code"><code>{sample}</code></pre>
      <p>
        <button className="action" type="button" onClick={onRun} disabled={pending}>
          {pending ? "실행 중" : "이 브라우저에서 실행"}
        </button>
      </p>
      {error ? <p className="result error" role="alert">{error}</p> : null}
      {result ? (
        <dl className="result">
          <div><dt>프로토콜</dt><dd>{result.protocolVersion}</dd></div>
          <div><dt>상태</dt><dd>{result.status}</dd></div>
          <div><dt>읽은 값</dt><dd>{String(result.value)}</dd></div>
          <div><dt>크기</dt><dd>{String(result.size)}</dd></div>
        </dl>
      ) : null}
    </main>
  );
}
