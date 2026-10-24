import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "워크스페이스 추가" };

export default function NewWorkspacePage() {
  redirect("/workspaces/new/organization");
}
