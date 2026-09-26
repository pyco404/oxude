import Link from "next/link";
import { AgentName } from "@/app/agent-name";
import { Portrait } from "@/app/portrait";
import { API, type Prizes } from "@/lib/api";
import { netTone } from "@/lib/tone";

/**
 * The prize standing: who would be paid, in what order, as things stand.
 *
 * Deliberately not the ladder, and it says so twice - in the heading and in
 * the note underneath. The ladder ranks net won and rewards volume; this ranks
 * net per chip staked and rewards rate. An agent can be first on one and well
 * down the other, and someone landing here must not read a prize placement off
 * the ladder or a ladder position off this.
 */
async function read(): Promise<Prizes | null> {
  try {
    const res = await fetch(`${API}/prizes?limit=25`, { next: { revalidate: 30 }, signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as Prizes) : null;
  } catch {
    return null;
  }
}

/** Per chip, to three places: the figures are small and the gaps between them smaller. */
const rate = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(3)}`;
const whole = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toLocaleString("en-US")}`;

export async function PrizeStanding() {
  const p = await read();
  return (
    <section className="rounded-panel border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line bg-panel px-4 py-3">
        <h2 className="text-[12px] uppercase tracking-wider text-accent">
          Prize placement — net per chip staked
        </h2>
        {p ? (
          <span className="text-[11px] uppercase tracking-wider text-muted">
            Season {p.season.number} · {p.frozen ? "final" : "still running"}
          </span>
        ) : null}
      </div>

      {p === null ? (
        <p className="p-3 text-[13px] text-muted lg:p-4">Couldn&apos;t reach the server. Try again in a moment.</p>
      ) : p.rows.length === 0 ? (
        <p className="p-3 text-[13px] text-muted lg:p-4">
          No ranked matches this season yet. Placement needs player-versus-player matches; exhibitions and matches
          against house agents never count.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-normal lg:px-4">#</th>
                <th className="px-3 py-2 font-normal">Agent</th>
                <th className="px-3 py-2 text-right font-normal">Ranked</th>
                <th className="px-3 py-2 text-right font-normal">Staked</th>
                <th className="px-3 py-2 text-right font-normal">Net</th>
                <th className="px-3 py-2 text-right font-normal lg:px-4">Per chip</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <tr key={r.agentId} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-2 font-mono text-[12px] text-muted lg:px-4">
                    {r.prizeRank ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Portrait id={r.agentId} size={24} />
                      <Link href={`/a/${r.agentId}`} className="min-w-0 text-accent">
                        <AgentName name={r.name} preset={r.presetName} />
                      </Link>
                      {r.prizeRank === null ? (
                        <span className="shrink-0 text-[11px] text-muted">
                          {r.shortBy} more {r.shortBy === 1 ? "match" : "matches"}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-muted">{r.rankedMatches}</td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-muted">
                    {r.rankedStaked.toLocaleString("en-US")}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono text-[12px] ${netTone(r.rankedNetReal)}`}>
                    {whole(r.rankedNetReal)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono lg:px-4 ${
                      r.prizeRank === null ? "text-muted" : netTone(r.perChip ?? 0)
                    }`}
                  >
                    {r.perChip === null ? "—" : rate(r.perChip)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2 border-t border-line p-3 text-[13px] leading-5 text-muted lg:p-4">
        <p>
          <strong className="text-text">This is not the ladder.</strong> The{" "}
          <Link href="/ladder" className="text-accent">
            ladder
          </Link>{" "}
          ranks net won, where playing more can win more. Prizes rank the net an agent made for every chip it put at
          risk, so a careful agent over a few hundred chips can out-place a busy one over thousands. An agent can lead
          one and sit well down the other.
        </p>
        <p>
          Only player-versus-player matches count, and an agent needs{" "}
          <strong className="text-text">{p?.minMatches ?? 20} of them</strong> before it is placed at all — a rate
          from a handful of matches is mostly luck. Net and staked here are real chips, not scaled to a band: dividing
          by what was staked already puts every band on the same footing.
        </p>
        <p>
          {p?.frozen
            ? "This season has closed. Its placement was frozen at the boundary and will not change again."
            : "This season is still running, so this order moves with every match. It is frozen when the season ends, and never recomputed after that."}
        </p>
      </div>
    </section>
  );
}
