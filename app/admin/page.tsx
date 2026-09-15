import { AdminFees } from "@/components/admin-fees";
import { AdminPayouts } from "@/components/admin-payouts";

export const metadata = { title: "Platform fee" };

export default function AdminFeesPage() {
  return (
    <div className="flex flex-col gap-5">
      <AdminFees />
      <AdminPayouts />
    </div>
  );
}
