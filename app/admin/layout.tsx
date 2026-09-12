import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ConnectionBanner } from "@/components/connection-banner";
import { AdminGate } from "@/components/admin-gate";

/**
 * The admin's pages share one frame and one gate. The dock below them is
 * the admin's own: Fees, Desks, Diagnostics — nothing here leads to a
 * student page or a desk's queue.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title="Admin"
        sub="The platform fee, and every desk: what each owes, what it settled, and a code for a new one's owner."
      />
      <Container className="pt-3">
        <div className="mb-4">
          <ConnectionBanner />
        </div>
        <AdminGate>{children}</AdminGate>
      </Container>
    </StaggerIn>
  );
}
