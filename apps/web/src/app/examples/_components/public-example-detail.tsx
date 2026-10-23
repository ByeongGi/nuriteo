import type { PublicPublishedExample } from "@nuriteo/api-client";
import Link from "next/link";

import { examplesStyles } from "#src/app/examples/_components/examples.styles.ts";
import { formatPublishedDate } from "#src/app/examples/_utils/format-published-date.ts";
import { Button } from "#src/components/ui/button.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";

export interface PublicExampleDetailProps {
  readonly example: PublicPublishedExample;
}

export function PublicExampleDetail({ example }: PublicExampleDetailProps) {
  const versionHref = `/examples/${example.publicId}/versions/${example.versionNumber}`;
  const styles = examplesStyles();

  return (
    <main id="main-content" className={styles.page()} tabIndex={-1}>
      <nav aria-label="예제 탐색" className={styles.breadcrumb()}>
        <Link className={styles.breadcrumbLink()} href="/examples">공개 예제</Link>
        <span aria-hidden="true"> / {example.name}</span>
      </nav>

      <PageHeader
        eyebrow={example.visibility === "unlisted" ? "링크 공개" : "전체 공개"}
        title={example.name}
        description={`${formatPublishedDate(example.publishedAt)} 게시됨. 게시된 스냅샷만 제공하며 원본 프로젝트 접근 권한은 포함하지 않습니다.`}
        actions={<Button variant="primary" render={<Link href={versionHref} />}>버전 {example.versionNumber} 미리보기 <span aria-hidden="true">→</span></Button>}
      />

      <article className={styles.detailCard()}>
        <dl className={styles.facts()}>
          <div className={styles.fact()}>
            <dt className={styles.factLabel()}>모드</dt>
            <dd className={styles.factValue()}>읽기 전용</dd>
          </div>
          <div className={styles.fact()}>
            <dt className={styles.factLabel()}>버전</dt>
            <dd className={styles.factValue({ className: "font-mono" })}>{example.versionNumber}</dd>
          </div>
          <div className={styles.fact()}>
            <dt className={styles.factLabel()}>업데이트 방식</dt>
            <dd className={styles.factValue()}>고정 스냅샷</dd>
          </div>
        </dl>
      </article>
    </main>
  );
}
