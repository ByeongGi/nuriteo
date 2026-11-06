import { useEffect } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { catalog } from "../content/catalog.ts";
import type { Block, DocEntry, Lang } from "../content/types.ts";
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

  return (
    <main className="page">
      <p className="eyebrow">{copy.eyebrow}</p>
      <h1>{copy.title}</h1>
      <p className="lead">{copy.lead}</p>
      {copy.blocks.map((block, blockIndex) => (
        <BlockView key={blockIndex} block={block} />
      ))}
      {entry.playground ? <SdkPlayground /> : null}
      <nav className="pager" aria-label={lang === "ko" ? "이전 다음" : "Previous and next"}>
        {previous ? <PagerLink entry={previous} lang={lang} /> : <span />}
        {next ? <PagerLink entry={next} lang={lang} /> : null}
      </nav>
    </main>
  );
}

export function DocSidebar() {
  const { lang } = useDocsPreferences();
  const sections = groupCatalog(lang);

  return (
    <nav className="side" aria-label={lang === "ko" ? "문서" : "Documentation"}>
      {sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          {section.entries.map((entry) => (
            <NavLink key={entry.path} to={entry.path} end={entry.path === "/"}>
              {entry[lang].nav}
            </NavLink>
          ))}
        </section>
      ))}
    </nav>
  );
}

export function DocControls() {
  const { lang, theme, toggleLang, cycleTheme } = useDocsPreferences();

  return (
    <div className="controls">
      <button type="button" onClick={toggleLang}>
        {lang === "ko" ? "English" : "한국어"}
      </button>
      <button type="button" onClick={cycleTheme} aria-label={lang === "ko" ? "테마 바꾸기" : "Change theme"}>
        {themeLabel(lang, theme)}
      </button>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.type === "p") return <p>{block.text}</p>;
  if (block.type === "h2") return <h2>{block.text}</h2>;
  if (block.type === "ul") {
    return (
      <ul>
        {block.items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    );
  }
  if (block.type === "code") {
    return <pre className="code"><code>{block.text}</code></pre>;
  }
  if (block.type === "links") {
    return (
      <ul className="links">
        {block.items.map((item) => (
          <li key={item.to}>{item.to.startsWith("/") ? <Link to={item.to}>{item.label}</Link> : <a href={item.to}>{item.label}</a>}</li>
        ))}
      </ul>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{block.columns[0]}</th>
          <th>{block.columns[1]}</th>
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row) => (
          <tr key={row[0]}>
            <td>{row[0]}</td>
            <td>{row[1]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PagerLink({ entry, lang }: { entry: DocEntry; lang: Lang }) {
  return <Link to={entry.path}>{entry[lang].nav}</Link>;
}

function MissingPage({ lang }: { lang: Lang }) {
  return (
    <main className="page">
      <h1>{lang === "ko" ? "이 주소의 문서가 없습니다." : "This page is not in the docs."}</h1>
      <p><Link to="/">{lang === "ko" ? "소개로 돌아가기" : "Back to the overview"}</Link></p>
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
