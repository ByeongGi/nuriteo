"use client";

import { ApiError, updateAdminSetting } from "@nuriteo/api-client";
import type {
  AdminSetting,
  AdminSettingCollection,
  AdminSettingValue,
  AdminStatus
} from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

interface NumberDescriptor {
  readonly kind: "number";
  readonly label: string;
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: string;
  readonly nullable?: boolean;
}

interface SelectDescriptor {
  readonly kind: "select";
  readonly label: string;
  readonly description: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

type SettingDescriptor = NumberDescriptor | SelectDescriptor;

const DESCRIPTORS: Readonly<Record<string, SettingDescriptor>> = {
  "audit.retention_days": numberDescriptor(
    "Audit retention",
    "Keep append-only security and administration events for this period.",
    30,
    3_650,
    "days",
    true
  ),
  "invitations.default_expiry_hours": numberDescriptor(
    "Invitation expiry",
    "Default lifetime for newly issued activation invitations.",
    1,
    720,
    "hours"
  ),
  "notifications.general_retention_days": numberDescriptor(
    "General notification retention",
    "Keep ordinary in-app notifications for this period.",
    30,
    365,
    "days"
  ),
  "notifications.security_retention_days": numberDescriptor(
    "Security notification retention",
    "Keep account and security notifications for this period.",
    90,
    1_825,
    "days",
    true
  ),
  "runtime.network.default": {
    kind: "select",
    label: "Default runtime network",
    description: "Apply the selected network posture to newly created runtimes.",
    options: [
      { value: "browser_direct", label: "Browser direct" },
      { value: "runtime_offline", label: "Runtime offline" }
    ]
  },
  "security.mfa_enforcement": {
    kind: "select",
    label: "MFA enforcement",
    description: "Choose which local accounts must enroll in multi-factor authentication.",
    options: [
      { value: "off", label: "Optional" },
      { value: "administrators", label: "Administrators" },
      { value: "all_local_users", label: "All local users" }
    ]
  },
  "security.mfa_grace_period_days": numberDescriptor(
    "MFA grace period",
    "Allow affected local accounts this long to complete enrollment.",
    0,
    30,
    "days"
  ),
  "security.reauthentication_window_minutes": numberDescriptor(
    "Reauthentication window",
    "Keep recent administrator verification valid for routine high-risk changes.",
    15,
    120,
    "minutes"
  ),
  "tokens.default_expiry_days": numberDescriptor(
    "Default token expiry",
    "Suggested lifetime for newly issued personal access tokens.",
    1,
    365,
    "days"
  ),
  "tokens.maximum_expiry_days": numberDescriptor(
    "Maximum token expiry",
    "Longest lifetime an administrator may select for a personal access token.",
    1,
    365,
    "days"
  )
};

export function AdminSettings({
  settings,
  status
}: {
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
            const descriptor = DESCRIPTORS[setting.key];
            return descriptor === undefined ? (
              <UnsupportedSetting key={setting.key} setting={setting} />
            ) : (
              <SettingEditor
                key={setting.key}
                initial={setting}
                descriptor={descriptor}
                onRestartRequired={() => setRestartRequired(true)}
              />
            );
          })}
        </div>
      </section>
    </main>
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
  const [feedback, setFeedback] = useState<{ message: string; reconcile: boolean; tone: "error" | "success" }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const value = settingValueFromDraft(descriptor, draft, unlimited);
        const result = await updateAdminSetting(
          createBrowserApiClient(),
          { key: setting.key, value, version: setting.version },
          { csrfToken: readCsrfCredential() }
        );
        setSetting(result.data);
        setDraft(settingValueToDraft(result.data.value));
        setUnlimited(result.data.value === null);
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
        {descriptor.kind === "select" ? (
          <select
            id={controlId}
            value={draft}
            disabled={mutation.isPending}
            onChange={(event) => setDraft(event.currentTarget.value)}
          >
            {descriptor.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : (
          <>
            <div className="admin-number-control">
              <input
                id={controlId}
                type="number"
                min={descriptor.minimum}
                max={descriptor.maximum}
                step="1"
                value={draft}
                required={!unlimited}
                disabled={mutation.isPending || unlimited}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <span>{descriptor.unit}</span>
            </div>
            {descriptor.nullable ? (
              <label className="admin-unlimited-control">
                <input
                  type="checkbox"
                  checked={unlimited}
                  disabled={mutation.isPending}
                  onChange={(event) => setUnlimited(event.currentTarget.checked)}
                />
                Keep indefinitely
              </label>
            ) : null}
          </>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
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

function numberDescriptor(
  label: string,
  description: string,
  minimum: number,
  maximum: number,
  unit: string,
  nullable = false
): NumberDescriptor {
  return { kind: "number", label, description, minimum, maximum, unit, nullable };
}

function settingValueToDraft(value: AdminSettingValue): string {
  return value === null ? "" : String(value);
}

function settingValueFromDraft(
  descriptor: SettingDescriptor,
  draft: string,
  unlimited: boolean
): AdminSettingValue {
  if (descriptor.kind === "select") return draft;
  if (descriptor.nullable && unlimited) return null;
  const value = Number(draft);
  if (!Number.isSafeInteger(value) || value < descriptor.minimum || value > descriptor.maximum) {
    throw new TypeError("The setting is outside its allowed range.");
  }
  return value;
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
