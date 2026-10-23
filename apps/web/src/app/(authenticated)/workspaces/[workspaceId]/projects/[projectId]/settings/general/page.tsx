import type { Metadata } from "next";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { loadProjectContext } from "#src/app/(authenticated)/workspaces/[workspaceId]/projects/[projectId]/project-context.ts";
import {
  ProjectFacts,
  ProjectSettingsPanel,
  ProjectSettingsSection
} from "#src/app/(authenticated)/workspaces/[workspaceId]/projects/[projectId]/settings/project-settings-section.tsx";
import { Badge } from "#src/components/ui/badge.tsx";

export const metadata: Metadata = { title: "프로젝트 일반 설정" };

const actionLink = tv({
  base: "inline-flex min-h-10 items-center justify-center rounded-md border px-4 text-sm font-medium no-underline transition-colors duration-fast outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  variants: {
    emphasis: {
      primary: "border-primary bg-primary text-on-primary shadow-xs hover:bg-primary-strong",
      secondary: "border-strong-border bg-surface text-foreground hover:bg-hover"
    }
  }
});

interface Props {
  readonly params: Promise<{ projectId: string; workspaceId: string }>;
}

export default async function GeneralSettingsPage({ params }: Props) {
  const { projectId, workspaceId } = await params;
  const { project, workspace } = await loadProjectContext(workspaceId, projectId);
  const studioHref = `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio`;

  return (
    <ProjectSettingsSection
      projectName={project.data.name}
      title="일반 설정"
      description="프로젝트의 기본 정보와 현재 실행 상태를 확인하고 개발 작업으로 이동합니다."
    >
      <ProjectSettingsPanel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <strong className="text-base text-foreground">{project.data.name}</strong>
            <span className="text-sm text-muted-foreground">{workspace.displayLabel}의 프로젝트</span>
          </div>
          <Badge size="sm" tone={project.data.state === "active" ? "success" : "neutral"} variant="status">
            {project.data.state === "active" ? "활성" : "보관됨"}
          </Badge>
        </div>
        <ProjectFacts
          items={[
            { label: "프로젝트 주소", value: project.data.slug },
            { label: "현재 버전", value: `v${project.data.version}` },
            { label: "워크스페이스", value: workspace.displayLabel },
            { label: "최근 변경", value: new Date(project.data.updatedAt).toLocaleString("ko-KR") }
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {project.data.state === "active" ? (
            <Link className={actionLink({ emphasis: "primary" })} href={studioHref}>
              Studio에서 열기
            </Link>
          ) : null}
          <Link className={actionLink({ emphasis: "secondary" })} href={`${studioHref.replace(/\/studio$/u, "")}/history`}>
            버전 기록 보기
          </Link>
        </div>
      </ProjectSettingsPanel>
    </ProjectSettingsSection>
  );
}
