import type { ReactNode } from "react";

interface ProductEntryShellProps {
  readonly children?: ReactNode;
  readonly compact?: boolean;
  readonly description: ReactNode;
  readonly eyebrow: string;
  readonly title: ReactNode;
  readonly titleId: string;
}

interface ProductEntryLoadingProps {
  readonly compact?: boolean;
  readonly label: string;
}

function EntryShowcase() {
  return (
    <aside className="entry-showcase" aria-label="NURITEO self-hosted workspace">
      <div className="entry-showcase__brand">
        <span aria-hidden="true">N</span>
        <strong>NURITEO</strong>
      </div>
      <div className="entry-showcase__message">
        <p>SELF-HOSTED WORKSPACE</p>
        <h2>코드를 열고, 바로 실행하세요.</h2>
        <span>프로젝트와 실행 환경은 조직의 인프라 안에 안전하게 유지됩니다.</span>
      </div>
      <p className="entry-showcase__status"><i aria-hidden="true" /> 브라우저 네이티브 개발 환경</p>
    </aside>
  );
}

export function ProductEntryShell({
  children,
  compact = false,
  description,
  eyebrow,
  title,
  titleId
}: ProductEntryShellProps) {
  return (
    <main id="main-content" className="entry-page" tabIndex={-1}>
      <div className="entry-window">
        <EntryShowcase />
        <section
          className={`entry-card${compact ? " entry-card--compact" : ""}`}
          aria-labelledby={titleId}
        >
          <header className="entry-card__header">
            <p className="eyebrow">{eyebrow}</p>
            <h1 id={titleId}>{title}</h1>
            <p className="entry-description">{description}</p>
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}

export function ProductEntryLoading({ compact = false, label }: ProductEntryLoadingProps) {
  return (
    <main id="main-content" className="entry-page" aria-busy="true" aria-live="polite">
      <p className="sr-only">{label}</p>
      <div className="entry-window">
        <EntryShowcase />
        <section className={`entry-card entry-card--loading${compact ? " entry-card--compact" : ""}`} aria-hidden="true">
          <div className="loading-shell__line loading-shell__line--short" />
          <div className="loading-shell__line loading-shell__line--title" />
          <div className="loading-shell__line" />
        </section>
      </div>
    </main>
  );
}
