import { NavLink, Route, Routes } from "react-router";

import { DocControls, DocPage, DocSidebar } from "./pages/doc-page.tsx";
import { DocsPreferencesProvider } from "./preferences.tsx";

export function App() {
  return (
    <DocsPreferencesProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-20 flex h-header items-center justify-between gap-4 border-b border-border bg-surface px-5">
          <NavLink className="inline-flex items-center gap-2.5 font-semibold tracking-tight text-foreground no-underline" to="/" end>
            <span className="grid size-7 place-items-center rounded-md bg-primary text-sm text-on-primary" aria-hidden="true">N</span>
            NURITEO
          </NavLink>
          <DocControls />
        </header>
        <div className="grid items-start min-[801px]:grid-cols-[16rem_minmax(0,1fr)]">
          <DocSidebar />
          <Routes>
            <Route path="*" element={<DocPage />} />
          </Routes>
        </div>
      </div>
    </DocsPreferencesProvider>
  );
}
