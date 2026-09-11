import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ClaimAdmin, DiagnosticsView } from "@/components/diagnostics-view";

export const metadata = { title: "Diagnostics" };

/**
 * Setup checks for whoever runs this deployment. Deliberately not linked from
 * anywhere in the app — students never configure a backend.
 */
export default function DiagnosticsPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Operator tools"
        title="Diagnostics"
        sub="Whether the services are wired up, and what Postgres thinks you are."
      />

      <Container className="pt-3">
        <div className="mb-7">
          <ClaimAdmin />
        </div>
        <DiagnosticsView />
      </Container>
    </StaggerIn>
  );
}
