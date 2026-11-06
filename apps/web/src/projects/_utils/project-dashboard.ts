import type {
  DirectProjectRole,
  OrganizationRole,
  Project,
  ProjectListState,
  ProjectRole,
  ProjectTemplateId
} from "@nuriteo/api-client";

export interface OrganizationMemberOption {
  readonly userId: string;
  readonly displayName: string;
  readonly role: OrganizationRole;
}

export function projectStateLabel(state: ProjectListState): string {
  if (state === "archived") return "보관됨";
  if (state === "all") return "전체";
  return "활성";
}

export function projectSettingsCopy(section: "access" | "all" | "danger" | "general"): {
  readonly description: string;
  readonly title: string;
} {
  if (section === "general") return { title: "일반 설정", description: "이름과 기본 표시 정보를 관리합니다." };
  if (section === "access") return { title: "접근 권한", description: "조직 멤버에게 직접 부여한 역할을 관리합니다." };
  if (section === "danger") return { title: "위험 영역", description: "보관, 복원과 영구 삭제 작업을 관리합니다." };
  return { title: "프로젝트 설정", description: "이름, Git, 접근 권한과 보관 상태를 관리합니다." };
}

export function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "P";
}

export function roleValue(value: FormDataEntryValue | null): ProjectRole {
  return value === "admin" || value === "write" ? value : "read";
}

export function projectTemplateId(value: FormDataEntryValue | null): ProjectTemplateId {
  if (value === "vite-react" || value === "next-app") return value;
  throw new TypeError("프로젝트 시작 템플릿을 선택하세요.");
}

export function organizationMemberLabel(member: OrganizationMemberOption): string {
  return `${member.displayName} · 조직 ${organizationRoleLabel(member.role)}`;
}

export function createProjectRoleDirectory(
  members: readonly OrganizationMemberOption[],
  grants: readonly DirectProjectRole[]
) {
  const grantedUserIds = new Set(grants.map((grant) => grant.userId));
  const memberByUserId = new Map<string, OrganizationMemberOption>();
  const memberLabelCounts = new Map<string, number>();

  for (const member of members) {
    memberByUserId.set(member.userId, member);
    const label = organizationMemberLabel(member);
    memberLabelCounts.set(label, (memberLabelCounts.get(label) ?? 0) + 1);
  }

  const hasUniqueMemberLabel = (member: OrganizationMemberOption): boolean =>
    memberLabelCounts.get(organizationMemberLabel(member)) === 1;
  let hasAvailableMembers = false;
  let hasAmbiguousMembers = false;

  for (const member of members) {
    if (member.role === "owner") continue;
    const hasUniqueLabel = hasUniqueMemberLabel(member);
    if (!hasUniqueLabel) hasAmbiguousMembers = true;
    if (hasUniqueLabel && !grantedUserIds.has(member.userId)) hasAvailableMembers = true;
  }

  return {
    grantedUserIds,
    hasAmbiguousMembers,
    hasAvailableMembers,
    hasUniqueMemberLabel,
    memberByUserId
  };
}

export function directGrantMemberLabel(
  grant: DirectProjectRole,
  grantIndex: number,
  grants: readonly DirectProjectRole[],
  memberByUserId: ReadonlyMap<string, OrganizationMemberOption>,
  hasUniqueMemberLabel: (member: OrganizationMemberOption) => boolean
): string {
  const member = memberByUserId.get(grant.userId);
  if (member !== undefined && hasUniqueMemberLabel(member)) return organizationMemberLabel(member);
  const baseLabel = member === undefined
    ? "확인할 수 없는 조직 멤버"
    : `${organizationMemberLabel(member)} · 이름 중복`;
  const belongsToSameGroup = (candidate: DirectProjectRole): boolean => {
    const candidateMember = memberByUserId.get(candidate.userId);
    return member === undefined
      ? candidateMember === undefined
      : candidateMember !== undefined && organizationMemberLabel(candidateMember) === organizationMemberLabel(member);
  };
  const ordinal = grants.slice(0, grantIndex + 1).filter(belongsToSameGroup).length;
  const total = grants.filter(belongsToSameGroup).length;
  return `${baseLabel} · 역할 ${ordinal}/${total}`;
}

export function organizationRoleLabel(role: OrganizationRole): string {
  return role === "owner" ? "소유자" : "멤버";
}

export function projectRoleLabel(role: ProjectRole): string {
  if (role === "admin") return "관리";
  if (role === "write") return "쓰기";
  return "읽기";
}

export function projectHref(scope: string, state: ProjectListState): string {
  const query = new URLSearchParams({ state });
  return `/workspaces/${encodeURIComponent(scope)}?${query.toString()}`;
}

export function projectDetailHref(scope: string, state: ProjectListState, projectId: string): string {
  return `/workspaces/${encodeURIComponent(scope)}/projects/${encodeURIComponent(projectId)}/settings/general?${new URLSearchParams({ state }).toString()}`;
}

export function projectStudioHref(scope: string, projectId: string): string {
  return `/workspaces/${encodeURIComponent(scope)}/projects/${encodeURIComponent(projectId)}/studio`;
}

export function visibleInState(project: Project, state: ProjectListState): boolean {
  return state === "all" || project.state === state;
}

export function upsertProject(projects: readonly Project[], project: Project): readonly Project[] {
  return projects.some((item) => item.id === project.id)
    ? projects.map((item) => {
      if (item.id === project.id) return (project);
      return (item);
    })
    : [...projects, project];
}
