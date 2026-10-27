import type { PublicPublishedExample } from "@nuriteo/api-client";
import Link from "next/link";

import { formatPublishedDate } from "#src/app/(public)/examples/_utils/format-published-date.ts";
import { examplesStyles } from "#src/app/(public)/examples/_components/examples.styles.ts";

interface ExampleCardProps {
  readonly example: PublicPublishedExample;
}

export function ExampleCard({ example }: ExampleCardProps) {
  const styles = examplesStyles();
  return (
    <article className={styles.card()}>
      <div>
        <div className={styles.cardMeta()}>
          <span className={styles.badge()}>
            버전 {example.versionNumber}
          </span>
          <span className={styles.date()}>
            {formatPublishedDate(example.publishedAt)}
          </span>
        </div>
        <h2 className={styles.cardTitle()}>
          {example.name}
        </h2>
        <p className={styles.cardDescription()}>
          게시 시점의 상태를 안전하게 살펴볼 수 있는 읽기 전용 고정 버전입니다.
        </p>
      </div>
      <Link
        className={styles.cardLink()}
        href={`/examples/${example.publicId}`}
      >
        예제 보기
        <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}
