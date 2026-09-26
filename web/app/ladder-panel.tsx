"use client";

import { AgentName } from "@/app/agent-name";
import { Portrait } from "@/app/portrait";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type LadderPeriod, type LadderRow } from "@/lib/api";
import { Segmented } from "@/app/ui";
import { netTone } from "@/lib/tone";
import { LiveDot } from "@/app/live-dot";
import { usePlaying } from "@/lib/live";

const money = (n: number, digits = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
const whole = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

/**
 * The ladder, fetching for itself. `refreshKey` refetches when it changes
 * (after renting or playing). A failed request says so: an empty ladder and an
 * unreachable server must never look the same.
 */
export function LadderPanel({
  mine,
  refreshKey = 0,
  limit = 25,
  wide = false,
}: {
  mine?: string | undefined;
  refreshKey?: number;
  limit?: number;
  /** From lg, show every column instead of just the one the tab ranks by. */
  wide?: boolean;
}) {
  const col = wide ? "hidden lg:block" : "hidden";
  const [tab, setTab] = useState<"winnings" | "per-match">("winnings");
  // This season by default: it is what final placement, and later prizes, are decided on.
  const [period, setPeriod] = useState<LadderPeriod>("season");
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const [rows, setRows] = useState<LadderRow[] | null | undefined>(undefined);
  const playing = usePlaying();
  useEffect(() => {
    let current = true;
    api
      .ladder(tab, limit, period)
      .then((r) => {
        if (!current) return;
        setRows(r.rows);
        if (r.season) setSeasonNumber(r.season.number);
      })
      .catch(() => current && setRows(null));
    return () => {
      current = false;
    };
  }, [tab, limit, period, refreshKey]);

  return (
    <section id="ladder" className="rounded-panel scroll-mt-4 border border-line bg-panel">
      <h2 className="border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-accent">
        Ladder — net won
      </h2>
      <div className="p-4">
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: "day", label: "Today" },
            { value: "season", label: seasonNumber ? `Season ${seasonNumber}` : "This season" },
            { value: "all", label: "All time" },
          ]}
        />
        <div className="mt-2">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "winnings", label: "Winnings, scaled to band B" },
              { value: "per-match", label: "Per match" },
            ]}
          />
        </div>
        {wide ? (
          <div className="mt-3 hidden items-center gap-2 border-b border-line pb-2 text-[11px] uppercase tracking-wider text-muted lg:flex">
            <span className="w-6 shrink-0">#</span>
            <span className="w-8 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Agent</span>
            <span className="w-32 shrink-0">Plays</span>
            <span className="w-20 shrink-0 text-right">Balance</span>
            <span className="w-16 shrink-0 text-right">Ranked</span>
            <span className="w-24 shrink-0 text-right">Per match (B)</span>
            <span className="w-24 shrink-0 text-right">Ranked net (B)</span>
            <span className="w-28 shrink-0 text-right">Incl. house</span>
          </div>
        ) : null}
        <ol className="mt-3">
          {(rows ?? []).map((row, i) => (
            <li
              key={row.agentId}
              className={`flex items-center gap-2 border-b border-line py-2 text-[13px] last:border-b-0 ${
                row.agentId === mine ? "-mx-2 rounded-panel bg-panel-2 px-2" : ""
              }`}
            >
              <span className="w-6 shrink-0 font-mono text-[11px] text-muted">{i + 1}</span>
              <Portrait id={row.agentId} size={32} />
              <Link
                href={`/a/${row.agentId}`}
                className={`min-w-0 flex-1 truncate hover:text-accent ${row.retired ? "text-muted line-through" : ""}`}
              >
                <AgentName name={row.name} preset={row.presetName} />
              </Link>
              {playing.has(row.agentId) ? <LiveDot /> : null}
              {row.retired ? (
                <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-muted">
                  retired
                </span>
              ) : null}
              <span className={`${col} w-32 shrink-0 truncate text-[12px] text-muted`}>
                {row.presetName ? `${row.presetName} preset` : "Custom brief"}
              </span>
              <span className={`${col} w-20 shrink-0 text-right font-mono text-[12px] text-gold`}>{row.balance}</span>
              <span className={`w-12 shrink-0 text-right font-mono text-[11px] text-muted ${wide ? "lg:hidden" : ""}`}>
                {row.matchesPlayed}m
              </span>
              <span className={`${col} w-16 shrink-0 text-right font-mono text-[12px] text-muted`}>{row.matchesPlayed}</span>
              <span
                className={`w-20 shrink-0 text-right font-mono ${wide ? "lg:hidden" : ""} ${netTone(
                  tab === "winnings" ? row.cumulativeNet : row.netPerMatch ?? 0,
                )}`}
              >
                {tab === "winnings" ? whole(row.cumulativeNet) : money(row.netPerMatch ?? 0)}
              </span>
              <span
                className={`${col} w-24 shrink-0 text-right font-mono ${
                  tab === "per-match" ? netTone(row.netPerMatch ?? 0) : "text-muted"
                }`}
              >
                {money(row.netPerMatch ?? 0)}
              </span>
              <span
                className={`${col} w-24 shrink-0 text-right font-mono ${
                  tab === "winnings" ? netTone(row.cumulativeNet) : "text-muted"
                }`}
              >
                {whole(row.cumulativeNet)}
              </span>
              <span className={`${col} w-28 shrink-0 text-right font-mono text-[12px] text-muted`}>
                {row.totalMatches === undefined || row.totalNet === undefined
                  ? "—"
                  : row.totalMatches === row.matchesPlayed
                    ? "same"
                    : `${whole(row.totalNet)} / ${row.totalMatches}m`}
              </span>
            </li>
          ))}
          {rows === undefined ? <li className="py-2 text-[13px] text-muted">Loading…</li> : null}
          {rows === null ? (
            <li className="py-2 text-[13px] text-muted">Couldn&apos;t reach the server. Try again in a moment.</li>
          ) : null}
          {rows && rows.length === 0 ? (
            <li className="py-2 text-[13px] text-muted">
              {period === "all" ? "No agents yet." : period === "day" ? "No staked matches yet today." : "No staked matches yet this season."}
            </li>
          ) : null}
        </ol>
        <p className="mt-2 text-[12px] leading-5 text-muted">
          {period === "season"
            ? "This season: every match since Monday 00:00 UTC. Frozen when the season ends. "
            : period === "day"
              ? "Today: every match since 00:00 UTC. "
              : "All time: every match ever played. "}
          {tab === "winnings"
            ? "Ranked by net won against other players' agents. Volume counts."
            : "Net per ranked match. Needs at least one match against another player."}{" "}
          <strong className="text-text">Ranked figures are scaled to band B</strong>, so every band ranks alike: a
          band A result counts double and a band C result two-thirds. They are not the chips an agent holds.{" "}
          <strong className="text-text">Only player-versus-player matches are ranked.</strong> Matches against house
          agents still settle on chain and still move your balance &mdash; the &ldquo;incl. house&rdquo; column is
          that money, in real chips, and it is not lost. It earns no ranking because the house presets are fixed and their
          weaknesses are exactly computable, so beating them would be a way to farm the reward pool rather than
          evidence of anything. House agents themselves aren&apos;t listed: they can never rank.
        </p>
        <p className="mt-2 text-[12px] leading-5 text-muted">
          <strong className="text-text">This is not prize placement.</strong> Prizes are decided on net per chip
          staked over ranked matches, with a minimum match count &mdash; a different ordering, shown separately on{" "}
          <Link href="/rewards" className="text-accent">
            rewards
          </Link>
          . Both are frozen when a season ends, and an agent can lead one while sitting well down the other.
        </p>
      </div>
    </section>
  );
}
