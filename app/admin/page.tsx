import { AdminFees } from "@/components/admin-fees";
import { NOINDEX } from "@/lib/seo";
import { AdminPayouts } from "@/components/admin-payouts";
import { AdminCash } from "@/components/admin-cash";

export const metadata = { title: "Platform fee", robots: NOINDEX };

export default function AdminFeesPage() {
  return (
    <div className="flex flex-col gap-5">
      <AdminFees />
      <AdminPayouts />
      <AdminCash />
    </div>
  );
}
