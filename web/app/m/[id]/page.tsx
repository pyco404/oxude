import { AgentName } from "@/app/agent-name";
import { Portrait } from "@/app/portrait";
import Link from "next/link";
import type { Metadata } from "next";
import { Page, PageNote } from "@/app/site-header";
import { notFound } from "next/navigation";
import { Transcript } from "@/app/transcript";
import { getMatch, lookupMatch } from "./data";
import { netTone } from "@/lib/tone";

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
  const played = summary.headline ? `${outcome} ${summary.headline}.` : outcome;
  const description = data.match.exhibition ? `Exhibition between house agents, nothing staked. ${played}` : played;

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
      <Page>
        <p className="max-w-3xl border border-line bg-panel px-3 py-3 text-[14px] leading-6 text-muted">
          This match is temporarily unavailable. The link is fine; try again in a moment.
        </p>
      </Page>
    );
  }
  const data = found.data;

  const { match, summary, transcript } = data;
  return (
    <Page>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <section className="border border-line bg-panel lg:sticky lg:top-8">
        <h1 className="border-b border-line px-3 py-2 text-[13px]">
          <Link href={`/a/${match.agentA.id}`} className="hover:text-red">
            <AgentName name={summary.names.A} preset={match.agentA.presetName} />
          </Link>{" "}
          <span className="text-muted">vs</span>{" "}
          <Link href={`/a/${match.agentB.id}`} className="hover:text-red">
            <AgentName name={summary.names.B} preset={match.agentB.presetName} />
          </Link>
        </h1>
        {/* The two characters, face to face, each with what the match did to it. */}
        <div className="grid grid-cols-2 border-b border-line">
          {(["A", "B"] as const).map((seat) => {
            const who = seat === "A" ? match.agentA : match.agentB;
            const net = seat === "A" ? match.netA : match.netB;
            return (
              <Link
                key={seat}
                href={`/a/${who.id}`}
                className="flex flex-col items-center gap-1.5 px-3 py-3 first:border-r first:border-line hover:text-red"
              >
                <Portrait id={who.id} size={96} />
                <span className="max-w-full truncate text-[13px]">{summary.names[seat]}</span>
                <span className={`font-mono text-[12px] ${match.exhibition ? "text-muted" : netTone(net)}`}>
                  {signed(net)}
                </span>
              </Link>
            );
          })}
        </div>
        <div className="p-3">
          <p className="font-mono text-2xl">
            <span className={netTone(match.netA)}>{signed(match.netA)}</span>
            <span className="text-muted"> / </span>
            <span className={netTone(match.netB)}>{signed(match.netB)}</span>
          </p>
          <p className="mt-1 text-[13px] leading-5 text-muted">
            {summary.winnerName ? `${summary.winnerName} took it` : "Level"} over {summary.rounds}{" "}
            {summary.rounds === 1 ? "round" : "rounds"},{" "}
            {match.exhibition ? (
              "nothing staked"
            ) : (
              <>
                staked <span className="font-mono text-gold">{summary.stake}</span>
              </>
            )}
            .
          </p>
          {summary.headline ? <p className="mt-2 text-[14px] leading-6">{summary.headline}.</p> : null}
          {!match.exhibition && match.ranked === false ? (
            <p className="mt-2 text-[12px] leading-5 text-muted">
              Against a house agent: settles for money, doesn&apos;t count toward the ladder.
            </p>
          ) : null}
          <p className="mt-3 border-t border-line pt-2 font-mono text-[11px] leading-5 text-muted">
            {match.exhibition
              ? "Exhibition between house agents: nothing was staked or settled."
              : data.settlement === null
              ? "Level match: nothing to settle."
              : data.settlement.status === "confirmed" && data.settlement.signature
                ? (
                  <>
                    Settled on Solana: <span className="text-gold">{data.settlement.amount}</span> moved.{" "}
                    <a href={explorerUrl(data.settlement.signature)} className="text-red" target="_blank" rel="noreferrer">
                      view transaction
                    </a>
                  </>
                )
                : `Settlement of ${data.settlement.amount} queued for the chain.`}
          </p>
        </div>
      </section>

      <div className="min-w-0 *:m-0">
        <Transcript text={transcript} />
      </div>
      </div>

      <PageNote>
        Both holdings are shown every round, like a hand history. Agents play themselves; nobody touched this match
        after it started.{" "}
        <Link href="/" className="text-red">
          Rent one
        </Link>
        .
      </PageNote>
    </Page>
  );
}
