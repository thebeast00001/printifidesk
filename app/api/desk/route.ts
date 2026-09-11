import { createClient } from "@supabase/supabase-js";
import { clerkClient } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turns a paired device plus a staff PIN into a Clerk session.
 *
 * The device token and the PIN are checked by `desk_verify_pin()` in
 * Postgres — the same function the harness drives through its lockout — and
 * on success this asks Clerk for a one-time sign-in ticket for that person.
 * The browser redeems the ticket and from then on holds an ordinary Clerk
 * session: same JWT, same is_staff(), same RLS. Nothing about the security
 * model changes; this is a different front door to the same house.
 *
 * Talks to Supabase as `anon` — the RPC is callable by anon by design, the
 * device token being the credential — so no service-role key is needed here.
 * The Clerk secret key is, and this is the only route that touches it.
 */

interface Body {
  token?: unknown;
  userId?: unknown;
  pin?: unknown;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  const pin = typeof body.pin === "string" ? body.pin : "";

  if (!/^[0-9a-f]{64}$/.test(token) || !userId || !/^[0-9]{4,6}$/.test(pin)) {
    return Response.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    return Response.json({ ok: false, message: "Supabase is not configured." }, { status: 503 });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc("desk_verify_pin", {
    p_token: token,
    p_user: userId,
    p_pin: pin,
  });

  if (error) {
    const needsMigration = /does not exist|schema cache/i.test(error.message);
    return Response.json(
      {
        ok: false,
        message: needsMigration
          ? "Desk sign-in needs migration 0018 — run it in the Supabase SQL editor."
          : error.message,
      },
      { status: needsMigration ? 503 : 500 },
    );
  }

  const verdict = (Array.isArray(data) ? data[0] : data) as
    | { ok: boolean; who: string | null; message: string | null }
    | undefined;

  if (!verdict?.ok || !verdict.who) {
    // 401, and the reason — "Wrong PIN", "Locked for 4 min 12 s" — is the
    // database's own wording, which the desk sees verbatim.
    return Response.json({ ok: false, message: verdict?.message ?? "Refused" }, { status: 401 });
  }

  try {
    const clerk = await clerkClient();
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: verdict.who,
      // Long enough to redeem, short enough that an intercepted one is
      // worthless by the time anyone could use it.
      expiresInSeconds: 60,
    });
    return Response.json({ ok: true, ticket: ticket.token });
  } catch (e) {
    return Response.json(
      { ok: false, message: e instanceof Error ? e.message : "Clerk refused to issue a sign-in." },
      { status: 502 },
    );
  }
}
