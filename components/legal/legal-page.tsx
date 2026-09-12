import Link from "next/link";
import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";

/**
 * The frame both legal pages share. Plain prose, a readable line length, a
 * dated header, and the contact address from the environment — a page that
 * printed a made-up mailbox would be worse than one that says none is set.
 */
export const LEGAL_UPDATED = "12 September 2026";
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || null;

export function LegalPage({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <StaggerIn>
      <PageHeader eyebrow="Printify" title={title} sub={sub} />
      <Container className="pt-3 pb-24">
        <article className="max-w-[68ch] text-[14px] leading-[1.7] text-ink-soft [&_p]:my-3">
          <p className="font-mono text-[11.5px] text-muted">Last updated {LEGAL_UPDATED}</p>
          {children}
          <p className="mt-10 border-t border-line pt-4 text-[12.5px] text-muted">
            See also the{" "}
            <Link href="/privacy" className="font-semibold underline-offset-2 hover:underline">
              privacy policy
            </Link>{" "}
            and the{" "}
            <Link href="/terms" className="font-semibold underline-offset-2 hover:underline">
              terms of service
            </Link>
            .
          </p>
        </article>
      </Container>
    </StaggerIn>
  );
}

export function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="font-heading mt-8 mb-2 text-[18px] font-bold text-ink">{children}</h2>;
}

/** The contact line. Only a real address is ever printed. */
export function Contact() {
  return SUPPORT_EMAIL ? (
    <p>
      Questions, corrections or requests about your data: write to{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-ink underline-offset-2 hover:underline">
        {SUPPORT_EMAIL}
      </a>
      .
    </p>
  ) : (
    <p>
      Questions, corrections or requests about your data: ask at the desk you ordered from, who can reach
      Printify.
    </p>
  );
}
