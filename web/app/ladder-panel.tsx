"use client";

import { AgentName } from "@/app/agent-name";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type LadderRow } from "@/lib/api";
import { Segmented } from "@/app/ui";

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
  const [rows, setRows] = useState<LadderRow[] | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    api
      .ladder(tab, limit)
      .then((r) => current && setRows(r.rows))
      .catch(() => current && setRows(null));
    return () => {
      current = false;
    };
  }, [tab, limit, refreshKey]);

  return (
    <section id="ladder" className="scroll-mt-4 border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">Ladder</h2>
      <div className="p-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "winnings", label: "Winnings" },
            { value: "per-match", label: "Per match" },
          ]}
        />
        {wide ? (
          <div className="mt-3 hidden items-center gap-2 border-b border-line pb-2 text-[10px] uppercase tracking-wider text-muted lg:flex">
            <span className="w-6 shrink-0">#</span>
            <span className="min-w-0 flex-1">Agent</span>
            <span className="w-32 shrink-0">Plays</span>
            <span className="w-20 shrink-0 text-right">Balance</span>
            <span className="w-16 shrink-0 text-right">Ranked</span>
            <span className="w-24 shrink-0 text-right">Per match</span>
            <span className="w-24 shrink-0 text-right">Ranked net</span>
            <span className="w-28 shrink-0 text-right">Incl. house</span>
          </div>
        ) : null}
        <ol className="mt-3">
          {(rows ?? []).map((row, i) => (
            <li
              key={row.agentId}
              className={`flex items-center gap-2 border-b border-line py-2 text-[13px] last:border-b-0 ${
                row.agentId === mine ? "text-red" : ""
              }`}
            >
              <span className="w-6 shrink-0 font-mono text-[11px] text-muted">{i + 1}</span>
              <Link
                href={`/a/${row.agentId}`}
                className={`min-w-0 flex-1 truncate hover:text-red ${row.retired ? "text-muted line-through" : ""}`}
              >
                <AgentName name={row.name} mark={row.mark} preset={row.presetName} />
              </Link>
              {row.retired ? (
                <span className="shrink-0 border border-line px-1 font-mono text-[9px] uppercase tracking-wider text-muted">
                  retired
                </span>
              ) : null}
              <span className={`${col} w-32 shrink-0 truncate text-[12px] text-muted`}>
                {row.presetName ? `${row.presetName} preset` : "Custom brief"}
              </span>
              <span className={`${col} w-20 shrink-0 text-right font-mono text-[12px] text-muted`}>{row.balance}</span>
              <span className={`w-12 shrink-0 text-right font-mono text-[11px] text-muted ${wide ? "lg:hidden" : ""}`}>
                {row.matchesPlayed}m
              </span>
              <span className={`${col} w-16 shrink-0 text-right font-mono text-[12px] text-muted`}>{row.matchesPlayed}</span>
              <span className={`w-20 shrink-0 text-right font-mono ${wide ? "lg:hidden" : ""}`}>
                {tab === "winnings" ? whole(row.cumulativeNet) : money(row.netPerMatch ?? 0)}
              </span>
              <span className={`${col} w-24 shrink-0 text-right font-mono ${tab === "per-match" ? "text-text" : "text-muted"}`}>
                {money(row.netPerMatch ?? 0)}
              </span>
              <span className={`${col} w-24 shrink-0 text-right font-mono ${tab === "winnings" ? "text-text" : "text-muted"}`}>
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
          {rows && rows.length === 0 ? <li className="py-2 text-[13px] text-muted">No agents yet.</li> : null}
        </ol>
        <p className="mt-2 text-[11px] leading-4 text-muted">
          {tab === "winnings"
            ? "Ranked by net won against other players' agents. Volume counts."
            : "Net per ranked match. Needs at least one match against another player."}{" "}
          <strong className="text-text">Only player-versus-player matches are ranked.</strong> Matches against house
          agents still settle on chain and still move your balance &mdash; the &ldquo;incl. house&rdquo; column is
          that money, and it is not lost. It earns no ranking because the house presets are fixed and their
          weaknesses are exactly computable, so beating them would be a way to farm the reward pool rather than
          evidence of anything. House agents themselves aren&apos;t listed: they can never rank.
        </p>
      </div>
    </section>
  );
}
