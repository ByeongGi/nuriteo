import Link from "next/link";

import { ProductEntryShell } from "#src/app/_components/product-entry-shell.tsx";

export default function NotFound() {
  return (
    <ProductEntryShell
      compact
      description="주소를 다시 확인하거나 워크스페이스로 돌아가세요."
      eyebrow="페이지를 찾을 수 없습니다"
      title="이 주소에는 페이지가 없습니다"
      titleId="not-found-title"
    >
      <Link className="link-button" href="/">홈으로 돌아가기</Link>
    </ProductEntryShell>
  );
}
