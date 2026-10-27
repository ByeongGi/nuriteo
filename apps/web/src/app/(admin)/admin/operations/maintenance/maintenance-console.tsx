"use client";

import { ApiError } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { tv } from "tailwind-variants";

import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminFeedback, AdminPage, AdminSection, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import type { AdminMaintenanceStatus } from "#src/app/(admin)/admin/operations/maintenance/maintenance-model.ts";
import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const maintenanceStyles = tv({
  slots: {
    badge: "inline-flex min-h-7 items-center gap-2 rounded-full border px-3 text-xs font-semibold",
    badgeDot: "size-1.5 rounded-full",
    overview: "grid grid-cols-[minmax(0,1.4fr)_minmax(22rem,1fr)] border-t border-muted-border max-[48rem]:grid-cols-1",
    stateSummary: "grid content-start gap-3 px-5 py-5 max-[37.5rem]:px-4",
    stateLabel: "m-0 text-xs font-semibold uppercase tracking-[0.08em]",
    stateTitle: "m-0 text-xl font-semibold tracking-[-0.02em] text-foreground",
    stateDescription: "m-0 max-w-[42rem] text-sm leading-6 text-muted-foreground",
    metrics: "grid grid-cols-2 border-l border-muted-border max-[48rem]:border-l-0 max-[48rem]:border-t max-[30rem]:grid-cols-1",
    metric: "grid content-center gap-1 px-5 py-4 even:border-l even:border-muted-border max-[30rem]:border-l-0 max-[30rem]:border-t max-[37.5rem]:px-4",
    metricLabel: "text-xs text-muted-foreground",
    metricValue: "text-sm font-semibold text-foreground",
    impactList: "m-0 grid list-none p-0",
    impactRow: "grid grid-cols-[9rem_minmax(0,1fr)_auto] items-center gap-4 border-t border-muted-border px-4 py-3 text-sm first:border-t-0 max-[37.5rem]:grid-cols-[minmax(0,1fr)_auto]",
    impactDescription: "text-muted-foreground max-[37.5rem]:col-span-2 max-[37.5rem]:row-start-2",
    impactStatus: "text-xs font-medium",
    actionBody: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-muted-border px-4 py-4 max-[42rem]:grid-cols-1 [&_label]:flex [&_label]:max-w-[42rem] [&_label]:items-start [&_label]:gap-2 [&_label]:text-sm",
    actionNote: "m-0 border-t border-muted-border px-4 py-3 text-xs leading-5 text-muted-foreground",
    drainingBody: "grid gap-3 border-t border-muted-border px-4 py-5",
    progressTrack: "h-1.5 overflow-hidden rounded-full bg-subtle",
    progressBar: "h-full w-1/2 rounded-full bg-warning motion-safe:animate-pulse"
  },
  variants: {
    phase: {
      active: { badge: "border-success/30 bg-success/10 text-foreground", badgeDot: "bg-success", stateLabel: "text-success" },
      draining: { badge: "border-warning/30 bg-warning/10 text-foreground", badgeDot: "bg-warning motion-safe:animate-pulse", stateLabel: "text-warning" },
      maintenance: { badge: "border-warning/30 bg-warning/10 text-foreground", badgeDot: "bg-warning", stateLabel: "text-warning" }
    },
    tone: {
      available: { impactStatus: "text-success" },
      blocked: { impactStatus: "text-warning" },
      neutral: { impactStatus: "text-muted-foreground" }
    }
  }
});

type Feedback = { readonly error: boolean; readonly text: string };
type ImpactRow = {
  readonly description: string;
  readonly label: string;
  readonly status: string;
  readonly tone: "available" | "blocked" | "neutral";
};

export function MaintenanceConsole({ initial }: { readonly initial: AdminMaintenanceStatus }) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [status, setStatus] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();

  async function update(nextEnabled: boolean) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const response = await createBrowserApiClient().put<AdminMaintenanceStatus>(
          "/admin/maintenance",
          { enabled: nextEnabled },
          { headers: { "x-csrf-token": readCsrfCredential() }, timeoutMs: 35_000 }
        );
        setStatus(response.data);
        setConfirmed(false);
        setFeedback({
          error: false,
          text: nextEnabled
            ? "유지보수 모드가 활성화되었습니다. 기존 쓰기가 종료된 뒤 쓰기 경계를 닫았습니다."
            : "유지보수 모드를 종료했습니다. 새 쓰기를 다시 허용합니다."
        });
        router.refresh();
      } catch (error) {
        setFeedback({ error: true, text: maintenanceError(error) });
      }
    });
  }

  return (
    <AdminPage id="main-content" contentWidth="standard" aria-busy={mutation.isPending}>
      <AdminPageHeader
        category="운영"
        title="점검 모드"
        description="업데이트나 복구 작업 전후의 쓰기 경계를 제어합니다. 현재 영향 범위를 확인한 뒤 운영 상태를 전환하세요."
        aside={<PhaseBadge phase={status.phase} />}
      />
      <StatusOverview status={status} />
      <ImpactSection phase={status.phase} />
      {status.phase === "draining" ? (
        <DrainingSection activeWrites={status.activeWrites} />
      ) : (
        <MaintenanceAction
          confirmed={confirmed}
          maintenanceEnabled={status.phase === "maintenance"}
          pending={mutation.isPending}
          onConfirmedChange={setConfirmed}
          onUpdate={update}
        />
      )}
      {feedback ? (
        <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>
          {feedback.text}
        </AdminFeedback>
      ) : null}
    </AdminPage>
  );
}

function PhaseBadge({ phase }: { readonly phase: AdminMaintenanceStatus["phase"] }) {
  const styles = maintenanceStyles({ phase });
  return (
    <span className={styles.badge()}>
      <span aria-hidden="true" className={styles.badgeDot()} />
      {phaseLabel(phase)}
    </span>
  );
}

function StatusOverview({ status }: { readonly status: AdminMaintenanceStatus }) {
  const styles = maintenanceStyles({ phase: status.phase });
  const content = phaseContent(status.phase);
  return (
    <AdminSection aria-labelledby="maintenance-state-title">
      <div className={styles.overview()}>
        <div className={styles.stateSummary()}>
          <p className={styles.stateLabel()}>현재 운영 상태</p>
          <h2 className={styles.stateTitle()} id="maintenance-state-title">{content.title}</h2>
          <p className={styles.stateDescription()}>{content.description}</p>
        </div>
        <dl className={styles.metrics()}>
          <div className={styles.metric()}>
            <dt className={styles.metricLabel()}>새 쓰기 요청</dt>
            <dd className={styles.metricValue()}>{status.writeAdmissionOpen ? "허용" : "차단"}</dd>
          </div>
          <div className={styles.metric()}>
            <dt className={styles.metricLabel()}>처리 중인 쓰기</dt>
            <dd className={styles.metricValue()}>{status.activeWrites}개</dd>
          </div>
        </dl>
      </div>
    </AdminSection>
  );
}

function ImpactSection({ phase }: { readonly phase: AdminMaintenanceStatus["phase"] }) {
  const rows = impactRows(phase);
  return (
    <AdminSection aria-labelledby="maintenance-impact-title">
      <AdminSectionHeading>
        <div>
          <h2 id="maintenance-impact-title">사용자 영향</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">전환 전 실제 서비스 동작을 확인하세요.</p>
        </div>
      </AdminSectionHeading>
      <ul className={maintenanceStyles().impactList()}>
        {rows.map((row) => {
          const styles = maintenanceStyles({ tone: row.tone });
          return (
            <li className={styles.impactRow()} key={row.label}>
              <strong>{row.label}</strong>
              <span className={styles.impactDescription()}>{row.description}</span>
              <span className={styles.impactStatus()}>{row.status}</span>
            </li>
          );
        })}
      </ul>
    </AdminSection>
  );
}

interface MaintenanceActionProps {
  readonly confirmed: boolean;
  readonly maintenanceEnabled: boolean;
  readonly onConfirmedChange: (checked: boolean) => void;
  readonly onUpdate: (enabled: boolean) => Promise<void>;
  readonly pending: boolean;
}

function MaintenanceAction({ confirmed, maintenanceEnabled, onConfirmedChange, onUpdate, pending }: MaintenanceActionProps) {
  const title = maintenanceEnabled ? "정상 운영 재개" : "유지보수 모드 시작";
  const label = maintenanceEnabled
    ? "유지보수 작업이 끝났으며 새 쓰기를 허용해도 안전함을 확인했습니다."
    : "새 쓰기가 거부되고 활성 쓰기가 먼저 종료되어야 함을 이해했습니다.";
  return (
    <AdminSection aria-labelledby="maintenance-action-title">
      <AdminSectionHeading>
        <div>
          <h2 id="maintenance-action-title">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {maintenanceEnabled ? "작업 완료를 확인한 뒤 서비스 쓰기를 다시 엽니다." : "영향 범위를 확인한 뒤 안전하게 쓰기를 닫습니다."}
          </p>
        </div>
      </AdminSectionHeading>
      <div className={maintenanceStyles().actionBody()} aria-busy={pending}>
        <CheckboxField checked={confirmed} disabled={pending} onCheckedChange={onConfirmedChange} label={label} />
        <Button
          className="min-w-32 max-[42rem]:w-full"
          disabled={!confirmed || pending}
          onClick={() => void onUpdate(!maintenanceEnabled)}
          type="button"
          variant={maintenanceEnabled ? "primary" : "danger"}
        >
          {actionLabel({ maintenanceEnabled, pending })}
        </Button>
      </div>
      <p className={maintenanceStyles().actionNote()}>
        최근 관리자 재인증이 필요합니다. 종료 제한 시간을 넘기면 안전을 위해 차단 상태를 유지하므로 다시 시도하기 전에 현재 상태를 새로 확인하세요.
      </p>
    </AdminSection>
  );
}

function DrainingSection({ activeWrites }: { readonly activeWrites: number }) {
  const styles = maintenanceStyles();
  return (
    <AdminSection aria-labelledby="maintenance-action-title">
      <AdminSectionHeading>
        <div>
          <h2 id="maintenance-action-title">활성 쓰기를 안전하게 종료하고 있습니다</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">새 쓰기는 이미 차단되었습니다. 이 화면을 닫아도 작업은 계속됩니다.</p>
        </div>
      </AdminSectionHeading>
      <div className={styles.drainingBody()} aria-live="polite">
        <div className={styles.progressTrack()}><div className={styles.progressBar()} /></div>
        <p className="m-0 text-sm text-muted-foreground">남은 활성 쓰기 <strong className="text-foreground">{activeWrites}개</strong>가 완료되면 읽기 전용 상태로 전환됩니다.</p>
      </div>
    </AdminSection>
  );
}

function phaseContent(phase: AdminMaintenanceStatus["phase"]): { readonly description: string; readonly title: string } {
  if (phase === "active") {
    return {
      title: "모든 기능을 정상적으로 사용할 수 있습니다",
      description: "새 쓰기와 조회가 모두 열려 있습니다. 점검 작업 전에는 사용자 영향과 진행 중인 작업을 먼저 확인하세요."
    };
  }
  if (phase === "draining") {
    return {
      title: "진행 중인 쓰기를 마무리하고 있습니다",
      description: "새 쓰기는 이미 차단했으며 기존 요청만 안전하게 끝내고 있습니다. 완료될 때까지 추가 조작은 필요하지 않습니다."
    };
  }
  return {
    title: "관리 작업이 끝날 때까지 프로젝트는 읽기 전용입니다.",
    description: "조회는 계속 사용할 수 있지만 새 저장과 변경은 거부됩니다. 작업을 마친 뒤 정상 운영을 재개하세요."
  };
}

function impactRows(phase: AdminMaintenanceStatus["phase"]): readonly ImpactRow[] {
  const readRow: ImpactRow = {
    description: "프로젝트와 운영 정보를 계속 확인할 수 있습니다.",
    label: "조회",
    status: "사용 가능",
    tone: "available"
  };
  if (phase === "active") {
    return [
      readRow,
      { description: "사용자와 시스템의 변경 요청을 정상 처리합니다.", label: "저장·수정", status: "사용 가능", tone: "available" },
      { description: "진행 중인 요청은 정상적으로 완료됩니다.", label: "진행 중 작업", status: "영향 없음", tone: "neutral" }
    ];
  }
  if (phase === "draining") {
    return [
      readRow,
      { description: "새 저장과 변경 요청은 안전을 위해 거부됩니다.", label: "저장·수정", status: "차단", tone: "blocked" },
      { description: "이미 시작된 요청이 끝날 때까지 기다리고 있습니다.", label: "진행 중 작업", status: "종료 대기", tone: "blocked" }
    ];
  }
  return [
    readRow,
    { description: "새 저장과 변경 요청은 안전을 위해 거부됩니다.", label: "저장·수정", status: "차단", tone: "blocked" },
    { description: "진행 중인 요청은 정상적으로 완료됩니다.", label: "진행 중 작업", status: "영향 없음", tone: "neutral" }
  ];
}

function actionLabel({ maintenanceEnabled, pending }: { readonly maintenanceEnabled: boolean; readonly pending: boolean }): string {
  if (pending) return maintenanceEnabled ? "재개하는 중…" : "활성 쓰기 종료 중…";
  return maintenanceEnabled ? "쓰기 재개" : "유지보수 시작";
}

function phaseLabel(phase: AdminMaintenanceStatus["phase"]): string {
  if (phase === "active") return "정상 운영";
  if (phase === "draining") return "쓰기 종료 중";
  return "읽기 전용";
}

function maintenanceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED") return "보안을 위해 다시 로그인한 뒤 유지보수 변경을 다시 시도하세요.";
    if (error.status === 403) return "이 유지보수 변경을 수행할 관리자 권한이 없습니다.";
    if (error.status === 504) return "제한 시간 안에 활성 쓰기가 종료되지 않았습니다. 인스턴스는 안전을 위해 차단 상태를 유지합니다. 계속하기 전에 상태를 새로 불러오세요.";
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") return "제어 결과를 확인할 수 없습니다. 현재 상태를 새로 불러온 뒤 다시 시도하세요.";
  }
  return "유지보수 모드를 변경하지 못했습니다. 현재 상태를 새로 불러온 뒤 다시 시도하세요.";
}
