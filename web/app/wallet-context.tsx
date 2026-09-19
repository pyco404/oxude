"use client";

import dynamic from "next/dynamic";
import { Component, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  installedWallets,
  loadSession,
  signInWith,
  signInWithSigner,
  signOut,
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
const PrivyBridge = PRIVY_APP_ID ? dynamic(() => import("./privy-bridge"), { ssr: false, loading: () => null }) : null;

class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Privy failed to load; wallet extensions still work.", error);
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
  connectPrivy: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

/** One sign-in for the whole site, so the top bar and the page agree on who is signed in. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [wallets, setWallets] = useState<WalletName[]>([]);
  const [busy, setBusy] = useState<WalletState["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [privy, setPrivy] = useState<PrivyApi | null>(null);

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
      value={{ session, wallets, busy, error, connect, disconnect, privyReady: privy !== null, connectPrivy }}
    >
      {children}
      {PrivyBridge ? (
        <Contained>
          <PrivyBridge appId={PRIVY_APP_ID} onReady={setPrivy} />
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
