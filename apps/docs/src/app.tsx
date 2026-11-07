import { Link, Route, Routes } from "react-router";

import { DocControls, DocPage, DocSectionNav, DocSidebar } from "./pages/doc-page.tsx";
import { DocsPreferencesProvider, useDocsPreferences } from "./preferences.tsx";

function SkipLink() {
  const { lang } = useDocsPreferences();
  return (
    <a className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-2 focus:text-sm" href="#docs-content">
      {lang === "ko" ? "본문으로" : "Skip to content"}
    </a>
  );
}

export function App() {
  return (
    <DocsPreferencesProvider>
      <div className="min-h-screen bg-background text-foreground">
        <SkipLink />
        <header className="sticky top-0 z-20 flex h-16 items-center gap-6 border-b border-border bg-surface px-6">
          <Link className="inline-flex shrink-0 items-center gap-2.5 font-semibold tracking-tight text-foreground no-underline" to="/">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-sm text-on-primary" aria-hidden="true">N</span>
            NURITEO
          </Link>
          <DocSectionNav />
          <div className="ml-auto">
            <DocControls />
          </div>
        </header>
        <div className="items-start min-[801px]:grid min-[801px]:grid-cols-[17rem_minmax(0,1fr)] min-[1180px]:grid-cols-[17rem_minmax(0,1fr)_16rem]">
          <DocSidebar />
          <Routes>
            <Route path="*" element={<DocPage />} />
          </Routes>
        </div>
      </div>
    </DocsPreferencesProvider>
  );
}
