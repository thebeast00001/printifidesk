"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MessageSquare } from "lucide-react";
import { markMessagesRead, messagesFor, type OrderMessage } from "@/lib/desk";
import { subscribeTable } from "@/lib/realtime";
import { easeIos } from "@/lib/utils";

/**
 * What the desk has said about this order, on the student's own capsule.
 *
 * Painted from the realtime payload, so a "page 3 is blank — print it anyway?"
 * appears while the student is still looking at the screen, not after they've
 * walked off. Opening the capsule marks them read; the desk sees "seen".
 */
export function DeskMessages({ orderId, visible }: { orderId: string; visible: boolean }) {
  const [messages, setMessages] = useState<OrderMessage[]>([]);

  const load = useCallback(async () => setMessages(await messagesFor(orderId)), [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return subscribeTable<OrderMessage>({
      table: "order_messages",
      filter: `order_id=eq.${orderId}`,
      onChange: ({ eventType, row }) => {
        if (eventType === "INSERT" && row) {
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        } else {
          void load();
        }
      },
    });
  }, [orderId, load]);

  // Only when it's actually on screen — a background tab shouldn't tell the
  // desk the student has read something they haven't.
  useEffect(() => {
    if (!visible || document.visibilityState !== "visible") return;
    if (messages.some((m) => !m.read_at)) void markMessagesRead(orderId);
  }, [visible, messages, orderId]);

  if (messages.length === 0) return null;

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key="desk-messages"
        layout="position"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.3, ease: easeIos }}
        className="overflow-hidden"
      >
        <div className="mt-3 flex flex-col gap-1.5">
          {messages.map((m) => (
            <p
              key={m.id}
              className="m-0 flex items-start gap-2 rounded-xl bg-shell-line px-3 py-2.5 text-[12.5px] leading-relaxed"
            >
              <MessageSquare size={14} strokeWidth={2.2} className="mt-px shrink-0 text-shell-faint" />
              <span>
                <span className="block">{m.body}</span>
                <span className="mt-0.5 block font-mono text-[10.5px] text-shell-faint">
                  from the desk ·{" "}
                  {new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </span>
            </p>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
