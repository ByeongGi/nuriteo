import type {
  AdminCleanupQueue,
  AdminDependencyCategory,
  AdminOperations,
  AdminOperationsState,
  AdminUsage
} from "@nuriteo/api-client";

import { SupportBundleDownload } from "./support-bundle-download.tsx";

export function OperationsDashboard({ operations }: { readonly operations: AdminOperations }) {
  return (
    <main id="main-content" className="workspace-page admin-operations-page">
      <header className="workspace-page__intro admin-operations-intro">
        <div>
          <p className="eyebrow">Instance administration</p>
          <h1>Operations</h1>
          <p>
            Monitor dependency readiness, durable cleanup work, and aggregate instance usage.
            Diagnostics are intentionally limited to safe operational categories.
          </p>
        </div>
        <div className="admin-operations-summary">
          <StateBadge state={operations.overallState} />
          <time dateTime={operations.generatedAt}>
            Updated {formatTimestamp(operations.generatedAt)}
          </time>
        </div>
      </header>

      <div className="admin-operations-grid">
        <section className="admin-operations-card" aria-labelledby="dependency-health-title">
          <CardHeading
            eyebrow="Readiness"
            title="Core dependencies"
            id="dependency-health-title"
            state={operations.dependencies.state}
          />
          <p className="admin-operations-card__summary">
            {operations.dependencies.category === null
              ? "Database schema and object storage probes are ready."
              : dependencyMessage(operations.dependencies.category)}
          </p>
          <p className="admin-operations-card__note">
            Detailed endpoints, credentials, and backend errors are never shown here.
          </p>
        </section>

        <section className="admin-operations-card" aria-labelledby="cleanup-queue-title">
          <CardHeading
            eyebrow="Background work"
            title="Cleanup queue"
            id="cleanup-queue-title"
            state={operations.cleanup.state}
          />
          <CleanupMetrics cleanup={operations.cleanup} />
        </section>

        <section className="admin-operations-card admin-operations-card--wide" aria-labelledby="usage-title">
          <CardHeading
            eyebrow="Aggregate accounting"
            title="Instance usage"
            id="usage-title"
            state={operations.usage.state}
          />
          <UsageMetrics usage={operations.usage} />
          <p className="admin-operations-card__note">
            Storage totals cover verified Bundle metadata and active reservations; they are not a
            provider billing estimate.
          </p>
        </section>

        <section className="admin-operations-card admin-operations-card--wide" aria-labelledby="support-bundle-title">
          <header className="admin-section-heading">
            <div>
              <p className="eyebrow">Safe diagnostics</p>
              <h2 id="support-bundle-title">Support bundle</h2>
            </div>
          </header>
          <SupportBundleDownload preview={operations.supportBundle} />
        </section>
      </div>
    </main>
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
    <header className="admin-section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      <StateBadge state={state} />
    </header>
  );
}

function StateBadge({ state }: { readonly state: AdminOperationsState }) {
  return (
    <span className="status-badge" data-state={state}>
      {state === "nominal" ? "Nominal" : state === "degraded" ? "Degraded" : "Unavailable"}
    </span>
  );
}

function CleanupMetrics({ cleanup }: { readonly cleanup: AdminCleanupQueue }) {
  if (cleanup.state === "unavailable") {
    return <UnavailableMetric message="Cleanup queue aggregation is temporarily unavailable." />;
  }
  return (
    <dl className="admin-operations-metrics">
      <Metric label="Queued" value={formatCount(cleanup.queueDepth)} />
      <Metric label="Running" value={formatCount(cleanup.runningCount)} />
      <Metric label="Waiting to retry" value={formatCount(cleanup.retryCount)} />
      <Metric label="Failed" value={formatCount(cleanup.failedCount)} />
      <Metric
        label="Oldest eligible"
        value={formatAge(cleanup.oldestEligibleAgeSeconds)}
      />
    </dl>
  );
}

function UsageMetrics({ usage }: { readonly usage: AdminUsage }) {
  if (usage.state === "unavailable") {
    return <UnavailableMetric message="Aggregate usage is temporarily unavailable." />;
  }
  return (
    <dl className="admin-operations-metrics admin-operations-metrics--usage">
      <Metric label="Active users" value={formatCount(usage.activeUsers)} />
      <Metric label="Active organizations" value={formatCount(usage.activeOrganizations)} />
      <Metric label="Active projects" value={formatCount(usage.activeProjects)} />
      <Metric label="Verified Bundles" value={formatCount(usage.verifiedBundles)} />
      <Metric label="Tracked storage" value={formatBytes(usage.trackedPhysicalBytes)} />
      <Metric label="Reserved storage" value={formatBytes(usage.reservedBytes)} />
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
  return <p className="admin-operations-unavailable">{message}</p>;
}

function dependencyMessage(category: AdminDependencyCategory): string {
  const messages: Record<AdminDependencyCategory, string> = {
    configuration: "Dependency probes are not configured for this runtime.",
    capacity: "Dependency probe capacity is temporarily exhausted.",
    deadline: "The combined dependency readiness deadline was exceeded.",
    database_timeout: "The database readiness probe timed out.",
    database: "The database readiness probe failed.",
    schema_pending: "Database migrations are pending.",
    schema_dirty: "The database migration state is incomplete.",
    schema_checksum_mismatch: "A database migration checksum does not match this release.",
    schema_unsupported: "The database schema is newer than this release supports.",
    object_storage_timeout: "The object storage readiness probe timed out.",
    object_storage: "The object storage readiness probe failed."
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
  if (seconds === null) return "No eligible work";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value)) + " UTC";
}
