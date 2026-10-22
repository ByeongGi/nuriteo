import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "관리자 홈" };

const adminAreas = [
  {
    description: "서비스 상태, 점검 모드, 백업과 업데이트 준비 상태를 확인합니다.",
    href: "/admin/operations",
    label: "운영",
    links: ["운영 현황", "유지보수", "백업", "업데이트"]
  },
  {
    description: "가입 초대와 조직 전체의 로그인·다중 인증 정책을 관리합니다.",
    href: "/admin/invitations",
    label: "사용자 및 접근",
    links: ["가입 초대", "MFA 정책", "인증 제공자"]
  },
  {
    description: "개발 도구와 메일 인프라에 연결되는 시스템 통합을 구성합니다.",
    href: "/admin/git-providers",
    label: "서비스 연동",
    links: ["Git 제공자", "패키지 저장소", "이메일", "SMTP 인증서"]
  },
  {
    description: "인스턴스 전역 정책과 데이터 보존 기준을 검토합니다.",
    href: "/admin/settings",
    label: "시스템 정책",
    links: ["정책 설정", "보존 정책", "인스턴스 상태"]
  }
] as const;

export default function AdminHomePage() {
  return (
    <main id="main-content" className="workspace-page admin-home" tabIndex={-1}>
      <header className="workspace-page__intro">
        <p className="eyebrow">NURITEO ADMIN</p>
        <h1>관리자 홈</h1>
        <p>사용자 경험과 분리된 운영 공간에서 서비스 상태, 접근 정책과 외부 연동을 관리합니다.</p>
      </header>

      <section className="admin-home__notice" aria-label="관리자 영역 안내">
        <strong>관리자 전용 영역</strong>
        <p>이곳의 변경 사항은 전체 사용자와 워크스페이스에 영향을 줄 수 있습니다.</p>
      </section>

      <section className="admin-home__grid" aria-label="관리 기능">
        {adminAreas.map((area) => (
          <article key={area.href}>
            <div>
              <p className="eyebrow">{area.label}</p>
              <h2>{area.label}</h2>
              <p>{area.description}</p>
            </div>
            <ul>
              {area.links.map((link) => <li key={link}>{link}</li>)}
            </ul>
            <Link href={area.href}>관리하기 <span aria-hidden="true">→</span></Link>
          </article>
        ))}
      </section>
    </main>
  );
}
