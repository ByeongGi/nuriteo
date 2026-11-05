import type { Metadata } from "next";
import { Suspense } from "react";

import { ActivationForm } from "@/app/(public)/activate/_components/activation-form.tsx";
import { ProductEntryLoading } from "@/app/_components/product-entry-shell.tsx";

export const metadata: Metadata = { title: "계정 활성화" };

export default function ActivatePage() {
  return (
    <Suspense fallback={<ProductEntryLoading label="계정 활성화를 준비하는 중" />}>
      <ActivationForm />
    </Suspense>
  );
}
