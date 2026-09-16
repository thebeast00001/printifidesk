import { AdminApplications } from "@/components/admin-applications";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Applications", robots: NOINDEX };

export default function AdminApplicationsPage() {
  return <AdminApplications />;
}
