"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { installedWallets, loadSession, signInWith, signOut, type Session, type WalletName } from "@/lib/wallet";

type WalletState = {
  session: Session | null;
  /** Wallet extensions found in this browser. */
  wallets: WalletName[];
  busy: "connect" | "disconnect" | null;
  error: string | null;
  connect: (name: WalletName) => Promise<void>;
  disconnect: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

/** One sign-in for the whole site, so the top bar and the page agree on who is signed in. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [wallets, setWallets] = useState<WalletName[]>([]);
  const [busy, setBusy] = useState<WalletState["busy"]>(null);
  const [error, setError] = useState<string | null>(null);

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

  const disconnect = useCallback(async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await signOut(session);
      setSession(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [session]);

  return (
    <WalletContext.Provider value={{ session, wallets, busy, error, connect, disconnect }}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside WalletProvider");
  return value;
}
