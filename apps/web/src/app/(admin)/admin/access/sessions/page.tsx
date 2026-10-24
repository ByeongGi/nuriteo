import { redirect } from "next/navigation";

export default function AdminSessionsPage() {
  redirect("/admin/access/mfa-reset");
}
