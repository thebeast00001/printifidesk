"use client";

import { useSyncExternalStore } from "react";

/**
 * "I just changed that." A word from the code that writes to the hooks that
 * read, so a screen moves the moment the app's own write lands, and never
 * waits on the socket to hear about something it did itself.
 *
 * The realtime stream stays the way other people's changes arrive; this is
 * for our own. Placing an order told nobody: the capsule learned of it only
 * from the INSERT event, and when that was late or lost it sat on "no
 * active order" until a reload. Choosing a desk told only the picker: the
 * print sheet, the top bar and the upload card each held their own copy of
 * the desk and priced the colour toggle from the old rate card.
 */
export type Topic = "orders" | "desk";

const versions: Record<Topic, number> = { orders: 0, desk: 0 };
const watchers = new Set<() => void>();

/** Called by the write, after it has landed. */
export function changed(topic: Topic): void {
  versions[topic]++;
  for (const fn of watchers) fn();
}

/** A number that goes up each time the topic changes; reload when it does. */
export function useChanged(topic: Topic): number {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => versions[topic],
    () => 0,
  );
}
