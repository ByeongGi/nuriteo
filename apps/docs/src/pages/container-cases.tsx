import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils.ts";
import { loadContainerCase } from "../example/cases/load-case.ts";
import { publishedExamplePath, scriptSrcFromHtml } from "../example/cases/load-patterns.ts";
import { loadActions, runLoadAction, type ContainerCaseMount, type LoadAction } from "../example/cases/mount-case.ts";
import { containerCaseKinds, type ContainerCase, type ContainerCaseKind } from "../example/cases/types.ts";
import { useDocsPreferences } from "../preferences.tsx";

const copy = {
  ko: {
    title: "불러온 파일을 컨테이너에서 다시 읽습니다",
    text: "케이스를 고르면 그 모듈만 import합니다. 각 행은 파일을 올리는 방식만 바꾸고, 한 번 부팅한 뒤 엔트리를 다시 읽습니다. 패키지 설치와 개발 서버는 실행하지 않습니다.",
    mounting: "올리는 중",
    idle: "아직 올리지 않았습니다.",
    isolated: "이 호스트는 Cross-Origin Isolation이 없습니다. 파일은 볼 수 있습니다. 부팅은 실행하지 않습니다.",
    failed: "마운트하지 못했습니다.",
    previewNone: "개발 서버 스크립트 없음",
    status: "부팅 직후 status",
    protocol: "프로토콜",
    entry: "다시 읽은 파일",
    written: "쓴 경로",
    listing: "/workspace 바로 아래",
    rejected: "거부된 경로",
    scriptSkipped: "이 케이스에는 module script src가 없어 이 단계는 실행하지 않습니다.",
    cases: {
      spa: { title: "SPA", detail: "index.html이 src/main.js를 불러옵니다." },
      next: { title: "Next.js", detail: "App Router의 app/page.tsx입니다. previewScript는 pnpm dev입니다." }
    },
    actions: {
      all: { title: "파일을 모두 올리고 엔트리를 읽습니다", detail: "케이스 전부를 맵에 넣고 부팅한 뒤 엔트리를 읽습니다." },
      each: { title: "파일을 하나씩 씁니다", detail: "writeFile을 경로마다 호출한 뒤 부팅합니다." },
      fetch: { title: "고른 파일을 주소에서 가져옵니다", detail: "이 사이트가 공개한 그 파일만 씁니다." },
      replace: { title: "엔트리만 바꿉니다", detail: "트리를 올린 뒤 엔트리에 replaced-entry를 씁니다." },
      script: { title: "HTML이 가리키는 스크립트만 올립니다", detail: "index.html과 그 module script만 씁니다." },
      prefix: { title: "한 디렉터리만 올립니다", detail: "SPA는 src/, Next는 app/ 아래만 씁니다." },
      missing: { title: "없는 경로를 읽습니다", detail: "missing.txt는 거부되고 엔트리 읽기는 성공합니다." }
    }
  },
  en: {
    title: "Read the loaded files back from the container",
    text: "Choosing a case imports only that module. Each row changes how the files are written, then boots once and reads the entry back. This page does not install packages or start the dev server.",
    mounting: "Mounting",
    idle: "Nothing is mounted yet.",
    isolated: "This host is not cross-origin isolated. You can read the files. Boot does not run.",
    failed: "The mount failed.",
    previewNone: "No dev-server script",
    status: "status just after boot",
    protocol: "protocol",
    entry: "File read back",
    written: "Written paths",
    listing: "Direct children of /workspace",
    rejected: "Rejected path",
    scriptSkipped: "This case has no module script src, so this step does not run.",
    cases: {
      spa: { title: "SPA", detail: "index.html loads src/main.js." },
      next: { title: "Next.js", detail: "App Router app/page.tsx. previewScript is pnpm dev." }
    },
    actions: {
      all: { title: "Mount every file and read the entry", detail: "Put the whole case in the map, boot, and read the entry." },
      each: { title: "Write one file at a time", detail: "Call writeFile for each path, then boot." },
      fetch: { title: "Fetch the selected file", detail: "Write only the file this site publishes at that path." },
      replace: { title: "Replace only the entry", detail: "Write the tree, then replace the entry with replaced-entry." },
      script: { title: "Load the script the HTML points at", detail: "Write index.html and the module script it names." },
      prefix: { title: "Load one directory", detail: "Write only src/ for the SPA, or app/ for Next." },
      missing: { title: "Read a path that was never written", detail: "missing.txt rejects. The entry read still succeeds." }
    }
  }
} as const;

type CaseCopy = (typeof copy)[keyof typeof copy];

export function ContainerCases() {
  const { lang } = useDocsPreferences();
  const text = copy[lang];
  const [kind, setKind] = useState<ContainerCaseKind>("spa");
  const [project, setProject] = useState<ContainerCase | null>(null);
  const [filePath, setFilePath] = useState<string>("src/main.js");
  const [chosen, setChosen] = useState<LoadAction | null>(null);
  const [pending, setPending] = useState(false);
  const [mount, setMount] = useState<ContainerCaseMount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const isolated = window.crossOriginIsolated;
  const indexHtml = project?.files.find((file) => file.path === "index.html")?.contents;
  const scriptPath = indexHtml ? scriptSrcFromHtml(indexHtml) : null;
  const selected = project?.files.find((file) => file.path === filePath) ?? null;

  useEffect(() => {
    let current = true;
    void loadContainerCase(kind).then((loaded) => {
      if (!current) return;
      setProject(loaded);
      setFilePath(loaded.entry);
    });
    return () => {
      current = false;
    };
  }, [kind]);

  function choose(nextKind: ContainerCaseKind) {
    if (nextKind === kind) return;
    token.current += 1;
    setKind(nextKind);
    setProject(null);
    setChosen(null);
    setMount(null);
    setError(null);
    setPending(false);
  }

  function actionDetail(action: LoadAction): string {
    const scriptSkipped = action === "script" && project !== null && scriptPath === null;
    if (scriptSkipped) return text.scriptSkipped;
    if (action === "fetch") return `${text.actions.fetch.detail} ${publishedExamplePath(kind, filePath)}`;
    return text.actions[action].detail;
  }

  function actionDisabled(action: LoadAction): boolean {
    if (!isolated || pending || project === null) return true;
    return action === "script" && scriptPath === null;
  }

  async function run(action: LoadAction) {
    const id = token.current + 1;
    token.current = id;
    setChosen(action);
    setPending(true);
    setError(null);
    setMount(null);
    try {
      const result = await runLoadAction({ kind, action, filePath });
      if (id !== token.current) return;
      setMount(result);
    } catch (caught) {
      if (id !== token.current) return;
      setError(caught instanceof Error ? caught.message : text.failed);
    } finally {
      if (id === token.current) setPending(false);
    }
  }

  return (
    <figure className="mb-8 overflow-hidden rounded-lg border border-border bg-surface">
      <figcaption className="border-b border-border px-4 py-4">
        <p className="m-0 font-medium text-foreground">{text.title}</p>
        <p className="mt-2 mb-0 text-sm text-pretty text-muted-foreground">{text.text}</p>
      </figcaption>
      <ul className="m-0 list-none border-b border-border p-0">
        {containerCaseKinds.map((caseKind) => {
          const item = text.cases[caseKind];
          const active = caseKind === kind;
          return (
            <li key={caseKind} className="border-b border-border last:border-b-0">
              <button
                className={cn("block w-full px-4 py-3 text-left", active ? "bg-selected" : "hover:bg-hover")}
                type="button"
                aria-pressed={active}
                onClick={() => choose(caseKind)}
              >
                <span className="font-medium text-foreground">{item.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{item.detail}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {project ? (
        <div className="grid docs-sidebar:grid-cols-[16rem_minmax(0,1fr)]">
          <ul className="m-0 list-none border-b border-border p-0 docs-sidebar:border-r docs-sidebar:border-b-0">
            {project.files.map((file) => {
              const active = file.path === filePath;
              return (
                <li key={file.path}>
                  <button
                    className={cn("block w-full px-4 py-2 text-left font-mono text-sm", active ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground")}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilePath(file.path)}
                  >
                    {file.path}
                  </button>
                </li>
              );
            })}
          </ul>
          <pre className="m-0 overflow-auto px-4 py-3 font-mono text-sm leading-relaxed"><code>{selected?.contents}</code></pre>
        </div>
      ) : null}
      <ul className="m-0 list-none border-t border-border p-0">
        {loadActions.map((action) => {
          const item = text.actions[action];
          const active = action === chosen;
          const disabled = actionDisabled(action);
          return (
            <li key={action} className="border-b border-border last:border-b-0">
              <button
                className={cn("block w-full px-4 py-3 text-left disabled:cursor-not-allowed", actionRowClass(active, disabled))}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => void run(action)}
              >
                <span className={cn("font-medium", disabled ? "text-muted-foreground" : "text-foreground")}>{item.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{actionDetail(action)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="px-4 pb-4">
        <MountResult text={text} error={error} isolated={isolated} mount={mount} pending={pending} />
      </div>
    </figure>
  );
}

function actionRowClass(active: boolean, disabled: boolean): string {
  if (active) return "bg-selected";
  if (disabled) return "";
  return "hover:bg-hover";
}

function MountResult({
  text,
  error,
  isolated,
  mount,
  pending
}: {
  text: CaseCopy;
  error: string | null;
  isolated: boolean;
  mount: ContainerCaseMount | null;
  pending: boolean;
}) {
  if (!isolated) return <p className="mt-3 mb-0 text-sm text-muted-foreground">{text.isolated}</p>;
  if (error) return <p className="mt-3 mb-0 text-sm text-foreground">{error}</p>;
  if (pending) return <p className="mt-3 mb-0 text-sm text-muted-foreground">{text.mounting}</p>;
  if (!mount) return <p className="mt-3 mb-0 text-sm text-muted-foreground">{text.idle}</p>;
  const preview = mount.previewScript ?? text.previewNone;
  const children = mount.listing.map((item) => `${item.type} ${item.path}`);
  return (
    <div className="mt-4 border-t border-muted-border pt-3 text-sm">
      <p className="m-0 font-medium text-foreground">{text.actions[mount.action].title}</p>
      <p className="mt-2 mb-0 text-foreground">{text.status}: {mount.status}. {text.protocol} {mount.protocolVersion}. {preview}</p>
      <PathList label={text.written} paths={mount.written} />
      <PathList label={text.listing} paths={children} />
      {mount.rejectedPath ? <p className="mt-3 mb-0 text-foreground">{text.rejected}: {mount.rejectedPath}</p> : null}
      <p className="mt-3 mb-1 font-mono text-xs text-muted-foreground">{text.entry} {mount.entryPath}</p>
      <pre className="m-0 overflow-auto font-mono text-sm leading-relaxed"><code>{mount.entry}</code></pre>
    </div>
  );
}

function PathList({ label, paths }: { label: string; paths: readonly string[] }) {
  return (
    <div className="mt-3">
      <p className="m-0 text-muted-foreground">{label}</p>
      <ul className="m-0 mt-1 list-none p-0 font-mono text-xs text-foreground">
        {paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </div>
  );
}
