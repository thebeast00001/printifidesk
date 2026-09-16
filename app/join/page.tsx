import { Container } from "@/components/container";
import { NOINDEX } from "@/lib/seo";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ConnectionBanner } from "@/components/connection-banner";
import { JoinDesk } from "@/components/join-desk";

export const metadata = { title: "Join a desk", robots: NOINDEX };

/** Typing a join code by hand — the page the QR's link also lands on. */
export default function JoinPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title="Join a desk"
        sub="A code from whoever runs the desk puts you on its staff. Sign in once; after that the counter device only asks for a PIN."
      />
      <Container className="pt-3">
        <div className="mb-4">
          <ConnectionBanner />
        </div>
        <JoinDesk />
      </Container>
    </StaggerIn>
  );
}
