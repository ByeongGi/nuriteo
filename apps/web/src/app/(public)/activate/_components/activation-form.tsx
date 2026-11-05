"use client";

import Link from "next/link";
import { tv } from "tailwind-variants";

import { useActivationForm } from "@/app/(public)/activate/_hooks/use-activation-form.ts";
import { ProductEntryShell } from "@/app/_components/product-entry-shell.tsx";
import { buttonVariants } from "@/components/ui/button.styles.ts";
import { Button } from "@/components/ui/button.tsx";
import { TextField } from "@/components/ui/field.tsx";

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
  const { error, handleSubmit, isPending, token } = useActivationForm(activationToken);

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
      <form className={styles.form()} onSubmit={handleSubmit} aria-busy={isPending}>
        <TextField label="이메일" name="email" type="email" autoComplete="username" required maxLength={320} disabled={isPending} />
        <TextField label="표시 이름" name="displayName" required maxLength={200} disabled={isPending} />
        <TextField label="비밀번호" name="password" type="password" autoComplete="new-password" required disabled={isPending} />
        {error ? <p className={styles.error()} role="alert">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={isPending}>{isPending ? "활성화 중…" : "계정 활성화"}</Button>
      </form>
    </ProductEntryShell>
  );
}
