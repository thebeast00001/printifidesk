import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ConnectionBanner } from "@/components/connection-banner";
import { DeskProvider } from "@/components/desk/desk-provider";
import { DeskShell } from "@/components/desk/desk-shell";

/**
 * The desk site's frame. The provider holds the one realtime subscription
 * and the operator row above the pages, so moving between the queue,
 * takings and settings never tears the socket down.
 */
export default function DeskLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printifi"
        title="Printifi Desk"
        sub="Your queue, your prices, your hours. Every action here writes a timeline entry the student sees immediately."
      />
      <Container className="pt-3">
        <div className="mb-4">
          <ConnectionBanner />
        </div>
        <DeskProvider>
          <DeskShell>{children}</DeskShell>
        </DeskProvider>
      </Container>
    </StaggerIn>
  );
}
