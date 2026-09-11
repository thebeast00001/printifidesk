import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ConnectionBanner } from "@/components/connection-banner";
import { JoinDesk } from "@/components/join-desk";

export const metadata = { title: "Join a desk · Printify" };

/**
 * The link inside the QR. The code is in the path, not a query string, so it
 * survives a share sheet and a copy-paste intact. Nothing here claims it —
 * that takes a tap on the page.
 */
export default async function JoinWithCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
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
        <JoinDesk initialCode={code} />
      </Container>
    </StaggerIn>
  );
}
