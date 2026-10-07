import "server-only";

import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "./collaboration-bff.ts";

const MAX_CURSOR_BYTES = 2_048;
const MAX_PAGE_SIZE = 100;

type TeamEtagKind = "team" | "team-member" | "team-project-role";

interface TeamForward {
  readonly etagKind?: TeamEtagKind;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly path: `/api/v1/${string}`;
  readonly safeLocation?: (value: string) => boolean;
  readonly withBody?: boolean;
}

export function forwardTeamRequest(request: Request, spec: TeamForward): Promise<Response> {
  return forwardCollaborationMutation(request, {
    ...(spec.etagKind === undefined ? {} : { etagKind: spec.etagKind }),
    method: spec.method,
    path: spec.path,
    requireCsrf: spec.method !== "GET",
    ...(spec.safeLocation === undefined ? {} : { safeLocation: spec.safeLocation }),
    withBody: spec.withBody ?? false,
    withEtag: spec.etagKind !== undefined
  });
}

export function invalidTeamRoute(request: Request): Response {
  return invalidCollaborationRoute(request, "/api/v1/organizations/teams");
}

export function teamCollectionPath(
  request: Request,
  organizationId: string
): `/api/v1/${string}` | undefined {
  const organization = uuidPathSegment(organizationId);
  if (organization === undefined) return undefined;
  const path = `/api/v1/organizations/${organization}/teams` as const;
  return request.method === "GET" ? listPath(request, path) : noQueryPath(request, path);
}

export function teamItemPath(
  request: Request,
  organizationId: string,
  teamId: string
): `/api/v1/${string}` | undefined {
  const collection = teamCollectionPathWithoutQuery(organizationId);
  const team = uuidPathSegment(teamId);
  return collection === undefined || team === undefined
    ? undefined
    : noQueryPath(request, `${collection}/${team}` as const);
}

export function teamChildCollectionPath(
  request: Request,
  organizationId: string,
  teamId: string,
  child: "members" | "project-roles"
): `/api/v1/${string}` | undefined {
  const parent = teamPathWithoutQuery(organizationId, teamId);
  if (parent === undefined) return undefined;
  const path = `${parent}/${child}` as const;
  return request.method === "GET" ? listPath(request, path) : noQueryPath(request, path);
}

export function teamChildItemPath(
  request: Request,
  organizationId: string,
  teamId: string,
  child: "members" | "project-roles",
  childId: string
): `/api/v1/${string}` | undefined {
  const parent = teamPathWithoutQuery(organizationId, teamId);
  const item = uuidPathSegment(childId);
  return parent === undefined || item === undefined
    ? undefined
    : noQueryPath(request, `${parent}/${child}/${item}` as const);
}

export function teamLocation(organizationId: string): (value: string) => boolean {
  const collection = teamCollectionPathWithoutQuery(organizationId);
  return (value) => {
    if (collection === undefined) return false;
    const prefix = `${collection}/`;
    return value.startsWith(prefix) && uuidPathSegment(value.slice(prefix.length)) !== undefined;
  };
}

function teamCollectionPathWithoutQuery(organizationId: string): `/api/v1/${string}` | undefined {
  const organization = uuidPathSegment(organizationId);
  return organization === undefined
    ? undefined
    : `/api/v1/organizations/${organization}/teams`;
}

function teamPathWithoutQuery(
  organizationId: string,
  teamId: string
): `/api/v1/${string}` | undefined {
  const collection = teamCollectionPathWithoutQuery(organizationId);
  const team = uuidPathSegment(teamId);
  return collection === undefined || team === undefined ? undefined : `${collection}/${team}`;
}

function noQueryPath(request: Request, path: `/api/v1/${string}`): `/api/v1/${string}` | undefined {
  return new URL(request.url).search === "" ? path : undefined;
}

function listPath(request: Request, path: `/api/v1/${string}`): `/api/v1/${string}` | undefined {
  const source = new URL(request.url).searchParams;
  const unexpected = [...source.keys()].some((key) => key !== "pageSize" && key !== "cursor");
  if (unexpected || source.getAll("pageSize").length > 1 || source.getAll("cursor").length > 1) {
    return undefined;
  }
  const pageSize = source.get("pageSize");
  if (pageSize !== null && (!/^[1-9]\d{0,2}$/u.test(pageSize) || Number(pageSize) > MAX_PAGE_SIZE)) {
    return undefined;
  }
  const cursor = source.get("cursor");
  if (
    cursor !== null &&
    (cursor.length === 0 || new TextEncoder().encode(cursor).byteLength > MAX_CURSOR_BYTES || /[\u0000-\u0020\u007f]/u.test(cursor))
  ) {
    return undefined;
  }
  const query = new URLSearchParams();
  if (pageSize !== null) query.set("pageSize", pageSize);
  if (cursor !== null) query.set("cursor", cursor);
  const serialized = query.toString();
  return serialized === "" ? path : `${path}?${serialized}`;
}
