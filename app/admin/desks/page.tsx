import { AdminDesks } from "@/components/admin-desks";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Desks", robots: NOINDEX };

export default function AdminDesksPage() {
  return <AdminDesks />;
}
