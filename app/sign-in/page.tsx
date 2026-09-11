import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { DeskDoor } from "@/components/sign-in/desk-door";
import { StudentDoor } from "@/components/sign-in/student-door";
import { requestOrigin, requestSurface } from "@/lib/server/surface";
import { sameOriginPath } from "@/lib/surface";

export const metadata = { title: "Sign in" };

/**
 * One address, two doors. The desk site always gets the desk's; on a shared
 * host `?desk=1` asks for it. Clerk sends people here from a protected page
 * with `redirect_url`, which is honoured only as a same-origin path.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ desk?: string; redirect_url?: string; next?: string }>;
}) {
  const surface = await requestSurface();
  const origin = await requestOrigin();
  const params = await searchParams;
  const desk = surface === "desk" || params.desk === "1";
  // Clerk sends `redirect_url` as an absolute URL; only this origin's are kept.
  const next = sameOriginPath(params.redirect_url ?? params.next, desk ? "/operator" : "/", origin);

  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Printify"
        title={desk ? "Printify Desk" : "Sign in"}
        sub={
          desk
            ? "The counter's side of Printify. Your desk account, or a fresh one — then a join code puts you on a desk."
            : "Campus printing without the queue."
        }
      />
      <Container className="pt-3">{desk ? <DeskDoor next={next} /> : <StudentDoor next={next} />}</Container>
    </StaggerIn>
  );
}
