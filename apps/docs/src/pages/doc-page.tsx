import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";

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

  const titleClass = entry.path === "/"
    ? "mb-4 text-4xl font-semibold tracking-tight text-pretty max-[800px]:text-3xl"
    : "mb-4 text-3xl font-semibold tracking-tight text-pretty max-[800px]:text-2xl";
  const headings = copy.blocks.flatMap((block, index) => block.type === "h2" ? [{ id: sectionId(index), text: block.text }] : []);
  const onThisPage = lang === "ko" ? "이 페이지" : "On this page";

  return (
    <main id="docs-content" className="min-w-0 px-6 pt-10 pb-16 max-[800px]:px-4 max-[800px]:pt-7 min-[801px]:px-8">
      <div className="min-[1180px]:grid min-[1180px]:grid-cols-[minmax(0,45rem)_14.5rem] min-[1180px]:items-start min-[1180px]:gap-x-8">
        <div className="min-w-0 max-w-[45rem]">
          <header className="mb-8 border-b border-border pb-6">
            <p className="mb-3 text-sm text-muted-foreground">{copy.eyebrow}</p>
            <h1 className={titleClass}>{copy.title}</h1>
            <p className="m-0 text-lg text-pretty text-muted-foreground">{copy.lead}</p>
          </header>
          {headings.length > 0 ? (
            <details className="mb-8 rounded-lg border border-border px-3 py-2 min-[1180px]:hidden">
              <summary className="cursor-pointer text-sm font-medium">{onThisPage}</summary>
              <PageOutline headings={headings} />
            </details>
          ) : null}
          {copy.blocks.map((block, blockIndex) => (
            <BlockView key={blockIndex} block={block} entryway={entry.path === "/"} index={blockIndex} />
          ))}
        </div>
        {headings.length > 0 ? (
          <aside className="sticky top-header hidden max-h-[calc(100vh-var(--spacing-header))] self-start overflow-auto pb-8 min-[1180px]:block" aria-label={onThisPage}>
            <p className="mb-3 text-sm font-semibold">{onThisPage}</p>
            <PageOutline headings={headings} />
          </aside>
        ) : null}
      </div>
      {entry.playground ? <div className="mt-10 max-w-[72rem]"><SdkPlayground /></div> : null}
      <nav className="mt-14 grid max-w-[45rem] gap-3 sm:grid-cols-2" aria-label={lang === "ko" ? "이전 다음" : "Previous and next"}>
        {previous ? <PagerLink entry={previous} lang={lang} direction="prev" /> : <span />}
        {next ? <PagerLink entry={next} lang={lang} direction="next" /> : null}
      </nav>
    </main>
  );
}

export function DocSidebar() {
  const { lang } = useDocsPreferences();
  const sections = groupCatalog(lang);
  const path = useLocation().pathname;
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    navRef.current?.querySelector("[aria-current='page']")?.scrollIntoView({ block: "nearest" });
  }, [path, lang]);

  return (
    <nav
      ref={navRef}
      className="border-border bg-surface px-3 pt-3 pb-8 max-[800px]:border-b min-[801px]:sticky min-[801px]:top-header min-[801px]:max-h-[calc(100vh-var(--spacing-header))] min-[801px]:overflow-auto min-[801px]:border-r"
      aria-label={lang === "ko" ? "문서" : "Documentation"}
    >
      <button
        className="mb-1 hidden w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-left text-sm max-[800px]:flex"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {lang === "ko" ? "목차" : "Contents"}
      </button>
      <div className={open ? "pt-1" : "pt-1 max-[800px]:hidden"}>
        {sections.map((section, index) => (
          <section key={section.title}>
            <h2 className={`mx-3 mb-1 text-xs font-semibold text-muted-foreground ${index === 0 ? "mt-2" : "mt-5"}`}>{section.title}</h2>
            {section.entries.map((entry) => (
              <NavLink
                key={entry.path}
                to={entry.path}
                end
                className={({ isActive }) =>
                  `block rounded-md px-3 py-1.5 text-sm no-underline hover:bg-subtle hover:text-foreground ${
                    isActive
                      ? "bg-subtle text-foreground shadow-[inset_2px_0_0_var(--color-primary)]"
                      : "text-muted-foreground"
                  }`
                }
              >
                {entry[lang].nav}
              </NavLink>
            ))}
          </section>
        ))}
      </div>
    </nav>
  );
}

export function DocControls() {
  const { lang, theme, toggleLang, cycleTheme } = useDocsPreferences();

  return (
    <div className="flex items-center gap-2">
      <a className="px-1 text-sm text-muted-foreground no-underline hover:text-foreground" href="https://github.com/ByeongGi/nuriteo">GitHub</a>
      <button className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm hover:border-strong-border" type="button" onClick={toggleLang}>
        {lang === "ko" ? "English" : "한국어"}
      </button>
      <button className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm hover:border-strong-border" type="button" onClick={cycleTheme} aria-label={lang === "ko" ? "테마 바꾸기" : "Change theme"}>
        {themeLabel(lang, theme)}
      </button>
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
            {item.to.startsWith("/")
              ? <Link className={linkClass(entryway)} to={item.to}>{item.label}</Link>
              : <a className={linkClass(entryway)} href={item.to}>{item.label}</a>}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="mb-6 overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="bg-subtle px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground">{block.columns[0]}</th>
            <th className="bg-subtle px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground">{block.columns[1]}</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row[0]}>
              <td className="border-t border-border px-3 py-2.5 align-top font-mono text-sm">{row[0]}</td>
              <td className="border-t border-border px-3 py-2.5 align-top">{row[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PagerLink({ entry, lang, direction }: { entry: DocEntry; lang: Lang; direction: "prev" | "next" }) {
  const label = direction === "prev"
    ? (lang === "ko" ? "이전" : "Previous")
    : (lang === "ko" ? "다음" : "Next");
  return (
    <Link className={`block rounded-lg border border-border px-4 py-3 no-underline hover:border-strong-border ${direction === "next" ? "sm:text-right" : ""}`} to={entry.path}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="mt-1 block text-foreground">{entry[lang].nav}</span>
    </Link>
  );
}

function MissingPage({ lang }: { lang: Lang }) {
  return (
    <main className="max-w-[42rem] px-7 py-11">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">{lang === "ko" ? "이 주소의 문서가 없습니다." : "This page is not in the docs."}</h1>
      <p><Link className="text-link" to="/">{lang === "ko" ? "소개로 돌아가기" : "Back to the overview"}</Link></p>
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

function linkClass(entryway: boolean): string {
  return entryway
    ? "block rounded-lg border border-border bg-surface px-4 py-3 text-foreground no-underline hover:border-strong-border"
    : "block px-0.5 py-3 text-foreground no-underline hover:text-link";
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
