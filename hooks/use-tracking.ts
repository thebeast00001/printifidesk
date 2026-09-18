"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthKey } from "./use-auth-key";
import { useChanged, type Topic } from "@/lib/changed";
import { ensureSession, getSupabase, type SessionState } from "@/lib/supabase/client";
import { subscribeTable, type ConnectionState } from "@/lib/realtime";
import {
  NOT_ENDED,
  activeOrderBundle,
  queueStatusMine,
  operatorQueue,
  operatorWait,
  defaultOperator,
  getOperator,
  listOrders,
  myTotals,
  orderEvents,
  queueStatus,
  staffOperatorIds,
  type Operator,
  type OperatorWait,
  type OrderEventRow,
  type OrderRow,
  type OrderStatus,
  type QueueStatus,
  type Totals,
} from "@/lib/orders";

export type Backend =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "signed-out" }
  | { state: "unconfigured"; message: string }
  | { state: "error"; message: string };

/** Null when the session is usable; otherwise the state the UI should show. */
function blockedBy(session: SessionState): Backend | null {
  switch (session.status) {
    case "ready":
      return null;
    case "loading":
      return { state: "loading" };
    case "signed-out":
      return { state: "signed-out" };
    case "unconfigured":
      return { state: "unconfigured", message: session.message };
    case "error":
      return { state: "error", message: session.message };
  }
}

/**
 * Re-reads whenever anything relevant changes.
 *
 * Kept for the hooks that only need a nudge (totals, counts). The order capsule
 * uses the payload directly instead — see `useActiveOrder`.
 */
function useRealtime(onChange: () => void, enabled: boolean, filter?: string) {
  const handler = useRef(onChange);
  // oxlint-disable-next-line react/refs -- the latest-value ref, read by callbacks that outlive this render
  handler.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    const stop = [
      subscribeTable({ table: "orders", filter, onChange: () => handler.current() }),
      subscribeTable({ table: "order_events", onChange: () => handler.current() }),
      subscribeTable({ table: "operators", onChange: () => handler.current() }),
    ];
    return () => stop.forEach((fn) => fn());
  }, [enabled, filter]);
}

/**
 * Reloads when the app itself changes the topic — an order placed or
 * cancelled, a desk chosen. The socket is how other people's changes
 * arrive; our own shouldn't wait on it. Reads `load` through a ref so a
 * new load identity (a token rotation) doesn't count as a change.
 */
function useReloadOn(topic: Topic, load: () => Promise<void> | void) {
  const version = useChanged(topic);
  const current = useRef(load);
  // oxlint-disable-next-line react/refs -- the latest-value ref, read by callbacks that outlive this render
  current.current = load;
  useEffect(() => {
    if (version > 0) void current.current();
  }, [version]);
}

/**
 * A short buzz when the job moves, a longer one when it's ready. Only where
 * the browser has the API and the page is visible — a hidden tab's push
 * notification carries its own pattern from the service worker.
 */
function buzz(status: OrderStatus) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  try {
    navigator.vibrate(status === "ready" ? [70, 50, 70, 50, 120] : status === "cancelled" || status === "failed" ? [150] : [35]);
  } catch {
    /* some browsers throw on a vibrate outside a gesture; silence is fine */
  }
}

/** Everything the student-facing tracking UI needs about the live job. */
export function useActiveOrder() {
  const authKey = useAuthKey();
  const [backend, setBackend] = useState<Backend>({ state: "loading" });
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [events, setEvents] = useState<OrderEventRow[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [userId, setUserId] = useState<string | null>(null);

  // Read inside realtime callbacks, which outlive the render that created them.
  const orderRef = useRef<OrderRow | null>(null);
  orderRef.current = order;

  const load = useCallback(async () => {
    const session = await ensureSession();
    const blocked = blockedBy(session);
    if (blocked) {
      setOrder(null);
      return setBackend(blocked);
    }
    setUserId(session.status === "ready" ? session.userId : null);

    try {
      // One round trip: the order carries its timeline, and the queue
      // position finds the same order on its own. Before this it was the
      // order first, then two more once its id was known.
      const [bundle, position] = await Promise.all([activeOrderBundle(), queueStatusMine()]);
      const current = bundle.order;
      setOrder(current);
      setEvents(bundle.events);
      setQueue(current && position && position.order_id === current.id ? position : null);
      // The pay sheet needs the desk's row; warm it now so "Pay now" opens
      // with the id and the QR already there.
      if (current) void getOperator(current.operator_id);
      setBackend({ state: "ready" });
    } catch (error) {
      setBackend({
        state: "error",
        message: error instanceof Error ? error.message : "Couldn't reach the database.",
      });
    }
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);
  useReloadOn("orders", load);

  /** Queue position and the timeline are derived; fetch them after painting. */
  const reconcile = useCallback(async (orderId: string) => {
    const [timeline, position] = await Promise.all([orderEvents(orderId), queueStatus(orderId)]);
    setEvents(timeline);
    setQueue(position);
  }, []);

  useEffect(() => {
    if (backend.state !== "ready" || !userId) return;

    const stop = [
      subscribeTable<OrderRow>({
        table: "orders",
        // Narrowed server-side: without it every order in the system wakes
        // this subscriber up just to be filtered away on the client.
        filter: `user_id=eq.${userId}`,
        onState: setConnection,
        onChange: ({ eventType, row }) => {
          if (!row) return;

          const current = orderRef.current;

          // A different order than the one on screen — a new job, or the
          // current one finishing — needs the full "which is active now" query.
          if (eventType === "INSERT" || !current || current.id !== row.id) {
            void load();
            return;
          }

          // The status the operator just set, painted this tick. No round trip.
          setOrder({ ...current, ...row });
          if (row.status !== current.status) buzz(row.status);
          void reconcile(row.id);
        },
      }),
      subscribeTable<OrderEventRow>({
        table: "order_events",
        onChange: ({ row }) => {
          const current = orderRef.current;
          if (!row || !current || row.order_id !== current.id) return;
          // Append rather than refetch; the timeline is append-only.
          setEvents((prev) => (prev.some((e) => e.id === row.id) ? prev : [...prev, row]));
        },
      }),
    ];

    return () => stop.forEach((fn) => fn());
  }, [backend.state, userId, load, reconcile]);

  /* If the socket is down we're showing stale data, so fall back to polling
     rather than silently freezing. */
  useEffect(() => {
    if (connection !== "down" || backend.state !== "ready") return;
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [connection, backend.state, load]);

  return { backend, order, events, queue, connection, reload: load };
}

export function useOrderHistory() {
  const authKey = useAuthKey();
  const [backend, setBackend] = useState<Backend>({ state: "loading" });
  const [orders, setOrders] = useState<OrderRow[]>([]);

  const load = useCallback(async () => {
    const blocked = blockedBy(await ensureSession());
    if (blocked) {
      setOrders([]);
      return setBackend(blocked);
    }
    setOrders(await listOrders());
    setBackend({ state: "ready" });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);
  useReloadOn("orders", load);

  useRealtime(load, backend.state === "ready");

  return { backend, orders, reload: load };
}

export function useTotals() {
  const authKey = useAuthKey();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    if (blockedBy(await ensureSession())) {
      setTotals(null);
      return setReady(true);
    }
    setTotals(await myTotals());
    setReady(true);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(load, ready);

  return { totals, ready };
}

/**
 * The operator's current wait.
 *
 * Deliberately does *not* require a session: how busy the operator is right now
 * is public information, and it's the first thing a visitor wants to know. The
 * `operators` table is world-readable and `operator_wait()` is security-definer,
 * so this works on the anon role too.
 */
export function useOperatorWait() {
  const authKey = useAuthKey();
  const [operator, setOperator] = useState<Operator | null>(null);
  const [wait, setWait] = useState<OperatorWait | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await defaultOperator();
      setOperator(found);
      setWait(found ? await operatorWait(found.id) : null);
    } catch {
      setOperator(null);
      setWait(null);
    }
    setReady(true);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);
  useReloadOn("desk", load);

  useRealtime(load, ready);

  return { operator, wait, ready };
}

/** How many jobs are still with the operator — the badge on the Orders tab. */
export function useActiveCount() {
  const authKey = useAuthKey();
  const [count, setCount] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    if (blockedBy(await ensureSession())) {
      setCount(null);
      return setReady(true);
    }
    const supabase = getSupabase();
    const { count: n } = await supabase!
      .from("orders")
      .select("id", { count: "exact", head: true })
      .not("status", "in", NOT_ENDED);
    setCount(n ?? 0);
    setReady(true);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);
  useReloadOn("orders", load);

  useRealtime(load, ready);

  return count;
}

/**
 * Operator console. Empty operatorId means "you aren't staff anywhere".
 *
 * `preferred` is the desk the person picked when they're on more than one;
 * it's honoured only if they really are staff of it, otherwise the first
 * desk wins, so a stale choice can never show someone else's queue.
 */
export function useOperatorQueue(preferred: string | null = null) {
  const authKey = useAuthKey();
  const [backend, setBackend] = useState<Backend>({ state: "loading" });
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [operatorIds, setOperatorIds] = useState<string[]>([]);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [queue, setQueue] = useState<OrderRow[]>([]);

  const load = useCallback(async () => {
    const blocked = blockedBy(await ensureSession());
    if (blocked) return setBackend(blocked);

    try {
      const ids = await staffOperatorIds();
      const id = (preferred && ids.includes(preferred) ? preferred : ids[0]) ?? null;
      setOperatorIds(ids);
      setOperatorId(id);
      setOperator(id ? await getOperator(id) : null);
      setQueue(id ? await operatorQueue(id) : []);
      setBackend({ state: "ready" });
    } catch (error) {
      setBackend({
        state: "error",
        message: error instanceof Error ? error.message : "Couldn't reach the database.",
      });
    }
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey, preferred]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(load, backend.state === "ready");

  return { backend, operatorId, operatorIds, operator, queue, reload: load };
}
