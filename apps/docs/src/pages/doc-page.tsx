import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { catalog } from "../content/catalog.ts";
import { normalizePath, pageHref } from "../content/paths.ts";
import type { ApiItem, Block, DocEntry, DocLink, Lang } from "../content/types.ts";
import { CodeBlock } from "./code-editor.tsx";
import { ContainerCases } from "./container-cases.tsx";
import { RichText } from "./rich-text.tsx";
import { SdkPlayground } from "./sdk-example.tsx";
import { SearchButton } from "./search-dialog.tsx";
import { themeLabel, useDocsPreferences } from "../preferences.tsx";

export function DocPage() {
  const { lang } = useDocsPreferences();
  const path = normalizePath(useLocation().pathname);
  const index = catalog.findIndex((entry) => entry.path === path);
  const entry = index >= 0 ? catalog[index] : undefined;

  useEffect(() => {
    document.title = entry ? `${entry[lang].title} · NURITEO` : "NURITEO";
    window.scrollTo(0, 0);
  }, [entry, lang, path]);

  if (!entry) return <MissingPage lang={lang} />;

  const copy = entry[lang];
  const previous = index > 0 ? catalog[index - 1] : undefined;
  const next = catalog[index + 1];

  const titleClass = wideTitle(entry.path === "/");
  const headings = pageOutline(copy.blocks);
  const onThisPage = lang === "ko" ? "이 페이지" : "On this page";
  const wide = entry.path === "/";
  const measure = wide ? "max-w-3xl" : "max-w-[43rem]";

  return (
    <>
      <main id="docs-content" className={cn("min-w-0 px-5 pt-7 pb-16 docs-sidebar:px-10 docs-sidebar:pt-10", headings.length === 0 && "docs-outline:col-span-2")}>
        <header className={`mb-8 ${measure}`}>
          <Breadcrumb entry={entry} lang={lang} />
          {wide ? <p className="mb-3 text-sm text-muted-foreground">{copy.eyebrow}</p> : null}
          <h1 className={titleClass}>{copy.title}</h1>
          <p className="m-0 text-lg text-pretty text-muted-foreground"><RichText text={copy.lead} /></p>
        </header>
        {headings.length > 0 ? (
          <Collapsible className={cn("mb-8 rounded-lg border docs-outline:hidden", measure)}>
            <CollapsibleTrigger className="w-full px-3 py-2 text-left text-sm">{onThisPage}</CollapsibleTrigger>
            <CollapsibleContent className="px-1 pb-2">
              <PageOutline headings={headings} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {copy.blocks.map((block, blockIndex) => (
          <div key={blockIndex} className={block.type === "playground" ? "my-10" : measure}>
            <BlockView block={block} index={blockIndex} />
          </div>
        ))}
        {entry.playground && !copy.blocks.some((block) => block.type === "playground") ? <div className="my-10"><SdkPlayground /></div> : null}
        <nav className={`mt-16 grid gap-3 border-t border-border pt-6 sm:grid-cols-2 ${measure}`} aria-label={lang === "ko" ? "이전 다음" : "Previous and next"}>
          {previous ? <PagerLink entry={previous} lang={lang} direction="prev" /> : <span />}
          {next ? <PagerLink entry={next} lang={lang} direction="next" /> : null}
        </nav>
      </main>
      {headings.length > 0 ? (
        <aside className="sticky top-header hidden max-h-[calc(100vh-var(--spacing-header))] self-start overflow-auto border-l border-border px-8 pt-10 pb-8 docs-outline:block" aria-label={onThisPage}>
          <p className="mb-3 text-xs font-medium text-muted-foreground">{onThisPage}</p>
          <PageOutline headings={headings} />
        </aside>
      ) : null}
    </>
  );
}

export function DocSectionNav() {
  const { lang } = useDocsPreferences();
  const path = normalizePath(useLocation().pathname);
  const sections = groupCatalog(lang);
  return (
    <nav className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto docs-sections:flex" aria-label={lang === "ko" ? "문서 구역" : "Documentation sections"}>
      {sections.map((section) => {
        const active = section.entries.some((entry) => entry.path === path);
        return (
          <Link
            key={section.title}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm no-underline ${active ? "bg-selected font-medium text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
            to={pageHref(section.entries[0].path)}
            aria-current={active ? "true" : undefined}
          >
            {section.title}
          </Link>
        );
      })}
    </nav>
  );
}

export function DocSidebar() {
  const { lang } = useDocsPreferences();
  const path = normalizePath(useLocation().pathname);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const contents = lang === "ko" ? "목차" : "Contents";

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    navRef.current?.querySelector("[aria-current='page']")?.scrollIntoView({ block: "nearest" });
  }, [path, lang]);

  return (
    <>
      <div className="border-b border-border bg-surface px-5 py-3 docs-sidebar:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button className="w-full justify-start" variant="outline" type="button">{contents}</Button>
          </SheetTrigger>
          <SheetContent side="left" aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle>{contents}</SheetTitle>
              <SheetDescription>{contents}</SheetDescription>
              <SheetClose asChild>
                <Button variant="ghost" size="sm" type="button">{lang === "ko" ? "닫기" : "Close"}</Button>
              </SheetClose>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-3 pb-6">
                <SearchButton className="mb-3 w-full justify-between" />
                <SidebarLinks lang={lang} path={path} />
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>
      </div>
      <nav
        ref={navRef}
        className="hidden border-r border-border bg-surface docs-sidebar:sticky docs-sidebar:top-header docs-sidebar:block docs-sidebar:h-[calc(100vh-var(--spacing-header))]"
        aria-label={lang === "ko" ? "문서" : "Documentation"}
      >
        <ScrollArea className="h-full">
          <div className="px-5 pt-5 pb-16">
            <SearchButton className="mb-4 w-full justify-between" />
            <SidebarLinks lang={lang} path={path} />
          </div>
        </ScrollArea>
      </nav>
    </>
  );
}

function SidebarLinks({ lang, path }: { lang: Lang; path: string }) {
  return (
    <>
      {groupCatalog(lang).map((section, index) => (
        <section key={section.title}>
          {index > 0 ? <Separator className="my-4" /> : null}
          {section.entries.length > 1 && section.title !== section.entries[0][lang].nav ? <h2 className="mb-1 px-3 text-xs font-semibold text-muted-foreground">{section.title}</h2> : null}
          {section.entries.map((entry) => {
            const current = path === entry.path;
            return (
              <Link
                key={entry.path}
                to={pageHref(entry.path)}
                aria-current={current ? "page" : undefined}
                className={`block rounded-md px-3 py-1.5 text-sm no-underline ${current ? "bg-selected font-medium text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
              >
                {entry[lang].nav}
              </Link>
            );
          })}
        </section>
      ))}
    </>
  );
}

export function DocControls() {
  const { lang, theme, toggleLang, cycleTheme } = useDocsPreferences();

  return (
    <div className="flex items-center gap-2">
      <SearchButton />
      <Button className="hidden docs-sidebar:inline-flex" variant="ghost" size="sm" asChild>
        <a href="https://github.com/ByeongGi/nuriteo">GitHub</a>
      </Button>
      <Button variant="outline" size="sm" type="button" onClick={toggleLang}>
        {lang === "ko" ? "English" : "한국어"}
      </Button>
      <Button variant="outline" size="sm" type="button" onClick={cycleTheme} aria-label={lang === "ko" ? "테마 바꾸기" : "Change theme"}>
        {themeLabel(lang, theme)}
      </Button>
    </div>
  );
}

function wideTitle(home: boolean): string {
  const shared = "mb-4 font-semibold tracking-tight text-pretty";
  if (home) return `${shared} text-3xl`;
  return `${shared} text-2xl`;
}

function BlockView({ block, index }: { block: Block; index: number }) {
  switch (block.type) {
    case "p":
      return <p className="mb-4 text-pretty"><RichText text={block.text} /></p>;
    case "h2":
      return <h2 id={headingId(block.text, index)} className="mt-12 mb-4 scroll-mt-scroll-offset text-xl font-semibold tracking-tight text-pretty">{block.text}</h2>;
    case "ul":
      return (
        <ul className="mb-6 list-disc pl-5 [&_li+li]:mt-1.5">
          {block.items.map((item) => <li key={item}><RichText text={item} /></li>)}
        </ul>
      );
    case "code":
      return <CodeBlock text={block.text} />;
    case "example":
      return <ExampleFrame block={block} index={index} />;
    case "playground":
      return <SdkPlayground />;
    case "cases":
      return <ContainerCases />;
    case "callout":
      return (
        <aside className={`mb-6 border-l-2 px-4 py-3 text-sm ${block.tone === "limit" ? "border-warning bg-warning-subtle" : "border-info bg-info-subtle"}`}>
          {block.title ? <p className="mb-1 font-medium text-foreground">{block.title}</p> : null}
          <p className="m-0"><RichText text={block.text} /></p>
        </aside>
      );
    case "steps":
      return (
        <ol className="mb-8 list-none p-0">
          {block.items.map((item, stepIndex) => (
            <li key={item.title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 pb-6">
              <span className="mt-0.5 grid size-7 place-items-center rounded-full border border-strong-border text-sm text-foreground tabular-nums" aria-hidden="true">{stepIndex + 1}</span>
              <div>
                <p className="m-0 font-medium">{item.title}</p>
                <p className="mt-1 mb-0 text-sm text-pretty text-muted-foreground"><RichText text={item.text} /></p>
              </div>
            </li>
          ))}
        </ol>
      );
    case "api":
      return <ApiList items={block.items} index={index} />;
    case "links":
      return <LinkList items={block.items} />;
    case "table":
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{block.columns[0]}</TableHead>
              <TableHead>{block.columns[1]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {block.rows.map((row) => (
              <TableRow key={row[0]}>
                <TableCell className={`align-top ${monoCell(row[0]) ? "font-mono text-sm" : "font-medium"}`}><RichText text={row[0]} /></TableCell>
                <TableCell><RichText text={row[1]} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function ExampleFrame({ block, index }: { block: Extract<Block, { type: "example" }>; index: number }) {
  return (
    <figure id={headingId(block.title, index)} className="mb-8 scroll-mt-scroll-offset overflow-hidden rounded-lg border border-border bg-surface">
      <figcaption className="border-b border-border px-4 py-4">
        <p className="m-0 font-medium text-foreground">{block.title}</p>
        <p className="mt-2 mb-0 text-sm text-pretty text-muted-foreground"><RichText text={block.text} /></p>
        <p className="mt-3 mb-0 border-t border-muted-border pt-3 text-sm text-pretty text-foreground"><RichText text={block.result} /></p>
      </figcaption>
      <CodeBlock text={block.code} embedded />
    </figure>
  );
}

function LinkList({ items }: { items: DocLink[] }) {
  return (
    <ul className="mb-8 list-none border-t border-border p-0">
      {items.map((item) => (
        <li key={item.to} className="border-b border-border">
          {docLink(item.to, "group block px-1 py-4 text-foreground no-underline", item.label, item.detail)}
        </li>
      ))}
    </ul>
  );
}

function PagerLink({ entry, lang, direction }: { entry: DocEntry; lang: Lang; direction: "prev" | "next" }) {
  const label = direction === "prev"
    ? (lang === "ko" ? "이전" : "Previous")
    : (lang === "ko" ? "다음" : "Next");
  return (
    <Link className={`block rounded-md px-3 py-3 no-underline hover:bg-hover ${direction === "next" ? "sm:text-right" : ""}`} to={pageHref(entry.path)}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="mt-1 block font-medium text-foreground">{entry[lang].nav}</span>
    </Link>
  );
}

function MissingPage({ lang }: { lang: Lang }) {
  return (
    <main className="max-w-[42rem] px-7 py-11">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">{lang === "ko" ? "이 주소의 문서가 없습니다." : "This page is not in the docs."}</h1>
      <Button variant="link" className="h-auto px-0" asChild>
        <Link to="/">{lang === "ko" ? "소개로 돌아가기" : "Back to the overview"}</Link>
      </Button>
    </main>
  );
}

function ApiList({ items, index }: { items: ApiItem[]; index: number }) {
  return (
    <div className="mb-8">
      {items.map((item, itemIndex) => (
        <section key={item.name} id={apiHeadingId(item.name, index, itemIndex)} className="scroll-mt-scroll-offset border-t border-border py-5">
          <h3 className="m-0 font-mono text-sm font-medium">{item.name}</h3>
          <p className="mt-2 mb-2 overflow-auto font-mono text-xs text-muted-foreground">{item.signature}</p>
          <p className="m-0 text-sm"><RichText text={item.text} /></p>
        </section>
      ))}
    </div>
  );
}

function Breadcrumb({ entry, lang }: { entry: DocEntry; lang: Lang }) {
  const sections = groupCatalog(lang);
  const section = sections.find((item) => item.entries.some((candidate) => candidate.path === entry.path));
  const first = section?.entries[0];
  if (!section || !first || first.path === entry.path) return null;
  const label = lang === "ko" ? "현재 위치" : "Breadcrumb";
  return (
    <nav className="mb-3 text-sm text-muted-foreground" aria-label={label}>
      <Link className="text-muted-foreground no-underline hover:text-foreground" to={pageHref(first.path)}>{section.title}</Link>
      <span aria-hidden="true"> / </span>
      <span className="text-foreground">{entry[lang].nav}</span>
    </nav>
  );
}

function docLink(to: string, className: string, label: string, detail?: string) {
  const body = (
    <>
      <span className="font-medium group-hover:text-link">{label}</span>
      {detail ? <span className="mt-1 block text-sm font-normal text-muted-foreground">{detail}</span> : null}
    </>
  );
  if (to.startsWith("/")) return <Link className={className} to={pageHref(to)}>{body}</Link>;
  return <a className={className} href={to}>{body}</a>;
}

function PageOutline({ headings }: { headings: { id: string; text: string; depth: 0 | 1 }[] }) {
  const headingIds = headings.map((heading) => heading.id).join("|");
  const [current, setCurrent] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const nodes = headingIds.split("|").flatMap((id) => {
      const node = document.getElementById(id);
      return node ? [node] : [];
    });
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id);
    }, { rootMargin: outlineRootMargin(), threshold: 0 });
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [headingIds]);

  return (
    <ul className="m-0 list-none p-0">
      {headings.map((heading) => (
        <li key={heading.id}>
          <a
            className={`block border-l py-1 text-sm leading-snug no-underline ${heading.depth === 1 ? "pl-6" : "pl-3"} ${heading.id === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            href={`#${heading.id}`}
            aria-current={heading.id === current ? "location" : undefined}
            onClick={() => setCurrent(heading.id)}
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

function pageOutline(blocks: Block[]): { id: string; text: string; depth: 0 | 1 }[] {
  const headings: { id: string; text: string; depth: 0 | 1 }[] = [];
  blocks.forEach((block, index) => {
    if (block.type === "h2") headings.push({ id: headingId(block.text, index), text: block.text, depth: 0 });
    if (block.type === "api") {
      block.items.forEach((item, itemIndex) => {
        headings.push({ id: apiHeadingId(item.name, index, itemIndex), text: item.name, depth: 1 });
      });
    }
  });
  return headings;
}

const API_HEADING_STRIDE = 100;
const OUTLINE_BOTTOM_CUTOFF = "420px";

function apiHeadingId(name: string, blockIndex: number, itemIndex: number): string {
  return headingId(name, blockIndex * API_HEADING_STRIDE + itemIndex);
}

function outlineRootMargin(): string {
  const anchor = document.querySelector(".scroll-mt-scroll-offset");
  const measured = anchor ? getComputedStyle(anchor).scrollMarginTop : "";
  const top = measured && measured !== "0px" ? measured : "76px";
  return `-${top} 0px -${OUTLINE_BOTTOM_CUTOFF} 0px`;
}

function monoCell(value: string): boolean {
  const isPath = value.includes("/");
  const isShortcut = value.startsWith("Ctrl");
  return isPath || isShortcut;
}

function headingId(text: string, index: number): string {
  const slug = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return `${slug || "section"}-${index}`;
}

function groupCatalog(lang: Lang) {
  const sections: { title: string; entries: DocEntry[] }[] = [];
  for (const entry of catalog) {
    const title = entry.group[lang];
    const current = sections.at(-1);
    if (current?.title === title) current.entries.push(entry);
    else sections.push({ title, entries: [entry] });
  }
  return sections;
}


