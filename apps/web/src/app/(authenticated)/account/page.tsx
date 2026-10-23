import type { Metadata } from "next";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";

export const metadata: Metadata = { title: "계정 설정" };

const accountOverviewStyles = tv({
  slots: {
    root: "grid gap-6 outline-none",
    grid: "grid gap-3 sm:grid-cols-2",
    item: "grid min-h-36 content-between gap-5 rounded-xl border border-muted-border bg-surface p-5 text-foreground no-underline shadow-xs transition-colors hover:border-strong-border hover:bg-hover",
    copy: "grid gap-2",
    title: "m-0 text-base font-semibold",
    description: "m-0 text-sm leading-relaxed text-muted-foreground",
    action: "text-sm font-medium text-link"
  }
});

const accountSections = [
  { href: "/account/security", title: "보안", description: "비밀번호, 다중 인증, 복구 수단과 활성 세션을 관리합니다." },
  { href: "/account/identities", title: "연결된 로그인", description: "로컬 계정과 OIDC 로그인 연결 상태를 확인합니다." },
  { href: "/account/tokens", title: "개인 액세스 토큰", description: "CLI와 자동화에 사용할 최소 권한 토큰을 관리합니다." },
  { href: "/account/notifications", title: "알림 설정", description: "이벤트별 앱·이메일 수신 방식을 선택합니다." }
] as const;

export default function AccountPage() {
  const styles = accountOverviewStyles();
  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        eyebrow="개인 범위"
        title="계정 설정"
        description="내 로그인, 보안, 개인 자격 증명과 알림 수신 방식을 관리하세요."
      />
      <section className={styles.grid()} aria-label="계정 설정 영역">
        {accountSections.map((section) => (
          <Link className={styles.item()} href={section.href} key={section.href}>
            <span className={styles.copy()}>
              <strong className={styles.title()}>{section.title}</strong>
              <span className={styles.description()}>{section.description}</span>
            </span>
            <span className={styles.action()}>설정 열기 →</span>
          </Link>
        ))}
      </section>
    </main>
  );
}

