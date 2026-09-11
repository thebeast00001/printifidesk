"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { messagesFor, sendMessage, type OrderMessage } from "@/lib/desk";
import { subscribeTable } from "@/lib/realtime";
import { cn } from "@/lib/utils";

/**
 * The phrases a desk actually sends. Tapping one fills the box rather than
 * sending, because "page 3" is usually "page 7" once you look.
 */
const QUICK = [
  "Page __ is blank — print it anyway?",
  "Your file won't open. Can you re-upload it as a PDF?",
  "Ready earlier than expected — come by whenever.",
  "We close at __ today; it'll be here tomorrow if you can't make it.",
];

/**
 * A short line from the desk to the student, with a push behind it.
 *
 * One direction only. The student's replies are the report button and the
 * phone number on the card; a chat in both directions is a support desk, and
 * a print counter isn't one.
 */
export function MessageThread({ orderId, canSend = true }: { orderId: string; canSend?: boolean }) {
  const [messages, setMessages] = useState<OrderMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setMessages(await messagesFor(orderId)), [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Read receipts arrive the same way the student sees the message: live.
  useEffect(() => {
    return subscribeTable<OrderMessage>({
      table: "order_messages",
      filter: `order_id=eq.${orderId}`,
      onChange: () => void load(),
    });
  }, [orderId, load]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await sendMessage(orderId, draft);
      setDraft("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3.5">
      <p className="label-caps m-0 mb-2">Message the student</p>

      {messages && messages.length > 0 && (
        <ul className="m-0 mb-2.5 flex list-none flex-col gap-1.5 p-0">
          {messages.map((m) => (
            <li key={m.id} className="rounded-xl bg-surface-sunk px-3 py-2">
              <p className="m-0 text-[12.5px] leading-relaxed">{m.body}</p>
              <p className="m-0 mt-0.5 font-mono text-[10.5px] text-muted">
                {new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                {m.read_at ? " · seen" : " · sent"}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canSend && (
        <>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <button
                key={q}
                onClick={() => setDraft(q)}
                className="rounded-full border border-line bg-surface px-2.5 py-1.5 text-left text-[11.5px] text-ink-soft transition-colors hover:border-ink"
              >
                {q}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim() && !sending) void send();
              }}
              maxLength={500}
              placeholder="They get a push the moment you send it"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface-sunk px-3 py-2 text-[12.5px] outline-none focus:border-ink"
            />
            <button
              onClick={send}
              disabled={sending || !draft.trim()}
              aria-label="Send"
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-xl transition-colors disabled:opacity-40",
                draft.trim() ? "bg-ink text-paper" : "border border-line text-faint",
              )}
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} strokeWidth={2.2} />}
            </button>
          </div>
          {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
        </>
      )}

      {messages && messages.length === 0 && !canSend && (
        <p className="m-0 flex items-center gap-1.5 text-[12px] text-muted">
          <MessageSquare size={13} strokeWidth={2.2} />
          Nothing was sent on this order.
        </p>
      )}
    </div>
  );
}
