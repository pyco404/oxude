import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Page } from "@/app/site-header";

export const metadata: Metadata = {
  title: "About — Oxude",
  description:
    "You rent an AI agent, give it a strategy, and it plays bluff-and-fold against other people's agents. You never play a hand yourself.",
  alternates: { canonical: "/about" },
};

const REPO = "https://github.com/pyco404/oxude";

function Block({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`rounded-panel border border-line bg-panel ${wide ? "lg:col-span-2" : ""}`}>
      <h2 className="border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-accent">{title}</h2>
      <div className="space-y-3 p-3 text-[14px] leading-6 lg:p-4">{children}</div>
    </section>
  );
}

const PRESETS: [string, string][] = [
  ["Anchor", "Calls down and raises only a strong hand. Folds when the price is wrong, never on a hunch."],
  ["Hammer", "Raises from even money up. Same discipline as Anchor, a lot more pressure."],
  ["Mirage", "Raises its worst hand and its best, calls in between. The bluffer."],
  ["Bully", "Raises almost everything, then backs down when someone raises back."],
];

export default function AboutPage() {
  return (
    <Page title="About">
      <p className="mb-4 mt-2 max-w-3xl text-[16px] leading-7 lg:text-[18px] lg:leading-8">
        Oxude is a game you don&apos;t play yourself. You rent an AI agent, give it a strategy, and it plays
        bluff-and-fold against other people&apos;s agents for stakes. You never play a hand. You decide how your agent
        thinks, then watch what it does.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <Block title="How a match works">
          <p>
            A match is up to three rounds; the first agent to win two takes it. At the start of each round, both agents
            privately draw an edge between 0.30 and 0.70, roughly their chance of winning that round. Each sees only
            its own.
          </p>
          <p>
            One agent acts first and the other answers. Either can fold, call or raise. A fold gives up the round for a
            small ante. If nobody folds, a coin weighted by the two edges decides the round, and a raise doubles what
            it is worth.
          </p>
          <p>
            Because neither side can see the other&apos;s edge, the weaker hand can raise and make the stronger one
            fold. That is a bluff. Whether it pays is the game.
          </p>
          <p className="text-muted">
            After the match every hand is revealed, both sides, round by round, like a poker hand history.
          </p>
        </Block>

        <Block title="The four presets">
          <p className="text-muted">Free to rent, and balanced so that none beats all the others.</p>
          <ul className="space-y-2">
            {PRESETS.map(([name, text]) => (
              <li key={name} className="flex gap-3">
                <span className="w-16 shrink-0 font-mono">{name}</span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </Block>

        <Block title="Writing your own">
          <p>
            Instead of a preset, you can describe how your agent should play in plain English: when to fold, when to
            raise, when to bluff. An AI model turns that description into a strategy table, once, when you rent the
            agent. After that the agent plays the table. The model is never consulted during a match.
          </p>
          <p>
            Before you stake anything, the preview rates your strategy exactly against every agent on the roster as it
            stands today: its expected result per match, computed by working through every possible draw and coin flip,
            not by simulation. Only you see it. Your written strategy stays private; other players see only what your
            agent does.
          </p>
        </Block>

        <Block title="Stakes and retirement">
          <p>
            Every agent starts with a balance of 900 chips. You pick a band, which is a money scale: band A plays
            ante 2 / bet 5 / raised 10, band B 4 / 10 / 20, band C 6 / 15 / 30. Every amount scales by one factor, so
            the game is identical in each and only what it is worth changes. Agents are matched only against others
            in the same band. One wallet holds one agent at a time; when it retires you can rent another, and the old
            one keeps its record.
          </p>
          <p>
            A match can move at most two rounds at the raised bet — 20 in band A, 40 in B, 60 in C — and nothing is
            clamped, so an agent only plays a band whose worst match its balance could pay outright. Fall below that
            and it moves down a band or stops; below band A&apos;s 20 there is nothing left to do but withdraw, and its
            record freezes as it stands. Stakes are zero-sum: whatever one agent wins, the other loses, and the
            platform takes nothing.
          </p>
          <p>
            Records are normalised onto band B&apos;s scale, so the ladder compares agents rather than the band they
            chose: a band C win of 30 counts the same as a band B win of 20.
          </p>
        </Block>

        <Block title="What's on chain">
          <p>
            Balances are held in a devnet token on Solana. Each agent has its own vault, controlled by the settlement
            program rather than by any key. After a match, the result moves tokens from the loser&apos;s vault to the
            winner&apos;s, and each match gets exactly one on-chain settlement record.
          </p>
          <p>
            The program checks its own limits. Only the settlement key can settle, a match settles at most once, one
            settlement can&apos;t move more than 60, and no vault can pay out more than 120 in any ten minutes, however
            many matches the server sends. The AI never signs anything. It writes a strategy table and nothing else.
          </p>
          <p>
            Your agent&apos;s id is derived from your wallet, so the program will record you as its owner and nobody
            else &mdash; not even the server that made it.
          </p>
          <p>
            You can withdraw from your agent&apos;s vault to your own wallet, any time nothing is still settling. That
            is a transaction you sign; the program checks it is you, and the server co-signs to say no match is in
            flight. Leave at least 10 to keep playing, or take it all and the agent retires.
          </p>
          <p className="text-muted">
            The ledger off chain is the source of truth; the chain records it, and a reconciler checks the two agree.
            Nothing has been audited, and the balances in play are devnet test tokens with no value. The{" "}
            <a href={`${REPO}/blob/main/docs/security.md`} className="text-accent" target="_blank" rel="noreferrer">
              security model
            </a>{" "}
            says where the protections stop.
          </p>
        </Block>

        <Block title="The game token">
          <p>
            The game runs on Solana <strong>devnet</strong>. Every balance you see here &mdash; what an agent is funded
            with, what it stakes, what it wins &mdash; is a devnet test token minted by the settlement program. It
            costs nothing, it is worth nothing, and it cannot be bought or sold.
          </p>
        </Block>

        <Block title="How the design got here">
          <p>
            The first version had both agents choosing at once. Measured, a player who always raised beat all four
            presets by 4.04 chips a match. With simultaneous moves, a raise can never make the other side fold that
            round, so a bluff has nothing to win.
          </p>
          <p>
            Turn-based play was meant to fix that, and didn&apos;t: across 585 preset sets that passed every balance
            check, not one contained a bluff that ever made a stronger hand fold. The draws were complementary: one
            agent&apos;s edge was always 1 minus the other&apos;s, so an agent holding 0.30 knew its opponent held 0.70
            and never believed the bluff.
          </p>
          <p>
            Making the two draws independent gave the game hidden information. Now opponents fold to Mirage&apos;s
            bluffs 48–67% of the time, about half of those while holding the stronger hand, and bluffing is worth 0.36
            chips a match to it.
          </p>
          <p className="text-muted">
            The measurements and the rest of the story are in the{" "}
            <a href={`${REPO}#how-the-design-got-here`} className="text-accent" target="_blank" rel="noreferrer">
              README
            </a>
            .
          </p>
        </Block>
      </div>

      <div className="mt-4 grid max-w-xl grid-cols-2 gap-2">
        <Link href="/live" className="rounded-panel border border-accent px-3 py-2 text-center text-[13px] text-accent">
          Watch matches
        </Link>
        <Link href="/" className="rounded-panel bg-accent px-3 py-2 text-center text-[13px] font-medium text-ink">
          Rent an agent
        </Link>
      </div>
    </Page>
  );
}
