"use client";

import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";

import { memberManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";

export function MemberExport({ members, organizationName, workspaceId }: Readonly<{ members: readonly OrganizationMember[]; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const csv = createMemberCsv(members);
  const membersHref = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  function download() {
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `workspace-members-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <WorkspaceSection eyebrow={organizationName} title="멤버 내보내기" description="현재 멤버 목록을 CSV 파일로 저장합니다." actions={<Button size="sm" render={<Link href={membersHref} />}>멤버 목록</Button>}><WorkspacePanel title={`${members.length}명의 멤버`} description="표시 이름, 역할, 멤버 ID가 포함됩니다. 계정 이메일은 멤버 API에서 제공하지 않으므로 포함되지 않습니다."><pre className={styles.csvPreview()} aria-label="CSV 미리보기">{csv.split("\n").slice(0, 6).join("\n")}{members.length > 5 ? "\n…" : ""}</pre><div className={styles.actions()}><Button variant="primary" type="button" onClick={download}>CSV 다운로드</Button></div></WorkspacePanel></WorkspaceSection>;
}

function createMemberCsv(members: readonly OrganizationMember[]): string {
  return [["display_name", "role", "user_id"], ...members.map((member) => [member.displayName, member.role, member.userId])].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
