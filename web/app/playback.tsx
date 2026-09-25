"use client";

import { Portrait } from "@/app/portrait";
import { LiveDot } from "@/app/live-dot";
import { useEffect, useState } from "react";
import type { Arrival, PlayRound } from "@/lib/live";
import { netTone } from "@/lib/tone";

/** The last stretch of a playback, after the rounds: who took the match. */
const FINAL_MS = 1500;
/** Each round shows the hands, then the action, then the outcome, in equal thirds. */
const PHASES = ["hands", "action", "outcome"] as const;

type Phase = (typeof PHASES)[number] | "final";

/** Where a playback is `elapsed` ms in: which round, and which part of it. */
export function playhead(rounds: number, elapsed: number, playMs: number): { round: number; phase: Phase } {
  const per = (playMs - FINAL_MS) / Math.max(1, rounds);
  if (rounds === 0 || elapsed >= playMs - FINAL_MS) return { round: Math.max(0, rounds - 1), phase: "final" };
  const round = Math.min(rounds - 1, Math.floor(Math.max(0, elapsed) / per));
  const within = (elapsed - round * per) / per;
  return { round, phase: PHASES[Math.min(2, Math.floor(within * 3))]! };
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;
const verb = { fold: "folds", call: "calls", raise: "raises" } as const;
const other = (s: "A" | "B") => (s === "A" ? "B" : "A");

/**
 * A match playing out in the feed, round by round, from the rounds the stream
 * sent. The result is already recorded; this is the hand history told at the
 * pace of a table. Two lines, like a finished row, so nothing jumps when it lands.
 */
export function PlayingRow({ arrival, playMs }: { arrival: Arrival; playMs: number }) {
  const { match } = arrival;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  const { round, phase } = playhead(match.play.length, now - arrival.startedAt, playMs);
  const r = match.play[round];
  const names = { A: match.a.name, B: match.b.name };
  // The running score moves when a round's outcome shows, not before.
  const nets =
    phase === "outcome" || phase === "final" ? (r?.nets ?? { A: 0, B: 0 }) : (match.play[round - 1]?.nets ?? { A: 0, B: 0 });

  return (
    <div className="flex gap-2.5 px-4 py-3">
      <span className="flex shrink-0 gap-1 pt-0.5">
        <Portrait id={match.a.id} size={32} />
        <Portrait id={match.b.id} size={32} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">
            {names.A}
            <span className="text-muted"> vs </span>
            {names.B}
          </span>
          <span className="shrink-0 font-mono text-[12px]">
            <span className={netTone(nets.A)}>{signed(nets.A)}</span>
            <span className="text-muted"> / </span>
            <span className={netTone(nets.B)}>{signed(nets.B)}</span>
          </span>
          <LiveDot label="wide" title="Playing out now" />
        </div>
        <div className="mt-1 flex items-baseline gap-2 text-[12px] leading-5">
          <span className="w-6 shrink-0 font-mono text-[11px] text-muted">
            {phase === "final" ? "end" : `R${r?.roundNumber ?? round + 1}`}
          </span>
          <span key={`${round}-${phase}`} className="phase-in flex min-w-0 flex-1 items-baseline gap-2">
            {r ? <Step round={r} phase={phase} names={names} match={match} /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

function Step({
  round,
  phase,
  names,
  match,
}: {
  round: PlayRound;
  phase: Phase;
  names: { A: string; B: string };
  match: Arrival["match"];
}) {
  if (phase === "hands") {
    return (
      <span className="flex min-w-0 items-center gap-3 font-mono">
        <Hand edge={round.edges.A} />
        <Hand edge={round.edges.B} />
        <span className="truncate text-muted">{round.leader ? `${names[round.leader]} acts first` : "both choose at once"}</span>
      </span>
    );
  }
  if (phase === "action") {
    const joiner = round.leader ? ", then " : ", ";
    return (
      <span className="min-w-0 truncate text-text">
        {round.sequence.map((m, i) => (
          <span key={i}>
            {i > 0 ? <span className="text-muted">{joiner}</span> : null}
            {names[m.seat]} {verb[m.action]}
          </span>
        ))}
      </span>
    );
  }
  if (phase === "outcome") {
    const bluff = round.beats.includes("bluff-worked");
    return (
      <>
        {bluff ? (
          <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-text">
            bluff
          </span>
        ) : null}
        <span className="min-w-0 truncate text-muted">
          {round.outcome === "both-folded" ? (
            "both fold, nothing moves"
          ) : round.outcome === "one-folded" ? (
            <>
              {names[other(round.winner!)]} folds and pays <span className="font-mono text-text">{round.bet}</span>
            </>
          ) : (
            <>
              flip for <span className="font-mono text-text">{round.bet}</span> at{" "}
              <span className="font-mono">{Math.round((round.chanceA ?? 0.5) * 100)}%</span>:{" "}
              <span className="text-text">{names[round.winner!]}</span> takes it
            </>
          )}
        </span>
      </>
    );
  }
  const won = match.winner;
  return (
    <span className="min-w-0 truncate text-text">
      {won === null ? (
        "the match ends level"
      ) : (
        <>
          {names[won]} takes the match{" "}
          <span className="font-mono">
            {round.roundsWon[won]}-{round.roundsWon[other(won)]}
          </span>
        </>
      )}
    </span>
  );
}

/** A hand's strength: the edge as a figure and a short bar, ivory like the text it sits in. */
function Hand({ edge }: { edge: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="relative inline-block h-1 w-8 bg-line" aria-hidden>
        <span className="bar-wipe absolute inset-y-0 left-0 bg-text" style={{ width: `${Math.round(edge * 100)}%` }} />
      </span>
      <span className="text-text">{edge.toFixed(2)}</span>
    </span>
  );
}
