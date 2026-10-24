import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "관리자 홈" };

export default function AdminHomePage() {
  redirect("/admin/operations");
}
