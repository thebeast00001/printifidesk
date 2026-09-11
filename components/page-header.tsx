import { Container } from "./container";

export function PageHeader({
  eyebrow,
  title,
  sub,
  aside,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  /** Something small at the top right — a way out, a status. */
  aside?: React.ReactNode;
}) {
  return (
    <Container className="pt-[max(24px,env(safe-area-inset-top))] pb-2 lg:pt-10">
      <div data-anim="page-header" className="relative">
        {aside && <div className="absolute top-0 right-0">{aside}</div>}
        <p className="label-caps mb-1">{eyebrow}</p>
        <h1 className="font-heading m-0 text-[32px] leading-[1.02] font-extrabold lg:text-[40px]">
          {title}
        </h1>
        {sub && <p className="mt-2 mb-0 max-w-[60ch] text-[13.5px] text-muted">{sub}</p>}
      </div>
    </Container>
  );
}
