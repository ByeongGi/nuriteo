"use client";

import {
  ApiError,
  previewAdminPolicyChange,
  previewAdminPolicyCleanup,
  updateAdminSetting
} from "@nuriteo/api-client";
import type {
  AdminPolicyCleanupPreview,
  AdminPolicyImpact,
  AdminSetting,
  AdminSettingCollection,
  AdminSettingConstraint,
  AdminSettingValue,
  AdminStatus
} from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

interface SettingDescriptor {
  readonly label: string;
  readonly description: string;
  readonly unit?: string;
}

const DESCRIPTORS: Readonly<Record<string, SettingDescriptor>> = {
  "audit.retention_days": descriptor("Audit retention", "Keep append-only security and administration events for this period.", "days"),
  "invitations.default_expiry_hours": descriptor("Invitation expiry", "Default lifetime for newly issued activation invitations.", "hours"),
  "notifications.general_retention_days": descriptor("General notification retention", "Keep ordinary in-app notifications for this period.", "days"),
  "notifications.security_retention_days": descriptor("Security notification retention", "Keep account and security notifications for this period.", "days"),
  "runtime.network.default": descriptor("Default runtime network", "Apply the selected network posture to newly created runtimes."),
  "security.reauthentication_window_minutes": descriptor("Reauthentication window", "Keep recent administrator verification valid for high-risk changes.", "minutes"),
  "tokens.default_expiry_days": descriptor("Default token expiry", "Suggested lifetime for newly issued access tokens.", "days"),
  "tokens.maximum_expiry_days": descriptor("Maximum token expiry", "Longest lifetime an administrator may select for an access token.", "days")
};

export function AdminSettings({
  cleanup,
  settings,
  status
}: {
  readonly cleanup: AdminPolicyCleanupPreview;
  readonly settings: AdminSettingCollection;
  readonly status: AdminStatus;
}) {
  const [restartRequired, setRestartRequired] = useState(status.restartRequired);

  return (
    <main id="main-content" className="workspace-page admin-settings-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Instance administration</p>
        <h1>Settings</h1>
        <p>
          Review deployment identity and change the bounded, public instance policy registry.
          Sensitive credentials are managed in their dedicated integration flows.
        </p>
      </header>

      <section className="admin-status" aria-labelledby="instance-status-title">
        <div className="admin-section-heading">
          <div>
            <p className="eyebrow">Runtime state</p>
            <h2 id="instance-status-title">Instance status</h2>
          </div>
          <span className={restartRequired ? "status-badge status-badge--warning" : "status-badge"}>
            {restartRequired ? "Restart required" : "Up to date"}
          </span>
        </div>
        <dl className="admin-status-grid">
          <StatusItem label="Release" value={status.releaseVersion} />
          <StatusItem label="Database schema" value={String(status.schemaVersion)} />
          <StatusItem label="Setting registry" value={String(status.settingRegistryVersion)} />
          <StatusItem label="Registered settings" value={String(status.settingCount)} />
        </dl>
      </section>

      <CleanupPreview initial={cleanup} />

      <section className="admin-settings" aria-labelledby="instance-settings-title">
        <div className="admin-section-heading">
          <div>
            <p className="eyebrow">Registry {settings.registryVersion}</p>
            <h2 id="instance-settings-title">Instance policy</h2>
          </div>
          <p>Each change is validated, version-checked, and recorded by Core.</p>
        </div>
        <div className="admin-setting-list">
          {settings.items.map((setting) => {
            if (setting.key === "security.mfa_enforcement" || setting.key === "security.mfa_grace_period_days") {
              return <ManagedMfaSetting key={setting.key} setting={setting} />;
            }
            if (setting.policyCategory === null) return (
              <UnsupportedSetting key={setting.key} setting={setting} />
            );
            return (
              <SettingEditor
                key={setting.key}
                initial={setting}
                descriptor={DESCRIPTORS[setting.key] ?? inferredDescriptor(setting)}
                onRestartRequired={() => setRestartRequired(true)}
              />
            );
          })}
        </div>
      </section>
    </main>
  );
}

function ManagedMfaSetting({ setting }: { readonly setting: AdminSetting }) {
  return (
    <article className="admin-setting">
      <div className="admin-setting__copy">
        <strong>{setting.key === "security.mfa_enforcement" ? "MFA enforcement" : "MFA grace period"}</strong>
        <p>This setting is managed with enrollment impact checks and active-administrator safety validation.</p>
        <code>{setting.key}</code>
        <span>{applyModeLabel(setting.applyMode)} · version {setting.version}</span>
      </div>
      <Link className="button button--sm" href="/admin/mfa">Manage MFA policy</Link>
    </article>
  );
}

function CleanupPreview({ initial }: { readonly initial: AdminPolicyCleanupPreview }) {
  const mutation = useExclusiveMutation();
  const [preview, setPreview] = useState(initial);
  const [failure, setFailure] = useState(false);

  async function refresh() {
    await mutation.run(async () => {
      setFailure(false);
      try {
        const result = await previewAdminPolicyCleanup(createBrowserApiClient(), preview.batchLimit);
        setPreview(result.data);
      } catch {
        setFailure(true);
      }
    });
  }

  return (
    <section className="admin-policy-preview" aria-labelledby="cleanup-preview-title">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">Read-only dry run</p>
          <h2 id="cleanup-preview-title">Object cleanup preview</h2>
        </div>
        <Button type="button" size="sm" onClick={refresh} disabled={mutation.isPending}>
          {mutation.isPending ? "Refreshing…" : "Refresh preview"}
        </Button>
      </div>
      <dl className="admin-status-grid">
        <StatusItem label="Garbage collection" value={preview.gcEnabled ? "Enabled" : "Disabled"} />
        <StatusItem label="Grace period" value={formatDuration(preview.gracePeriodSeconds)} />
        <StatusItem label="Eligible candidates" value={String(preview.eligibleCandidates)} />
        <StatusItem label="Expected reclaim" value={formatBytes(preview.expectedReclaimBytes)} />
      </dl>
      <p className="admin-policy-preview__note">
        This is a dry run capped at {preview.batchLimit} candidates. It never starts deletion.
      </p>
      {failure ? <p className="admin-policy-preview__error" role="alert">The cleanup preview could not be refreshed.</p> : null}
    </section>
  );
}

function SettingEditor({
  initial,
  descriptor,
  onRestartRequired
}: {
  readonly initial: AdminSetting;
  readonly descriptor: SettingDescriptor;
  readonly onRestartRequired: () => void;
}) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [setting, setSetting] = useState(initial);
  const [draft, setDraft] = useState(settingValueToDraft(initial.value));
  const [unlimited, setUnlimited] = useState(initial.value === null);
  const [impact, setImpact] = useState<{ readonly signature: string; readonly value: AdminPolicyImpact }>();
  const [feedback, setFeedback] = useState<{ message: string; reconcile: boolean; tone: "error" | "success" }>();

  async function preview(value: AdminSettingValue) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await previewAdminPolicyChange(
          createBrowserApiClient(),
          setting.key,
          value,
          { csrfToken: readCsrfCredential() }
        );
        setImpact({ signature: valueSignature(value), value: result.data });
      } catch (error) {
        setImpact(undefined);
        setFeedback(settingFailure(error));
      }
    });
  }

  async function review() {
    try {
      await preview(settingValueFromDraft(setting.constraint, draft, unlimited));
    } catch (error) {
      setFeedback(settingFailure(error));
    }
  }

  async function resetDefault() {
    const value = setting.defaultValue;
    setDraft(settingValueToDraft(value));
    setUnlimited(value === null);
    setImpact(undefined);
    await preview(value);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const value = settingValueFromDraft(setting.constraint, draft, unlimited);
        if (impact?.signature !== valueSignature(value)) {
          setFeedback({
            message: "Review the current value's impact before applying this change.",
            reconcile: false,
            tone: "error"
          });
          return;
        }
        const result = await updateAdminSetting(
          createBrowserApiClient(),
          { key: setting.key, value, version: setting.version },
          { csrfToken: readCsrfCredential() }
        );
        setSetting(result.data);
        setDraft(settingValueToDraft(result.data.value));
        setUnlimited(result.data.value === null);
        setImpact(undefined);
        if (result.data.applyMode === "server_restart") onRestartRequired();
        setFeedback({ message: `${descriptor.label} saved.`, reconcile: false, tone: "success" });
      } catch (error) {
        setFeedback(settingFailure(error));
      }
    });
  }

  const controlId = `setting-${setting.key.replaceAll(".", "-")}`;
  return (
    <form className="admin-setting" onSubmit={submit} aria-busy={mutation.isPending}>
      <div className="admin-setting__copy">
        <label htmlFor={controlId}>{descriptor.label}</label>
        <p>{descriptor.description}</p>
        <code>{setting.key}</code>
        <span>{applyModeLabel(setting.applyMode)} · version {setting.version}</span>
      </div>
      <div className="admin-setting__control">
        <SettingControl
          controlId={controlId}
          constraint={setting.constraint}
          descriptor={descriptor}
          disabled={mutation.isPending}
          draft={draft}
          unlimited={unlimited}
          onDraft={(value) => { setDraft(value); setImpact(undefined); setFeedback(undefined); }}
          onUnlimited={(value) => { setUnlimited(value); setImpact(undefined); setFeedback(undefined); }}
        />
        <div className="admin-setting__actions">
          <Button type="button" size="sm" onClick={review} disabled={mutation.isPending}>Review impact</Button>
          <Button type="button" size="sm" onClick={resetDefault} disabled={mutation.isPending || (draft === settingValueToDraft(setting.defaultValue) && unlimited === (setting.defaultValue === null))}>
            Reset to default
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={mutation.isPending || impact === undefined}>
            {mutation.isPending ? "Applying…" : "Apply change"}
          </Button>
        </div>
      </div>
      {impact ? <ImpactPreview impact={impact.value} /> : null}
      {feedback ? (
        <div className={`admin-setting__feedback admin-setting__feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          <span>{feedback.message}</span>
          {feedback.reconcile ? (
            <Button type="button" size="sm" onClick={() => router.refresh()}>
              Reload latest
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function SettingControl({
  controlId,
  constraint,
  descriptor,
  disabled,
  draft,
  unlimited,
  onDraft,
  onUnlimited
}: {
  readonly controlId: string;
  readonly constraint: AdminSettingConstraint;
  readonly descriptor: SettingDescriptor;
  readonly disabled: boolean;
  readonly draft: string;
  readonly unlimited: boolean;
  readonly onDraft: (value: string) => void;
  readonly onUnlimited: (value: boolean) => void;
}) {
  if (constraint.kind === "boolean") {
    return (
      <select id={controlId} value={draft} disabled={disabled} onChange={(event) => onDraft(event.currentTarget.value)}>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </select>
    );
  }
  if (constraint.kind === "enumeration") {
    return (
      <select id={controlId} value={draft} disabled={disabled} onChange={(event) => onDraft(event.currentTarget.value)}>
        {constraint.allowed.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
      </select>
    );
  }
  if (
    constraint.kind === "unsigned_integer" ||
    constraint.kind === "optional_unsigned_integer" ||
    constraint.kind === "retention_days"
  ) {
    const nullable = constraint.kind === "optional_unsigned_integer" ||
      (constraint.kind === "retention_days" && constraint.allowUnlimited);
    return (
      <>
        <div className="admin-number-control">
          <input
            id={controlId}
            type="number"
            min={constraint.minimum}
            max={constraint.maximum}
            step="1"
            value={draft}
            required={!unlimited}
            disabled={disabled || unlimited}
            onChange={(event) => onDraft(event.currentTarget.value)}
          />
          {descriptor.unit ? <span>{descriptor.unit}</span> : null}
        </div>
        {nullable ? (
          <label className="admin-unlimited-control">
            <input type="checkbox" checked={unlimited} disabled={disabled} onChange={(event) => onUnlimited(event.currentTarget.checked)} />
            No limit
          </label>
        ) : null}
      </>
    );
  }
  return (
    <input
      id={controlId}
      type={constraint.kind === "email_address" ? "email" : "text"}
      minLength={constraint.kind === "text" ? constraint.minimumBytes : undefined}
      maxLength={constraint.kind === "text" ? constraint.maximumBytes : undefined}
      value={draft}
      required
      disabled={disabled}
      autoComplete="off"
      onChange={(event) => onDraft(event.currentTarget.value)}
    />
  );
}

function ImpactPreview({ impact }: { readonly impact: AdminPolicyImpact }) {
  return (
    <div className="admin-policy-impact" role="status" aria-live="polite">
      <div className="admin-policy-impact__heading">
        <strong>Impact reviewed</strong>
        <span>{humanize(impact.direction)} · {humanize(impact.applyScope)}</span>
      </div>
      <dl>
        <StatusItem label="Affected resources" value={String(impact.affectedResources)} />
        <StatusItem label="Non-compliant resources" value={String(impact.nonCompliantResources)} />
        <StatusItem label="Grace period" value={impact.gracePeriodSeconds === null ? "Not applicable" : formatDuration(impact.gracePeriodSeconds)} />
      </dl>
      <p>Existing data will not be deleted automatically.</p>
      {impact.requiresRecentReauthentication ? <p className="admin-policy-impact__warning">Recent administrator reauthentication is required to apply this change.</p> : null}
    </div>
  );
}

function UnsupportedSetting({ setting }: { readonly setting: AdminSetting }) {
  return (
    <article className="admin-setting admin-setting--unsupported">
      <div className="admin-setting__copy">
        <strong>{setting.key}</strong>
        <p>This registry entry is newer than this Web release and is read-only here.</p>
        <span>{applyModeLabel(setting.applyMode)} · version {setting.version}</span>
      </div>
      <span className="status-badge status-badge--warning">Web update required</span>
    </article>
  );
}

function StatusItem({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function descriptor(label: string, description: string, unit?: string): SettingDescriptor {
  return { label, description, ...(unit === undefined ? {} : { unit }) };
}

function inferredDescriptor(setting: AdminSetting): SettingDescriptor {
  const leaf = setting.key.split(".").at(-1) ?? setting.key;
  const label = humanize(leaf);
  const category = humanize(setting.policyCategory ?? "instance");
  return descriptor(
    label.charAt(0).toUpperCase() + label.slice(1),
    `Controls ${label} for the ${category.toLowerCase()} policy.`,
    inferredUnit(setting.key)
  );
}

function inferredUnit(key: string): string | undefined {
  if (key.endsWith("_bytes")) return "bytes";
  if (key.endsWith("_minutes")) return "minutes";
  if (key.endsWith("_hours")) return "hours";
  if (key.endsWith("_days")) return "days";
  if (key.endsWith("_percent")) return "%";
  return undefined;
}

function settingValueToDraft(value: AdminSettingValue): string {
  return value === null ? "" : String(value);
}

function settingValueFromDraft(
  constraint: AdminSettingConstraint,
  draft: string,
  unlimited: boolean
): AdminSettingValue {
  if (constraint.kind === "boolean") return draft === "true";
  if (constraint.kind === "enumeration") {
    if (!constraint.allowed.includes(draft)) throw new TypeError("Select an allowed setting value.");
    return draft;
  }
  if (constraint.kind === "optional_unsigned_integer" || constraint.kind === "retention_days") {
    if (unlimited) return null;
  }
  if (
    constraint.kind === "unsigned_integer" ||
    constraint.kind === "optional_unsigned_integer" ||
    constraint.kind === "retention_days"
  ) {
    const value = Number(draft);
    if (!Number.isSafeInteger(value) || value < constraint.minimum || value > constraint.maximum) {
      throw new TypeError("The setting is outside its allowed range.");
    }
    return value;
  }
  if (draft.length === 0) throw new TypeError("Enter a setting value.");
  return draft;
}

function valueSignature(value: AdminSettingValue): string {
  return JSON.stringify(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return "Immediate";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function formatBytes(raw: string): string {
  const bytes = BigInt(raw);
  const units = [[1_073_741_824n, "GiB"], [1_048_576n, "MiB"], [1_024n, "KiB"]] as const;
  for (const [size, label] of units) {
    if (bytes >= size && bytes % size === 0n) return `${bytes / size} ${label}`;
  }
  return `${bytes} bytes`;
}

function settingFailure(error: unknown): { message: string; reconcile: boolean; tone: "error" } {
  if (error instanceof ApiError) {
    if (error.status === 412 || error.status === 428) {
      return {
        message: "This setting changed elsewhere. Reload the latest version before saving again.",
        reconcile: true,
        tone: "error"
      };
    }
    if (error.status === 403) {
      return {
        message: "Recent administrator reauthentication is required for this change.",
        reconcile: false,
        tone: "error"
      };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        message: "This value is outside the server policy. Review it and try again.",
        reconcile: false,
        tone: "error"
      };
    }
  }
  return {
    message: error instanceof TypeError
      ? error.message
      : "The setting could not be saved. No change was confirmed.",
    reconcile: false,
    tone: "error"
  };
}

function applyModeLabel(mode: AdminSetting["applyMode"]): string {
  if (mode === "live") return "Applies immediately";
  if (mode === "new_runtime") return "Applies to new runtimes";
  return "Requires server restart";
}
