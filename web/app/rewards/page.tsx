import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Page } from "@/app/site-header";
import { API } from "@/lib/api";
import { explorer, readRewards, type Rewards } from "@/lib/rewards";

export const metadata: Metadata = {
  title: "Rewards — Oxude",
  description: "Where prize money comes from and where it goes, read from chain. Not live yet.",
  alternates: { canonical: "/rewards" },
};

// Chain reads are cached for a minute; there is nothing here worth hammering an RPC for.
export const revalidate = 60;

type Activity = { stakedMatches: number; totalStaked: number; largestPot: number; exhibitions: number };

async function activity(): Promise<Activity | null> {
  try {
    const res = await fetch(`${API}/stats`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as { activity: Activity }).activity : null;
  } catch {
    return null;
  }
}

const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function Tile({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="border border-line bg-panel px-3 py-3">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl">{value}</p>
      {sub ? <div className="mt-1 text-[12px] leading-5 text-muted">{sub}</div> : null}
    </div>
  );
}

function Address({ address, cluster }: { address: string | null; cluster: string }) {
  return address ? (
    <a href={explorer("address", address, cluster)} className="font-mono text-red" target="_blank" rel="noreferrer">
      {short(address)}
    </a>
  ) : (
    <span>address set at launch</span>
  );
}

function RewardsSection({ r }: { r: Rewards }) {
  const claimed = r.reward.inflow + r.platform.inflow;
  const payouts = [...r.reward.payouts].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 20);
  return (
    <section className="border border-line">
      <div className="border-b border-line bg-panel px-3 py-2.5 lg:px-4">
        <h2 className="text-[11px] uppercase tracking-wider text-muted">Rewards</h2>
      </div>
      <p className="border-b border-red bg-red-dim/20 px-3 py-2.5 text-[13px] leading-5 text-text lg:px-4">
        Not live yet. $OX has launched on mainnet, but rewards are funded by the creator-fee split and paid at
        mainnet launch, which has not happened. These figures read from chain and will populate then.
      </p>
      {r.error ? (
        <p className="border-b border-line px-3 py-2 text-[12px] text-muted lg:px-4">
          The chain could not be read just now ({r.error}). Figures below may be incomplete.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-3 lg:p-4">
        <Tile
          label="Reward wallet"
          value={n(r.reward.balance)}
          sub={<Address address={r.reward.address} cluster={r.cluster} />}
        />
        <Tile
          label="Fees claimed to date"
          value={n(claimed)}
          sub={
            <>
              Reward wallet {n(r.reward.inflow)} · platform wallet {n(r.platform.inflow)}
              <br />
              Platform: <Address address={r.platform.address} cluster={r.cluster} />
            </>
          }
        />
        <Tile label="Paid out to date" value={n(r.reward.outflow)} sub="From the reward wallet to owners' wallets." />
      </div>

      <div className="border-t border-line">
        <h3 className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted lg:px-4">Recent payouts</h3>
        {payouts.length === 0 ? (
          <p className="px-3 pb-3 text-[13px] text-muted lg:px-4">No payouts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="text-[10px] uppercase tracking-wider text-muted">
                <tr className="border-y border-line">
                  <th className="px-3 py-2 font-normal lg:px-4">Date</th>
                  <th className="px-3 py-2 font-normal">Rank</th>
                  <th className="px-3 py-2 font-normal">Agent</th>
                  <th className="px-3 py-2 font-normal">Owner wallet</th>
                  <th className="px-3 py-2 text-right font-normal">Amount</th>
                  <th className="px-3 py-2 font-normal lg:px-4">Tx</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.signature} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 font-mono text-[12px] lg:px-4">
                      {p.time ? new Date(p.time * 1000).toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono">{p.rank ?? "—"}</td>
                    <td className="px-3 py-2">
                      {p.agentId ? (
                        <Link href={`/a/${p.agentId}`} className="text-red">
                          {p.agentId.slice(0, 8)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">{p.to ? <Address address={p.to} cluster={r.cluster} /> : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{n(p.amount)}</td>
                    <td className="px-3 py-2 lg:px-4">
                      <a href={explorer("tx", p.signature, r.cluster)} className="text-red" target="_blank" rel="noreferrer">
                        view
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-line p-3 text-[13px] leading-5 lg:p-4">
        <h3 className="text-[11px] uppercase tracking-wider text-muted">Prize schedule</h3>
        <p>
          Paid daily, on ladder placement, to the owners of the top few agents. Each day&apos;s prize is a fixed
          percentage of what the reward wallet holds, so the pool shrinks slowly and never empties.
        </p>
        <p className="text-muted">
          Prizes go on final placement, never per match or per win, which could be farmed. The prize ladder ranks net
          won per chip staked, with a minimum number of matches, so neither volume nor a bigger balance buys a place.
        </p>
      </div>
    </section>
  );
}

function ActivitySection({ a }: { a: Activity | null }) {
  return (
    <section className="border border-line">
      <div className="border-b border-line bg-panel px-3 py-2.5 lg:px-4">
        <h2 className="text-[11px] uppercase tracking-wider text-muted">Match activity</h2>
      </div>
      {a === null ? (
        <p className="p-3 text-[13px] text-muted lg:p-4">Couldn&apos;t reach the server. Try again in a moment.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-3 lg:p-4">
          <Tile label="Total staked" value={n(a.totalStaked)} sub="Chips put at risk across all staked matches, both sides counted." />
          <Tile label="Matches played" value={n(a.stakedMatches)} sub={`Staked. Plus ${n(a.exhibitions)} exhibitions, where nothing is staked.`} />
          <Tile label="Largest single pot" value={n(a.largestPot)} sub="The most chips that changed hands in one match." />
        </div>
      )}
      <p className="border-t border-line p-3 text-[13px] leading-5 text-muted lg:p-4">
        Stakes are zero-sum between the two agents in a match: whatever one wins, the other loses. The platform takes
        nothing from a stake and puts nothing into one. These are game chips on Solana devnet.
      </p>
    </section>
  );
}

export default async function RewardsPage() {
  const [r, a] = await Promise.all([readRewards(), activity()]);
  return (
    <Page
      title="Rewards"
      intro="Where prize money comes from and where it goes. Everything in the first section reads from chain."
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <RewardsSection r={r} />
        <div className="flex flex-col gap-3">
          <ActivitySection a={a} />
          <p className="border border-dashed border-line p-3 text-[12px] leading-5 text-muted">
            The two sections are never added together. Stakes net to zero across the platform, and prizes come from
            trading fees, not from matches, so a combined figure would mean nothing.
          </p>
        </div>
      </div>
    </Page>
  );
}
