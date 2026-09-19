"use client";

import dynamic from "next/dynamic";
import { Component, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  installedWallets,
  loadSession,
  signInWith,
  signInWithSigner,
  signOut,
  signTransactionWith,
  fromBase64,
  toBase64,
  type Session,
  type WalletName,
} from "@/lib/wallet";
import type { PrivyApi } from "./privy-bridge";

/**
 * Privy is a second way in, behind a flag: only with NEXT_PUBLIC_PRIVY_APP_ID
 * set, loaded as its own chunk, and caught if it fails, so the extension
 * wallets work exactly as before whether or not it ever loads.
 */
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const PrivyBridge = PRIVY_APP_ID
  ? dynamic(
      () =>
        import("./privy-bridge").catch((error) => {
          // A chunk that can't load (blocked, offline) must not take the page with it.
          reportPrivy("failed", `couldn't load Privy (${(error as Error).message})`);
          return { default: () => null };
        }),
      { ssr: false, loading: () => null },
    )
  : null;
/** How long Privy gets to become ready before the page says it didn't. */
const PRIVY_READY_TIMEOUT_MS = 20_000;

export type PrivyStatus = "off" | "loading" | "ready" | "failed";

/**
 * Privy's state, kept where it can be seen: on window.__oxudePrivy and in the
 * console, and in the UI as a loading or failed line. A silent failure here is
 * indistinguishable from the feature not existing.
 */
let reportPrivy: (status: PrivyStatus, reason?: string) => void = () => {};
function publish(status: PrivyStatus, reason: string | null, startedAt: number) {
  const state = { status, reason, afterMs: Math.round(performance.now() - startedAt) };
  (window as unknown as { __oxudePrivy?: typeof state }).__oxudePrivy = state;
  (status === "failed" ? console.warn : console.info)(`[oxude] Privy ${status}${reason ? `: ${reason}` : ""} after ${state.afterMs}ms`);
}

class Contained extends Component<{ children: ReactNode; onError: (reason: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(`Privy crashed (${(error as Error)?.message ?? String(error)})`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type WalletState = {
  session: Session | null;
  /** Wallet extensions found in this browser. */
  wallets: WalletName[];
  busy: "connect" | "disconnect" | null;
  error: string | null;
  connect: (name: WalletName) => Promise<void>;
  disconnect: () => Promise<void>;
  /** True once Privy has loaded and can take an email or X login. */
  privyReady: boolean;
  privyStatus: PrivyStatus;
  /** Why Privy isn't available, when it failed. */
  privyReason: string | null;
  connectPrivy: () => Promise<void>;
  /** Signs a prepared withdrawal (base64) with whichever wallet signed in; returns it signed, base64. */
  signWithdrawal: (prepared: string) => Promise<string>;
};

const WalletContext = createContext<WalletState | null>(null);

/** One sign-in for the whole site, so the top bar and the page agree on who is signed in. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [wallets, setWallets] = useState<WalletName[]>([]);
  const [busy, setBusy] = useState<WalletState["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [privy, setPrivy] = useState<PrivyApi | null>(null);
  const [privyStatus, setPrivyStatus] = useState<PrivyStatus>(PRIVY_APP_ID ? "loading" : "off");
  const [privyReason, setPrivyReason] = useState<string | null>(null);

  // Track Privy's state, give up visibly after a while, and publish it for debugging.
  useEffect(() => {
    if (!PRIVY_APP_ID) return;
    const startedAt = performance.now();
    let settled = false;
    reportPrivy = (status, reason) => {
      if (settled && status !== "ready") return;
      if (status !== "loading") settled = true;
      setPrivyStatus(status);
      setPrivyReason(reason ?? null);
      publish(status, reason ?? null, startedAt);
    };
    publish("loading", null, startedAt);
    const timer = setTimeout(() => reportPrivy("failed", `not ready after ${PRIVY_READY_TIMEOUT_MS / 1000}s`), PRIVY_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
  const onPrivyReady = useCallback((api: PrivyApi | null) => {
    setPrivy(api);
    if (api) reportPrivy("ready");
  }, []);

  useEffect(() => {
    setSession(loadSession());
    // Wallets inject after load; look again shortly so a slow extension still shows up.
    setWallets(installedWallets());
    const late = setTimeout(() => setWallets(installedWallets()), 600);
    return () => clearTimeout(late);
  }, []);

  const connect = useCallback(async (name: WalletName) => {
    setBusy("connect");
    setError(null);
    try {
      setSession(await signInWith(name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const connectPrivy = useCallback(async () => {
    if (!privy) return;
    setBusy("connect");
    setError(null);
    try {
      const signer = await privy.signIn();
      setSession(await signInWithSigner(signer.publicKey, signer.sign, "Privy"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [privy]);

  const signWithdrawal = useCallback(
    async (prepared: string) => {
      if (!session) throw new Error("sign in first");
      if (session.wallet !== "Privy") return signTransactionWith(session, prepared);
      if (!privy) throw new Error("email or X sign-in isn't available in this browser right now");
      return toBase64(await privy.signTransaction(fromBase64(prepared)));
    },
    [session, privy],
  );

  const disconnect = useCallback(async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await signOut(session);
      if (session?.wallet === "Privy") await privy?.logout().catch(() => undefined);
      setSession(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [session, privy]);

  return (
    <WalletContext.Provider
      value={{
        session,
        wallets,
        busy,
        error,
        connect,
        disconnect,
        privyReady: privy !== null,
        privyStatus,
        privyReason,
        connectPrivy,
        signWithdrawal,
      }}
    >
      {children}
      {PrivyBridge ? (
        <Contained onError={(reason) => reportPrivy("failed", reason)}>
          <PrivyBridge appId={PRIVY_APP_ID} onReady={onPrivyReady} />
        </Contained>
      ) : null}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside WalletProvider");
  return value;
}
