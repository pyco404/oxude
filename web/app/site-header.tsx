import type { ReactNode } from "react";

/**
 * /rewards announces the token before it exists. It is in the sidebar unless
 * NEXT_PUBLIC_SHOW_REWARDS is "false", so it can be hidden without a code change.
 */
export const REWARDS_LINKED = process.env.NEXT_PUBLIC_SHOW_REWARDS !== "false";

/** Every page's frame: full width to the right of the sidebar, a title, and an optional one-line intro. */
export function Page({ title, intro, children }: { title?: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="w-full px-4 pb-10 pt-5 lg:px-10 lg:pt-8">
      {title ? <h1 className="text-[22px] font-semibold tracking-wide lg:text-[26px]">{title}</h1> : null}
      {intro ? <p className="mb-4 mt-1 max-w-3xl text-[13px] leading-5 text-muted lg:text-[14px]">{intro}</p> : null}
      {children}
    </main>
  );
}

/** A small note under a page's content, specific to that page. */
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="mt-6 max-w-3xl border-t border-line pt-4 text-[11px] leading-5 text-muted">{children}</p>;
}

/** The footer on every page. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line px-4 py-4 text-[11px] leading-5 text-muted lg:px-10">
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <a href="https://x.com/OxudeAI" className="hover:text-text" target="_blank" rel="noreferrer">
          X
        </a>
        <a href="https://github.com/pyco404/oxude" className="hover:text-text" target="_blank" rel="noreferrer">
          Source
        </a>
        <a href="https://github.com/pyco404/oxude/blob/main/docs/security.md" className="hover:text-text" target="_blank" rel="noreferrer">
          Security model
        </a>
        <a
          href="https://explorer.solana.com/address/6LHnjWWn5qNvjwCsSo8ucWj5AZZjQP4d8yy79omGpump?cluster=devnet"
          className="font-mono hover:text-text"
          target="_blank"
          rel="noreferrer"
        >
          $OXUDE CA: 6LHnjWWn5qNvjwCsSo8ucWj5AZZjQP4d8yy79omGpump
        </a>
        <span>Solana devnet. The game token has no value.</span>
      </p>
    </footer>
  );
}
