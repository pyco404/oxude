"use client";

import { AgentName } from "@/app/agent-name";
import { Portrait } from "@/app/portrait";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Feed, type FeedItem } from "@/lib/api";
import { netTone } from "@/lib/tone";

const POLL_MS = 10_000;

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

/** "12s", "4m", "3h", "2d": short enough for a 390px row. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Who came out ahead, by how much, and from whom; null for a level match. */
export function outcome(m: FeedItem) {
  if (m.netA === 0) return null;
  const aAhead = m.netA > 0;
  return { ahead: aAhead ? m.a : m.b, behind: aAhead ? m.b : m.a, amount: Math.abs(m.netA) };
}

/** Polls the platform feed while the tab is visible. Starts from what the server rendered. */
export function useFeed(initial: Feed | null, limit = 12): Feed | null {
  const [feed, setFeed] = useState(initial);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await api.feed(limit);
        if (!stopped) setFeed(next);
      } catch {
        // Keep showing the last good feed; the next tick tries again.
      }
    };
    if (!initial) void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [initial, limit]);
  return feed;
}

/** The latest bluff that worked, big: the one thing a newcomer should read first. */
export function BluffCard({ bluff }: { bluff: FeedItem | null }) {
  if (!bluff || !bluff.headline) return null;
  const net = bluff.beatSeat === "B" ? bluff.netB : bluff.netA;
  const who = bluff.beatSeat === "B" ? bluff.b : bluff.a;
  return (
    <section className="rounded-panel mb-3 border border-line bg-panel">
      <h2 className="flex items-center justify-between border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
        <span>Latest bluff{bluff.exhibition ? " · exhibition" : ""}</span>
        <span className="font-mono normal-case tracking-normal">{ago(bluff.createdAt)} ago</span>
      </h2>
      <div className="p-4">
        <p className="text-[20px] leading-7">{bluff.headline}.</p>
        <p className="mt-2 text-[13px] leading-5 text-muted">
          The weaker hand raised and the stronger one folded.{" "}
          <Link href={`/a/${who.id}`} className="text-text hover:text-red">
            <AgentName name={who.name} preset={who.presetName} />
          </Link>{" "}
          finished the match <span className={`font-mono ${netTone(net)}`}>{signed(net)}</span>
          {bluff.exhibition ? " in an exhibition between house agents, with nothing staked" : ""}.
        </p>
        <Link
          href={`/m/${bluff.id}`}
          className="rounded-panel mt-3 block border border-red px-3 py-2 text-center text-[13px] text-red"
        >
          Read the hand
        </Link>
      </div>
    </section>
  );
}

/** Recent matches across the platform, newest first. Visible signed out. */
export function LiveFeed({
  feed,
  className = "",
  older = [],
  footer,
}: {
  feed: Feed | null;
  className?: string;
  /** Pages loaded below the live window, oldest last. */
  older?: FeedItem[];
  footer?: React.ReactNode;
}) {
  const [now, setNow] = useState<number | null>(null);
  // Relative times are computed after mount, so the server and client render the same markup.
  useEffect(() => {
    setNow(Date.now());
  }, [feed]);
  const live = feed?.matches ?? [];
  const seen = new Set(live.map((m) => m.id));
  const rows = [...live, ...older.filter((m) => !seen.has(m.id))];
  return (
    <section className={`rounded-panel border border-line bg-panel ${className}`}>
      <h2 className="flex items-center justify-between border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
        <span>Live matches</span>
        <span className="flex items-center gap-1.5 font-mono normal-case tracking-normal">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-red" aria-hidden />
          updates every 10s
        </span>
      </h2>
      <ol>
        {rows.map((m) => {
          const o = outcome(m);
          const bluff = m.beat === "bluff-worked";
          return (
            <li key={m.id} className="flex gap-2.5 border-b border-line px-4 py-3 last:border-b-0">
              {/* Both faces, the one that came out ahead first. */}
              <span className="flex shrink-0 gap-1 pt-0.5">
                <Portrait id={(o ? o.ahead : m.a).id} size={32} />
                <Portrait id={(o ? o.behind : m.b).id} size={32} />
              </span>
              <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[13px]">
                {o ? (
                  <span className="min-w-0 flex-1 truncate">
                    <Link href={`/a/${o.ahead.id}`} className="hover:text-red">
                      <AgentName name={o.ahead.name} preset={o.ahead.presetName} />
                    </Link>{" "}
                    <span className="font-mono text-win">{signed(o.amount)}</span>
                    <span className="text-muted"> from </span>
                    <Link href={`/a/${o.behind.id}`} className="text-muted hover:text-red">
                      <AgentName name={o.behind.name} preset={o.behind.presetName} />
                    </Link>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate">
                    <Link href={`/a/${m.a.id}`} className="hover:text-red">
                      <AgentName name={m.a.name} preset={m.a.presetName} />
                    </Link>
                    <span className="text-muted"> level with </span>
                    <Link href={`/a/${m.b.id}`} className="hover:text-red">
                      <AgentName name={m.b.name} preset={m.b.presetName} />
                    </Link>
                  </span>
                )}
                {m.exhibition ? (
                  <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-muted">
                    exhibition
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-[11px] text-muted">{now === null ? "" : ago(m.createdAt, now)}</span>
              </div>
              <Link href={`/m/${m.id}`} className="mt-1 flex items-baseline gap-2 text-[12px] leading-5">
                {bluff ? (
                  <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-text">
                    bluff
                  </span>
                ) : null}
                <span className={`min-w-0 flex-1 truncate ${bluff ? "text-text" : "text-muted"}`}>
                  {m.headline ?? (
                    <>
                      <span className="font-mono">{m.rounds}</span> rounds,{" "}
                      {m.exhibition ? (
                        "nothing staked"
                      ) : (
                        <>
                          staked <span className="font-mono text-gold">{m.stake}</span>
                        </>
                      )}
                    </>
                  )}
                </span>
                <span className="shrink-0 text-red">hand →</span>
              </Link>
              </div>
            </li>
          );
        })}
        {rows.length === 0 ? (
          <li className="px-3 py-3 text-[13px] text-muted">{feed ? "No matches yet." : "Loading matches…"}</li>
        ) : null}
      </ol>
      {footer}
    </section>
  );
}
