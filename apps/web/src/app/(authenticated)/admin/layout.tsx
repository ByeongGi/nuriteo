import type { ReactNode } from "react";

import { AdminNavigation } from "./admin-navigation.tsx";

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="admin-shell">
      <AdminNavigation />
      {children}
    </div>
  );
}
