"use client";

import { useSyncExternalStore } from "react";
import { API, type FeedItem } from "@/lib/api";

/** One round as the stream sends it. Mirrors PlayRound in src/db/feed.ts. */
export type PlayRound = {
  roundNumber: number;
  leader: "A" | "B" | null;
  edges: { A: number; B: number };
  sequence: { seat: "A" | "B"; action: "fold" | "call" | "raise" }[];
  outcome: "both-folded" | "one-folded" | "flipped";
  bet: number;
  chanceA: number | null;
  winner: "A" | "B" | null;
  nets: { A: number; B: number };
  roundsWon: { A: number; B: number };
  beats: string[];
};
export type LiveMatch = FeedItem & { play: PlayRound[] };
export type Counters = { matchesToday: number; totalStaked: number };

/** A match as it reached this page, and when its playback started on this page's clock. */
export type Arrival = { match: LiveMatch; startedAt: number };

export type LiveState = {
  status: "connecting" | "open" | "down";
  /** How long a match takes to play out; the server says, so both agree on "in a match". */
  playMs: number;
  counters: Counters | null;
  /** Newest first, exhibitions included. */
  arrivals: Arrival[];
  /** This page's clock at the last change: moves when a playback ends, so derived views update. */
  now: number;
};

const KEEP = 100;
/** Leaving the page briefly (a route change) should not drop the connection. */
const LINGER_MS = 5_000;

let state: LiveState = { status: "connecting", playMs: 10_000, counters: null, arrivals: [], now: 0 };
const listeners = new Set<() => void>();
let source: EventSource | null = null;
let users = 0;
let linger: ReturnType<typeof setTimeout> | null = null;
let wake: ReturnType<typeof setTimeout> | null = null;

function set(next: Partial<LiveState>) {
  state = { ...state, ...next, now: Date.now() };
  scheduleWake();
  for (const l of listeners) l();
}

/** Re-renders once, when the next playback ends, so dots and rows settle without polling. */
function scheduleWake() {
  if (wake) clearTimeout(wake);
  wake = null;
  const now = Date.now();
  const next = Math.min(...state.arrivals.map((a) => a.startedAt + state.playMs).filter((t) => t > now));
  if (Number.isFinite(next)) wake = setTimeout(() => set({}), next - now + 20);
}

function open() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource(`${API}/live`);
  source.addEventListener("open", () => set({ status: "open" }));
  // EventSource reconnects by itself, sending the last id so the server replays what was missed.
  source.addEventListener("error", () => set({ status: source?.readyState === EventSource.CLOSED ? "down" : "connecting" }));
  source.addEventListener("hello", (e) => {
    const hello = JSON.parse((e as MessageEvent<string>).data) as { counters: Counters; playMs: number };
    set({ counters: hello.counters, playMs: hello.playMs, status: "open" });
  });
  source.addEventListener("match", (e) => {
    const { match, ageMs, counters } = JSON.parse((e as MessageEvent<string>).data) as {
      match: LiveMatch;
      ageMs: number;
      counters?: Counters;
    };
    if (state.arrivals.some((a) => a.match.id === match.id)) return;
    // A match the server read a moment ago plays from where it is now, not from the start.
    const arrival = { match, startedAt: Date.now() - Math.max(0, ageMs) };
    set({
      arrivals: [arrival, ...state.arrivals].sort((x, y) => y.match.seq - x.match.seq).slice(0, KEEP),
      ...(counters ? { counters } : {}),
    });
  });
}

function close() {
  source?.close();
  source = null;
  set({ status: "connecting" });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  users++;
  if (linger) clearTimeout(linger);
  linger = null;
  open();
  return () => {
    listeners.delete(listener);
    users--;
    if (users === 0) linger = setTimeout(close, LINGER_MS);
  };
}

const server: LiveState = state;

/** The live stream, shared by everything on the page: one connection however many panels use it. */
export function useLive(): LiveState {
  return useSyncExternalStore(subscribe, () => state, () => server);
}

/** Whether a match is still playing out at `now`. */
export const isPlaying = (a: Arrival, playMs: number, now: number) => now < a.startedAt + playMs;

/** The agents in a match that is still playing out. */
export function usePlaying(): Set<string> {
  const live = useLive();
  const ids = new Set<string>();
  const now = Math.max(live.now, typeof window === "undefined" ? 0 : Date.now());
  for (const a of live.arrivals) {
    if (!isPlaying(a, live.playMs, now)) continue;
    ids.add(a.match.a.id);
    ids.add(a.match.b.id);
  }
  return ids;
}
