"use client";

import { activateAccount } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { buttonVariants } from "#src/components/ui/button.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { ProductEntryShell } from "#src/app/_components/product-entry-shell.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { collaborationError } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

interface ActivationFormProps {
  readonly activationToken?: string | null | undefined;
}

const activationStyles = tv({
  slots: {
    actions: "mt-6 flex flex-wrap items-center gap-3",
    form: "mt-6 grid gap-4",
    error: "m-0 rounded-lg border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger"
  }
});

export function ActivationForm({ activationToken }: ActivationFormProps) {
  const styles = activationStyles();
  const router = useRouter();
  const searchParams = useSearchParams();
  const mutation = useExclusiveMutation();
  const [error, setError] = useState<string>();
  const token = activationToken === undefined ? searchParams.get("token") : activationToken;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (token === null) {
      setError("활성화 링크가 없거나 올바르지 않습니다.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        await activateAccount(createBrowserApiClient(), {
          token,
          email: String(data.get("email") ?? ""),
          displayName: String(data.get("displayName") ?? ""),
          password: String(data.get("password") ?? "")
        });
        form.reset();
        router.replace("/sign-in?activated=1");
      } catch (cause) {
        setError(collaborationError(cause, "activation-invitation-terminal"));
      }
    });
  }

  if (token === null || token.trim().length === 0) {
    return (
      <ProductEntryShell
        compact
        description="초대 링크가 없거나 올바르지 않습니다. 관리자가 보낸 최신 초대 메일을 다시 확인하세요."
        eyebrow="초대 링크 확인 필요"
        title="계정을 활성화할 수 없습니다"
        titleId="activation-invalid-title"
      >
        <div className={styles.actions()} role="alert">
          <Link className={buttonVariants({ variant: "primary" })} href="/sign-in">로그인으로 돌아가기</Link>
        </div>
      </ProductEntryShell>
    );
  }

  return (
    <ProductEntryShell
      description="프로필과 비밀번호를 설정한 뒤 새 계정으로 로그인할 수 있습니다."
      eyebrow="초대받은 워크스페이스"
      title="계정을 활성화하세요"
      titleId="activation-title"
    >
      <form className={styles.form()} onSubmit={handleSubmit} aria-busy={mutation.isPending}>
        <TextField label="이메일" name="email" type="email" autoComplete="username" required maxLength={320} disabled={mutation.isPending} />
        <TextField label="표시 이름" name="displayName" required maxLength={200} disabled={mutation.isPending} />
        <TextField label="비밀번호" name="password" type="password" autoComplete="new-password" required disabled={mutation.isPending} />
        {error ? <p className={styles.error()} role="alert">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "활성화 중…" : "계정 활성화"}</Button>
      </form>
    </ProductEntryShell>
  );
}
