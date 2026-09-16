import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ReceiptView } from "@/components/receipt-view";

export const metadata = { title: "Receipt" };

/** A printable receipt for one order — the student's own; RLS answers for anyone else's. */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <StaggerIn>
      <PageHeader eyebrow="Print Counter" title="Receipt" sub="The bill as it was charged, for your records." />
      <Container className="pt-3 pb-24">
        <div className="max-w-[640px]">
          <ReceiptView orderId={id} />
        </div>
      </Container>
    </StaggerIn>
  );
}
