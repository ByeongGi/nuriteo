import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button.tsx";
import { searchDocs, type SearchHit } from "../content/search.ts";
import { pageHref } from "../content/paths.ts";
import { useDocsPreferences } from "../preferences.tsx";

const RESULT_LIST_ID = "docs-search-results";

interface DocsSearchControls {
  openSearch: () => void;
}

const DocsSearchContext = createContext<DocsSearchControls | null>(null);

export function DocsSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      const inField = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']");
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "/" && !inField && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <DocsSearchContext.Provider value={{ openSearch: () => setOpen(true) }}>
      {children}
      {open ? <SearchDialog onClose={() => setOpen(false)} /> : null}
    </DocsSearchContext.Provider>
  );
}

export function SearchButton({ className }: { className?: string }) {
  const controls = useContext(DocsSearchContext);
  const { lang } = useDocsPreferences();
  if (!controls) return null;
  const label = lang === "ko" ? "검색" : "Search";
  return (
    <Button className={className} variant="outline" size="sm" type="button" onClick={controls.openSearch}>
      {label}
      <kbd className="hidden font-sans text-xs text-muted-foreground docs-sidebar:inline">{shortcutLabel()}</kbd>
    </Button>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const { lang } = useDocsPreferences();
  const navigate = useNavigate();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const hits = searchDocs(query, lang);
  const copy = searchCopy[lang];

  useEffect(() => {
    inputRef.current?.focus();
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  function openHit(hit: SearchHit) {
    navigate(pageHref(hit.path));
    onClose();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (hits.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[active];
      if (hit) openHit(hit);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-overlay" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-auto mt-[12vh] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-none"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="sr-only">{copy.title}</h2>
        <input
          ref={inputRef}
          className="w-full border-0 border-b border-border bg-transparent px-4 py-3 text-base outline-none"
          value={query}
          placeholder={copy.placeholder}
          aria-controls={RESULT_LIST_ID}
          aria-activedescendant={hits[active] ? resultId(active) : undefined}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul id={RESULT_LIST_ID} role="listbox" aria-label={copy.title} className="m-0 max-h-80 list-none overflow-auto p-2">
          {query.trim().length === 0 ? <li className="px-3 py-6 text-sm text-muted-foreground">{copy.empty}</li> : null}
          {query.trim().length > 0 && hits.length === 0 ? <li className="px-3 py-6 text-sm text-muted-foreground">{copy.none}</li> : null}
          {hits.map((hit, index) => (
            <li key={hit.path} id={resultId(index)} role="option" aria-selected={index === active}>
              <button
                className={`block w-full rounded-md px-3 py-2 text-left ${index === active ? "bg-selected" : "hover:bg-hover"}`}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => openHit(hit)}
              >
                <span className="text-xs text-muted-foreground">{hit.group}</span>
                <span className="mt-0.5 block text-sm text-foreground">{hit.title}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="m-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">{copy.hint}</p>
      </div>
    </div>
  );
}

const searchCopy = {
  ko: {
    title: "문서 검색",
    placeholder: "제목, 본문, 기호",
    empty: "검색어를 입력하면 이 사이트의 한국어 문서에서 찾습니다.",
    none: "해당하는 문서가 없습니다.",
    hint: "위아래 화살표로 고르고 Enter로 엽니다. Esc로 닫습니다."
  },
  en: {
    title: "Search docs",
    placeholder: "Title, page, or symbol",
    empty: "Type to search the English pages on this site.",
    none: "No page matches.",
    hint: "Use the up and down arrows, Enter to open, Esc to close."
  }
} as const;

function resultId(index: number): string {
  return `docs-search-result-${index}`;
}

function shortcutLabel(): string {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)) return "⌘K";
  return "Ctrl K";
}
