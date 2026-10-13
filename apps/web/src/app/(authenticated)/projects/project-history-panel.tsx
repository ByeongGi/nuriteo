"use client";

import {
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError,
  ApiTimeoutError,
  ApiTransportError,
  createProjectVersion,
  listProjectVersions,
  listRecoveryCheckpoints,
  reconcileProjectHistory,
  restoreProjectHistory
} from "@nuriteo/api-client";
import type {
  HistoricalReferenceKind,
  Project,
  ProjectVersion,
  RecoveryCheckpoint
} from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";

const VERSION_PAGE_SIZE = 20;

interface HistoryReference {
  readonly id: string;
  readonly kind: HistoricalReferenceKind;
  readonly label: string;
  readonly createdAt: string;
}

export interface RestoredProjectHead {
  readonly projectEtag: string;
  readonly projectVersion: number;
}

interface Props {
  readonly hasLocalDraft: boolean;
  readonly onProjectCommit: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly onReloadProject: () => void;
  readonly onResumeRestoredSave: (head: RestoredProjectHead) => void;
  readonly project: Project;
  readonly projectEtag?: string;
}

export function ProjectHistoryPanel({
  hasLocalDraft,
  onProjectCommit,
  onReloadProject,
  onResumeRestoredSave,
  project,
  projectEtag
}: Props) {
  const [versions, setVersions] = useState<readonly ProjectVersion[]>([]);
  const [recovery, setRecovery] = useState<readonly RecoveryCheckpoint[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<HistoryReference>();
  const [restoredHead, setRestoredHead] = useState<RestoredProjectHead>();
  const [status, setStatus] = useState("Loading Version and Recovery history…");
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const createAttempt = useRef<{ readonly key: string; readonly signature: string } | null>(null);
  const restoreAttemptKey = useRef<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const owner = { ownerType: project.ownerType, ownerId: project.ownerId } as const;

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(undefined);
    void Promise.all([
      listProjectVersions(createBrowserApiClient(), {
        owner, projectId: project.id, pageSize: VERSION_PAGE_SIZE
      }, { signal: controller.signal }),
      listRecoveryCheckpoints(createBrowserApiClient(), {
        owner, projectId: project.id
      }, { signal: controller.signal })
    ]).then(([versionResult, recoveryResult]) => {
      if (controller.signal.aborted) return;
      setVersions(versionResult.data.items);
      setCursor(versionResult.data.nextCursor);
      setRecovery(sortRecoveryCheckpoints(recoveryResult.data.items));
      setStatus(historyLoadedStatus(versionResult.data.items.length, recoveryResult.data.items.length));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(historyFailureMessage(cause, "read"));
        setStatus("History could not be loaded.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [project.id, project.ownerId, project.ownerType]);

  useEffect(() => {
    if (pendingRestore === undefined) return;
    confirmButtonRef.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isMutating) closeRestore();
    };
    globalThis.addEventListener("keydown", dismiss);
    return () => globalThis.removeEventListener("keydown", dismiss);
  }, [isMutating, pendingRestore]);

  async function refreshRecovery(): Promise<void> {
    const result = await listRecoveryCheckpoints(createBrowserApiClient(), { owner, projectId: project.id });
    setRecovery(sortRecoveryCheckpoints(result.data.items));
  }

  async function loadMore(): Promise<void> {
    if (cursor === null || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(undefined);
    try {
      const result = await listProjectVersions(createBrowserApiClient(), {
        owner, projectId: project.id, pageSize: VERSION_PAGE_SIZE, cursor
      });
      setVersions((current) => appendUniqueVersions(current, result.data.items));
      setCursor(result.data.nextCursor);
      setStatus(`${result.data.items.length} more Versions loaded.`);
    } catch (cause) {
      setError(historyFailureMessage(cause, "read"));
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function createVersion(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (project.state !== "active" || projectEtag === undefined || isMutating) return;
    const form = event.currentTarget;
    const name = String(new FormData(form).get("versionName") ?? "").trim();
    setIsMutating(true);
    setError(undefined);
    setStale(false);
    setStatus("Creating an explicit Version from the current Server Save…");
    const signature = `${projectEtag}\n${name}`;
    if (createAttempt.current?.signature !== signature) {
      createAttempt.current = { key: idempotencyKey("version"), signature };
    }
    const key = createAttempt.current.key;
    try {
      const result = await createProjectVersion(createBrowserApiClient(), {
        owner,
        projectId: project.id,
        name,
        projectEtag,
        idempotencyKey: key
      }, { csrfToken: readCsrfCredential() });
      setVersions((current) => appendUniqueVersions([result.data.version], current));
      createAttempt.current = null;
      form.reset();
      setStatus(result.replayed ? "Version creation was safely reconciled." : `Version “${result.data.version.name}” created.`);
    } catch (cause) {
      const isStale = staleProject(cause);
      setStale(isStale);
      setError(historyFailureMessage(cause, "create"));
      setStatus(isStale ? "Version creation blocked by a newer Server Project." : "Version creation can be retried safely.");
    } finally {
      setIsMutating(false);
    }
  }

  async function confirmRestore(): Promise<void> {
    const reference = pendingRestore;
    if (reference === undefined || project.state !== "active" || projectEtag === undefined || isMutating) return;
    setIsMutating(true);
    setError(undefined);
    setStale(false);
    setStatus(`Restoring ${reference.label} to the Server Working Head…`);
    const key = restoreAttemptKey.current ??= idempotencyKey("restore");
    try {
      const input = {
        owner,
        projectId: project.id,
        referenceKind: reference.kind,
        referenceId: reference.id,
        projectEtag,
        idempotencyKey: key
      } as const;
      let result;
      try {
        result = await restoreProjectHistory(createBrowserApiClient(), input, {
          csrfToken: readCsrfCredential()
        });
      } catch (cause) {
        if (!outcomeMayBeUnknown(cause)) throw cause;
        setStatus("Restore outcome is unknown. Reconciling with the server…");
        result = await reconcileProjectHistory(createBrowserApiClient(), {
          owner, projectId: project.id, idempotencyKey: key
        });
      }
      onProjectCommit({ projectEtag: result.projectEtag, projectVersion: result.data.projectVersion });
      setRestoredHead({ projectEtag: result.projectEtag, projectVersion: result.data.projectVersion });
      restoreAttemptKey.current = null;
      restoreTriggerRef.current = null;
      setPendingRestore(undefined);
      setStatus(`Server Working Head is now v${result.data.projectVersion}. The browser Local Draft was not replaced.`);
      void refreshRecovery().catch(() => {
        setError("The Server Working Head was restored, but Recovery checkpoints could not be refreshed. Your Local Draft remains unchanged.");
      });
    } catch (cause) {
      const isStale = staleProject(cause);
      setStale(isStale);
      setError(historyFailureMessage(cause, "restore"));
      setStatus(isStale ? "Restore blocked by a newer Server Project." : "Restore can be retried or reconciled safely.");
    } finally {
      setIsMutating(false);
    }
  }

  function openRestore(reference: HistoryReference, trigger: HTMLButtonElement): void {
    restoreTriggerRef.current = trigger;
    setPendingRestore(reference);
  }

  function closeRestore(): void {
    restoreAttemptKey.current = null;
    setPendingRestore(undefined);
    const trigger = restoreTriggerRef.current;
    restoreTriggerRef.current = null;
    globalThis.requestAnimationFrame(() => trigger?.focus());
  }

  function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab") return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [])].filter((element) => element.tabIndex >= 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const archived = project.state === "archived";
  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-4" aria-labelledby={`history-title-${project.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs uppercase tracking-wide text-muted-foreground">Server history</p>
          <h3 id={`history-title-${project.id}`} className="m-0 text-sm font-semibold">Versions &amp; Recovery</h3>
          <p className="mb-0 mt-1 text-xs text-muted-foreground">History changes the Server Working Head. It never silently replaces this browser&apos;s Local Draft.</p>
        </div>
        {archived ? <span className="rounded-md border border-border bg-subtle px-2 py-1 text-xs">Archived · read-only</span> : null}
      </header>

      <p className="mt-3 text-sm text-muted-foreground" role="status" aria-live="polite">{status}</p>
      {error ? <div className="mt-3 rounded-md border border-danger p-3" role="alert"><p className="m-0 text-sm text-danger">{error}</p>{stale ? <Button className="mt-2" type="button" size="sm" onClick={onReloadProject}>Reload latest Project</Button> : null}</div> : null}
      {restoredHead !== undefined ? (
        <div className="mt-3 rounded-md border border-warning bg-subtle p-3">
          <p className="m-0 text-sm"><strong>Server v{restoredHead.projectVersion} is restored.</strong> {hasLocalDraft ? "Your current Local Draft is still open and unchanged." : "No Local Draft is open."}</p>
          {archived ? null : <Button className="mt-2" type="button" size="sm" variant="primary" onClick={() => onResumeRestoredSave(restoredHead)}>Replace Local Draft with restored Server Save</Button>}
        </div>
      ) : null}

      {!archived ? (
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={createVersion} aria-busy={isMutating}>
          <label className="field-group min-w-64 flex-1">Version name<input name="versionName" required maxLength={200} disabled={isMutating || projectEtag === undefined} /></label>
          <Button type="submit" size="sm" disabled={isMutating || projectEtag === undefined}>{isMutating ? "Working…" : "Create Version"}</Button>
        </form>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <HistoryList
          archived={archived}
          heading="Versions"
          isLoading={isLoading}
          items={versions.map((version) => ({
            id: version.id,
            kind: "version" as const,
            label: version.name,
            createdAt: version.createdAt,
            detail: `Server v${version.sourceProjectVersion} · ${formatBytes(version.physicalBytes)} · ${version.fileCount} files`
          }))}
          isMutating={isMutating}
          onRestore={openRestore}
        />
        <HistoryList
          archived={archived}
          heading="Recovery checkpoints"
          isLoading={isLoading}
          items={recovery.map((checkpoint) => ({
            id: checkpoint.id,
            kind: "recovery" as const,
            label: `Recovery ${checkpoint.position}`,
            createdAt: checkpoint.createdAt,
            detail: `${formatBytes(checkpoint.physicalBytes)} · ${checkpoint.fileCount} files`
          }))}
          isMutating={isMutating}
          onRestore={openRestore}
        />
      </div>
      {cursor !== null ? <Button className="mt-3" type="button" size="sm" disabled={isLoadingMore} onClick={() => void loadMore()}>{isLoadingMore ? "Loading…" : "Load more Versions"}</Button> : null}

      {pendingRestore ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" role="presentation">
          <section ref={dialogRef} className="max-w-lg rounded-lg border border-danger bg-surface p-5 shadow-lg" role="alertdialog" aria-modal="true" aria-labelledby={`restore-title-${pendingRestore.id}`} aria-describedby={`restore-description-${pendingRestore.id}`} onKeyDown={trapDialogFocus}>
            <h4 id={`restore-title-${pendingRestore.id}`} className="m-0 text-base font-semibold">Restore {pendingRestore.label}?</h4>
            <p id={`restore-description-${pendingRestore.id}`} className="mt-2 text-sm text-muted-foreground">This promotes the selected snapshot to a new Server Working Head. {hasLocalDraft ? "Your open Local Draft remains unchanged until you explicitly replace it." : "The browser will not start or replace a Local Draft automatically."}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button ref={confirmButtonRef} type="button" size="sm" variant="danger" disabled={isMutating} onClick={() => void confirmRestore()}>{isMutating ? "Restoring…" : "Restore Server Working Head"}</Button>
              <Button type="button" size="sm" disabled={isMutating} onClick={closeRestore}>Cancel</Button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

interface HistoryListItem extends HistoryReference { readonly detail: string }

function HistoryList({ archived, heading, isLoading, isMutating, items, onRestore }: {
  readonly archived: boolean;
  readonly heading: string;
  readonly isLoading: boolean;
  readonly isMutating: boolean;
  readonly items: readonly HistoryListItem[];
  readonly onRestore: (item: HistoryReference, trigger: HTMLButtonElement) => void;
}) {
  return (
    <section aria-label={heading}>
      <h4 className="m-0 text-sm font-semibold">{heading}</h4>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">No {heading.toLowerCase()} yet.</p> : (
        <ol className="mt-2 grid list-none gap-2 p-0">
          {items.map((item) => <li className="rounded-md border border-muted-border p-3" key={item.id}><div className="flex items-start justify-between gap-2"><div><strong className="text-sm">{item.label}</strong><p className="m-0 text-xs text-muted-foreground">{formatTimestamp(item.createdAt)} · {item.detail}</p></div>{archived ? null : <Button type="button" size="sm" disabled={isMutating} onClick={(event) => onRestore(item, event.currentTarget)}>Restore</Button>}</div></li>)}
        </ol>
      )}
    </section>
  );
}

function idempotencyKey(action: string): string {
  return `history-${action}-${globalThis.crypto.randomUUID()}`;
}

function historyLoadedStatus(versionCount: number, recoveryCount: number): string {
  return `${versionCount} Versions and ${recoveryCount} Recovery checkpoints loaded.`;
}

function appendUniqueVersions(first: readonly ProjectVersion[], second: readonly ProjectVersion[]): readonly ProjectVersion[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => seen.has(item.id) ? false : (seen.add(item.id), true));
}

export function sortRecoveryCheckpoints(items: readonly RecoveryCheckpoint[]): readonly RecoveryCheckpoint[] {
  return [...items].sort((left, right) => {
    const instantOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return instantOrder || right.id.localeCompare(left.id);
  });
}

function staleProject(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 412 || cause.status === 428);
}

function outcomeMayBeUnknown(cause: unknown): boolean {
  return cause instanceof ApiTimeoutError ||
    cause instanceof ApiTransportError ||
    cause instanceof ApiInvalidResponseError ||
    cause instanceof ApiResponseTooLargeError ||
    (cause instanceof ApiError && (cause.code === "COMMIT_OUTCOME_UNKNOWN" || cause.code === "RECONCILIATION_REQUIRED"));
}

function historyFailureMessage(cause: unknown, action: "create" | "read" | "restore"): string {
  if (cause instanceof ApiError) {
    if (cause.status === 412 || cause.status === 428) return "The Server Project changed. Your Local Draft is preserved; reload the latest Project before retrying.";
    if (cause.status === 403) return "You do not have permission for this history action.";
    if (cause.code === "COMMIT_OUTCOME_UNKNOWN" || cause.code === "RECONCILIATION_REQUIRED") return "The server outcome is still unknown. Your Local Draft is preserved; retry reconciliation when the service is available.";
  }
  if (action === "read") return "History is temporarily unavailable. Retry without changing the Local Draft.";
  return `${action === "create" ? "Version creation" : "History restore"} did not complete. Your Local Draft is preserved; the same action can be retried safely.`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
