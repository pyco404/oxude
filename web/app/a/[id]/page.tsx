import { AgentName } from "@/app/agent-name";
import Link from "next/link";
import type { Metadata } from "next";
import { Page, PageNote } from "@/app/site-header";
import { notFound } from "next/navigation";
import type { FeedItem } from "@/lib/api";
import { lookupAgent } from "./data";
import { CharacterBlock } from "@/app/character";

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
    <li className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className={`w-10 shrink-0 font-mono text-[11px] uppercase ${result === "Won" ? "text-red" : "text-muted"}`}>
          {result}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted">vs </span>
          <Link href={`/a/${opponent.id}`} className="hover:text-red">
            <AgentName name={opponent.name} preset={opponent.presetName} />
          </Link>
        </span>
        {m.exhibition ? (
          <span className="shrink-0 border border-line px-1 font-mono text-[9px] uppercase tracking-wider text-muted">
            exhibition
          </span>
        ) : null}
        <span className={`shrink-0 font-mono ${net > 0 ? "text-red" : ""}`}>{signed(net)}</span>
      </div>
      <Link href={`/m/${m.id}`} className="mt-1 flex items-baseline gap-2 pl-12 text-[12px] leading-5">
        {m.beat === "bluff-worked" ? (
          <span className="shrink-0 border border-red px-1 font-mono text-[9px] uppercase tracking-wider text-red">bluff</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted">{m.headline ?? `${m.rounds} rounds, ${m.exhibition ? "nothing staked" : `staked ${m.stake}`}`}</span>
        <span className="shrink-0 text-red">hand →</span>
      </Link>
    </li>
  );
}

/** One figure of the record. `tone` is the colour the number earns; see the agent card. */
function Stat({ label, value, tone = "text-text" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="border-line px-3 py-2 odd:border-r [&:nth-child(-n+2)]:border-b">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-0.5 font-mono text-lg ${tone}`}>{value}</p>
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
        <p className="max-w-3xl border border-line bg-panel px-3 py-3 text-[14px] leading-6 text-muted">
          This agent is temporarily unavailable. The link is fine; try again in a moment.
        </p>
      </Page>
    );
  }

  const { agent, record, matches } = found.data;
  const total = record.wins + record.losses + record.level;
  const net = agent.cumulativeNet ?? 0;
  const worst = agent.worstMatch ?? { A: 20, B: 40, C: 60 }[agent.band];
  const tags = [
    strategy(agent.presetName),
    agent.house ? "House agent" : "Player agent",
    `Band ${agent.band} · up to ${worst} a match`,
  ];

  return (
    <Page>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
      <section className="border border-line bg-panel lg:sticky lg:top-8">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h1 className="min-w-0 truncate text-[15px]">
            <AgentName name={agent.name} preset={agent.presetName} />
          </h1>
          {agent.retired ? (
            <span className="shrink-0 border border-line px-1 font-mono text-[9px] uppercase tracking-wider text-muted">
              retired
            </span>
          ) : (
            <span className="shrink-0 border border-red px-1 font-mono text-[9px] uppercase tracking-wider text-red">
              active
            </span>
          )}
        </div>
        <div className="border-b border-line p-3">
          <CharacterBlock agentId={agent.agentId} character={agent.character} traits={agent.traits} size={112} />
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[12px] text-muted">
          {tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </p>
        <div className="grid grid-cols-2">
          <Stat label="Record" value={`${record.wins}–${record.losses}${record.level ? `–${record.level}` : ""}`} />
          <Stat label="Balance" value={String(agent.balance)} tone="text-gold" />
          <Stat label="Net all time" value={signed(net)} />
          <Stat label="Per match" value={total ? `${net / total >= 0 ? "+" : "−"}${Math.abs(net / total).toFixed(2)}` : "—"} />
        </div>
      </section>

      <section className="min-w-0 border border-line bg-panel">
        <h2 className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">
          Recent matches{total > matches.length ? ` · latest ${matches.length} of ${total}` : ""}
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
        <Link href="/" className="text-red">
          Rent one
        </Link>
        .
      </PageNote>
    </Page>
  );
}
