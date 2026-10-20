import type { Metadata } from "next";
import { Suspense } from "react";

import { ActivationForm } from "./activation-form.tsx";
import { ProductEntryLoading } from "../_components/product-entry-shell.tsx";

export const metadata: Metadata = { title: "Activate account" };

export default function ActivatePage() {
  return (
    <Suspense fallback={<ProductEntryLoading label="Loading activation" />}>
      <ActivationForm />
    </Suspense>
  );
}
