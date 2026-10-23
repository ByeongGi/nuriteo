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

import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { SwitchField } from "#src/components/ui/switch.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminPage, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

interface SettingDescriptor {
  readonly label: string;
  readonly description: string;
  readonly unit?: string;
}

const DESCRIPTORS: Readonly<Record<string, SettingDescriptor>> = {
  "audit.retention_days": descriptor("감사 로그 보존", "보안 및 관리자 이벤트를 보존하는 기간입니다.", "일"),
  "invitations.default_expiry_hours": descriptor("초대 만료", "새 계정 활성화 초대의 기본 유효 기간입니다.", "시간"),
  "notifications.general_retention_days": descriptor("일반 알림 보존", "일반 앱 알림을 보존하는 기간입니다.", "일"),
  "notifications.security_retention_days": descriptor("보안 알림 보존", "계정 및 보안 알림을 보존하는 기간입니다.", "일"),
  "runtime.network.default": descriptor("기본 런타임 네트워크", "새 런타임에 적용할 네트워크 정책입니다."),
  "security.reauthentication_window_minutes": descriptor("재인증 유효 시간", "민감한 변경에 사용할 최근 관리자 인증의 유효 시간입니다.", "분"),
  "tokens.default_expiry_days": descriptor("기본 토큰 만료", "새 액세스 토큰에 제안할 기본 유효 기간입니다.", "일"),
  "tokens.maximum_expiry_days": descriptor("최대 토큰 만료", "관리자가 선택할 수 있는 액세스 토큰의 최대 유효 기간입니다.", "일")
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
    <AdminPage id="main-content">
      <AdminPageHeader
        category="인스턴스 설정"
        title="인스턴스 설정"
        description="현재 설정과 변경 영향을 같은 맥락에서 검토하세요. 민감한 자격 증명은 각 연동 화면에서 별도로 관리합니다."
        aside={<span className={restartRequired ? "status-badge status-badge--warning" : "status-badge"}>{restartRequired ? "재시작 필요" : "최신 상태"}</span>}
      />

      <section className="admin-status" aria-labelledby="instance-status-title">
        <AdminSectionHeading>
          <div>
            <p className="eyebrow">런타임 상태</p>
            <h2 id="instance-status-title">인스턴스 상태</h2>
          </div>
          <span className={restartRequired ? "status-badge status-badge--warning" : "status-badge"}>
            {restartRequired ? "재시작 필요" : "최신 상태"}
          </span>
        </AdminSectionHeading>
        <dl className="admin-status-grid">
          <StatusItem label="릴리스" value={status.releaseVersion} />
          <StatusItem label="데이터베이스 스키마" value={String(status.schemaVersion)} />
          <StatusItem label="설정 레지스트리" value={String(status.settingRegistryVersion)} />
          <StatusItem label="등록된 설정" value={String(status.settingCount)} />
        </dl>
      </section>

      <CleanupPreview initial={cleanup} />

      <section className="admin-settings" aria-labelledby="instance-settings-title">
        <AdminSectionHeading>
          <div>
            <p className="eyebrow">REGISTRY {settings.registryVersion}</p>
            <h2 id="instance-settings-title">인스턴스 정책</h2>
          </div>
          <p>모든 변경은 유효성 및 버전을 확인한 뒤 감사 기록에 남습니다.</p>
        </AdminSectionHeading>
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
    </AdminPage>
  );
}

function ManagedMfaSetting({ setting }: { readonly setting: AdminSetting }) {
  return (
    <article className="admin-setting">
      <div className="admin-setting__copy">
        <strong>{setting.key === "security.mfa_enforcement" ? "MFA 적용 정책" : "MFA 유예 기간"}</strong>
        <p>등록 영향과 활성 관리자 안전 검증을 포함하는 전용 화면에서 관리합니다.</p>
        <code>{setting.key}</code>
        <span>{applyModeLabel(setting.applyMode)} · version {setting.version}</span>
      </div>
      <Link className="button button--sm" href="/admin/authentication/mfa">MFA 정책 관리</Link>
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
      <AdminSectionHeading>
        <div>
          <p className="eyebrow">읽기 전용 사전 점검</p>
          <h2 id="cleanup-preview-title">오브젝트 정리 미리보기</h2>
        </div>
        <Button type="button" size="sm" onClick={refresh} disabled={mutation.isPending}>
          {mutation.isPending ? "새로 고치는 중…" : "미리보기 새로 고침"}
        </Button>
      </AdminSectionHeading>
      <dl className="admin-status-grid">
        <StatusItem label="가비지 컬렉션" value={preview.gcEnabled ? "켜짐" : "꺼짐"} />
        <StatusItem label="유예 기간" value={formatDuration(preview.gracePeriodSeconds)} />
        <StatusItem label="정리 대상" value={String(preview.eligibleCandidates)} />
        <StatusItem label="예상 회수량" value={formatBytes(preview.expectedReclaimBytes)} />
      </dl>
      <p className="admin-policy-preview__note">
        최대 {preview.batchLimit}개 후보를 확인하는 읽기 전용 점검입니다. 실제 삭제는 시작하지 않습니다.
      </p>
      {failure ? <p className="admin-policy-preview__error" role="alert">정리 미리보기를 새로 고치지 못했습니다.</p> : null}
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
            message: "변경을 적용하기 전에 현재 값의 영향을 검토해 주세요.",
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
        setFeedback({ message: `${descriptor.label} 설정을 저장했습니다.`, reconcile: false, tone: "success" });
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
        <span>{applyModeLabel(setting.applyMode)} · 버전 {setting.version}</span>
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
          <Button type="button" size="sm" onClick={review} disabled={mutation.isPending}>영향 검토</Button>
          <Button type="button" size="sm" onClick={resetDefault} disabled={mutation.isPending || (draft === settingValueToDraft(setting.defaultValue) && unlimited === (setting.defaultValue === null))}>
            기본값으로 초기화
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={mutation.isPending || impact === undefined}>
            {mutation.isPending ? "적용 중…" : "변경 적용"}
          </Button>
        </div>
      </div>
      {impact ? <ImpactPreview impact={impact.value} /> : null}
      {feedback ? (
        <div className={`admin-setting__feedback admin-setting__feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          <span>{feedback.message}</span>
          {feedback.reconcile ? (
            <Button type="button" size="sm" onClick={() => router.refresh()}>
              최신 상태 불러오기
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
      <SwitchField
        id={controlId}
        label={descriptor.label}
        checked={draft === "true"}
        disabled={disabled}
        onCheckedChange={(checked) => onDraft(String(checked))}
      />
    );
  }
  if (constraint.kind === "enumeration") {
    return (
      <SelectField
        id={controlId}
        label={descriptor.label}
        labelHidden
        options={constraint.allowed.map((value) => ({ value, label: humanize(value) }))}
        value={draft}
        disabled={disabled}
        onValueChange={onDraft}
      />
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
          <Input
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
          <CheckboxField checked={unlimited} disabled={disabled} onCheckedChange={onUnlimited} label="제한 없음" />
        ) : null}
      </>
    );
  }
  return (
    <Input
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
        <strong>영향 검토 완료</strong>
        <span>{humanize(impact.direction)} · {humanize(impact.applyScope)}</span>
      </div>
      <dl>
        <StatusItem label="영향받는 리소스" value={String(impact.affectedResources)} />
        <StatusItem label="정책 미준수 리소스" value={String(impact.nonCompliantResources)} />
        <StatusItem label="유예 기간" value={impact.gracePeriodSeconds === null ? "해당 없음" : formatDuration(impact.gracePeriodSeconds)} />
      </dl>
      <p>기존 데이터는 자동으로 삭제되지 않습니다.</p>
      {impact.requiresRecentReauthentication ? <p className="admin-policy-impact__warning">이 변경을 적용하려면 최근 관리자 재인증이 필요합니다.</p> : null}
    </div>
  );
}

function UnsupportedSetting({ setting }: { readonly setting: AdminSetting }) {
  return (
    <article className="admin-setting admin-setting--unsupported">
      <div className="admin-setting__copy">
        <strong>{setting.key}</strong>
        <p>이 레지스트리 항목은 현재 웹 릴리스보다 새 버전이어서 읽기 전용으로 표시됩니다.</p>
        <span>{applyModeLabel(setting.applyMode)} · 버전 {setting.version}</span>
      </div>
      <span className="status-badge status-badge--warning">웹 업데이트 필요</span>
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
    `${category.toLowerCase()} 정책의 ${label} 값을 제어합니다.`,
    inferredUnit(setting.key)
  );
}

function inferredUnit(key: string): string | undefined {
  if (key.endsWith("_bytes")) return "바이트";
  if (key.endsWith("_minutes")) return "분";
  if (key.endsWith("_hours")) return "시간";
  if (key.endsWith("_days")) return "일";
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
    if (!constraint.allowed.includes(draft)) throw new TypeError("허용된 설정 값을 선택해 주세요.");
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
      throw new TypeError("설정 값이 허용 범위를 벗어났습니다.");
    }
    return value;
  }
  if (draft.length === 0) throw new TypeError("설정 값을 입력해 주세요.");
  return draft;
}

function valueSignature(value: AdminSettingValue): string {
  return JSON.stringify(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return "즉시";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}일`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}시간`;
  if (seconds % 60 === 0) return `${seconds / 60}분`;
  return `${seconds}초`;
}

function formatBytes(raw: string): string {
  const bytes = BigInt(raw);
  const units = [[1_073_741_824n, "GiB"], [1_048_576n, "MiB"], [1_024n, "KiB"]] as const;
  for (const [size, label] of units) {
    if (bytes >= size && bytes % size === 0n) return `${bytes / size} ${label}`;
  }
  return `${bytes} 바이트`;
}

function settingFailure(error: unknown): { message: string; reconcile: boolean; tone: "error" } {
  if (error instanceof ApiError) {
    if (error.status === 412 || error.status === 428) {
      return {
        message: "다른 곳에서 설정이 변경되었습니다. 최신 상태를 불러온 뒤 다시 저장해 주세요.",
        reconcile: true,
        tone: "error"
      };
    }
    if (error.status === 403) {
      return {
        message: "이 변경에는 최근 관리자 재인증이 필요합니다.",
        reconcile: false,
        tone: "error"
      };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        message: "서버 정책에서 허용하지 않는 값입니다. 값을 확인한 뒤 다시 시도해 주세요.",
        reconcile: false,
        tone: "error"
      };
    }
  }
  return {
    message: error instanceof TypeError
      ? error.message
      : "설정을 안전하게 저장하지 못했습니다. 변경 사항은 확정되지 않았습니다.",
    reconcile: false,
    tone: "error"
  };
}

function applyModeLabel(mode: AdminSetting["applyMode"]): string {
  if (mode === "live") return "즉시 적용";
  if (mode === "new_runtime") return "새 런타임에 적용";
  return "서버 재시작 필요";
}
