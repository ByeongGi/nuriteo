import type { PublicPublishedExample, Workspace } from "@nuriteo/api-client";
import Link from "next/link";

import { examplesStyles } from "#src/app/(public)/examples/_components/examples.styles.ts";
import { formatPublishedDate } from "#src/app/(public)/examples/_utils/format-published-date.ts";
import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";
import { ForkExampleForm } from "#src/app/(public)/examples/_components/fork-example-form.tsx";
import { PublishedExamplePreview } from "#src/app/(public)/examples/_components/published-example-preview.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";

export interface ReadOnlyExampleShellProps {
  readonly example: PublicPublishedExample;
  readonly initialForkWorkspaces?: readonly Workspace[] | undefined;
  readonly previewConfiguration: PreviewOriginConfiguration;
}

export function ReadOnlyExampleShell({ example, initialForkWorkspaces, previewConfiguration }: ReadOnlyExampleShellProps) {
  const bundleHref = `/api/v1/published-examples/${example.publicId}/versions/${example.versionNumber}/content`;
  const styles = examplesStyles();
  return (
    <main id="main-content" className={styles.readOnlyPage()} tabIndex={-1}>
      <div className={styles.readOnlyInner()}>
        <nav aria-label="예제 탐색" className={styles.breadcrumb()}>
          <Link className={styles.breadcrumbLink()} href="/examples">
            공개 예제
          </Link>
          <span aria-hidden="true"> / </span>
          <Link
            className={styles.breadcrumbLink()}
            href={`/examples/${example.publicId}`}
          >
            {example.name}
          </Link>
          <span aria-hidden="true"> / 버전 {example.versionNumber}</span>
        </nav>

        <PageHeader
          eyebrow="읽기 전용 / 고정 스냅샷"
          title={example.name}
          description="게시된 버전을 안전한 공개 경계에서 확인하고, 필요한 경우 독립 프로젝트로 복제하세요."
          actions={(
            <dl className={styles.shellMeta()}>
              <dt className="text-subtle-foreground">버전</dt>
              <dd className="m-0 text-right font-mono text-foreground">{example.versionNumber}</dd>
              <dt className="text-subtle-foreground">게시일</dt>
              <dd className="m-0 text-right text-foreground">{formatPublishedDate(example.publishedAt)}</dd>
            </dl>
          )}
        />

        <section className={styles.shell()} aria-label={`${example.name} 읽기 전용 버전`}>
          <div className={styles.shellLayout()}>
            <aside className={styles.shellAside()} aria-label="스냅샷 정보">
              <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
                스냅샷
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                이 공개 화면은 버전 {example.versionNumber}에 고정되어 있으며 이후 원본 변경을 따라가지 않습니다.
              </p>
              <p className="mt-4 break-all font-mono text-xs text-subtle-foreground">
                {example.publicId}
              </p>
            </aside>

            <div className={styles.shellContent()}>
              <div className={styles.shellContentInner()}>
                <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-subtle text-xl text-primary" aria-hidden="true">
                  ◇
                </span>
                <h2 className="mt-5 text-2xl font-medium tracking-[-0.03em] text-foreground text-balance">
                  게시된 버전을 바로 살펴볼 수 있습니다.
                </h2>
                <p className="mt-3 text-muted-foreground text-balance">
                  검증·정제된 아카이브는 쿠키가 없는 공개 경계를 통해 제공됩니다. 이 고정 스냅샷만 포함하며 프로젝트 권한, Git, 계정 또는 환경 정보는 포함하지 않습니다.
                </p>
                <div className={styles.actionRow()}>
                  <Button className={styles.action()} variant="primary" render={<a download="nuriteo-published-example.tar" href={bundleHref} />}>
                    정제된 아카이브 다운로드
                  </Button>
                  <Button className={styles.action()} render={<Link href={`/examples/${example.publicId}`} />}>
                    예제 상세로 돌아가기
                  </Button>
                </div>
                <div className="mx-auto mt-8 max-w-md">
                  <ForkExampleForm example={example} initialWorkspaces={initialForkWorkspaces} />
                </div>
                <PublishedExamplePreview
                  example={example}
                  previewConfiguration={previewConfiguration}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
