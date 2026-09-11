"use client";

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { listStaff } from "@/lib/desk";
import { orderEvents, STATUS_LABEL, type OrderEventRow } from "@/lib/orders";

/**
 * Who moved this order, and when.
 *
 * `order_events.actor` has always recorded the Clerk id of whoever changed
 * the status; this puts a name to it. The staff list is fetched once per
 * operator and shared by every card, so opening ten history cards is one
 * request, not ten.
 */
const staffNames = new Map<string, Promise<Map<string, string>>>();

function namesFor(operatorId: string): Promise<Map<string, string>> {
  let cached = staffNames.get(operatorId);
  if (!cached) {
    cached = listStaff(operatorId).then(
      (rows) => new Map(rows.map((r) => [r.user_id, r.name ?? r.email ?? "a colleague"])),
    );
    staffNames.set(operatorId, cached);
  }
  return cached;
}

/** Forget the cache — after adding or removing someone. */
export function forgetStaffNames(operatorId: string) {
  staffNames.delete(operatorId);
}

export function HandledBy({ orderId, operatorId }: { orderId: string; operatorId: string }) {
  const [lines, setLines] = useState<{ what: string; who: string; when: string }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([orderEvents(orderId), namesFor(operatorId)]).then(([events, names]) => {
      if (cancelled) return;
      // Only the moments a person acted on. "Order placed" is the student.
      const acted = events.filter(
        (e: OrderEventRow) => e.actor && names.has(e.actor) && e.status !== "placed",
      );
      setLines(
        acted.map((e) => ({
          what: STATUS_LABEL[e.status] ?? e.status,
          who: names.get(e.actor!) ?? "a colleague",
          when: new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, operatorId]);

  if (!lines || lines.length === 0) return null;

  return (
    <div className="mt-3.5">
      <p className="label-caps m-0 mb-1.5">Handled by</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {lines.map((l, i) => (
          <li key={i} className="flex items-center gap-2 text-[12px]">
            <UserRound size={12} strokeWidth={2.2} className="shrink-0 text-muted" />
            <span className="font-semibold">{l.who}</span>
            <span className="text-muted">
              {l.what.toLowerCase()} · {l.when}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
