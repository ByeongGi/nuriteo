import type { Metadata } from "next";
import { Suspense } from "react";

import { ActivationForm } from "./activation-form.tsx";

export const metadata: Metadata = { title: "Activate account" };

export default function ActivatePage() {
  return (
    <Suspense fallback={<main id="main-content" className="entry-page" aria-busy="true">Loading activation…</main>}>
      <ActivationForm />
    </Suspense>
  );
}
