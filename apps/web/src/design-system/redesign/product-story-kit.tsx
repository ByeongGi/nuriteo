import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

type NavigationKey =
  | "workspaces"
  | "projects"
  | "organization"
  | "notifications"
  | "security"
  | "admin"
  | "examples";

type ProductStoryShellProps = Readonly<{
  active: NavigationKey;
  children: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
  toolbar?: ReactNode;
}>;

type StatusTone = "danger" | "info" | "neutral" | "success" | "warning";

const shell = tv({
  slots: {
    stage: "min-h-screen bg-background p-[clamp(0.75rem,2vw,2rem)] text-foreground",
    window: "mx-auto grid min-h-[52rem] w-full max-w-[92rem] grid-cols-[14rem_minmax(0,1fr)] overflow-hidden rounded-2xl border border-muted-border bg-background shadow-lg max-[58rem]:grid-cols-1",
    sidebar: "flex flex-col border-r border-muted-border bg-sidebar p-4 max-[58rem]:hidden",
    brand: "flex items-center gap-2 px-2 text-sm font-bold tracking-[-0.02em]",
    brandMark: "grid size-8 place-items-center rounded-lg bg-primary text-on-primary shadow-xs",
    workspace: "mt-5 flex items-center justify-between rounded-lg border border-border bg-surface p-2.5 text-left text-sm",
    navigation: "mt-5 grid gap-1",
    navigationLabel: "mb-1 mt-4 px-2 text-[0.65rem] font-semibold tracking-[0.12em] text-subtle-foreground first:mt-0",
    navItem: "grid min-h-10 grid-cols-[1.5rem_1fr_auto] items-center gap-2 rounded-lg px-2.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-link",
    profile: "mt-auto flex items-center gap-2 border-t border-muted-border pt-4 text-sm",
    profileMark: "grid size-8 place-items-center rounded-full bg-selected font-semibold text-link",
    content: "min-w-0 p-[clamp(1.25rem,3vw,2.5rem)]",
    header: "flex items-start justify-between gap-6 border-b border-muted-border pb-6 max-[42rem]:grid",
    eyebrow: "m-0 text-xs font-semibold tracking-[0.08em] text-link",
    title: "mt-1 mb-0 text-3xl font-semibold tracking-[-0.04em] text-foreground",
    description: "mt-2 max-w-2xl text-sm text-muted-foreground",
    toolbar: "flex flex-wrap items-center justify-end gap-2 max-[42rem]:justify-start",
    body: "mt-6 grid gap-5"
  }
});

const action = tv({
  base: "inline-flex min-h-10 items-center justify-center rounded-lg border px-4 text-sm font-semibold transition-colors",
  variants: {
    tone: {
      danger: "border-danger/30 bg-danger-subtle text-danger hover:border-danger/50",
      primary: "border-primary bg-primary text-on-primary shadow-xs hover:bg-primary-strong",
      secondary: "border-border bg-surface text-foreground hover:bg-hover"
    }
  },
  defaultVariants: { tone: "secondary" }
});

const status = tv({
  base: "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
  variants: {
    tone: {
      danger: "bg-danger-subtle text-danger",
      info: "bg-info-subtle text-info",
      neutral: "bg-subtle text-muted-foreground",
      success: "bg-success-subtle text-success",
      warning: "bg-warning-subtle text-warning"
    }
  },
  defaultVariants: { tone: "neutral" }
});

const navigationGroups = [
  {
    label: "WORKSPACE",
    items: [
      { icon: "W", key: "workspaces", label: "워크스페이스" },
      { icon: "P", key: "projects", label: "프로젝트" },
      { icon: "O", key: "organization", label: "조직과 팀" }
    ]
  },
  {
    label: "ACCOUNT",
    items: [
      { icon: "N", key: "notifications", label: "알림" },
      { icon: "S", key: "security", label: "보안과 연결" },
      { icon: "E", key: "examples", label: "공개 예제" }
    ]
  },
  {
    label: "SYSTEM",
    items: [{ icon: "A", key: "admin", label: "관리자" }]
  }
] as const;

export function ProductStoryShell({ active, children, description, eyebrow, title, toolbar }: ProductStoryShellProps) {
  const styles = shell();

  return (
    <main className={styles.stage()}>
      <div className={styles.window()}>
        <aside className={styles.sidebar()}>
          <div className={styles.brand()}><span className={styles.brandMark()}>N</span><strong>NURITEO</strong></div>
          <button className={styles.workspace()} type="button">
            <span className="grid"><strong>누리터 팀</strong><small className="text-xs text-subtle-foreground">Organization</small></span>
            <span aria-hidden="true">⌄</span>
          </button>
          <nav className={styles.navigation()} aria-label="리디자인 제품 메뉴">
            {navigationGroups.map((group) => (
              <div className="contents" key={group.label}>
                <p className={styles.navigationLabel()}>{group.label}</p>
                {group.items.map((item) => (
                  <a className={styles.navItem()} aria-current={item.key === active ? "page" : undefined} href={`#redesign-${item.key}`} key={item.key}>
                    <span className="grid size-5 place-items-center text-[0.65rem]" aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                    {item.key === "notifications" ? <small className="rounded-full bg-primary px-1.5 text-[0.65rem] text-on-primary">3</small> : null}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className={styles.profile()}>
            <span className={styles.profileMark()}>BK</span>
            <span className="grid min-w-0 flex-1"><strong>김병기</strong><small className="truncate text-xs text-subtle-foreground">byeonggi@nuriteo.dev</small></span>
            <button className="border-0 bg-transparent text-muted-foreground" aria-label="계정 메뉴" type="button">•••</button>
          </div>
        </aside>
        <section className={styles.content()} id={`redesign-${active}`}>
          <header className={styles.header()}>
            <div>
              <p className={styles.eyebrow()}>{eyebrow}</p>
              <h1 className={styles.title()}>{title}</h1>
              <p className={styles.description()}>{description}</p>
            </div>
            <div className={styles.toolbar()}>{toolbar}</div>
          </header>
          <div className={styles.body()}>{children}</div>
        </section>
      </div>
    </main>
  );
}

export function PrimaryAction({ children }: Readonly<{ children: ReactNode }>) {
  return <button className={action({ tone: "primary" })} type="button">{children}</button>;
}

export function SecondaryAction({ children }: Readonly<{ children: ReactNode }>) {
  return <button className={action({ tone: "secondary" })} type="button">{children}</button>;
}

export function DangerAction({ children }: Readonly<{ children: ReactNode }>) {
  return <button className={action({ tone: "danger" })} type="button">{children}</button>;
}

export function Status({ children, tone = "neutral" }: Readonly<{ children: ReactNode; tone?: StatusTone }>) {
  return <span className={status({ tone })}><i className="size-1.5 rounded-full bg-current" aria-hidden="true" />{children}</span>;
}

export function MetricGrid({ children }: Readonly<{ children: ReactNode }>) {
  return <section className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3" aria-label="주요 지표">{children}</section>;
}

export function Metric({ detail, label, value }: Readonly<{ detail: string; label: string; value: string }>) {
  return <article className="rounded-xl border border-muted-border bg-surface p-4"><span className="text-xs text-muted-foreground">{label}</span><strong className="mt-3 block text-2xl tracking-[-0.04em]">{value}</strong><small className="mt-1 block text-xs text-subtle-foreground">{detail}</small></article>;
}

export function Panel({ children, description, title, toolbar }: Readonly<{ children: ReactNode; description?: string; title: string; toolbar?: ReactNode }>) {
  return (
    <section className="overflow-hidden rounded-xl border border-muted-border bg-surface">
      <header className="flex items-start justify-between gap-4 border-b border-muted-border px-5 py-4">
        <div><h2 className="m-0 text-base font-semibold">{title}</h2>{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}</div>
        {toolbar}
      </header>
      {children}
    </section>
  );
}

export function Toolbar({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-muted-border bg-surface p-3">{children}</div>;
}

export function SearchField({ label, placeholder }: Readonly<{ label: string; placeholder: string }>) {
  return <label className="flex min-h-10 min-w-56 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 text-muted-foreground"><span aria-hidden="true">⌕</span><span className="sr-only">{label}</span><input className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none" aria-label={label} placeholder={placeholder} /></label>;
}

export function SegmentedControl({ items }: Readonly<{ items: readonly string[] }>) {
  return <div className="flex items-center gap-1 rounded-lg bg-subtle p-1">{items.map((item, index) => <button className={index === 0 ? "min-h-8 rounded-md bg-surface px-3 text-xs font-semibold shadow-xs" : "min-h-8 rounded-md border-0 bg-transparent px-3 text-xs text-muted-foreground"} key={item} type="button">{item}</button>)}</div>;
}

export function DataRows({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="divide-y divide-muted-border">{children}</div>;
}

export function DataRow({ actions, children, meta, status: rowStatus, title }: Readonly<{ actions?: ReactNode; children?: ReactNode; meta: string; status?: ReactNode; title: string }>) {
  return <article className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-5 py-3 max-[42rem]:grid-cols-1"><div className="min-w-0"><strong className="block truncate text-sm">{title}</strong><span className="mt-1 block truncate text-xs text-muted-foreground">{meta}</span>{children}</div>{rowStatus}<div className="flex items-center justify-end gap-2">{actions}</div></article>;
}

export function Callout({ children, tone = "info", title }: Readonly<{ children: ReactNode; tone?: "danger" | "info" | "warning"; title: string }>) {
  const colors = tone === "danger" ? "border-danger/25 bg-danger-subtle text-danger" : tone === "warning" ? "border-warning/25 bg-warning-subtle text-warning" : "border-info/25 bg-info-subtle text-info";
  return <aside className={`grid grid-cols-[auto_1fr] gap-3 rounded-xl border p-4 ${colors}`}><span className="grid size-7 place-items-center rounded-full bg-current/10 font-bold" aria-hidden="true">i</span><div><strong className="text-sm">{title}</strong><p className="mt-1 text-sm text-foreground/75">{children}</p></div></aside>;
}

export function EmptyState({ actionLabel, description, title }: Readonly<{ actionLabel: string; description: string; title: string }>) {
  return <section className="grid min-h-72 place-items-center rounded-xl border border-dashed border-border bg-subtle/45 p-8 text-center"><div className="max-w-md"><span className="mx-auto grid size-12 place-items-center rounded-xl bg-selected text-xl text-link">＋</span><h2 className="mt-4 mb-0 text-xl font-semibold">{title}</h2><p className="mt-2 text-sm text-muted-foreground">{description}</p><button className={action({ tone: "primary", className: "mt-5" })} type="button">{actionLabel}</button></div></section>;
}

export function SettingRow({ children, description, label }: Readonly<{ children: ReactNode; description: string; label: string }>) {
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] gap-6 px-5 py-4 max-[42rem]:grid-cols-1"><div><strong className="text-sm">{label}</strong><p className="mt-1 text-sm text-muted-foreground">{description}</p></div><div className="flex items-center justify-end gap-2 max-[42rem]:justify-start">{children}</div></div>;
}

export function TextInput({ ariaLabel, value }: Readonly<{ ariaLabel: string; value: string }>) {
  return <input className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" aria-label={ariaLabel} defaultValue={value} />;
}
