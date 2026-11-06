import { NavLink, Route, Routes } from "react-router";

import { HomePage } from "./pages/home.tsx";
import { SdkExamplePage } from "./pages/sdk-example.tsx";

export function App() {
  return (
    <div className="shell">
      <header className="top">
        <NavLink className="brand" to="/">
          <span className="mark" aria-hidden="true">N</span>
          NURITEO
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>소개</NavLink>
          <NavLink to="/sdk">SDK 예시</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/sdk" element={<SdkExamplePage />} />
      </Routes>
    </div>
  );
}
