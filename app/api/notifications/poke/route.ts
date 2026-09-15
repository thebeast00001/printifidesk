import { auth } from "@clerk/nextjs/server";
import { refuseCrossOrigin } from "@/lib/server/db";
import { drain } from "../dispatch/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Something was just queued — send it."
 *
 * The app calls this the moment it does something that queues a
 * notification: a desk moves an order along, messages a student, or a
 * student places an order. Pushes then go out in seconds with no scheduler
 * at all, which matters on a plan whose crons run once a day. Any signed-in
 * account may call it — it can't choose what is sent, only that the queue
 * is drained, and every row is claimed atomically, so a stampede of pokes
 * sends nothing twice. The scheduled run stays as the backstop for anything
 * queued by hand or while nobody was looking.
 */
export async function POST(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;
  const { userId } = await auth();
  if (!userId) return Response.json({ ok: false, error: "Sign in first" }, { status: 401 });
  return drain();
}
