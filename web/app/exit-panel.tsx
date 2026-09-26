"use client";

import { useCallback, useEffect, useState } from "react";
import { type Withdrawable } from "@/lib/api";
import { providerFor } from "@/lib/wallet";
import { useWallet } from "./wallet-context";
import {
  buildMessage,
  base58Encode,
  claimExitIx,
  closeExitIx,
  requestExitIx,
  associatedTokenAddress,
} from "../public/exit/exit.mjs";

/**
 * The exit the server does not co-sign.
 *
 * Deliberately not part of the withdraw panel's normal state. The co-signed
 * withdrawal is the front door: it is instant, it costs the owner no SOL, and
 * while it works this component renders nothing at all. An owner who never
 * meets a problem should never read the word "exit".
 *
 * It appears in exactly two cases: an exit is already under way, in which case
 * an owner needs to see it wherever they look; or the instant path has just
 * failed in a way that means we cannot co-sign, in which case this is the
 * answer to that failure rather than an alternative offered alongside it.
 *
 * It builds its transactions from `public/exit/exit.mjs` - the same file the
 * standalone page uses, held to @solana/web3.js byte for byte in
 * test/standalone-exit.test.ts. One implementation, so the in-app path and the
 * one that works when we are gone cannot disagree about what an exit is.
 */

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: any; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "the network refused that");
  return body.result;
}

function remaining(unlockAt: string): string {
  const ms = new Date(unlockAt).getTime() - Date.now();
  if (ms <= 0) return "any moment";
  const mins = Math.ceil(ms / 60_000);
  return mins === 1 ? "about a minute" : `about ${mins} minutes`;
}

export function ExitPanel({
  agentId,
  info,
  offer,
  onChanged,
}: {
  agentId: string;
  info: Withdrawable;
  /** The instant path just failed in a way we cannot fix for them. */
  offer: boolean;
  onChanged: () => void;
}) {
  const { session } = useWallet();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [, tick] = useState(0);

  const exit = info.exit;
  // Re-render on a timer only while something is counting down.
  useEffect(() => {
    if (!exit || exit.claimed) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [exit]);

  const send = useCallback(
    async (what: string, build: (owner: string) => Promise<any>) => {
      if (!session) return;
      setBusy(true);
      setNote(null);
      try {
        const provider = session.wallet === "Privy" ? null : providerFor(session.wallet);
        if (!provider) throw new Error("This needs a Phantom or Solflare extension, which signs the transaction itself.");
        const owner = session.ownerId;
        const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
        const message = buildMessage({ payer: owner, instructions: [await build(owner)], recentBlockhash: blockhash });
        const result = await (provider as any).request({
          method: "signAndSendTransaction",
          params: { message: base58Encode(message) },
        });
        const signature = result?.signature ?? result;
        setNote({ text: `${what}. Signature ${String(signature).slice(0, 12)}…`, kind: "ok" });
        setTimeout(onChanged, 3000);
      } catch (e) {
        setNote({ text: e instanceof Error ? e.message : String(e), kind: "err" });
      } finally {
        setBusy(false);
      }
    },
    [session, onChanged],
  );

  // The ordinary case: the front door works, nothing started. Say nothing.
  if (!exit && !offer) return null;
  if (!session) return null;

  return (
    <div className="mt-3 rounded-panel border border-line p-3">
      <h4 className="text-[12px] uppercase tracking-wider text-muted">
        {exit ? "Exit in progress" : "Leave without us"}
      </h4>

      {!exit ? (
        <>
          <p className="mt-2 text-[13px] leading-5">
            We can&apos;t co-sign a withdrawal right now. You can take your money out without us: it needs two
            transactions about 30 minutes apart, and you pay the network fees.
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            The wait is so any match this agent already played can settle before the money leaves. The agent
            can&apos;t play while it&apos;s waiting, and you can cancel at any point before you claim.
          </p>
          <button
            onClick={() =>
              void send("Exit started", (owner) =>
                requestExitIx({ owner, agentId, amount: Math.round(info.balance * 1e6) }),
              )
            }
            disabled={busy || info.balance <= 0}
            className="rounded-panel mt-2 border border-accent px-3 py-2 text-[13px] text-accent disabled:border-line disabled:text-muted"
          >
            Start a 30-minute exit for {info.balance}
          </button>
        </>
      ) : exit.claimed && !exit.settled ? (
        <p className="mt-2 text-[13px] leading-5">
          <span className="font-mono text-gold">{exit.claimedAmount}</span> is in your wallet. We&apos;re still
          catching up with the chain; this agent comes back to you in a minute or so.
        </p>
      ) : exit.claimed ? (
        <>
          <p className="mt-2 text-[13px] leading-5">
            Done: <span className="font-mono text-gold">{exit.claimedAmount}</span> went to your wallet.
          </p>
          <button
            onClick={() => void send("Record cleared", (owner) => closeExitIx({ owner, agentId }))}
            disabled={busy}
            className="rounded-panel mt-2 border border-line px-3 py-2 text-[12px] text-muted disabled:text-muted"
          >
            Clear the record and get its rent back
          </button>
        </>
      ) : exit.claimable ? (
        <>
          <p className="mt-2 text-[13px] leading-5">
            The wait is over. Claiming pays out whatever the vault holds, up to the{" "}
            <span className="font-mono">{exit.amount}</span> you asked for.
          </p>
          <ClaimButton agentId={agentId} busy={busy} send={send} />
          <button
            onClick={() => void send("Exit cancelled", (owner) => closeExitIx({ owner, agentId }))}
            disabled={busy}
            className="rounded-panel mt-2 ml-2 border border-line px-3 py-2 text-[12px] text-muted"
          >
            Cancel instead
          </button>
        </>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-5">
            Waiting: <span className="font-mono text-gold">{remaining(exit.unlockAt)}</span> before you can claim{" "}
            <span className="font-mono">{exit.amount}</span>. This agent can&apos;t play until it&apos;s resolved.
          </p>
          <button
            onClick={() => void send("Exit cancelled", (owner) => closeExitIx({ owner, agentId }))}
            disabled={busy}
            className="rounded-panel mt-2 border border-line px-3 py-2 text-[12px] text-muted"
          >
            Cancel and keep playing
          </button>
        </>
      )}

      {note ? (
        <p className={`mt-2 text-[12px] ${note.kind === "err" ? "text-loss" : "text-gold"}`} role="status">
          {note.text}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] leading-4 text-muted">
        This goes straight to Solana and never through us: your wallet signs it, and nothing here can stop it or
        delay it. The same three instructions work from{" "}
        <a href="/exit/" className="text-accent">
          a plain HTML page
        </a>{" "}
        that needs no server of ours at all. Save it while you can.
      </p>
    </div>
  );
}

/** Claiming needs the stake mint, which comes from the program's own config. */
function ClaimButton({
  agentId,
  busy,
  send,
}: {
  agentId: string;
  busy: boolean;
  send: (what: string, build: (owner: string) => Promise<any>) => Promise<void>;
}) {
  return (
    <button
      onClick={() =>
        void send("Claimed", async (owner) => {
          const { pdas, decodeConfig } = await import("../public/exit/exit.mjs");
          const [configAddress] = await pdas.config();
          const account = await rpc("getAccountInfo", [configAddress, { encoding: "base64" }]);
          if (!account?.value) throw new Error("the program has no config on this network");
          const data = Uint8Array.from(atob(account.value.data[0]), (c: string) => c.charCodeAt(0));
          const destination = await associatedTokenAddress(owner, decodeConfig(data).mint);
          return claimExitIx({ owner, agentId, destination });
        })
      }
      disabled={busy}
      className="rounded-panel mt-2 bg-accent px-3 py-2 text-[13px] font-medium text-ink disabled:bg-line disabled:text-muted"
    >
      Claim now
    </button>
  );
}
