import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { catalog } from "../content/catalog.ts";
import type { Block, DocEntry, Lang } from "../content/types.ts";
import { CodeBlock } from "./code-editor.tsx";
import { SdkPlayground } from "./sdk-example.tsx";
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

  const titleClass = "mb-4 text-[2rem] leading-10 font-semibold tracking-tight text-pretty max-[800px]:text-2xl max-[800px]:leading-8";
  const headings = copy.blocks.flatMap((block, index) => block.type === "h2" ? [{ id: sectionId(index), text: block.text }] : []);
  const onThisPage = lang === "ko" ? "이 페이지" : "On this page";

  return (
    <>
      <main id="docs-content" className={`min-w-0 px-6 pt-10 pb-16 max-[800px]:px-4 max-[800px]:pt-7 min-[801px]:px-10 ${headings.length === 0 ? "min-[1180px]:col-span-2" : ""}`}>
        <header className="mb-8 max-w-[43rem]">
          <p className="mb-3 text-sm text-muted-foreground">{copy.eyebrow}</p>
          <h1 className={titleClass}>{copy.title}</h1>
          <p className="m-0 text-lg text-pretty text-muted-foreground">{copy.lead}</p>
          <Separator className="mt-6" />
        </header>
        {headings.length > 0 ? (
          <Collapsible className="mb-8 max-w-[43rem] rounded-lg border min-[1180px]:hidden">
            <CollapsibleTrigger className="w-full px-3 py-2 text-left text-sm">{onThisPage}</CollapsibleTrigger>
            <CollapsibleContent className="px-1 pb-2">
              <PageOutline headings={headings} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <div className="max-w-[43rem]">
          {copy.blocks.map((block, blockIndex) => (
            <BlockView key={blockIndex} block={block} entryway={entry.path === "/"} index={blockIndex} />
          ))}
        </div>
        {entry.playground ? <div className="mt-8"><SdkPlayground /></div> : null}
        <nav className="mt-14 grid max-w-[43rem] gap-3 sm:grid-cols-2" aria-label={lang === "ko" ? "이전 다음" : "Previous and next"}>
          {previous ? <PagerLink entry={previous} lang={lang} direction="prev" /> : <span />}
          {next ? <PagerLink entry={next} lang={lang} direction="next" /> : null}
        </nav>
      </main>
      {headings.length > 0 ? (
        <aside className="sticky top-16 hidden max-h-[calc(100vh-4rem)] self-start overflow-auto border-l border-border px-8 pt-10 pb-8 min-[1180px]:block" aria-label={onThisPage}>
          <p className="mb-3 text-xs font-medium tracking-wide text-muted-foreground">{onThisPage}</p>
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
    <nav className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto min-[1100px]:flex" aria-label={lang === "ko" ? "문서 구역" : "Documentation sections"}>
      {sections.map((section) => {
        const active = section.entries.some((entry) => entry.path === path);
        return (
          <Link
            key={section.title}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm no-underline ${active ? "font-medium text-primary" : "text-muted-foreground hover:text-foreground"}`}
            to={section.entries[0].path}
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
      <div className="border-b border-border bg-surface p-3 min-[801px]:hidden">
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
              <SidebarLinks lang={lang} path={path} />
            </ScrollArea>
          </SheetContent>
        </Sheet>
      </div>
      <nav
        ref={navRef}
        className="hidden border-r border-border bg-surface min-[801px]:sticky min-[801px]:top-16 min-[801px]:block min-[801px]:h-[calc(100vh-4rem)]"
        aria-label={lang === "ko" ? "문서" : "Documentation"}
      >
        <ScrollArea className="h-full">
          <div className="px-5 pt-5 pb-16">
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
          {section.entries.length > 1 ? <h2 className="mb-1 px-3 text-xs font-semibold text-muted-foreground">{section.title}</h2> : null}
          {section.entries.map((entry) => {
            const current = path === entry.path;
            return (
              <Link
                key={entry.path}
                to={entry.path}
                aria-current={current ? "page" : undefined}
                className={`block rounded-md px-3 py-1.5 text-sm no-underline hover:text-foreground ${current ? "font-medium text-primary" : "text-muted-foreground"}`}
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
      <Button variant="ghost" size="sm" asChild>
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

function BlockView({ block, entryway, index }: { block: Block; entryway: boolean; index: number }) {
  if (block.type === "p") return <p className="mb-4 text-pretty">{block.text}</p>;
  if (block.type === "h2") return <h2 id={sectionId(index)} className="mt-12 mb-4 text-2xl font-semibold tracking-tight text-pretty">{block.text}</h2>;
  if (block.type === "ul") {
    return (
      <ul className="mb-6 list-disc pl-5 [&_li+li]:mt-1.5">
        {block.items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    );
  }
  if (block.type === "code") return <CodeBlock text={block.text} />;
  if (block.type === "links") {
    return (
      <ul className={entryway ? "mb-2 grid list-none gap-2 p-0" : "mb-7 list-none border-t border-border p-0"}>
        {block.items.map((item) => (
          <li key={item.to} className={entryway ? "" : "border-b border-border"}>
            {entryway
              ? <Card className="shadow-none">{item.to.startsWith("/")
                ? <Link className="block px-4 py-3 text-foreground no-underline" to={item.to}>{item.label}</Link>
                : <a className="block px-4 py-3 text-foreground no-underline" href={item.to}>{item.label}</a>}
              </Card>
              : item.to.startsWith("/")
                ? <Link className="block px-0.5 py-3 text-foreground no-underline hover:text-link" to={item.to}>{item.label}</Link>
                : <a className="block px-0.5 py-3 text-foreground no-underline hover:text-link" href={item.to}>{item.label}</a>}
          </li>
        ))}
      </ul>
    );
  }
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
            <TableCell className="font-mono">{row[0]}</TableCell>
            <TableCell>{row[1]}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PagerLink({ entry, lang, direction }: { entry: DocEntry; lang: Lang; direction: "prev" | "next" }) {
  const label = direction === "prev"
    ? (lang === "ko" ? "이전" : "Previous")
    : (lang === "ko" ? "다음" : "Next");
  return (
    <Card className={`shadow-none ${direction === "next" ? "sm:text-right" : ""}`}>
      <Link className="block px-4 py-3 no-underline" to={entry.path}>
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="mt-1 block text-foreground">{entry[lang].nav}</span>
      </Link>
    </Card>
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

function PageOutline({ headings }: { headings: { id: string; text: string }[] }) {
  const key = headings.map((heading) => heading.id).join("|");
  const [current, setCurrent] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const nodes = key.split("|").flatMap((id) => {
      const node = document.getElementById(id);
      return node ? [node] : [];
    });
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id);
    }, { rootMargin: "-80px 0px -420px 0px", threshold: 0 });
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [key]);

  return (
    <ul className="m-0 list-none p-0">
      {headings.map((heading) => (
        <li key={heading.id}>
          <a
            className={`block border-l py-1 pl-3 text-sm leading-snug no-underline ${heading.id === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
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

function sectionId(index: number): string {
  return `section-${index}`;
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

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}
