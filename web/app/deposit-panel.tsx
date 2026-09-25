"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useWallet } from "./wallet-context";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;

type Phase =
  | { at: "idle" }
  | { at: "preparing" | "signing" | "sending" }
  | { at: "done"; chips: number; signature: string | null }
  | { at: "waiting" }
  | { at: "error"; message: string };

/**
 * Put more of your own money into an agent's vault.
 *
 * Only for agents rented by deposit: one rented before deposits existed holds
 * the old program's token, and there is nowhere to put this. The api refuses
 * those, and this renders nothing for them rather than offering something that
 * cannot work.
 */
export function DepositPanel({
  agentId,
  canDeposit,
  onChanged,
}: {
  agentId: string;
  /** False for an agent rented before deposits, or when the server has no deposit flow. */
  canDeposit: boolean;
  onChanged: () => void;
}) {
  const { session, signTransaction } = useWallet();
  const token = session?.token ?? null;
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>({ at: "idle" });

  if (!token || !canDeposit) return null;

  const chips = Number(amount);
  const ok = Number.isInteger(chips) && chips > 0;
  const busy = phase.at === "preparing" || phase.at === "signing" || phase.at === "sending";

  const send = async () => {
    setPhase({ at: "preparing" });
    try {
      const { deposit } = await api.prepareDeposit(token, agentId, chips);
      setPhase({ at: "signing" });
      const signed = await signTransaction(deposit.transaction);
      setPhase({ at: "sending" });
      const { deposit: out } = await api.submitDeposit(token, deposit.depositId, signed);
      setPhase(out.status === "confirmed" ? { at: "done", chips: deposit.chips, signature: out.signature } : { at: "waiting" });
      setAmount("");
      onChanged();
    } catch (error) {
      setPhase({ at: "error", message: error instanceof ApiError ? error.message : (error as Error).message });
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[12px] uppercase tracking-wider text-muted">Add funds</h3>
      <p className="mt-2 text-[13px] leading-5 text-muted">
        Your own money, into this agent&apos;s vault. This is how an agent that has played itself down gets back into a
        band it can cover.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          placeholder="chips"
          aria-label="Chips to deposit"
          className="rounded-panel w-28 border border-line bg-panel-2 px-3 py-2 font-mono text-[13px]"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !ok}
          className="rounded-panel flex-1 border border-gold px-3 py-2 text-[13px] text-gold disabled:border-line disabled:text-muted"
        >
          {phase.at === "signing" ? "Waiting for your wallet…" : busy ? "Sending…" : `Add${ok ? ` ${chips}` : ""}`}
        </button>
      </div>

      {phase.at === "done" ? (
        <p className="mt-2 text-[12px] text-win">
          <span className="font-mono">{phase.chips.toLocaleString()}</span> added.{" "}
          {phase.signature ? (
            <a href={explorerTx(phase.signature)} target="_blank" rel="noreferrer" className="underline">
              View the transaction
            </a>
          ) : null}
        </p>
      ) : null}
      {phase.at === "waiting" ? (
        <p className="mt-2 text-[12px] text-muted">
          Sent, and not landed yet. The balance updates when it does; if it never lands, nothing is charged.
        </p>
      ) : null}
      {phase.at === "error" ? <p className="mt-2 text-[12px] text-loss">{phase.message}</p> : null}
    </div>
  );
}
