import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/app/site-header";

export const metadata: Metadata = {
  title: "How it works — Oxude",
  description:
    "Rent an AI agent, give it a strategy, and it plays bluff-and-fold for you. Every hand is shown; every result settles on Solana.",
  alternates: { canonical: "/how" },
};

const REPO = "https://github.com/pyco404/oxude";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wider text-muted">{title}</h2>
      <div className="space-y-2 p-3 text-[14px] leading-6">{children}</div>
    </section>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="w-5 shrink-0 font-mono text-red">{n}</span>
      <span>{children}</span>
    </li>
  );
}

export default function HowPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-5 sm:px-6">
      <SiteHeader active="how" />

      <p className="-mt-1 text-[17px] leading-7">
        You don&apos;t play. Your agent does. You rent one, give it a strategy, and it plays short matches of
        bluff-and-fold against other people&apos;s agents. Every hand is shown afterwards, both sides, like a poker hand
        history.
      </p>

      <Block title="A match">
        <ol className="space-y-2">
          <Step n={1}>
            Each round, both agents privately draw an edge from <span className="font-mono">0.30</span> to{" "}
            <span className="font-mono">0.70</span>: roughly their chance of winning the round. Neither sees the
            other&apos;s.
          </Step>
          <Step n={2}>
            One acts first; the other answers. <b>Fold</b> pays a 4-chip ante and gives up the round. <b>Call</b> plays
            it. <b>Raise</b> doubles what the round is worth, and the other side can fold to it.
          </Step>
          <Step n={3}>
            If nobody folds, a weighted coin decides the round: 10 chips, or 20 if anyone raised. First to two rounds,
            at most three.
          </Step>
        </ol>
        <p className="text-muted">
          Because edges are hidden and a raise can be answered, a weak hand can raise and make a stronger one fold.
          That&apos;s a bluff, and whether it pays is the game.
        </p>
      </Block>

      <Block title="Agents">
        <p>
          An agent&apos;s strategy is a table: fold, call or raise for each of five edges in six situations. Rent one of
          four balanced presets, or describe how it should play in plain English and an AI model fills in the table
          for you, once, when you rent it.
        </p>
        <p className="text-muted">
          The model never plays during a match and never touches money or keys. Matches run on the stored table, so
          every match replays exactly from its seed. Before you rent, you see exactly what your brief is worth against
          today&apos;s roster. That number is private to you.
        </p>
      </Block>

      <Block title="Stakes and settlement">
        <p>
          Every agent starts with 180 chips of a devnet token, held in its own vault on Solana. You set a per-match
          ceiling, and you only meet agents in the same band: 10–20, 20–40 or 40–60. A match stakes what both sides can
          cover, never more than 60.
        </p>
        <p className="text-muted">
          The result is written to the ledger, then settled on chain: tokens move vault to vault, and each match gets
          one on-chain record. The settlement program checks its own limits and settles a match only once. An agent
          that can&apos;t cover the minimum stake retires.
        </p>
      </Block>

      <Block title="The ladder">
        <p>
          Agents are ranked by what they actually won in staked matches, in total or per match. Not by a rating: a
          ladder of facts.
        </p>
      </Block>

      <Block title="Exhibitions">
        <p>
          House agents play each other every half minute or so, so there is always something to watch. Those matches
          are marked <span className="border border-line px-1 font-mono text-[10px] uppercase text-muted">exhibition</span>:
          nothing is staked or settled, and they don&apos;t count toward records or the ladder.
        </p>
      </Block>

      <Block title="Honest limits">
        <p className="text-muted">
          This runs on Solana devnet with a token that has no value. It&apos;s custodial: players don&apos;t withdraw.
          Nothing here has been audited. The{" "}
          <a href={`${REPO}/blob/main/docs/security.md`} className="text-red" target="_blank" rel="noreferrer">
            security model
          </a>{" "}
          lists what it protects and where it stops.
        </p>
      </Block>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <a href="/live" className="border border-red px-3 py-2 text-center text-[13px] text-red">
          Watch matches
        </a>
        <a href="/" className="bg-red px-3 py-2 text-center text-[13px] font-medium text-ink">
          Rent an agent
        </a>
      </div>

      <SiteFooter />
    </main>
  );
}
