"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "./supabase/client";

/**
 * Postgres change streams, delivered with their payload intact.
 *
 * The first version of this threw the payload away and re-fetched everything on
 * every event, which meant a status change cost a session check plus three
 * queries before the screen moved — hundreds of milliseconds on top of a socket
 * push that had already arrived. Callers now get the changed row itself and can
 * paint it immediately, reconciling anything derived (queue position, totals)
 * in the background.
 *
 * Channels are keyed by table + filter and shared: supabase-js hands back the
 * *same* channel object for a repeated topic, and a channel refuses new
 * `postgres_changes` callbacks once subscribed, so two hooks opening the same
 * topic would otherwise throw.
 */

export type ChangeType = "INSERT" | "UPDATE" | "DELETE";

export interface Change<T> {
  table: string;
  eventType: ChangeType;
  row: T | null;
  /** Only the primary key unless the table is REPLICA IDENTITY FULL. */
  previous: Partial<T> | null;
}

export type ConnectionState = "connecting" | "live" | "down";

interface Entry {
  channel: RealtimeChannel;
  listeners: Set<(change: Change<unknown>) => void>;
  states: Set<(state: ConnectionState) => void>;
  retry: ReturnType<typeof setTimeout> | null;
  attempts: number;
}

const entries = new Map<string, Entry>();

/** Backoff so a server-side problem isn't hammered, capped so recovery is quick. */
const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 15_000);

export function subscribeTable<T>(params: {
  table: string;
  /** PostgREST-style, e.g. `user_id=eq.user_123`. Narrows what the server sends. */
  filter?: string;
  onChange: (change: Change<T>) => void;
  onState?: (state: ConnectionState) => void;
}): () => void {
  const supabase = getSupabase();
  if (!supabase) return () => {};

  const key = `${params.table}:${params.filter ?? "*"}`;
  const onChange = params.onChange as (change: Change<unknown>) => void;

  let entry = entries.get(key);

  if (!entry) {
    const listeners = new Set<(change: Change<unknown>) => void>();
    const states = new Set<(state: ConnectionState) => void>();

    const announce = (state: ConnectionState) => {
      for (const fn of states) fn(state);
    };

    const build = (): RealtimeChannel => {
      const channel = supabase
        .channel(`rt:${key}:${Math.random().toString(36).slice(2, 8)}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: params.table,
            ...(params.filter ? { filter: params.filter } : {}),
          },
          (payload) => {
            const change: Change<unknown> = {
              table: params.table,
              eventType: payload.eventType as ChangeType,
              row: (payload.new && Object.keys(payload.new).length ? payload.new : null) ?? null,
              previous: (payload.old as Record<string, unknown>) ?? null,
            };
            for (const fn of listeners) fn(change);
          },
        )
        .subscribe((status) => {
          const current = entries.get(key);
          if (!current) return;

          if (status === "SUBSCRIBED") {
            current.attempts = 0;
            announce("live");
            return;
          }

          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            announce("down");
            // supabase-js reconnects the socket, but a channel that errored
            // stays dead until it is rebuilt.
            if (current.retry) clearTimeout(current.retry);
            current.retry = setTimeout(() => {
              if (!entries.has(key)) return;
              void supabase.removeChannel(current.channel);
              current.attempts += 1;
              announce("connecting");
              current.channel = build();
            }, backoffMs(current.attempts));
          }
        });

      return channel;
    };

    entry = { channel: null as unknown as RealtimeChannel, listeners, states, retry: null, attempts: 0 };
    entries.set(key, entry);
    entry.channel = build();
    announce("connecting");
  }

  entry.listeners.add(onChange);
  if (params.onState) entry.states.add(params.onState);

  return () => {
    const current = entries.get(key);
    if (!current) return;

    current.listeners.delete(onChange);
    if (params.onState) current.states.delete(params.onState);

    if (current.listeners.size === 0) {
      if (current.retry) clearTimeout(current.retry);
      void supabase.removeChannel(current.channel);
      entries.delete(key);
    }
  };
}
