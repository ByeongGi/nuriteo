"use client";

import { tv } from "tailwind-variants";

import { useAcceptInvitation } from "@/app/(authenticated)/organization-invitations/accept/_hooks/use-accept-invitation.ts";
import { ProductEntryShell } from "@/app/_components/product-entry-shell.tsx";
import { Button } from "@/components/ui/button.tsx";

const invitationStyles = tv({
  slots: {
    error: "mt-5 rounded-lg border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger",
    actions: "mt-6 flex flex-wrap gap-2 border-t border-muted-border pt-5 max-[32rem]:grid max-[32rem]:[&>button]:w-full"
  }
});

export function AcceptInvitation() {
  const styles = invitationStyles();
  const { error, isPending, respond } = useAcceptInvitation();

  return (
    <ProductEntryShell
      compact
      description="수락하면 조직 워크스페이스가 내 워크스페이스 선택 목록에 추가됩니다."
      eyebrow="조직 초대"
      title="공유 워크스페이스에 참여하세요"
      titleId="organization-invitation-title"
    >
      {error ? <p className={styles.error()} role="alert">{error}</p> : null}
      <div className={styles.actions()}>
        <Button type="button" variant="primary" disabled={isPending} onClick={() => void respond("accept")}>초대 수락</Button>
        <Button type="button" disabled={isPending} onClick={() => void respond("decline")}>거절</Button>
      </div>
    </ProductEntryShell>
  );
}
