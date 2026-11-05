"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { forkExampleSchema } from "@/app/(public)/examples/_schema/fork-example.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { ApiError } from "@/services/http/api.ts";
import { forkPublishedExample } from "@/services/published-examples/api.ts";
import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import type { PublicPublishedExample, Workspace } from "@nuriteo/api-client";
import type { FormEvent } from "react";

interface Attempt {
  readonly key: string;
  readonly signature: string;
}

const forkInputError = "프로젝트 슬러그와 이름을 확인하고 다시 시도하세요.";

export function useForkExampleForm(
  example: PublicPublishedExample,
  initialWorkspaces: readonly Workspace[] | undefined
) {
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
    const parsed = forkExampleSchema.safeParse({
      slug: String(data.get("slug") ?? ""),
      name: String(data.get("name") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? forkInputError);
      setForkSessionEnded(false);
      return;
    }
    const { slug, name } = parsed.data;
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

  return {
    error,
    fork,
    forkSessionEnded,
    pending,
    selectedScope,
    setSelectedScope,
    status,
    workspaces
  };
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
