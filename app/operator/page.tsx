import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { OperatorBoard } from "@/components/operator-board";
import { ConnectionBanner } from "@/components/connection-banner";

export const metadata = { title: "Operator · Print Counter" };

export default function CounterPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title="Printify Operator"
        sub="Your queue, your prices, your hours. Every action here writes a timeline entry the student sees immediately."
      />

      <Container className="pt-3">
        <div className="mb-4">
          <ConnectionBanner />
        </div>
        <OperatorBoard />
      </Container>
    </StaggerIn>
  );
}
