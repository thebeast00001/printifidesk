import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { OperatorBoard } from "@/components/operator-board";
import { ConnectionBanner } from "@/components/connection-banner";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export const metadata = { title: "Operator · Print Counter" };

export default function CounterPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title="Printify Operator"
        sub="Your queue, your prices, your hours. Every action here writes a timeline entry the student sees immediately."
        aside={
          /* The dock never leaves the desk; this does, on purpose. */
          <Link
            href="/"
            className="flex items-center gap-1 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
          >
            Student side
            <ArrowUpRight size={13} strokeWidth={2.2} />
          </Link>
        }
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
