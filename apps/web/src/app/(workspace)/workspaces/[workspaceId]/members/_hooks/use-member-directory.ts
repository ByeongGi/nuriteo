"use client";

import { useDeferredValue, useMemo, useState } from "react";

import type { OrganizationMember } from "@nuriteo/api-client";

type RoleFilter = "all" | OrganizationMember["role"];

export function useMemberDirectory(members: readonly OrganizationMember[]) {
  const [query, setQuery] = useState("");
  const [role, setRoleState] = useState<RoleFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const visibleMembers = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    return members.filter((member) => (role === "all" || member.role === role) && (normalized === "" || `${member.displayName} ${member.userId}`.toLocaleLowerCase("ko-KR").includes(normalized)));
  }, [deferredQuery, members, role]);

  function setRole(value: string) {
    setRoleState(value === "owner" || value === "member" ? value : "all");
  }

  return {
    deferredQuery,
    query,
    role,
    setQuery,
    setRole,
    visibleMembers
  };
}
