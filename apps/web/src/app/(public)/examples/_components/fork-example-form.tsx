"use client";

import {
  ApiError,
  forkPublishedExample,
  getCurrentWorkspaces
} from "@nuriteo/api-client";
import type { PublicPublishedExample, Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { examplesStyles } from "#src/app/(public)/examples/_components/examples.styles.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { signInHref } from "#src/app/(public)/sign-in/return-to.ts";

export interface ForkExampleFormProps {
  readonly example: PublicPublishedExample;
  readonly initialWorkspaces?: readonly Workspace[] | undefined;
}

interface Attempt {
  readonly key: string;
  readonly signature: string;
}

export function ForkExampleForm({ example, initialWorkspaces }: ForkExampleFormProps) {
  const styles = examplesStyles();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<readonly Workspace[] | undefined>(initialWorkspaces);
  const [selectedScope, setSelectedScope] = useState(initialWorkspaces?.[0]?.storageScopeId ?? "");
  const [status, setStatus] = useState<"loading" | "ready" | "signed-out" | "unavailable">(
    initialWorkspaces === undefined ? "loading" : "ready"
  );
  const [error, setError] = useState<string>();
  const [forkSessionEnded, setForkSessionEnded] = useState(false);
  const [pending, setPending] = useState(false);
  const attempt = useRef<Attempt | undefined>(undefined);
  const returnTo = `/examples/${example.publicId}/versions/${example.versionNumber}`;

  useEffect(() => {
    if (initialWorkspaces !== undefined) return;
    const controller = new AbortController();
    void getCurrentWorkspaces(createBrowserApiClient(), { signal: controller.signal })
      .then((result) => {
        setWorkspaces(result.data.workspaces);
        setSelectedScope(result.data.workspaces[0]?.storageScopeId ?? "");
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setStatus(cause instanceof ApiError && cause.status === 401 ? "signed-out" : "unavailable");
      });
    return () => controller.abort();
  }, [initialWorkspaces]);

  async function fork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workspace = workspaces?.find((item) => item.storageScopeId === selectedScope);
    if (workspace === undefined || pending) return;
    const data = new FormData(event.currentTarget);
    const slug = String(data.get("slug") ?? "");
    const name = String(data.get("name") ?? "");
    const signature = JSON.stringify([example.publicId, example.versionNumber, selectedScope, slug, name]);
    if (attempt.current?.signature !== signature) {
      attempt.current = { key: `published-example-fork-${crypto.randomUUID()}`, signature };
    }
    setPending(true);
    setError(undefined);
    setForkSessionEnded(false);
    try {
      const result = await forkPublishedExample(createBrowserApiClient(), {
        publicId: example.publicId,
        versionNumber: example.versionNumber,
        destinationOwner: {
          ownerType: workspace.ownerType,
          ownerId: workspace.ownerId
        },
        slug,
        name,
        idempotencyKey: attempt.current.key
      }, { csrfToken: readCsrfCredential() });
      router.push(
        `/workspaces/${encodeURIComponent(workspace.storageScopeId)}/projects/${encodeURIComponent(result.data.project.id)}/studio`
      );
    } catch (cause) {
      setForkSessionEnded(cause instanceof ApiError && cause.status === 401);
      setError(forkError(cause));
    } finally {
      setPending(false);
    }
  }

  if (status === "loading") {
    return <p aria-live="polite" className="text-sm text-muted-foreground">사용 가능한 워크스페이스를 확인하는 중…</p>;
  }
  if (status === "signed-out") {
    return (
      <div className={styles.forkState()}>
        <p className="m-0 text-sm text-muted-foreground">이 고정 버전을 내 워크스페이스로 복제하려면 로그인하세요.</p>
        <Link className="mt-3 inline-flex text-sm font-semibold text-link underline-offset-4 hover:underline" href={signInHref(returnTo)}>
          로그인하고 복제
        </Link>
      </div>
    );
  }
  if (status === "unavailable") {
    return <p role="alert" className={styles.forkState({ className: "border-danger/30 text-danger" })}>워크스페이스 정보를 일시적으로 사용할 수 없습니다.</p>;
  }
  if (workspaces?.length === 0) {
    return <p className={styles.forkState()}>이 계정에서 쓸 수 있는 워크스페이스가 없습니다.</p>;
  }

  return (
    <form className={styles.forkForm()} onSubmit={fork} aria-busy={pending}>
      <div>
        <h3 className={styles.forkTitle()}>내 워크스페이스로 복제</h3>
        <p className={styles.forkDescription()}>원본 접근 권한, Git 연결이나 환경값 없이 독립적인 프로젝트를 만듭니다.</p>
      </div>
      <SelectField
        className="text-sm text-foreground"
        label="워크스페이스"
        disabled={pending}
        options={(workspaces ?? []).map((workspace) => ({ value: workspace.storageScopeId, label: workspace.displayLabel }))}
        required
        value={selectedScope}
        onValueChange={setSelectedScope}
      />
      <TextField
          label="프로젝트 슬러그"
          defaultValue={suggestedSlug(example.name)}
          disabled={pending}
          maxLength={63}
          name="slug"
          pattern="[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?"
          required
        />
      <TextField
          label="프로젝트 이름"
          defaultValue={`${example.name} 복제본`}
          disabled={pending}
          maxLength={200}
          name="name"
          required
        />
      {error === undefined ? null : (
        <div className="grid gap-2 text-sm text-danger" role="alert">
          <p className="m-0">{error}</p>
          {forkSessionEnded ? (
            <Link className="w-fit font-semibold text-link underline-offset-4 hover:underline" href={signInHref(returnTo)}>
              로그인하고 계속
            </Link>
          ) : null}
        </div>
      )}
      <Button disabled={pending || selectedScope === ""} type="submit" variant="primary">
        {pending ? "복제하는 중…" : "워크스페이스로 복제"}
      </Button>
    </form>
  );
}

function suggestedSlug(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 58)
    .replace(/-+$/gu, "");
  return normalized === "" ? "example-fork" : `${normalized}-fork`;
}

function forkError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "복제가 완료되었을 수 있습니다. 같은 값으로 다시 시도해 안전하게 결과를 확인하세요.";
    }
    if (error.status === 401) return "세션이 종료되었습니다. 다시 로그인한 뒤 복제하세요.";
    if (error.status === 403) return "해당 워크스페이스에 프로젝트를 만들 수 없습니다.";
    if (error.status === 404) return "이 게시 버전을 더 이상 사용할 수 없습니다.";
    if (error.status === 409) return "프로젝트 슬러그가 이미 사용 중이거나 워크스페이스 할당량에 도달했습니다.";
    if (error.status === 400 || error.status === 422) return "프로젝트 슬러그와 이름을 확인하고 다시 시도하세요.";
  }
  return "복제를 완료하지 못했습니다. 원본 예제는 변경되지 않았습니다.";
}
