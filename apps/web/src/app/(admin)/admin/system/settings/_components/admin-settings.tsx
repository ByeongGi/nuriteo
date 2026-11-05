"use client";

import type { AdminPolicyImpact, AdminSetting, AdminSettingCollection, AdminSettingConstraint, AdminStatus } from "@nuriteo/api-client";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminPage, AdminSection, AdminSectionHeading } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { settingValueToDraft, useAdminSettings, useSettingEditor } from "@/app/(admin)/admin/system/settings/_hooks/use-admin-settings.ts";
import { buttonVariants } from "@/components/ui/button.styles.ts";
import { Button } from "@/components/ui/button.tsx";
import { SelectField } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";

const adminSettingsStyles = tv({
  slots: {
    status: "shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground",
    statusGrid: "m-0 grid grid-cols-2 border-t border-muted-border max-[37.5rem]:grid-cols-1 [&>div]:min-w-0 [&>div]:border-b [&>div]:border-muted-border [&>div]:px-5 [&>div]:py-3.5 [&>div:nth-child(odd)]:border-r [&>div:nth-last-child(-n+2)]:border-b-0 max-[37.5rem]:[&>div]:border-r-0 max-[37.5rem]:[&>div]:border-b max-[37.5rem]:[&>div:last-child]:border-b-0 [&_dt]:m-0 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere]",
    settingList: "border-t border-muted-border",
    filterBar: "grid grid-cols-[minmax(0,1fr)_14rem] gap-3 border-t border-muted-border px-4 py-3 max-[40rem]:grid-cols-1",
    settingGroups: "grid min-w-0",
    category: "min-w-0 border-t border-muted-border first:border-t-0",
    categoryHeader: "flex items-center justify-between gap-3 bg-subtle/55 px-4 py-2.5 [&_h3]:m-0 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground [&_span]:text-xs [&_span]:text-muted-foreground",
    setting: "m-0 grid grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] gap-6 border-t border-muted-border px-4 py-3.5 first:border-t-0 max-[48rem]:grid-cols-1 max-[48rem]:items-stretch",
    copy: "grid min-w-0 content-start gap-1 [&>label]:text-sm [&>label]:font-medium [&>strong]:text-sm [&>strong]:font-medium [&_p]:m-0 [&_p]:text-xs [&_p]:text-muted-foreground [&>span]:text-xs [&>span]:text-muted-foreground [&_code]:w-fit [&_code]:max-w-full [&_code]:text-xs [&_code]:text-subtle-foreground [&_code]:[overflow-wrap:anywhere]",
    control: "grid min-w-0 content-start gap-3",
    actions: "flex flex-wrap gap-2 max-[37.5rem]:[&_[data-slot=button]]:w-full",
    feedback: "col-span-full flex items-center justify-between gap-3 rounded-md border bg-subtle p-3 text-sm max-[37.5rem]:flex-col max-[37.5rem]:items-stretch",
    numberControl: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 [&_span]:text-sm [&_span]:text-muted-foreground",
    impact: "col-span-full grid gap-3 rounded-md border border-border bg-subtle p-4 [&_dl]:m-0 [&_dl]:grid [&_dl]:grid-cols-3 [&_dl]:gap-3 max-[37.5rem]:[&_dl]:grid-cols-1 [&_dt]:m-0 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dd]:mt-1 [&_dd]:font-mono",
    impactHeading: "flex justify-between gap-3 max-[37.5rem]:flex-col [&_span]:text-sm [&_span]:text-muted-foreground",
    empty: "m-0 border-t border-muted-border px-4 py-10 text-center text-sm text-muted-foreground"
  },
  variants: {
    warning: { true: { status: "border-warning" } },
    feedbackTone: {
      error: { feedback: "border-danger text-danger" },
      success: { feedback: "border-success" }
    }
  }
});

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
  "object_storage.gc_enabled": descriptor("자동 오브젝트 정리", "참조되지 않는 오브젝트를 유예 기간 이후 자동 정리합니다."),
  "runtime.network.default": descriptor("기본 런타임 네트워크", "새 런타임에 적용할 네트워크 정책입니다."),
  "security.reauthentication_window_minutes": descriptor("재인증 유효 시간", "민감한 변경에 사용할 최근 관리자 인증의 유효 시간입니다.", "분"),
  "tokens.default_expiry_days": descriptor("기본 토큰 만료", "새 액세스 토큰에 제안할 기본 유효 기간입니다.", "일"),
  "tokens.maximum_expiry_days": descriptor("최대 토큰 만료", "관리자가 선택할 수 있는 액세스 토큰의 최대 유효 기간입니다.", "일")
};

const SETTING_CATEGORIES = [
  { value: "all", label: "전체 설정" },
  { value: "security", label: "보안" },
  { value: "identity", label: "인증과 세션" },
  { value: "workspace", label: "워크스페이스" },
  { value: "project", label: "프로젝트" },
  { value: "runtime", label: "런타임" },
  { value: "object_storage", label: "오브젝트 스토리지" },
  { value: "notification", label: "알림" },
  { value: "token", label: "액세스 토큰" },
  { value: "audit", label: "감사 로그" },
  { value: "unsupported", label: "업데이트 필요" }
] as const;

export function AdminSettings({
  settings,
  status
}: {
  readonly settings: AdminSettingCollection;
  readonly status: AdminStatus;
}) {
  const { category, onCategory, onQueryChange, onRestartRequired, query, restartRequired } = useAdminSettings(status);
  const styles = adminSettingsStyles({ warning: restartRequired });
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const visibleSettings = settings.items.filter((setting) => {
    const settingCategory = setting.policyCategory ?? "unsupported";
    if (category !== "all" && settingCategory !== category) return false;
    if (normalizedQuery.length === 0) return true;
    const descriptor = DESCRIPTORS[setting.key] ?? inferredDescriptor(setting);
    return `${descriptor.label} ${descriptor.description} ${setting.key}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery);
  });
  const visibleCategories = SETTING_CATEGORIES
    .filter((item) => item.value !== "all")
    .map((item) => ({ ...item, settings: visibleSettings.filter((setting) => (setting.policyCategory ?? "unsupported") === item.value) }))
    .filter((item) => item.settings.length > 0);

  return (
    <AdminPage id="main-content" contentWidth="standard">
      <AdminPageHeader
        category="시스템"
        title="인스턴스 설정"
        description="현재 설정과 변경 영향을 같은 맥락에서 검토하세요. 민감한 자격 증명은 각 연동 화면에서 별도로 관리합니다."
        aside={<span className={styles.status()}>{restartRequired ? "재시작 필요" : "최신 상태"}</span>}
      />

      <AdminSection aria-labelledby="instance-status-title">
        <AdminSectionHeading>
          <div>
            <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">런타임 상태</p>
            <h2 id="instance-status-title">인스턴스 상태</h2>
          </div>
          <span className={styles.status()}>
            {restartRequired ? "재시작 필요" : "최신 상태"}
          </span>
        </AdminSectionHeading>
        <dl className={styles.statusGrid()}>
          <StatusItem label="릴리스" value={status.releaseVersion} />
          <StatusItem label="데이터베이스 스키마" value={String(status.schemaVersion)} />
          <StatusItem label="설정 레지스트리" value={String(status.settingRegistryVersion)} />
          <StatusItem label="등록된 설정" value={String(status.settingCount)} />
        </dl>
      </AdminSection>

      <AdminSection aria-labelledby="instance-settings-title">
        <AdminSectionHeading>
          <div>
            <p className="m-0 mb-3 text-xs font-semibold tracking-[0.08em] text-accent-foreground">설정 레지스트리 {settings.registryVersion}</p>
            <h2 id="instance-settings-title">인스턴스 정책</h2>
          </div>
          <p>모든 변경은 유효성 및 버전을 확인한 뒤 감사 기록에 남습니다.</p>
        </AdminSectionHeading>
        <div className={styles.filterBar()} role="search" aria-label="인스턴스 설정 찾기">
          <SearchField density="compact" label="설정 검색" placeholder="이름이나 설정 키로 검색" value={query} onChange={onQueryChange} />
          <SelectField density="compact" label="설정 영역" labelHidden options={SETTING_CATEGORIES} value={category} onValueChange={onCategory} />
        </div>
        {visibleCategories.length === 0 ? <p className={styles.empty()}>조건에 맞는 설정이 없습니다.</p> : (
          <div className={styles.settingGroups()}>
            {visibleCategories.map((group) => (
              <section className={styles.category()} key={group.value} aria-labelledby={`settings-category-${group.value}`}>
                <header className={styles.categoryHeader()}>
                  <h3 id={`settings-category-${group.value}`}>{group.label}</h3>
                  <span>{group.settings.length}개</span>
                </header>
                <div>
                  {group.settings.map((setting) => <SettingEntry key={setting.key} setting={setting} onRestartRequired={onRestartRequired} />)}
                </div>
              </section>
            ))}
          </div>
        )}
      </AdminSection>
    </AdminPage>
  );
}

function SettingEntry({ onRestartRequired, setting }: { readonly onRestartRequired: () => void; readonly setting: AdminSetting }) {
  if (setting.key === "security.mfa_enforcement" || setting.key === "security.mfa_grace_period_days") {
    return <ManagedMfaSetting setting={setting} />;
  }
  if (setting.policyCategory === null) return <UnsupportedSetting setting={setting} />;
  return (
    <SettingEditor
      initial={setting}
      descriptor={DESCRIPTORS[setting.key] ?? inferredDescriptor(setting)}
      onRestartRequired={onRestartRequired}
    />
  );
}

function ManagedMfaSetting({ setting }: { readonly setting: AdminSetting }) {
  const styles = adminSettingsStyles();
  return (
    <article className={styles.setting()}>
      <div className={styles.copy()}>
        <strong>{setting.key === "security.mfa_enforcement" ? "MFA 적용 정책" : "MFA 유예 기간"}</strong>
        <p>등록 영향과 활성 관리자 안전 검증을 포함하는 전용 화면에서 관리합니다.</p>
        <code>{setting.key}</code>
        <span>{applyModeLabel(setting.applyMode)} · version {setting.version}</span>
      </div>
      <Link className={buttonVariants({ size: "sm", variant: "secondary" })} href="/admin/authentication/mfa">MFA 정책 관리</Link>
    </article>
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
  const {
    draft,
    feedback,
    impact,
    mutation,
    onDraft,
    onUnlimited,
    refresh,
    resetDefault,
    review,
    setting,
    submit,
    unlimited
  } = useSettingEditor({ descriptor, initial, onRestartRequired });

  const controlId = `setting-${setting.key.replaceAll(".", "-")}`;
  const styles = adminSettingsStyles({ feedbackTone: feedback?.tone });
  return (
    <form className={styles.setting()} onSubmit={submit} aria-busy={mutation.isPending}>
      <div className={styles.copy()}>
        <label htmlFor={controlId}>{descriptor.label}</label>
        <p>{descriptor.description}</p>
        <code>{setting.key}</code>
        <span>{applyModeLabel(setting.applyMode)} · 버전 {setting.version}</span>
      </div>
      <div className={styles.control()}>
        <SettingControl
          controlId={controlId}
          constraint={setting.constraint}
          descriptor={descriptor}
          disabled={mutation.isPending}
          draft={draft}
          unlimited={unlimited}
          onDraft={onDraft}
          onUnlimited={onUnlimited}
        />
        <div className={styles.actions()}>
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
        <div className={styles.feedback()} role={(function () {
    if (feedback.tone === "error") {
        return ("alert");
    }
    return ("status");
})()}>
          <span>{feedback.message}</span>
          {(function () {
    if (feedback.reconcile) {
        return ((
            <Button type="button" size="sm" onClick={refresh}>
              최신 상태 불러오기
            </Button>
          ));
    }
    return (null);
})()}
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
      <SegmentedControl
        aria-label={descriptor.label}
        disabled={disabled}
        options={[{ value: "false", label: "사용 안 함" }, { value: "true", label: "사용" }]}
        value={draft === "true" ? "true" : "false"}
        width="full"
        onValueChange={onDraft}
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
        <div className={adminSettingsStyles().numberControl()}>
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
          <SegmentedControl aria-label={`${descriptor.label} 제한 방식`} disabled={disabled} options={[{ value: "limited", label: "기간 지정" }, { value: "unlimited", label: "제한 없음" }]} value={(function () {
    if (unlimited) {
        return ("unlimited");
    }
    return ("limited");
})()} width="full" onValueChange={(value) => onUnlimited(value === "unlimited")} />
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
  const styles = adminSettingsStyles();
  return (
    <div className={styles.impact()} role="status" aria-live="polite">
      <div className={styles.impactHeading()}>
        <strong>영향 검토 완료</strong>
        <span>{humanize(impact.direction)} · {humanize(impact.applyScope)}</span>
      </div>
      <dl>
        <StatusItem label="영향받는 리소스" value={String(impact.affectedResources)} />
        <StatusItem label="정책 미준수 리소스" value={String(impact.nonCompliantResources)} />
        <StatusItem label="유예 기간" value={impact.gracePeriodSeconds === null ? "해당 없음" : formatDuration(impact.gracePeriodSeconds)} />
      </dl>
      <p>기존 데이터는 자동으로 삭제되지 않습니다.</p>
      {impact.requiresRecentReauthentication ? <p className="m-0 text-sm text-danger">이 변경을 적용하려면 최근 관리자 재인증이 필요합니다.</p> : null}
    </div>
  );
}

function UnsupportedSetting({ setting }: { readonly setting: AdminSetting }) {
  const styles = adminSettingsStyles();
  return (
    <article className={styles.setting({ className: "items-start" })}>
      <div className={styles.copy()}>
        <strong>{setting.key}</strong>
        <p>이 레지스트리 항목은 현재 웹 릴리스보다 새 버전이어서 읽기 전용으로 표시됩니다.</p>
        <span>{applyModeLabel(setting.applyMode)} · 버전 {setting.version}</span>
      </div>
      <span className={adminSettingsStyles({ warning: true }).status()}>웹 업데이트 필요</span>
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

function applyModeLabel(mode: AdminSetting["applyMode"]): string {
  if (mode === "live") return "즉시 적용";
  if (mode === "new_runtime") return "새 런타임에 적용";
  return "서버 재시작 필요";
}
