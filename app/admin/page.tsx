import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ConnectionBanner } from "@/components/connection-banner";
import { AdminDesks } from "@/components/admin-desks";

export const metadata = { title: "Desks" };

/** Creating desks and handing their owners a code. Admins only, enforced in the database. */
export default function AdminPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title="Desks"
        sub="The platform fee, and every desk: what each owes, what it settled, and a code for a new one's owner."
      />
      <Container className="pt-3">
        <div className="mb-4">
          <ConnectionBanner />
        </div>
        <AdminDesks />
      </Container>
    </StaggerIn>
  );
}
