/**
 * Rewards, read from chain and nowhere else. Nothing here touches the game's
 * database: the reward and platform wallets are the record.
 *
 * Configured on the server once the token launches:
 *   REWARD_WALLET, PLATFORM_WALLET  owner addresses of the two fee wallets
 *   REWARD_MINT                     the token paid out
 *   REWARDS_RPC_URL                 RPC for the cluster the token lives on
 *   REWARDS_CLUSTER                 explorer cluster; default mainnet-beta
 * Unset, every figure is zero and the page says the addresses come at launch.
 *
 * A payout is any transfer out of the reward wallet. Rank and agent are not
 * chain facts, so each payout transaction carries an SPL memo:
 *   oxude:payout:rank=<n>:agent=<agent id>
 */

export type Payout = {
  signature: string;
  time: number | null;
  amount: number;
  to: string | null;
  rank: number | null;
  agentId: string | null;
};

export type WalletFlows = { balance: number; inflow: number; outflow: number; payouts: Payout[] };

export type Rewards = {
  configured: boolean;
  cluster: string;
  reward: { address: string | null } & WalletFlows;
  platform: { address: string | null } & WalletFlows;
  error: string | null;
};

const EMPTY: WalletFlows = { balance: 0, inflow: 0, outflow: 0, payouts: [] };
/** How far back history is read. Enough for weeks of daily payouts; older totals would need an indexer. */
const HISTORY = 200;

type RpcResult<T> = { result?: T; error?: { message: string } };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    next: { revalidate: 60 },
  });
  const body = (await res.json()) as RpcResult<T>;
  if (body.error || body.result === undefined) throw new Error(body.error?.message ?? `${method} failed`);
  return body.result;
}

type ParsedTokenAccount = { pubkey: string; account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } };
type TokenBalance = { owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null } };
type ParsedTx = {
  blockTime: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { message: { instructions: { program?: string; parsed?: unknown }[] } };
};

const MEMO = /oxude:payout:rank=(\d+):agent=([0-9a-f-]{36})/;

/** Balance, and every movement in and out, of one wallet's holdings of the mint. */
async function flowsOf(url: string, owner: string, mint: string): Promise<WalletFlows> {
  const accounts = await rpc<{ value: ParsedTokenAccount[] }>(url, "getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const flows: WalletFlows = { balance: 0, inflow: 0, outflow: 0, payouts: [] };
  for (const acct of accounts.value) {
    flows.balance += acct.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    const sigs = await rpc<{ signature: string; err: unknown }[]>(url, "getSignaturesForAddress", [
      acct.pubkey,
      { limit: HISTORY, commitment: "confirmed" },
    ]);
    for (const { signature, err } of sigs) {
      if (err) continue;
      const tx = await rpc<ParsedTx | null>(url, "getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]);
      if (!tx?.meta || tx.meta.err) continue;
      const amountOf = (list: TokenBalance[] | undefined, who: string) =>
        (list ?? []).filter((b) => b.mint === mint && b.owner === who).reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
      const delta = amountOf(tx.meta.postTokenBalances, owner) - amountOf(tx.meta.preTokenBalances, owner);
      if (delta > 0) flows.inflow += delta;
      if (delta < 0) {
        flows.outflow += -delta;
        // Whoever gained the mint in the same transaction received it.
        const owners = new Set((tx.meta.postTokenBalances ?? []).filter((b) => b.mint === mint && b.owner && b.owner !== owner).map((b) => b.owner!));
        const to = [...owners].find((o) => amountOf(tx.meta!.postTokenBalances, o) > amountOf(tx.meta!.preTokenBalances, o)) ?? null;
        const memo = tx.transaction.message.instructions
          .map((i) => (i.program === "spl-memo" && typeof i.parsed === "string" ? i.parsed : ""))
          .map((m) => m.match(MEMO))
          .find(Boolean);
        flows.payouts.push({
          signature,
          time: tx.blockTime,
          amount: -delta,
          to,
          rank: memo ? Number(memo[1]) : null,
          agentId: memo ? memo[2]! : null,
        });
      }
    }
  }
  return flows;
}

export async function readRewards(): Promise<Rewards> {
  const reward = process.env.REWARD_WALLET ?? null;
  const platform = process.env.PLATFORM_WALLET ?? null;
  const mint = process.env.REWARD_MINT ?? null;
  const url = process.env.REWARDS_RPC_URL ?? null;
  const cluster = process.env.REWARDS_CLUSTER ?? "mainnet-beta";
  const blank: Rewards = {
    configured: false,
    cluster,
    reward: { address: reward, ...EMPTY },
    platform: { address: platform, ...EMPTY },
    error: null,
  };
  if (!reward || !platform || !mint || !url) return blank;
  try {
    const [r, p] = await Promise.all([flowsOf(url, reward, mint), flowsOf(url, platform, mint)]);
    return { configured: true, cluster, reward: { address: reward, ...r }, platform: { address: platform, ...p }, error: null };
  } catch (e) {
    return { ...blank, configured: true, error: (e as Error).message };
  }
}

export function explorer(kind: "address" | "tx", id: string, cluster: string): string {
  return `https://explorer.solana.com/${kind}/${id}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
}
