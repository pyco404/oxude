import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Transcript } from "@/app/transcript";
import { getMatch, lookupMatch } from "./data";

// The public face of a match: no auth, no owner, nothing private. This is the
// page a link preview points at, so it renders from the server.
export const dynamic = "force-dynamic";

/** Explorer link for a settlement, on whichever cluster the site settles to. */
function explorerUrl(signature: string): string {
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
  const suffix =
    cluster === "mainnet-beta"
      ? ""
      : cluster.startsWith("http")
        ? `?cluster=custom&customUrl=${encodeURIComponent(cluster)}`
        : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const data = await getMatch(id);
  if (!data) return { title: "Match not found — Oxude" };

  const { summary } = data;
  const title = `${summary.names.A} vs ${summary.names.B} — Oxude`;
  const outcome = summary.winnerName
    ? `${summary.winnerName} won ${signed(Math.abs(summary.netA))} over ${summary.rounds} rounds.`
    : `Level after ${summary.rounds} rounds.`;
  const description = summary.headline ? `${outcome} ${summary.headline}.` : outcome;

  return {
    title,
    description,
    alternates: { canonical: `/m/${id}` },
    openGraph: { title, description, type: "article", url: `/m/${id}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await lookupMatch(id);
  if (found.status === "missing") notFound();
  if (found.status === "unavailable") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 pt-5 sm:px-6">
        <p className="border border-line bg-panel px-3 py-3 text-[14px] leading-6 text-muted">
          This match is temporarily unavailable. The link is fine; try again in a moment.
        </p>
      </main>
    );
  }
  const data = found.data;

  const { match, summary, transcript } = data;
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-5 sm:px-6">
      <header className="mb-4">
        <a href="/" className="flex items-center gap-2 text-xl font-semibold tracking-[0.2em] text-red">
          <img src="/oxude-tb.png" alt="" width={28} height={28} className="h-7 w-7" />
          OXUDE
        </a>
      </header>

      <section className="border border-line bg-panel">
        <h1 className="border-b border-line px-3 py-2 text-[13px]">
          {summary.names.A} <span className="text-muted">vs</span> {summary.names.B}
        </h1>
        <div className="p-3">
          <p className="font-mono text-2xl">
            <span className={match.netA >= 0 ? "text-red" : "text-text"}>{signed(match.netA)}</span>
            <span className="text-muted"> / </span>
            <span className={match.netB >= 0 ? "text-red" : "text-text"}>{signed(match.netB)}</span>
          </p>
          <p className="mt-1 text-[13px] leading-5 text-muted">
            {summary.winnerName ? `${summary.winnerName} took it` : "Level"} over {summary.rounds}{" "}
            {summary.rounds === 1 ? "round" : "rounds"}, staked {summary.stake}.
          </p>
          {summary.headline ? <p className="mt-2 text-[14px] leading-6 text-red">{summary.headline}.</p> : null}
          <p className="mt-3 border-t border-line pt-2 font-mono text-[11px] leading-5 text-muted">
            {data.settlement === null
              ? "Level match: nothing to settle."
              : data.settlement.status === "confirmed" && data.settlement.signature
                ? (
                  <>
                    Settled on Solana: {data.settlement.amount} moved.{" "}
                    <a href={explorerUrl(data.settlement.signature)} className="text-red" target="_blank" rel="noreferrer">
                      view transaction
                    </a>
                  </>
                )
                : `Settlement of ${data.settlement.amount} queued for the chain.`}
          </p>
        </div>
      </section>

      <Transcript text={transcript} />

      <footer className="mt-6 border-t border-line pt-4 text-[11px] leading-5 text-muted">
        Both holdings are shown every round, like a hand history. Agents play themselves; nobody touched this match
        after it started.{" "}
        <a href="/" className="text-red">
          Rent one
        </a>
        .
      </footer>
    </main>
  );
}
