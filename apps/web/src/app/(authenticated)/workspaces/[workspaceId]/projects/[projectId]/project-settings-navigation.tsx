"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tv } from "tailwind-variants";

const styles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-3 px-[clamp(1.25rem,4vw,3.5rem)] pt-5 max-[48rem]:px-4",
    context: "flex min-w-0 items-center justify-between gap-3",
    contextCopy: "grid min-w-0 gap-0.5",
    eyebrow: "m-0 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground",
    projectName: "m-0 truncate text-sm font-semibold text-foreground",
    studio: "shrink-0 text-sm font-medium text-link no-underline hover:underline",
    nav: "flex gap-1 overflow-x-auto rounded-lg bg-subtle p-1",
    link: "inline-flex min-h-9 shrink-0 items-center rounded-md px-3 text-xs font-semibold text-muted-foreground no-underline hover:bg-hover hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground aria-[current=page]:shadow-xs"
  }
});

export function ProjectSettingsNavigation({ projectId, projectName, workspaceId }: Readonly<{ projectId: string; projectName: string; workspaceId: string }>) {
  const pathname = usePathname();
  const css = styles();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
  const items = [
    [`${base}/settings/general`, "일반"],
    [`${base}/settings/git`, "Git"],
    [`${base}/history`, "버전 기록"],
    [`${base}/settings/access`, "접근 권한"],
    [`${base}/settings/runtime`, "런타임"],
    [`${base}/settings/tokens`, "토큰"],
    [`${base}/settings/danger`, "위험 영역"]
  ] as const;
  return (
    <div className={css.root()}>
      <div className={css.context()}>
        <div className={css.contextCopy()}>
          <p className={css.eyebrow()}>프로젝트 관리</p>
          <p className={css.projectName()}>{projectName}</p>
        </div>
        <Link className={css.studio()} href={`${base}/studio`}>Studio 열기</Link>
      </div>
      <nav className={css.nav()} aria-label="프로젝트 관리 메뉴">
        {items.map(([href, label]) => (
          <Link className={css.link()} href={href} aria-current={pathname === href ? "page" : undefined} key={href}>
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
