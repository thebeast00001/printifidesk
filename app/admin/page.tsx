import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ConnectionBanner } from "@/components/connection-banner";
import { AdminApplications } from "@/components/admin-applications";

export const metadata = { title: "Applications · Printify" };

/** Reviewing operator applications. Admins only, enforced in the database. */
export default function AdminPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title="Operator applications"
        sub="Approving one creates the operator and grants access, in a single step."
      />
      <Container className="pt-3">
        <div className="mb-4">
          <ConnectionBanner />
        </div>
        <AdminApplications />
      </Container>
    </StaggerIn>
  );
}
