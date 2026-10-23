import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "@nuriteo/api-client";

import {
  resolveWorkspaceSelection,
  workspaceOwnerLabel
} from "../src/lib/workspace-selection.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personal = workspace(
  "user",
  "Personal Workspace",
  "0199ee6c-c777-7000-8000-000000004001",
  "0199ee6c-c777-7000-8000-000000004002"
);
const organization = workspace(
  "organization",
  "Platform Team",
  "0199ee6c-c777-7000-8000-000000004003",
  "0199ee6c-c777-7000-8000-000000004004"
);

testSelectionContract();
testRequestScopedAuthenticatedBoundary();
testAccessibleStateContract();

function testSelectionContract(): void {
  assert.equal(
    resolveWorkspaceSelection([organization, personal], undefined),
    personal.storageScopeId
  );
  assert.equal(
    resolveWorkspaceSelection([personal, organization], organization.storageScopeId),
    organization.storageScopeId
  );
  assert.equal(resolveWorkspaceSelection([personal], "unknown"), personal.storageScopeId);
  assert.equal(resolveWorkspaceSelection([personal], [personal.storageScopeId]), personal.storageScopeId);
  assert.equal(resolveWorkspaceSelection([], undefined), undefined);
  assert.equal(workspaceOwnerLabel(personal), "개인");
  assert.equal(workspaceOwnerLabel(organization), "조직");
}

function testRequestScopedAuthenticatedBoundary(): void {
  const layout = read("src/app/(authenticated)/layout.tsx");
  const page = read("src/app/(authenticated)/workspaces/page.tsx");

  assert.match(layout, /await createServerApiClient\(\)/u);
  assert.match(layout, /await getCurrentUser\(client\)/u);
  assert.match(layout, /getCurrentWorkspaces\(client\)/u);
  assert.match(layout, /workspaces=\{workspaces\}/u);
  assert.match(layout, /<Suspense fallback=\{<AuthenticatedShellLoading/u);
  assert.match(layout, /<AuthenticatedShellFrame/u);
  assert.match(layout, /isExplicitlySignedOut\(error\)/u);
  assert.match(layout, /redirect\("\/sign-in"\)/u);
  assert.match(page, /await createServerApiClient\(\)/u);
  assert.match(page, /await getCurrentWorkspaces\(client\)/u);
  assert.match(page, /워크스페이스를 일시적으로 사용할 수 없습니다/u);
  assert.doesNotMatch(`${layout}\n${page}`, /cache\(|globalThis\.|mock|localStorage|sessionStorage/u);
  assert.doesNotMatch(`${layout}\n${page}`, /["']use client["']/u);
}

function testAccessibleStateContract(): void {
  const page = read("src/app/(authenticated)/workspaces/page.tsx");
  const catalog = read("src/app/(authenticated)/workspaces/workspace-catalog.tsx");
  const newWorkspace = read("src/app/(authenticated)/workspaces/new/page.tsx");
  const loading = read("src/app/(authenticated)/workspaces/loading.tsx");
  const sharedLoading = read("src/app/_components/workspace-page-loading.tsx");
  const navigation = read("src/app/(authenticated)/authenticated-navigation.tsx");
  const logout = read("src/app/(authenticated)/logout-button.tsx");

  assert.match(page, /<WorkspaceScreen/u);
  assert.match(catalog, /aria-label="워크스페이스 검색 및 필터"/u);
  assert.match(catalog, /<SegmentedControl/u);
  assert.match(catalog, /value=\{filter\}/u);
  assert.match(catalog, /onValueChange=\{setFilter\}/u);
  assert.match(catalog, /href=\{`\/workspaces\/\$\{encodeURIComponent\(workspace\.storageScopeId\)\}\/projects`\}/u);
  assert.match(catalog, /export function EmptyWorkspaceScreen/u);
  assert.match(catalog, /워크스페이스 추가/u);
  assert.match(catalog, /href="\/workspaces\/new"/u);
  assert.match(newWorkspace, /href="\/organizations\?intent=create"/u);
  assert.doesNotMatch(catalog, /새 조직 만들기/u);
  assert.match(catalog, /접근 권한 다시 확인/u);
  assert.match(loading, /<WorkspacePageLoading/u);
  assert.match(sharedLoading, /aria-busy="true"/u);
  assert.match(sharedLoading, /aria-live="polite"/u);
  assert.match(loading, /워크스페이스를 불러오는 중/u);
  assert.match(navigation, /<LogoutButton\s*\/>/u);
  assert.match(navigation, /mobileMore:/u);
  assert.match(navigation, /계정 및 시스템 메뉴 열기/u);
  assert.match(navigation, /<span>더보기<\/span>/u);
  assert.match(navigation, /aria-label="모바일 계정 메뉴"/u);
  assert.match(navigation, /<LogoutButton placement="mobile"\s*\/>/u);
  assert.match(navigation, /resolveWorkspaceSelection\(workspaces, requestedScope\)/u);
  assert.match(navigation, /label: "대시보드"/u);
  assert.match(navigation, /label: "워크스페이스"/u);
  assert.match(navigation, /label: "프로젝트"/u);
  assert.match(navigation, /aria-label="현재 워크스페이스 메뉴"/u);
  assert.match(navigation, /aria-label="협업 메뉴"/u);
  assert.match(navigation, /: `\$\{workspaceBaseHref\}\/projects`/u);
  assert.doesNotMatch(navigation, /workspaceBaseHref[^\n]+[?&]workspace=/u);
  assert.match(logout, /await deleteSession/u);
  assert.match(logout, /csrfToken: readCsrfCredential\(\)/u);
  assert.match(logout, /router\.replace\("\/sign-in"\)/u);
  assert.match(logout, /role="alert"/u);
}

function workspace(
  ownerType: Workspace["ownerType"],
  displayLabel: string,
  ownerId: string,
  storageScopeId: string
): Workspace {
  return { displayLabel, ownerId, ownerType, storageScopeId };
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
