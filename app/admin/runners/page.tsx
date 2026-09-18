import { AdminRunners } from "@/components/admin-runners";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Runners", robots: NOINDEX };

export default function AdminRunnersPage() {
  return <AdminRunners />;
}
