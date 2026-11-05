import type { Metadata } from "next";

import { RegistryConsole } from "@/app/(admin)/admin/integrations/registries/_components/registry-console.tsx";

export const metadata: Metadata = { title: "새 패키지 저장소" };

export default function NewRegistryPage() {
  return <RegistryConsole createMode initialConfiguration={{ items: [], scopes: [] }} />;
}
