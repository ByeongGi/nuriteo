"use client";

import type { PublicPublishedExample, Workspace } from "@nuriteo/api-client";
import Link from "next/link";

import { useForkExampleForm } from "@/app/(public)/examples/_hooks/use-fork-example-form.ts";
import { examplesStyles } from "@/app/(public)/examples/_components/examples.styles.ts";
import { signInHref } from "@/app/(public)/sign-in/_utils/return-to.ts";
import { Button } from "@/components/ui/button.tsx";
import { SelectField, TextField } from "@/components/ui/field.tsx";

export interface ForkExampleFormProps {
  readonly example: PublicPublishedExample;
  readonly initialWorkspaces?: readonly Workspace[] | undefined;
}

export function ForkExampleForm({ example, initialWorkspaces }: ForkExampleFormProps) {
  const styles = examplesStyles();
  const {
    error,
    fork,
    forkSessionEnded,
    pending,
    selectedScope,
    setSelectedScope,
    status,
    workspaces
  } = useForkExampleForm(example, initialWorkspaces);
  const returnTo = `/examples/${example.publicId}/versions/${example.versionNumber}`;

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
          {(function () {
    if (forkSessionEnded) {
        return ((
            <Link className="w-fit font-semibold text-link underline-offset-4 hover:underline" href={signInHref(returnTo)}>
              로그인하고 계속
            </Link>
          ));
    }
    return (null);
})()}
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
