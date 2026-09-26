"use client";

import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useCallback, useEffect, useRef } from "react";
import { palette } from "@/lib/palette";

/**
 * Privy, kept to one job: turn an email or X login into a Solana embedded
 * wallet that can sign Oxude's sign-in message. It is loaded on its own, only
 * when NEXT_PUBLIC_PRIVY_APP_ID is set, and wraps nothing but this bridge, so
 * if it fails the rest of the page never notices.
 */

export type PrivySigner = { publicKey: string; sign: (message: Uint8Array) => Promise<Uint8Array> };
export type PrivyApi = {
  /** Opens Privy's login if needed, and resolves once an embedded wallet can sign. */
  signIn: () => Promise<PrivySigner>;
  /** Signs a serialized transaction (a withdrawal) with the embedded wallet; returns it signed. */
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  logout: () => Promise<void>;
};

type Pending = { resolve: (s: PrivySigner) => void; reject: (e: Error) => void };

function Bridge({ onReady }: { onReady: (api: PrivyApi | null) => void }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const pending = useRef<Pending | null>(null);

  // The embedded wallet, never an extension wallet Privy may also detect.
  const embedded = wallets.find((w) => (w.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet) ?? null;

  const signerFor = useCallback(
    (wallet: NonNullable<typeof embedded>): PrivySigner => ({
      publicKey: wallet.address,
      // The message is the same free, no-transaction text Phantom users sign; no Privy prompt on top.
      sign: async (message) =>
        (await signMessage({ message, wallet, options: { uiOptions: { showWalletUIs: false } } })).signature,
    }),
    [signMessage],
  );

  const { login } = useLogin({
    onError: (error) => {
      pending.current?.reject(new Error(error === "exited_auth_flow" ? "Sign-in cancelled" : `Privy: ${error}`));
      pending.current = null;
    },
  });

  // Once logged in and the wallet exists, hand the signer to whoever asked.
  useEffect(() => {
    if (pending.current && authenticated && embedded) {
      pending.current.resolve(signerFor(embedded));
      pending.current = null;
    }
  }, [authenticated, embedded, signerFor]);

  const latest = useRef({ authenticated, embedded, login, logout, signerFor, signTransaction });
  latest.current = { authenticated, embedded, login, logout, signerFor, signTransaction };

  useEffect(() => {
    if (!ready) return;
    onReady({
      signIn: () =>
        new Promise<PrivySigner>((resolve, reject) => {
          const { authenticated: authed, embedded: wallet, login: open, signerFor: toSigner } = latest.current;
          if (authed && wallet) return resolve(toSigner(wallet));
          pending.current = { resolve, reject };
          if (!authed) open({ loginMethods: ["email", "twitter"] });
        }),
      logout: () => latest.current.logout(),
      signTransaction: async (transaction) => {
        const { embedded: wallet, signTransaction: sign } = latest.current;
        if (!wallet) throw new Error("sign in with email or X again to withdraw");
        return (await sign({ transaction, wallet })).signedTransaction;
      },
    });
    return () => onReady(null);
  }, [ready, onReady]);

  return null;
}

export default function PrivyBridge({ appId, onReady }: { appId: string; onReady: (api: PrivyApi | null) => void }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "twitter"],
        appearance: { theme: "dark", accentColor: palette.accent, walletChainType: "solana-only" },
        embeddedWallets: { solana: { createOnLogin: "all-users" }, showWalletUIs: false },
      }}
    >
      <Bridge onReady={onReady} />
    </PrivyProvider>
  );
}
