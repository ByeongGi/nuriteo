"use client";

import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";

import { useMemberExport } from "@/app/(workspace)/workspaces/[workspaceId]/members/export/_hooks/use-member-export.ts";
import { memberManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/members/_components/member-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";

export function MemberExport({ members, organizationName, workspaceId }: Readonly<{ members: readonly OrganizationMember[]; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const { csv, download } = useMemberExport(members);
  const membersHref = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  return <WorkspaceSection eyebrow={organizationName} title="멤버 내보내기" description="현재 멤버 목록을 CSV 파일로 저장합니다." actions={<Button size="sm" render={<Link href={membersHref} />}>멤버 목록</Button>}><WorkspacePanel title={`${members.length}명의 멤버`} description="표시 이름, 역할, 멤버 ID가 포함됩니다. 계정 이메일은 멤버 API에서 제공하지 않으므로 포함되지 않습니다."><pre className={styles.csvPreview()} aria-label="CSV 미리보기">{csv.split("\n").slice(0, 6).join("\n")}{members.length > 5 ? "\n…" : ""}</pre><div className={styles.actions()}><Button variant="primary" type="button" onClick={download}>CSV 다운로드</Button></div></WorkspacePanel></WorkspaceSection>;
}
