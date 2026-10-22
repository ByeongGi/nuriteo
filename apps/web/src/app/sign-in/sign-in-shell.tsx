import type { ReactNode } from "react";

import { signInStyles } from "#src/app/sign-in/sign-in.styles.ts";

interface SignInShellProps {
  readonly children: ReactNode;
}

export function SignInShell({ children }: SignInShellProps) {
  const styles = signInStyles();

  return (
    <main id="main-content" className={styles.page()} tabIndex={-1}>
      <div className={styles.window()}>
        <aside className={styles.showcase()} aria-label="누리터 서비스 정보">
          <div className={styles.brand()}>
            <span className={styles.brandMark()} aria-hidden="true">N</span>
            <strong>NURITEO</strong>
          </div>

          <p className={styles.summary()}>
            설치 없이 브라우저에서 Node.js 프로젝트를 개발하고 실행하세요.
          </p>

          <p className={styles.meta()}>
            <span>개발 서버</span>
            <small className={styles.metaVersion()}>v0.1.0</small>
          </p>
        </aside>

        <section className={styles.panel()} aria-labelledby="sign-in-title">
          <h1 className={styles.title()} id="sign-in-title">로그인</h1>
          {children}
          <p className={styles.help()} id="sign-in-password-help">
            로그인 문제는 관리자에게 문의하세요.
          </p>
        </section>
      </div>
    </main>
  );
}
