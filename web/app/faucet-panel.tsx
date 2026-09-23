"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type FaucetStatus } from "@/lib/api";
import { useWallet } from "./wallet-context";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;

type Phase = { at: "idle" | "claiming" } | { at: "done"; chips: number; signature: string } | { at: "error"; message: string };

/**
 * Devnet only: test tokens, so somebody can rent and fund an agent without
 * buying anything. The api answers 503 on any other network and this renders
 * nothing, so nobody is ever shown a faucet that cannot exist.
 */
export function FaucetPanel({ onFunded }: { onFunded?: () => void }) {
  const { session } = useWallet();
  const token = session?.token ?? null;
  const [info, setInfo] = useState<FaucetStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "idle" });

  const load = useCallback(async () => {
    if (!token) return setInfo(null);
    try {
      setInfo((await api.faucet(token)).faucet);
    } catch {
      // 503 on a network with no faucet, which is every network but devnet.
      setInfo(null);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!token || !info) return null;

  const claim = async () => {
    setPhase({ at: "claiming" });
    try {
      const { grant } = await api.claimFaucet(token);
      setPhase({ at: "done", chips: grant.chips, signature: grant.signature });
      await load();
      onFunded?.();
    } catch (error) {
      setPhase({ at: "error", message: error instanceof ApiError ? error.message : "could not reach the faucet" });
    }
  };

  const waitsUntil = info.nextAt ? new Date(info.nextAt) : null;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[12px] uppercase tracking-wider text-muted">Test tokens</h3>
      <p className="mt-2 text-[13px] leading-5 text-muted">
        This is devnet, so the tokens are free and worth nothing. Take{" "}
        <span className="font-mono text-gold">{info.chips.toLocaleString()}</span> to pay an agent&apos;s rent and fund
        it.
      </p>

      {info.available ? (
        <button
          onClick={() => void claim()}
          disabled={phase.at === "claiming"}
          className="rounded-panel mt-3 w-full border border-gold px-3 py-2 text-[13px] text-gold disabled:border-line disabled:text-muted"
        >
          {phase.at === "claiming" ? "Sending…" : `Get ${info.chips.toLocaleString()} test tokens`}
        </button>
      ) : (
        <p className="mt-2 text-[12px] text-muted">
          Already topped up. You can ask again{" "}
          {waitsUntil ? waitsUntil.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "tomorrow"}.
        </p>
      )}

      {phase.at === "done" ? (
        <p className="mt-2 text-[12px] text-win">
          <span className="font-mono">{phase.chips.toLocaleString()}</span> sent.{" "}
          <a href={explorerTx(phase.signature)} target="_blank" rel="noreferrer" className="underline">
            View the transaction
          </a>
        </p>
      ) : null}
      {phase.at === "error" ? <p className="mt-2 text-[12px] text-loss">{phase.message}</p> : null}
    </div>
  );
}
