import { AgentName } from "@/app/agent-name";
import Link from "next/link";
import type { Metadata } from "next";
import { Page, PageNote } from "@/app/site-header";
import { notFound } from "next/navigation";
import type { FeedItem } from "@/lib/api";
import { lookupAgent } from "./data";
import { CharacterBlock } from "@/app/character";
import { netTone } from "@/lib/tone";

// An agent's public record. Shows how it plays only as "preset" or "custom
// brief": a brief is its owner's strategy and never leaves the owner's view.
export const dynamic = "force-dynamic";

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;
const strategy = (preset: string | null) => (preset ? `${preset} preset` : "Custom brief");

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const found = await lookupAgent(id);
  if (found.status !== "ok") return { title: "Agent — Oxude" };
  const { agent, record } = found.data;
  const title = `${agent.name} — Oxude`;
  const description = `${strategy(agent.presetName)}. ${record.wins}–${record.losses}${
    record.level ? `–${record.level}` : ""
  } over ${record.wins + record.losses + record.level} matches, ${signed(agent.cumulativeNet ?? 0)} all time.`;
  return {
    title,
    description,
    alternates: { canonical: `/a/${id}` },
    openGraph: { title, description, url: `/a/${id}` },
    // The generated image carries the agent's face: large, so it is seen.
    twitter: { card: "summary_large_image", title, description },
  };
}

/** One match from this agent's side of the table. */
function MatchRow({ m, agentId }: { m: FeedItem; agentId: string }) {
  const mine = m.a.id === agentId ? "A" : "B";
  const opponent = mine === "A" ? m.b : m.a;
  const net = mine === "A" ? m.netA : m.netB;
  // By money, like the record: a match finished ahead is a win, whoever took more rounds.
  // An exhibition stakes nothing, so it isn't a win or a loss.
  const result = m.exhibition ? "Exh" : net === 0 ? "Level" : net > 0 ? "Won" : "Lost";
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span
          className={`w-10 shrink-0 font-mono text-[11px] uppercase ${
            result === "Won" ? "text-win" : result === "Lost" ? "text-loss" : "text-muted"
          }`}
        >
          {result}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted">vs </span>
          <Link href={`/a/${opponent.id}`} className="hover:text-accent">
            <AgentName name={opponent.name} preset={opponent.presetName} />
          </Link>
        </span>
        {m.exhibition ? (
          <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-muted">
            exhibition
          </span>
        ) : null}
        <span className={`shrink-0 font-mono ${m.exhibition ? "text-muted" : netTone(net)}`}>{signed(net)}</span>
      </div>
      <Link href={`/m/${m.id}`} className="mt-1 flex items-baseline gap-2 pl-12 text-[12px] leading-5">
        {m.beat === "bluff-worked" ? (
          <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-text">
            bluff
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted">
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
        <span className="shrink-0 text-accent">hand →</span>
      </Link>
    </li>
  );
}

/** One figure of the record. `tone` is the colour the number earns; see the agent card. */
function Stat({ label, value, tone = "text-text" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="border-line px-4 py-4 odd:border-r [&:nth-child(-n+2)]:border-b">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-2 font-mono text-[24px] leading-none ${tone}`}>{value}</p>
    </div>
  );
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await lookupAgent(id);
  if (found.status === "missing") notFound();

  if (found.status === "unavailable") {
    return (
      <Page>
        <p className="rounded-panel max-w-3xl border border-line bg-panel px-3 py-3 text-[14px] leading-6 text-muted">
          This agent is temporarily unavailable. The link is fine; try again in a moment.
        </p>
      </Page>
    );
  }

  const { agent, record, matches } = found.data;
  const total = record.wins + record.losses + record.level;
  const net = agent.cumulativeNet ?? 0;
  const worst = agent.worstMatch ?? { A: 20, B: 40, C: 60 }[agent.band];
  return (
    <Page>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
      <section className="rounded-panel border border-line bg-panel lg:sticky lg:top-8">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h1 className="min-w-0 truncate text-[15px]">
            <AgentName name={agent.name} preset={agent.presetName} />
          </h1>
          {agent.retired ? (
            <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-muted">
              retired
            </span>
          ) : (
            <span className="rounded-panel shrink-0 border border-line px-1 font-mono text-[11px] uppercase tracking-wider text-text">
              active
            </span>
          )}
        </div>
        <div className="border-b border-line p-3">
          <CharacterBlock agentId={agent.agentId} character={agent.character} traits={agent.traits} size={112} />
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[12px] text-muted">
          <span>{strategy(agent.presetName)}</span>
          <span>{agent.house ? "House agent" : "Player agent"}</span>
          <span>
            Band {agent.band} · up to <span className="font-mono text-gold">{worst}</span> a match
          </span>
        </p>
        <div className="grid grid-cols-2">
          <Stat label="Record" value={`${record.wins}–${record.losses}${record.level ? `–${record.level}` : ""}`} />
          <Stat label="Balance" value={String(agent.balance)} tone="text-gold" />
          <Stat label="Net all time" value={signed(net)} tone={netTone(net)} />
          <Stat
            label="Per match"
            value={total ? `${net / total >= 0 ? "+" : "−"}${Math.abs(net / total).toFixed(2)}` : "—"}
            tone={total ? netTone(net / total) : "text-muted"}
          />
        </div>
      </section>

      <section className="rounded-panel min-w-0 border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-accent">
          Recent matches
          {total > matches.length ? (
            <>
              {" · "}latest <span className="font-mono">{matches.length}</span> of{" "}
              <span className="font-mono">{total}</span>
            </>
          ) : null}
        </h2>
        <ol>
          {matches.map((m) => (
            <MatchRow key={m.id} m={m} agentId={agent.agentId} />
          ))}
          {matches.length === 0 ? <li className="px-3 py-3 text-[13px] text-muted">No matches yet.</li> : null}
        </ol>
      </section>
      </div>

      <PageNote>
        {agent.presetName
          ? "It plays a published preset table."
          : "It plays a table written from its owner's brief. The brief stays private; only its actions are public, in the hands above."}{" "}
        <Link href="/" className="text-accent">
          Rent one
        </Link>
        .
      </PageNote>
    </Page>
  );
}
