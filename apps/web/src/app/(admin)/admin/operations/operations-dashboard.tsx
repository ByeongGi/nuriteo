import type {
  AdminCleanupQueue,
  AdminDependencyCategory,
  AdminOperations,
  AdminOperationsState,
  AdminUsage
} from "@nuriteo/api-client";
import { tv } from "tailwind-variants";

import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminPage, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import { SupportBundleDownload } from "#src/app/(admin)/admin/operations/support-bundle-download.tsx";

const operationStyles = tv({
  slots: {
    summary: "grid shrink-0 justify-items-end gap-2 text-xs text-subtle-foreground max-[37.5rem]:justify-items-start",
    grid: "mt-4 grid grid-cols-2 gap-3 max-[37.5rem]:grid-cols-1",
    card: "min-w-0 overflow-hidden rounded-lg border border-muted-border bg-surface",
    cardText: "m-0 border-t border-muted-border px-4 py-3 text-sm",
    cardNote: "m-0 border-t border-muted-border px-4 py-3 text-xs text-muted-foreground",
    metrics: "m-0 grid grid-cols-2 border-t border-muted-border max-[37.5rem]:grid-cols-1 [&>div]:min-w-0 [&>div]:border-r [&>div]:border-b [&>div]:border-muted-border [&>div]:px-4 [&>div]:py-3 [&>div:nth-child(2n)]:border-r-0 max-[37.5rem]:[&>div]:border-r-0 [&_dt]:m-0 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere]",
    status: "shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground data-[state=degraded]:border-warning data-[state=unavailable]:border-warning"
  },
  variants: {
    wide: { true: { card: "col-span-full" } },
    usage: { true: { metrics: "grid-cols-3 [&>div:nth-child(2n)]:border-r [&>div:nth-child(3n)]:border-r-0 max-[37.5rem]:grid-cols-1 max-[37.5rem]:[&>div]:border-r-0" } }
  }
});

export function OperationsDashboard({ operations }: { readonly operations: AdminOperations }) {
  const styles = operationStyles();
  return (
    <AdminPage id="main-content">
      <AdminPageHeader
        category="운영 현황"
        title="운영 현황"
        description={<>서비스 상태, 정리 작업과 전체 인스턴스 사용량을 한눈에 확인하세요. 진단 정보는 안전한 운영 범위만 표시합니다.</>}
        aside={<div className={styles.summary()}>
          <StateBadge state={operations.overallState} />
          <time dateTime={operations.generatedAt}>
            {formatTimestamp(operations.generatedAt)} 업데이트
          </time>
        </div>}
      />

      <div className={styles.grid()}>
        <section className={styles.card()} aria-labelledby="dependency-health-title">
          <CardHeading
            eyebrow="READINESS"
            title="핵심 의존성"
            id="dependency-health-title"
            state={operations.dependencies.state}
          />
          <p className={styles.cardText()}>
            {operations.dependencies.category === null
              ? "데이터베이스 스키마와 오브젝트 스토리지가 정상입니다."
              : dependencyMessage(operations.dependencies.category)}
          </p>
          <p className={styles.cardNote()}>
            상세 엔드포인트, 자격 증명과 내부 오류 내용은 표시하지 않습니다.
          </p>
        </section>

        <section className={styles.card()} aria-labelledby="cleanup-queue-title">
          <CardHeading
            eyebrow="BACKGROUND WORK"
            title="정리 작업 대기열"
            id="cleanup-queue-title"
            state={operations.cleanup.state}
          />
          <CleanupMetrics cleanup={operations.cleanup} />
        </section>

        <section className={operationStyles({ wide: true }).card()} aria-labelledby="usage-title">
          <CardHeading
            eyebrow="AGGREGATE USAGE"
            title="인스턴스 사용량"
            id="usage-title"
            state={operations.usage.state}
          />
          <UsageMetrics usage={operations.usage} />
          <p className={styles.cardNote()}>
            스토리지 합계는 검증된 번들 메타데이터와 활성 예약량 기준이며 공급자 청구 예상치는 아닙니다.
          </p>
        </section>

        <section className={operationStyles({ wide: true }).card()} aria-labelledby="support-bundle-title">
          <AdminSectionHeading>
            <div>
              <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">안전 진단</p>
              <h2 id="support-bundle-title">지원 번들</h2>
            </div>
          </AdminSectionHeading>
          <SupportBundleDownload preview={operations.supportBundle} />
        </section>
      </div>
    </AdminPage>
  );
}

function CardHeading({
  eyebrow,
  title,
  id,
  state
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly id: string;
  readonly state: AdminOperationsState;
}) {
  return (
    <AdminSectionHeading>
      <div>
        <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      <StateBadge state={state} />
    </AdminSectionHeading>
  );
}

function StateBadge({ state }: { readonly state: AdminOperationsState }) {
  const styles = operationStyles();
  return (
    <span className={styles.status()} data-state={state}>
      {state === "nominal" ? "정상" : state === "degraded" ? "주의" : "사용 불가"}
    </span>
  );
}

function CleanupMetrics({ cleanup }: { readonly cleanup: AdminCleanupQueue }) {
  if (cleanup.state === "unavailable") {
    return <UnavailableMetric message="정리 작업 대기열 집계를 일시적으로 사용할 수 없습니다." />;
  }
  const styles = operationStyles();
  return (
    <dl className={styles.metrics()}>
      <Metric label="대기" value={formatCount(cleanup.queueDepth)} />
      <Metric label="실행 중" value={formatCount(cleanup.runningCount)} />
      <Metric label="재시도 대기" value={formatCount(cleanup.retryCount)} />
      <Metric label="실패" value={formatCount(cleanup.failedCount)} />
      <Metric
        label="가장 오래된 작업"
        value={formatAge(cleanup.oldestEligibleAgeSeconds)}
      />
    </dl>
  );
}

function UsageMetrics({ usage }: { readonly usage: AdminUsage }) {
  if (usage.state === "unavailable") {
    return <UnavailableMetric message="전체 사용량 집계를 일시적으로 사용할 수 없습니다." />;
  }
  const styles = operationStyles({ usage: true });
  return (
    <dl className={styles.metrics()}>
      <Metric label="활성 사용자" value={formatCount(usage.activeUsers)} />
      <Metric label="활성 조직" value={formatCount(usage.activeOrganizations)} />
      <Metric label="활성 프로젝트" value={formatCount(usage.activeProjects)} />
      <Metric label="검증된 번들" value={formatCount(usage.verifiedBundles)} />
      <Metric label="사용 스토리지" value={formatBytes(usage.trackedPhysicalBytes)} />
      <Metric label="예약 스토리지" value={formatBytes(usage.reservedBytes)} />
    </dl>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UnavailableMetric({ message }: { readonly message: string }) {
  const styles = operationStyles();
  return <p className={styles.cardNote()}>{message}</p>;
}

function dependencyMessage(category: AdminDependencyCategory): string {
  const messages: Record<AdminDependencyCategory, string> = {
    configuration: "이 런타임에는 의존성 점검이 구성되지 않았습니다.",
    capacity: "의존성 점검 용량이 일시적으로 소진되었습니다.",
    deadline: "통합 의존성 준비 상태 점검 시간이 초과되었습니다.",
    database_timeout: "데이터베이스 준비 상태 점검 시간이 초과되었습니다.",
    database: "데이터베이스 준비 상태 점검에 실패했습니다.",
    schema_pending: "데이터베이스 마이그레이션이 대기 중입니다.",
    schema_dirty: "데이터베이스 마이그레이션 상태가 완료되지 않았습니다.",
    schema_checksum_mismatch: "데이터베이스 마이그레이션 체크섬이 현재 릴리스와 일치하지 않습니다.",
    schema_unsupported: "데이터베이스 스키마가 현재 릴리스에서 지원하는 버전보다 새 버전입니다.",
    object_storage_timeout: "오브젝트 스토리지 준비 상태 점검 시간이 초과되었습니다.",
    object_storage: "오브젝트 스토리지 준비 상태 점검에 실패했습니다."
  };
  return messages[category];
}

function formatCount(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en").format(value);
}

function formatBytes(value: string | null): string {
  if (value === null) return "—";
  let amount = BigInt(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  let unit = 0;
  let remainder = 0n;
  while (amount >= 1024n && unit < units.length - 1) {
    remainder = amount % 1024n;
    amount /= 1024n;
    unit += 1;
  }
  const fraction = unit === 0 || remainder === 0n
    ? ""
    : `.${((remainder * 10n) / 1024n).toString()}`;
  return `${amount.toLocaleString("en")}${fraction} ${units[unit]}`;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "대기 작업 없음";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value)) + " UTC";
}
