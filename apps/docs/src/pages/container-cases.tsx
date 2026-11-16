import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils.ts";
import { loadContainerCase } from "../example/cases/load-case.ts";
import { publishedExamplePath, scriptSrcFromHtml, spaPreviewDocument } from "../example/cases/load-patterns.ts";
import { loadActions, mountEditorDraft, runLoadAction, type CaseAction, type ContainerCaseMount, type LoadAction } from "../example/cases/mount-case.ts";
import { containerCaseKinds, type ContainerCase, type ContainerCaseKind } from "../example/cases/types.ts";
import { useDocsPreferences } from "../preferences.tsx";
import { CodeEditor } from "./code-editor.tsx";

const PREVIEW_INPUT_MS = 200;

type SpaPreview =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "unavailable" };

const copy = {
  ko: {
    title: "에디터를 컨테이너 파일에 붙입니다",
    text: "SPA의 src/main.js 위쪽 greeting, place, action을 고치면 아래 화면이 바뀝니다. 이름을 입력하고 버튼을 누르면 그 인사가 명단에 남습니다. 적용은 그 내용을 컨테이너에 쓰고 다시 읽습니다. 런타임은 이 스크립트를 평가하지 않고, Next 개발 서버도 켜지지 않습니다.",
    mounting: "올리는 중",
    applying: "적용하는 중",
    apply: "에디터 내용을 컨테이너에 쓰고 다시 읽습니다",
    browserPreview: "브라우저가 실행한 SPA",
    previewHint: "이름을 입력하고 남기기를 누릅니다.",
    previewLoading: "화면을 준비하고 있습니다.",
    previewUnavailable: "index.html에서 module script를 찾지 못했습니다.",
    nextSourceOnly: "이 파일은 에디터에서 고칩니다. 적용하면 컨테이너가 소스를 다시 읽습니다. 이 페이지는 Next를 렌더하지 않습니다.",
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
      missing: { title: "없는 경로를 읽습니다", detail: "missing.txt는 거부되고 엔트리 읽기는 성공합니다." },
      editor: { title: "에디터 내용을 컨테이너에 적용했습니다", detail: "에디터에 있던 파일을 쓰고 다시 읽었습니다." }
    }
  },
  en: {
    title: "Attach an editor to the container files",
    text: "Change greeting, place, and action at the top of the SPA src/main.js and the screen below updates. Type a name and press the button to keep that greeting on the list. Apply writes that buffer into the container and reads it back. The runtime does not evaluate the script, and the Next dev server does not start.",
    mounting: "Mounting",
    applying: "Applying",
    apply: "Write the editor into the container and read it back",
    idle: "Nothing is mounted yet.",
    isolated: "This host is not cross-origin isolated. You can read the files. Boot does not run.",
    failed: "The mount failed.",
    browserPreview: "SPA run by the browser",
    previewHint: "Type a name, then press the button to keep it.",
    previewLoading: "Preparing the screen.",
    previewUnavailable: "No module script was found in index.html.",
    nextSourceOnly: "Edit this file in the editor. Apply makes the container read the source back. This page does not render Next.",
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
      missing: { title: "Read a path that was never written", detail: "missing.txt rejects. The entry read still succeeds." },
      editor: { title: "Applied the editor to the container", detail: "Wrote the editor files and read them back." }
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
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const draftsRef = useRef<Readonly<Record<string, string>>>({});
  const [chosen, setChosen] = useState<CaseAction | null>(null);
  const [pending, setPending] = useState(false);
  const [mount, setMount] = useState<ContainerCaseMount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const isolated = window.crossOriginIsolated;
  const indexHtml = project?.files.find((file) => file.path === "index.html")?.contents;
  const scriptPath = indexHtml ? scriptSrcFromHtml(indexHtml) : null;
  const draft = drafts[filePath] ?? "";
  const draftHtml = drafts["index.html"];
  const draftScript = drafts["src/main.js"];
  const [preview, setPreview] = useState<SpaPreview>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void loadContainerCase(kind).then((loaded) => {
      if (!current) return;
      const nextDrafts = Object.fromEntries(loaded.files.map((file) => [file.path, file.contents]));
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setProject(loaded);
      setFilePath(loaded.entry);
    });
    return () => {
      current = false;
    };
  }, [kind]);

  useEffect(() => {
    if (kind !== "spa" || draftHtml === undefined || draftScript === undefined) {
      setPreview({ kind: "loading" });
      return;
    }
    const timer = window.setTimeout(() => {
      const doc = spaPreviewDocument(draftHtml, draftScript);
      setPreview(doc === null ? { kind: "unavailable" } : { kind: "ready", doc });
    }, PREVIEW_INPUT_MS);
    return () => window.clearTimeout(timer);
  }, [kind, draftHtml, draftScript]);

  function choose(nextKind: ContainerCaseKind) {
    if (nextKind === kind) return;
    token.current += 1;
    setKind(nextKind);
    setProject(null);
    draftsRef.current = {};
    setDrafts({});
    setChosen(null);
    setMount(null);
    setError(null);
    setPending(false);
    setPreview({ kind: "loading" });
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

  function onEdit(value: string) {
    const next = { ...draftsRef.current, [filePath]: value };
    draftsRef.current = next;
    setDrafts(next);
  }

  async function applyEditor() {
    if (!project) return;
    const id = token.current + 1;
    token.current = id;
    setChosen("editor");
    setPending(true);
    setError(null);
    setMount(null);
    const files = project.files.map((file) => ({
      path: file.path,
      contents: draftsRef.current[file.path] ?? file.contents
    }));
    try {
      const result = await mountEditorDraft({ kind, files, readPath: filePath });
      if (id !== token.current) return;
      setMount(result);
    } catch (caught) {
      if (id !== token.current) return;
      setError(caught instanceof Error ? caught.message : text.failed);
    } finally {
      if (id === token.current) setPending(false);
    }
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
      <div className="@container border-t border-border">
        <div className="grid items-start @min-[64rem]:grid-cols-2">
          <LivePreview kind={kind} preview={preview} text={text} />
          {project ? (
            <div className="border-t border-border @min-[64rem]:border-t-0 @min-[64rem]:border-l">
              <ul className="m-0 flex list-none gap-1 overflow-x-auto p-2">
                {project.files.map((file) => {
                  const active = file.path === filePath;
                  return (
                    <li key={file.path}>
                      <button
                        className={cn("rounded-md px-3 py-1.5 text-left font-mono text-sm whitespace-nowrap", active ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground")}
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
              <CodeEditor key={`${kind}:${filePath}`} initialText={draft} label={filePath} onChange={onEdit} />
            </div>
          ) : null}
        </div>
      </div>
      <ul className="m-0 list-none border-t border-border p-0">
        <li className="border-b border-border">
          <button
            className={cn("block w-full px-4 py-3 text-left disabled:cursor-not-allowed", actionRowClass(chosen === "editor", !isolated || pending || project === null))}
            type="button"
            aria-pressed={chosen === "editor"}
            disabled={!isolated || pending || project === null}
            onClick={() => void applyEditor()}
          >
            <span className={cn("font-medium", !isolated || pending || project === null ? "text-muted-foreground" : "text-foreground")}>
              {text.apply}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">{text.actions.editor.detail}</span>
          </button>
        </li>
      </ul>
      <div className="px-4 pb-4">
        <MountResult text={text} error={error} isolated={isolated} mount={mount} pending={pending} pendingLabel={chosen === "editor" ? text.applying : text.mounting} />
      </div>
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
  pending,
  pendingLabel
}: {
  text: CaseCopy;
  error: string | null;
  isolated: boolean;
  mount: ContainerCaseMount | null;
  pending: boolean;
  pendingLabel: string;
}) {
  if (!isolated) return <p className="mt-3 mb-0 text-sm text-muted-foreground">{text.isolated}</p>;
  if (error) return <p className="mt-3 mb-0 text-sm text-foreground">{error}</p>;
  if (pending) return <p className="mt-3 mb-0 text-sm text-muted-foreground">{pendingLabel}</p>;
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

function LivePreview({ kind, preview, text }: { kind: ContainerCaseKind; preview: SpaPreview; text: CaseCopy }) {
  if (kind === "next") {
    return <p className="m-0 px-4 py-4 text-sm text-muted-foreground">{text.nextSourceOnly}</p>;
  }
  return (
    <div>
      <div className="px-4 py-3">
        <p className="m-0 text-sm font-medium text-foreground">{text.browserPreview}</p>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">{text.previewHint}</p>
      </div>
      <PreviewSurface preview={preview} title={text.browserPreview} loading={text.previewLoading} unavailable={text.previewUnavailable} />
    </div>
  );
}

function PreviewSurface({ preview, title, loading, unavailable }: { preview: SpaPreview; title: string; loading: string; unavailable: string }) {
  switch (preview.kind) {
    case "ready":
      return <iframe className="h-96 w-full border-0" sandbox="allow-scripts" srcDoc={preview.doc} title={title} />;
    case "unavailable":
      return <p className="m-0 px-4 pb-4 text-sm text-muted-foreground">{unavailable}</p>;
    case "loading":
      return <p className="m-0 px-4 pb-4 text-sm text-muted-foreground">{loading}</p>;
    default: {
      const exhaustive: never = preview;
      return exhaustive;
    }
  }
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
