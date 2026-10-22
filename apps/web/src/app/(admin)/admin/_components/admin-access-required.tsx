import Link from "next/link";

interface AdminAccessRequiredProps {
  readonly description: string;
}

export function AdminAccessRequired({ description }: AdminAccessRequiredProps) {
  return (
    <main id="main-content" className="workspace-page" tabIndex={-1}>
      <section className="access-required" aria-labelledby="admin-access-required-title">
        <span className="access-required__mark" aria-hidden="true">◇</span>
        <div>
          <p className="eyebrow">접근 제한</p>
          <h1 id="admin-access-required-title">관리자 권한이 필요합니다</h1>
          <p>{description}</p>
          <Link className="link-button" href="/workspaces">사용자 화면으로 돌아가기</Link>
        </div>
      </section>
    </main>
  );
}
