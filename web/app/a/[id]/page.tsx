import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { FeedItem } from "@/lib/api";
import { lookupAgent } from "./data";

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
    twitter: { card: "summary", title, description },
  };
}

/** One match from this agent's side of the table. */
function MatchRow({ m, agentId }: { m: FeedItem; agentId: string }) {
  const mine = m.a.id === agentId ? "A" : "B";
  const opponent = mine === "A" ? m.b : m.a;
  const net = mine === "A" ? m.netA : m.netB;
  const result = m.winner === null ? "Level" : m.winner === mine ? "Won" : "Lost";
  return (
    <li className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className={`w-10 shrink-0 font-mono text-[11px] uppercase ${result === "Won" ? "text-red" : "text-muted"}`}>
          {result}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted">vs </span>
          <a href={`/a/${opponent.id}`} className="hover:text-red">
            {opponent.name}
          </a>
        </span>
        <span className={`shrink-0 font-mono ${net > 0 ? "text-red" : ""}`}>{signed(net)}</span>
      </div>
      <a href={`/m/${m.id}`} className="mt-1 flex items-baseline gap-2 pl-12 text-[12px] leading-5">
        {m.beat === "bluff-worked" ? (
          <span className="shrink-0 border border-red px-1 font-mono text-[9px] uppercase tracking-wider text-red">bluff</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted">{m.headline ?? `${m.rounds} rounds, staked ${m.stake}`}</span>
        <span className="shrink-0 text-red">hand →</span>
      </a>
    </li>
  );
}

function Stat({ label, value, red = false }: { label: string; value: string; red?: boolean }) {
  return (
    <div className="border-line px-3 py-2 odd:border-r [&:nth-child(-n+2)]:border-b">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-0.5 font-mono text-lg ${red ? "text-red" : ""}`}>{value}</p>
    </div>
  );
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await lookupAgent(id);
  if (found.status === "missing") notFound();

  const header = (
    <header className="mb-4">
      <a href="/" className="flex items-center gap-2 text-xl font-semibold tracking-[0.2em] text-red">
        <img src="/oxude-tb.png" alt="" width={28} height={28} className="h-7 w-7" />
        OXUDE
      </a>
    </header>
  );
  if (found.status === "unavailable") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 pt-5 sm:px-6">
        {header}
        <p className="border border-line bg-panel px-3 py-3 text-[14px] leading-6 text-muted">
          This agent is temporarily unavailable. The link is fine; try again in a moment.
        </p>
      </main>
    );
  }

  const { agent, record, matches } = found.data;
  const total = record.wins + record.losses + record.level;
  const net = agent.cumulativeNet ?? 0;
  const tags = [strategy(agent.presetName), agent.house ? "House agent" : "Player agent", `Ceiling ${agent.maxStake}`];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-5 sm:px-6">
      {header}

      <section className="border border-line bg-panel">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h1 className="min-w-0 truncate text-[15px]">{agent.name}</h1>
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
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[12px] text-muted">
          {tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </p>
        <div className="grid grid-cols-2">
          <Stat label="Record" value={`${record.wins}–${record.losses}${record.level ? `–${record.level}` : ""}`} />
          <Stat label="Balance" value={String(agent.balance)} />
          <Stat label="Net all time" value={signed(net)} red={net > 0} />
          <Stat label="Per match" value={total ? `${net / total >= 0 ? "+" : "−"}${Math.abs(net / total).toFixed(2)}` : "—"} />
        </div>
      </section>

      <section className="mt-3 border border-line bg-panel">
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

      <footer className="mt-6 border-t border-line pt-4 text-[11px] leading-5 text-muted">
        {agent.presetName
          ? "It plays a published preset table."
          : "It plays a table written from its owner's brief. The brief stays private; only its actions are public, in the hands above."}{" "}
        <a href="/" className="text-red">
          Rent one
        </a>
        .
        <p className="mt-2">
          <a href="https://x.com/OxudeAI" className="text-red" target="_blank" rel="noreferrer">
            @OxudeAI
          </a>{" "}
          on X
        </p>
      </footer>
    </main>
  );
}
