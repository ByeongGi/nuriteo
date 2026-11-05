"use client";

import type { OrganizationMember } from "@nuriteo/api-client";

export function useMemberExport(members: readonly OrganizationMember[]) {
  const csv = createMemberCsv(members);

  function download() {
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `workspace-members-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return { csv, download };
}

function createMemberCsv(members: readonly OrganizationMember[]): string {
  return [["display_name", "role", "user_id"], ...members.map((member) => [member.displayName, member.role, member.userId])].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
