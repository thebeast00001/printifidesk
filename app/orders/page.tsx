import { Container } from "@/components/container";
import { NOINDEX } from "@/lib/seo";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { StatusIsland } from "@/components/status-island";
import { OrderList } from "@/components/order-list";
import { PrivacyNote } from "@/components/privacy-note";

export const metadata = { title: "Orders", robots: NOINDEX };

export default function OrdersPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Print Counter"
        title="Your orders"
        sub="Every job you've placed, live. Show the token when you collect."
      />

      <Container className="pt-3">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-10">
          <div className="order-2 min-w-0 lg:order-1">
            <OrderList />
          </div>

          <aside className="order-1 min-w-0 lg:order-2 lg:sticky lg:top-6">
            <StatusIsland />
          </aside>
        </div>

        <PrivacyNote />
      </Container>
    </StaggerIn>
  );
}
