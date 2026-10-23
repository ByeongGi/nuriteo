import type { ReactNode } from "react";

import { productEntryStyles } from "#src/app/_components/product-entry-shell.styles.ts";

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
  const styles = productEntryStyles();
  return (
    <aside className={styles.showcase()} aria-label="누리터 자체 호스팅 워크스페이스">
      <div className={styles.brand()}>
        <span className={styles.brandMark()} aria-hidden="true">N</span>
        <strong>NURITEO</strong>
      </div>
      <div className={styles.message()}>
        <p className={styles.eyebrow()}>자체 호스팅 워크스페이스</p>
        <h2 className={styles.heading()}>코드를 열고, 바로 실행하세요.</h2>
        <span className={styles.detail()}>프로젝트와 실행 환경은 조직의 인프라 안에 안전하게 유지됩니다.</span>
      </div>
      <p className={styles.status()}><i className={styles.statusMark()} aria-hidden="true" /> 브라우저 네이티브 개발 환경</p>
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
  const styles = productEntryStyles();
  return (
    <main id="main-content" className={styles.page()} tabIndex={-1}>
      <div className={styles.window()}>
        <EntryShowcase />
        <section
          className={styles.card({ className: compact ? styles.cardCompact() : undefined })}
          aria-labelledby={titleId}
        >
          <header className={styles.header()}>
            <p className={styles.cardEyebrow()}>{eyebrow}</p>
            <h1 className={styles.title()} id={titleId}>{title}</h1>
            <p className={styles.description()}>{description}</p>
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}

export function ProductEntryLoading({ compact = false, label }: ProductEntryLoadingProps) {
  const styles = productEntryStyles();
  return (
    <main id="main-content" className={styles.page()} aria-busy="true" aria-live="polite">
      <p className="sr-only">{label}</p>
      <div className={styles.window()}>
        <EntryShowcase />
        <section className={styles.card({ className: compact ? styles.cardCompact() : undefined })} aria-hidden="true">
          <div className={styles.loadingLine({ className: styles.loadingShort() })} />
          <div className={styles.loadingLine({ className: styles.loadingTitle() })} />
          <div className={styles.loadingLine({ className: styles.loadingBody() })} />
        </section>
      </div>
    </main>
  );
}
