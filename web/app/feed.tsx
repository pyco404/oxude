"use client";

import { AgentName } from "@/app/agent-name";
import { Portrait } from "@/app/portrait";
import { LiveDot } from "@/app/live-dot";
import { PlayingRow } from "@/app/playback";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, type Feed, type FeedItem } from "@/lib/api";
import { isPlaying, useLive, type Arrival } from "@/lib/live";
import { useTicker } from "@/lib/motion";
import { netTone } from "@/lib/tone";

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

/** A feed, and which of its rows the stream brought after the page loaded. */
export type LiveFeedData = Feed & { fresh?: ReadonlySet<string> };

/**
 * The platform feed: what the server rendered, with every staked match the live
 * stream has pushed since on top. `keep` holds on to every row instead of the
 * newest `limit`, for a page that loads older ones below.
 *
 * The bluff card follows the stream too, but only once a bluff has finished
 * playing out, so it never gives away a match still on screen.
 */
export function useFeed(initial: Feed | null, limit = 12, keep = false): LiveFeedData | null {
  const [base, setBase] = useState(initial);
  const live = useLive();
  useEffect(() => {
    if (initial) return;
    // The server could not render one; ask once. The stream carries everything after.
    api.feed(limit).then(setBase, () => {});
  }, [initial, limit]);

  return useMemo(() => {
    if (!base && live.arrivals.length === 0) return null;
    const known = new Set(base?.matches.map((m) => m.id));
    // Exhibitions included. They are most of what is played while players wait
    // for an opponent, and leaving them out makes a working site look dead.
    // Every row says which it is, so nobody has to guess.
    const fresh = live.arrivals.filter((a) => !known.has(a.match.id)).map((a) => a.match);
    const matches = [...fresh, ...(base?.matches ?? [])];
    const played = live.arrivals.find(
      (a) =>
        a.match.beat === "bluff-worked" &&
        !isPlaying(a, live.playMs, live.now) &&
        (a.match.beatSeat === "B" ? a.match.netB : a.match.netA) > 0,
    );
    return {
      fresh: new Set(fresh.map((m) => m.id)),
      matches: keep ? matches : matches.slice(0, limit),
      bluff: played && (!base?.bluff || played.match.seq > base.bluff.seq) ? played.match : (base?.bluff ?? null),
    };
  }, [base, live, limit, keep]);
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
          {bluff.exhibition ? " in an exhibition, with nothing staked" : ""}.
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

/** Recent matches across the platform, newest first, as they are played. Visible signed out. */
export function LiveFeed({
  feed,
  className = "",
  older = [],
  footer,
}: {
  feed: LiveFeedData | null;
  className?: string;
  /** Pages loaded below the live window, oldest last. */
  older?: FeedItem[];
  footer?: React.ReactNode;
}) {
  const live = useLive();
  const [now, setNow] = useState<number | null>(null);
  // Relative times are computed after mount, so the server and client render the same markup.
  useEffect(() => {
    setNow(Date.now());
  }, [feed, live.now]);
  // Rows the stream brought: they open in at the top, and play out while they are fresh.
  // A row the page loaded with is already finished, even if the stream sends it again.
  const arrived = useMemo(
    () => new Map<string, Arrival>(live.arrivals.filter((a) => feed?.fresh?.has(a.match.id)).map((a) => [a.match.id, a])),
    [live.arrivals, feed?.fresh],
  );
  const latest = feed?.matches ?? [];
  const seen = new Set(latest.map((m) => m.id));
  const rows = [...latest, ...older.filter((m) => !seen.has(m.id))];
  return (
    <section className={`rounded-panel border border-line bg-panel ${className}`}>
      <h2 className="flex items-center justify-between border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
        <span>Live matches</span>
        <span className="flex items-center gap-1.5 font-mono normal-case tracking-normal">
          {live.status === "open" ? (
            <LiveDot label title="Connected: matches appear as they are played" />
          ) : (
            <>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted" aria-hidden />
              {live.status === "down" ? "offline" : "connecting"}
            </>
          )}
        </span>
      </h2>
      <LiveCounters counters={live.counters} />
      <ol>
        {rows.map((m) => {
          const arrival = arrived.get(m.id);
          const playing = arrival && live.now !== 0 && isPlaying(arrival, live.playMs, Date.now());
          return (
            <li key={m.id} className={`border-b border-line last:border-b-0 ${arrival ? "row-in" : ""}`}>
              <div>
                {playing ? <PlayingRow arrival={arrival} playMs={live.playMs} /> : <FinishedRow m={m} now={now} />}
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

/**
 * Staked matches today and chips staked all time, ticking up as matches land.
 * Exhibitions stake nothing and count toward neither.
 */
function LiveCounters({ counters }: { counters: { matchesToday: number; totalStaked: number } | null }) {
  const today = useTicker(counters?.matchesToday);
  const staked = useTicker(counters?.totalStaked);
  if (!counters) return null;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  return (
    <dl className="grid grid-cols-2 border-b border-line">
      <div className="border-r border-line px-4 py-2.5">
        <dt className="text-[11px] uppercase tracking-wider text-muted">Staked matches today</dt>
        <dd className="mt-0.5 font-mono text-[18px] tabular-nums">{n(today)}</dd>
      </div>
      <div className="px-4 py-2.5">
        <dt className="text-[11px] uppercase tracking-wider text-muted">Chips staked, all time</dt>
        <dd className="mt-0.5 font-mono text-[18px] tabular-nums text-gold">{n(staked)}</dd>
      </div>
    </dl>
  );
}

/** A match that has played out: who came out ahead, by how much, and the beat worth reading. */
function FinishedRow({ m, now }: { m: FeedItem; now: number | null }) {
  const o = outcome(m);
  const bluff = m.beat === "bluff-worked";
  return (
    <div className="flex gap-2.5 px-4 py-3">
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
          // Readable rather than merely present: somebody landing on the site
          // must not take an exhibition for staked play.
          <span
            className="rounded-panel shrink-0 border border-muted px-1 font-mono text-[11px] uppercase tracking-wider text-text"
            title="Nothing is staked in an exhibition: no money moves and it counts toward no ladder."
          >
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
                <span className="text-text">nothing staked</span>
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
    </div>
  );
}
