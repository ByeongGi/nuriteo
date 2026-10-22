import type { PublicPublishedExample } from "@nuriteo/api-client";
import Link from "next/link";

import { formatPublishedDate } from "#src/app/examples/_utils/format-published-date.ts";

export interface PublicExampleDetailProps {
  readonly example: PublicPublishedExample;
}

export function PublicExampleDetail({ example }: PublicExampleDetailProps) {
  const versionHref = `/examples/${example.publicId}/versions/${example.versionNumber}`;

  return (
    <main id="main-content" className="public-example-detail" tabIndex={-1}>
      <nav aria-label="예제 탐색" className="public-example-breadcrumb">
        <Link href="/examples">공개 예제</Link>
        <span aria-hidden="true"> / {example.name}</span>
      </nav>

      <article className="public-example-detail__card">
        <div className="public-example-detail__hero">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-selected px-2.5 py-1 text-xs font-semibold text-foreground">
              {example.visibility === "unlisted" ? "링크 공개" : "전체 공개"}
            </span>
            <span className="text-xs text-subtle-foreground">변경되지 않는 버전 {example.versionNumber}</span>
          </div>
          <h1 className="mt-5 mb-0 text-4xl font-medium tracking-[-0.045em] text-foreground text-balance md:text-6xl">
            {example.name}
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted-foreground">
            {formatPublishedDate(example.publishedAt)} 게시됨. 이 화면은 게시된 스냅샷만 제공하며 원본 프로젝트 접근 권한을 포함하지 않습니다.
          </p>
          <Link
            className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary no-underline transition-colors hover:bg-primary-strong"
            href={versionHref}
          >
            버전 {example.versionNumber} 미리보기
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        <dl className="grid gap-px bg-muted-border sm:grid-cols-3">
          <div className="bg-surface p-5">
            <dt className="text-xs text-subtle-foreground">모드</dt>
            <dd className="mt-2 ml-0 font-medium text-foreground">읽기 전용</dd>
          </div>
          <div className="bg-surface p-5">
            <dt className="text-xs text-subtle-foreground">버전</dt>
            <dd className="mt-2 ml-0 font-mono text-foreground">{example.versionNumber}</dd>
          </div>
          <div className="bg-surface p-5">
            <dt className="text-xs text-subtle-foreground">업데이트 방식</dt>
            <dd className="mt-2 ml-0 font-medium text-foreground">고정 스냅샷</dd>
          </div>
        </dl>
      </article>
    </main>
  );
}
