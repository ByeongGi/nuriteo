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
  assert.equal(workspaceOwnerLabel(personal), "Personal");
  assert.equal(workspaceOwnerLabel(organization), "Organization");
}

function testRequestScopedAuthenticatedBoundary(): void {
  const layout = read("src/app/(authenticated)/layout.tsx");
  const page = read("src/app/(authenticated)/workspaces/page.tsx");

  assert.match(layout, /await createServerApiClient\(\)/u);
  assert.match(layout, /await getCurrentUser\(client\)/u);
  assert.match(layout, /isExplicitlySignedOut\(error\)/u);
  assert.match(layout, /redirect\("\/sign-in"\)/u);
  assert.match(page, /await createServerApiClient\(\)/u);
  assert.match(page, /await getCurrentWorkspaces\(client\)/u);
  assert.match(page, /Workspaces are temporarily unavailable/u);
  assert.doesNotMatch(`${layout}\n${page}`, /cache\(|globalThis\.|mock|localStorage|sessionStorage/u);
  assert.doesNotMatch(`${layout}\n${page}`, /["']use client["']/u);
}

function testAccessibleStateContract(): void {
  const page = read("src/app/(authenticated)/workspaces/page.tsx");
  const loading = read("src/app/(authenticated)/workspaces/loading.tsx");

  assert.match(page, /<nav[^>]+aria-labelledby="workspace-selector-title"/u);
  assert.match(page, /aria-current=\{isSelected \? "page" : undefined\}/u);
  assert.match(page, /Personal or Organization/u);
  assert.match(page, /Ask an administrator for access/u);
  assert.match(loading, /aria-busy="true"/u);
  assert.match(loading, /aria-live="polite"/u);
  assert.match(loading, /Loading Workspaces/u);
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
