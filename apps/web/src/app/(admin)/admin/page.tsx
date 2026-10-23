import Link from "next/link";
import type { Metadata } from "next";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";

export const metadata: Metadata = { title: "관리자 홈" };

const adminAreas = [
  {
    description: "사용자 디렉터리에서 가입과 접근 복구 작업의 지원 범위를 확인합니다.",
    href: "/admin/access/users",
    label: "사용자·접근",
    links: ["사용자 디렉터리", "사용자 세션", "가입 초대", "MFA 초기화"]
  },
  {
    description: "조직 전체의 로그인 정책과 외부 인증 제공자를 관리합니다.",
    href: "/admin/authentication/mfa",
    label: "인증",
    links: ["MFA 정책", "OIDC 제공자"]
  },
  {
    description: "개발 도구와 메일 인프라에 연결되는 시스템 통합을 구성합니다.",
    href: "/admin/integrations/git",
    label: "연동",
    links: ["Git 제공자", "패키지 저장소", "SMTP 인증서"]
  },
  {
    description: "서비스 상태와 이메일 전송, 점검 및 백업 작업을 확인합니다.",
    href: "/admin/operations",
    label: "운영",
    links: ["운영 현황", "이메일 전송", "점검 모드", "백업"]
  },
  {
    description: "업데이트 준비 상태와 인스턴스 전역 정책을 검토합니다.",
    href: "/admin/system/updates",
    label: "시스템",
    links: ["감사 로그", "업데이트", "인스턴스 설정"]
  }
] as const;

const adminHomeStyles = tv({
  slots: {
    root: "grid w-full content-start gap-4 px-6 py-5 outline-none max-[48rem]:px-4 max-[48rem]:py-4",
    notice: "flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 max-[48rem]:items-start max-[48rem]:flex-col",
    noticeCopy: "m-0 text-sm text-muted-foreground",
    grid: "grid grid-cols-2 gap-3 min-[72rem]:grid-cols-3 max-[48rem]:grid-cols-1",
    card: "grid min-h-52 grid-rows-[auto_1fr_auto] gap-3 rounded-lg border border-muted-border bg-surface p-4 transition-colors hover:border-strong-border",
    cardCopy: "[&_h2]:mt-1 [&_h2]:mb-1.5 [&_h2]:text-base [&_p]:m-0 [&_p]:text-sm [&_p]:leading-5 [&_p]:text-muted-foreground",
    eyebrow: "m-0 text-xs font-semibold tracking-[0.08em] text-accent-foreground",
    tags: "m-0 flex list-none flex-wrap content-start gap-2 p-0",
    tag: "rounded-full bg-subtle px-2.5 py-1 text-xs text-muted-foreground",
    link: "flex items-center justify-between border-t border-muted-border pt-3 text-sm font-semibold text-link no-underline hover:text-foreground"
  }
});

export default function AdminHomePage() {
  const styles = adminHomeStyles();
  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        eyebrow="NURITEO ADMIN"
        title="관리자 홈"
        description="사용자 경험과 분리된 운영 공간에서 서비스 상태, 접근 정책과 외부 연동을 관리합니다."
      />

      <section className={styles.notice()} aria-label="관리자 영역 안내">
        <strong>관리자 전용 영역</strong>
        <p className={styles.noticeCopy()}>이곳의 변경 사항은 전체 사용자와 워크스페이스에 영향을 줄 수 있습니다.</p>
      </section>

      <section className={styles.grid()} aria-label="관리 기능">
        {adminAreas.map((area) => (
          <article className={styles.card()} key={area.href}>
            <div className={styles.cardCopy()}>
              <p className={styles.eyebrow()}>{area.label}</p>
              <h2>{area.label}</h2>
              <p>{area.description}</p>
            </div>
            <ul className={styles.tags()}>
              {area.links.map((link) => <li className={styles.tag()} key={link}>{link}</li>)}
            </ul>
            <Link className={styles.link()} href={area.href}>관리하기 <span aria-hidden="true">→</span></Link>
          </article>
        ))}
      </section>
    </main>
  );
}
