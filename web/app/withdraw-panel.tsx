"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Withdrawable } from "@/lib/api";
import { useWallet } from "./wallet-context";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;

type Phase =
  | { at: "idle" }
  | { at: "preparing" | "signing" | "sending" }
  | { at: "done"; amount: number; signature: string | null; retired: boolean }
  | { at: "error"; message: string };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Withdraw from an agent's vault to the owner's wallet: an amount that leaves
 * enough to keep playing, or the lot, which retires the agent. The owner signs
 * a real transaction here - not a sign-in message - and the server pays the fee.
 */
export function WithdrawPanel({
  agentId,
  agentName,
  refreshKey,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  /** Anything that changes when the balance might have (matches played, balance). */
  refreshKey: string;
  onChanged: () => void;
}) {
  const { session, signWithdrawal } = useWallet();
  const token = session?.token ?? null;
  const [info, setInfo] = useState<Withdrawable | null>(null);
  const [amount, setAmount] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [phase, setPhase] = useState<Phase>({ at: "idle" });

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setInfo((await api.withdrawable(token, agentId)).withdrawable);
    } catch {
      setInfo(null);
    }
  }, [token, agentId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const busy = phase.at === "preparing" || phase.at === "signing" || phase.at === "sending";

  const withdraw = async (what: number | "all") => {
    setConfirmAll(false);
    try {
      setPhase({ at: "preparing" });
      const { withdrawal } = await api.prepareWithdrawal(token, agentId, what);
      setPhase({ at: "signing" });
      const signed = await signWithdrawal(withdrawal.transaction);
      setPhase({ at: "sending" });
      let { status, signature } = (await api.submitWithdrawal(token, withdrawal.withdrawalId, signed)).withdrawal;
      // Recorded but not yet landed: it lands within a minute or two, or is put back.
      for (let i = 0; status === "submitted" && i < 40; i++) {
        await pause(3000);
        const now = (await api.withdrawal(token, withdrawal.withdrawalId)).withdrawal;
        status = now.status === "prepared" ? "submitted" : now.status;
        signature = now.signature;
        if (now.status === "expired") throw new Error(`it couldn't land on chain, so nothing moved (${now.error ?? "expired"})`);
      }
      setPhase({ at: "done", amount: withdrawal.amount, signature, retired: withdrawal.retire });
      setAmount("");
      onChanged();
      await load();
    } catch (e) {
      setPhase({ at: "error", message: e instanceof ApiError ? e.message : (e as Error).message });
      await load();
    }
  };

  if (!info) return null;
  // Retired: nothing to withdraw. Show only the result of the withdrawal that retired it, if that just happened.
  if (info.reason === "this agent is retired") {
    return phase.at === "done" ? (
      <p className="mt-3 border-t border-line pt-3 text-[12px] leading-5" role="status">
        Withdrew {phase.amount} to your wallet; {agentName} is retired.{" "}
        {phase.signature ? (
          <a href={explorerTx(phase.signature)} target="_blank" rel="noreferrer" className="text-red">
            view transaction
          </a>
        ) : null}
      </p>
    ) : null;
  }
  const n = Number(amount);
  const amountOk = Number.isInteger(n) && n >= 1 && n <= info.maxPartial;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[11px] uppercase tracking-wider text-muted">Withdraw</h3>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <span>
          Withdrawable now <span className="font-mono text-text">{info.withdrawable}</span>
        </span>
        <span className="text-muted">
          Locked while matches settle <span className="font-mono">{info.locked}</span>
        </span>
      </p>
      {info.reason ? <p className="mt-1 text-[12px] text-muted">Not right now: {info.reason}.</p> : null}

      {info.withdrawable > 0 ? (
        <>
          <div className="mt-3 flex gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={info.maxPartial}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy || info.maxPartial < 1}
              placeholder={info.maxPartial >= 1 ? `1–${info.maxPartial}` : "—"}
              aria-label="Amount to withdraw"
              className="w-28 border border-line bg-panel-2 px-3 py-2 font-mono text-[13px]"
            />
            <button
              onClick={() => void withdraw(n)}
              disabled={busy || !amountOk}
              className="flex-1 border border-red px-3 py-2 text-[13px] text-red disabled:border-line disabled:text-muted"
            >
              Withdraw{amountOk ? ` ${n}` : ""}
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-muted">
            Leave at least {info.minStake} to keep playing, or take it all.
          </p>

          {confirmAll ? (
            <div className="mt-3 border border-red px-3 py-3 text-[13px] leading-5" role="alertdialog" aria-label="Confirm retirement">
              <p>
                Withdraw all <span className="font-mono">{info.withdrawable}</span> and retire {agentName}? It can never
                play again, and its record freezes as it stands. This can&apos;t be undone.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  onClick={() => void withdraw("all")}
                  disabled={busy}
                  className="bg-red px-3 py-2 text-[13px] font-medium text-ink disabled:bg-line disabled:text-muted"
                >
                  Withdraw all and retire
                </button>
                <button onClick={() => setConfirmAll(false)} className="border border-line px-3 py-2 text-[13px] text-muted">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmAll(true)}
              disabled={busy}
              className="mt-3 w-full border border-line px-3 py-2 text-[13px] text-muted hover:border-red hover:text-red disabled:hover:border-line disabled:hover:text-muted"
            >
              Withdraw all and retire
            </button>
          )}
        </>
      ) : null}

      <p className="mt-2 min-h-5 text-[12px] leading-5" role="status">
        {phase.at === "preparing" ? <span className="text-muted">Preparing the withdrawal…</span> : null}
        {phase.at === "signing" ? <span className="text-text">Sign the withdrawal in your wallet.</span> : null}
        {phase.at === "sending" ? <span className="text-muted">Sending it to Solana…</span> : null}
        {phase.at === "done" ? (
          <span className="text-text">
            Withdrew {phase.amount} to your wallet{phase.retired ? `; ${agentName} is retired` : ""}.{" "}
            {phase.signature ? (
              <a href={explorerTx(phase.signature)} target="_blank" rel="noreferrer" className="text-red">
                view transaction
              </a>
            ) : null}
          </span>
        ) : null}
        {phase.at === "error" ? <span className="text-red">Didn&apos;t withdraw: {phase.message}</span> : null}
      </p>
      <p className="text-[11px] leading-4 text-muted">
        Unlike signing in, this is a transaction you sign: it moves tokens from the vault to your wallet. The fee is
        paid for you. Devnet tokens have no value.
      </p>
    </div>
  );
}
