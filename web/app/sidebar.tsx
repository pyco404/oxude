"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { installUrl, shortKey, type WalletName } from "@/lib/wallet";
import { useWallet } from "./wallet-context";
import { REWARDS_LINKED } from "./site-header";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/live", label: "Live" },
  { href: "/ladder", label: "Ladder" },
  { href: "/games", label: "Games" },
  // Announces the token before it exists; NEXT_PUBLIC_SHOW_REWARDS=false hides it without a code change.
  ...(REWARDS_LINKED ? [{ href: "/rewards", label: "Rewards" }] : []),
  { href: "/about", label: "About" },
];

/** Which section a path belongs to: match pages live under Live, agent pages under Ladder. */
function sectionOf(path: string): string | null {
  if (path === "/") return "/";
  if (path.startsWith("/m/") || path.startsWith("/live")) return "/live";
  if (path.startsWith("/a/") || path.startsWith("/ladder")) return "/ladder";
  if (path.startsWith("/games")) return "/games";
  if (path.startsWith("/rewards")) return "/rewards";
  if (path.startsWith("/about")) return "/about";
  return null;
}

function Mark({ onClick }: { onClick?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onClick}
      aria-label="Oxude home"
      className="flex items-center gap-2 text-xl font-semibold tracking-[0.2em] text-red"
    >
      {/* The mark on its transparent field; the chrome around it stays flat. */}
      <img src="/oxude-tb.png" alt="" width={28} height={28} className="h-7 w-7" />
      {/* The bull alone in the mobile drawer; the wordmark only in the desktop sidebar. */}
      <span className="hidden lg:inline">OXUDE</span>
    </Link>
  );
}

/**
 * The wallet control, in the mobile top bar and at the foot of the desktop
 * sidebar: "Connect wallet" signed out, the short address signed in. Either opens a small menu rather than acting on one tap,
 * so a stray tap can't sign anyone out.
 */
function WalletControl({ placement = "down" }: { placement?: "down" | "up" }) {
  const { session, wallets, busy, error, connect, disconnect, privyReady, connectPrivy } = useWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Close once signing in or out finishes.
  useEffect(() => setOpen(false), [session]);

  const all: WalletName[] = ["Phantom", "Solflare"];
  return (
    <div ref={box} className={`relative min-w-0 ${placement === "up" ? "w-full" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={session ? `Wallet ${session.ownerId}` : "Connect wallet"}
        className={`h-9 max-w-full truncate border px-3 text-[12px] ${placement === "up" ? "w-full" : ""} ${
          // One look everywhere: dark, red text, a 1px red border.
          session ? "border-line font-mono text-text" : "border-red bg-ink text-red"
        }`}
      >
        {busy === "connect" ? "Waiting…" : session ? shortKey(session.ownerId) : "Connect wallet"}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-40 border border-line bg-panel p-3 text-[12px] leading-5 ${
            placement === "up" ? "bottom-11 left-0 w-full" : "right-0 top-11 w-64"
          }`}
        >
          {session ? (
            <>
              <p className="text-muted">
                Signed in with {session.wallet === "Privy" ? "an email or X wallet" : session.wallet}
              </p>
              <p className="mt-1 break-all font-mono text-[11px]">{session.ownerId}</p>
              <button
                type="button"
                role="menuitem"
                onClick={() => void disconnect()}
                disabled={busy === "disconnect"}
                className="mt-3 w-full border border-line px-3 py-2 text-[13px] text-muted hover:text-red"
              >
                {busy === "disconnect" ? "Signing out…" : "Sign out"}
              </button>
            </>
          ) : (
            <>
              <p className="text-muted">You sign a message, not a transaction. It costs nothing and moves nothing.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {all.map((name) =>
                  wallets.includes(name) ? (
                    <button
                      key={name}
                      type="button"
                      role="menuitem"
                      onClick={() => void connect(name)}
                      disabled={busy === "connect"}
                      className="bg-red px-3 py-2 text-[13px] font-medium text-ink disabled:bg-line disabled:text-muted"
                    >
                      {name}
                    </button>
                  ) : (
                    <a
                      key={name}
                      role="menuitem"
                      href={installUrl(name)}
                      target="_blank"
                      rel="noreferrer"
                      className="border border-line px-3 py-2 text-center text-[13px] text-muted"
                    >
                      Get {name}
                    </a>
                  ),
                )}
              </div>
              {/* A second way in: an embedded wallet from an email or X login, when Privy has loaded. */}
              {privyReady ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void connectPrivy()}
                  disabled={busy === "connect"}
                  className="mt-2 w-full border border-line px-3 py-2 text-[13px] text-text hover:border-red disabled:text-muted"
                >
                  Email or X
                </button>
              ) : null}
            </>
          )}
          {error ? <p className="mt-2 text-red">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Desktop: a fixed sidebar, always there. Below lg: an off-canvas drawer behind
 * a hamburger, closed by the X, the backdrop, Escape or following a link, with
 * the page behind it locked from scrolling.
 */
export function Sidebar() {
  const path = usePathname() ?? "/";
  const active = sectionOf(path);
  const [open, setOpen] = useState(false);

  // Close on navigation.
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {/* Mobile top bar. */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-ink px-4 py-3 lg:hidden">
        {/* The bull alone: the wordmark is in the drawer, and the room goes to the wallet. */}
        <Link href="/" aria-label="Oxude home" className="shrink-0">
          <img src="/oxude-tb.png" alt="" width={28} height={28} className="h-7 w-7" />
        </Link>
        <div className="flex min-w-0 flex-1 justify-end">
          <WalletControl />
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="site-nav"
          className="flex h-9 w-9 shrink-0 flex-col items-center justify-center gap-1.5 border border-line"
        >
          <span className="block h-px w-4 bg-text" />
          <span className="block h-px w-4 bg-text" />
          <span className="block h-px w-4 bg-text" />
        </button>
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 bg-ink/80 lg:hidden" onClick={() => setOpen(false)} aria-hidden />
      ) : null}

      <aside
        id="site-nav"
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-panel transition-transform duration-200 motion-reduce:transition-none lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-60 lg:shrink-0 lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Site"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-4">
          <Mark onClick={() => setOpen(false)} />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="flex h-9 w-9 items-center justify-center border border-line text-lg leading-none text-muted hover:text-text lg:hidden"
          >
            ×
          </button>
        </div>
        <nav className="flex flex-col py-2" aria-label="Sections">
          {NAV.map((item) => {
            const current = active === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`border-l-2 px-4 py-2.5 text-[13px] uppercase tracking-wider ${
                  current ? "border-red bg-panel-2 text-text" : "border-transparent text-muted hover:text-text"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-line p-4">
          <Link href="/" className="block bg-red px-3 py-2 text-center text-[13px] font-medium text-ink">
            Rent an agent
          </Link>
          {/* Phones have it in the top bar; the drawer is this same element, so desktop only. */}
          <div className="mt-2 hidden lg:block">
            <WalletControl placement="up" />
          </div>
          <p className="mt-3 text-[11px] leading-4 text-muted">Devnet. The token has no value.</p>
        </div>
      </aside>
    </>
  );
}
