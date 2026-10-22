import type { PublicPublishedExample } from "@nuriteo/api-client";
import Link from "next/link";

import { formatPublishedDate } from "#src/app/examples/_utils/format-published-date.ts";

interface ExampleCardProps {
  readonly example: PublicPublishedExample;
}

export function ExampleCard({ example }: ExampleCardProps) {
  return (
    <article className="public-example-card group">
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full bg-selected px-2.5 py-1 text-xs font-medium text-foreground">
            버전 {example.versionNumber}
          </span>
          <span className="text-xs text-subtle-foreground">
            {formatPublishedDate(example.publishedAt)}
          </span>
        </div>
        <h2 className="mt-5 text-xl font-medium tracking-[-0.025em] text-foreground text-balance">
          {example.name}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          게시 시점의 상태를 안전하게 살펴볼 수 있는 읽기 전용 고정 버전입니다.
        </p>
      </div>
      <Link
        className="inline-flex w-fit items-center gap-2 text-sm font-medium text-link underline-offset-4 group-hover:underline"
        href={`/examples/${example.publicId}`}
      >
        예제 보기
        <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}
