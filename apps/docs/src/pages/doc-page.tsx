import { useEffect, useState } from "react";
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
    ? "mb-4 text-3xl font-semibold tracking-tight max-[800px]:text-2xl"
    : "mb-4 text-2xl font-semibold tracking-tight";

  return (
    <main className={`${entry.playground ? "max-w-6xl" : "max-w-[42rem]"} px-7 pt-11 pb-18 max-[800px]:px-[1.15rem] max-[800px]:pt-7 max-[800px]:pb-12`}>
      <div className={entry.playground ? "max-w-[42rem]" : undefined}>
        <p className="mb-2.5 text-sm font-medium text-primary">{copy.eyebrow}</p>
        <h1 className={titleClass}>{copy.title}</h1>
        <p className="mb-7 text-lg text-muted-foreground">{copy.lead}</p>
        {copy.blocks.map((block, blockIndex) => (
          <BlockView key={blockIndex} block={block} />
        ))}
      </div>
      {entry.playground ? <SdkPlayground /> : null}
      <nav className={`${entry.playground ? "max-w-[42rem]" : ""} mt-12 flex justify-between gap-4 border-t border-border pt-5`} aria-label={lang === "ko" ? "이전 다음" : "Previous and next"}>
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

  useEffect(() => {
    setOpen(false);
  }, [path]);

  return (
    <nav
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
        {sections.map((section) => (
          <section key={section.title}>
            <h2 className="mx-3 mt-4 mb-1 text-xs font-semibold text-muted-foreground">{section.title}</h2>
            {section.entries.map((entry) => (
              <NavLink
                key={entry.path}
                to={entry.path}
                end={entry.path === "/"}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-1.5 text-sm no-underline hover:text-foreground ${
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
    <div className="flex gap-2">
      <button className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm hover:border-strong-border" type="button" onClick={toggleLang}>
        {lang === "ko" ? "English" : "한국어"}
      </button>
      <button className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm hover:border-strong-border" type="button" onClick={cycleTheme} aria-label={lang === "ko" ? "테마 바꾸기" : "Change theme"}>
        {themeLabel(lang, theme)}
      </button>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.type === "p") return <p className="mb-4">{block.text}</p>;
  if (block.type === "h2") return <h2 className="mt-9 mb-3 text-xl tracking-tight">{block.text}</h2>;
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
      <ul className="mb-7 list-none border-t border-border p-0">
        {block.items.map((item) => (
          <li key={item.to} className="border-b border-border">
            {item.to.startsWith("/")
              ? <Link className="block px-0.5 py-3 text-foreground no-underline hover:text-link" to={item.to}>{item.label}</Link>
              : <a className="block px-0.5 py-3 text-foreground no-underline hover:text-link" href={item.to}>{item.label}</a>}
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
    <Link className={`grid max-w-64 gap-0.5 text-foreground no-underline hover:text-link ${direction === "next" ? "justify-self-end text-right" : ""}`} to={entry.path}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {entry[lang].nav}
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
