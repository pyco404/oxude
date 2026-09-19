"use client";

import { useWallet } from "./wallet-context";

/**
 * The email-or-X way in, wherever sign-in is offered. It says what state Privy
 * is in, so a browser where it can't load shows why instead of just lacking it.
 * Off entirely when Privy isn't configured.
 */
export function PrivyOption({ label = "Email or X", menu = false }: { label?: string; menu?: boolean }) {
  const { privyStatus, privyReason, busy, connectPrivy } = useWallet();
  if (privyStatus === "off") return null;
  if (privyStatus === "failed") {
    return (
      <p className="mt-2 text-[11px] leading-4 text-muted" role="status">
        Email or X sign-in couldn&apos;t load in this browser{privyReason ? ` (${privyReason})` : ""}. The wallets above
        still work.
      </p>
    );
  }
  const loading = privyStatus === "loading";
  return (
    <button
      type="button"
      role={menu ? "menuitem" : undefined}
      onClick={() => void connectPrivy()}
      disabled={loading || busy === "connect"}
      className="mt-2 w-full border border-line px-3 py-2 text-[13px] text-text hover:border-red disabled:text-muted disabled:hover:border-line"
    >
      {loading ? `${label} · loading…` : label}
    </button>
  );
}
