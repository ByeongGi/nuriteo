import { NavLink, Route, Routes } from "react-router";

import { DocControls, DocPage, DocSidebar } from "./pages/doc-page.tsx";
import { DocsPreferencesProvider } from "./preferences.tsx";

export function App() {
  return (
    <DocsPreferencesProvider>
      <div className="shell">
        <header className="top">
          <NavLink className="brand" to="/" end>
            <span className="mark" aria-hidden="true">N</span>
            NURITEO
          </NavLink>
          <DocControls />
        </header>
        <div className="frame">
          <DocSidebar />
          <Routes>
            <Route path="*" element={<DocPage />} />
          </Routes>
        </div>
      </div>
    </DocsPreferencesProvider>
  );
}
