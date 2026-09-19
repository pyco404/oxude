"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
    <a href="/" onClick={onClick} className="flex items-center gap-2 text-xl font-semibold tracking-[0.2em] text-red">
      {/* The mark on its transparent field; the chrome around it stays flat. */}
      <img src="/oxude-tb.png" alt="" width={28} height={28} className="h-7 w-7" />
      OXUDE
    </a>
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
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-ink px-4 py-3 lg:hidden">
        <Mark />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="site-nav"
          className="flex h-9 w-9 flex-col items-center justify-center gap-1.5 border border-line"
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
              <a
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`border-l-2 px-4 py-2.5 text-[13px] uppercase tracking-wider ${
                  current ? "border-red bg-panel-2 text-text" : "border-transparent text-muted hover:text-text"
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-line p-4">
          <a href="/" className="block bg-red px-3 py-2 text-center text-[13px] font-medium text-ink">
            Rent an agent
          </a>
          <p className="mt-3 text-[11px] leading-4 text-muted">Devnet. The token has no value.</p>
        </div>
      </aside>
    </>
  );
}
