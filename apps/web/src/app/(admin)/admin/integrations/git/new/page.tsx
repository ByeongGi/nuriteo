import type { Metadata } from "next";

import { GitProviderConsole } from "#src/app/(admin)/admin/git-providers/provider-console.tsx";

export const metadata: Metadata = { title: "새 Git 제공자" };

export default function NewGitProviderPage() {
  return <GitProviderConsole createMode initialProviders={[]} />;
}
