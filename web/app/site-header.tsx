import type { ReactNode } from "react";

export type Section = "live" | "ladder" | "how" | null;

const LINKS: { key: Exclude<Section, null>; href: string; label: string }[] = [
  { key: "live", href: "/live", label: "Live" },
  { key: "ladder", href: "/ladder", label: "Ladder" },
  { key: "how", href: "/how", label: "How it works" },
];

/** The same header on every page: the mark, the three sections, and an optional slot (the wallet button on home). */
export function SiteHeader({ active = null, right }: { active?: Section; right?: ReactNode }) {
  return (
    <header className="mb-4">
      <div className="flex items-center justify-between gap-2">
        <a href="/" className="flex items-center gap-2 text-2xl font-semibold tracking-[0.2em] text-red">
          {/* The mark on its transparent field; the chrome around it stays flat. */}
          <img src="/oxude-tb.png" alt="" width={32} height={32} className="h-8 w-8" />
          OXUDE
        </a>
        {right}
      </div>
      <nav className="mt-3 flex border border-line" aria-label="Sections">
        {LINKS.map((l) => (
          <a
            key={l.key}
            href={l.href}
            aria-current={active === l.key ? "page" : undefined}
            className={`flex-1 border-r border-line px-2 py-2 text-center text-[12px] uppercase tracking-wider last:border-r-0 ${
              active === l.key ? "bg-red font-medium text-ink" : "bg-panel text-muted hover:text-text"
            }`}
          >
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

/** The footer every page ends with. */
export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="mt-8 border-t border-line pt-4 text-[11px] leading-5 text-muted">
      {children}
      <p className={children ? "mt-2" : ""}>
        <a href="https://x.com/OxudeAI" className="text-red" target="_blank" rel="noreferrer">
          @OxudeAI
        </a>{" "}
        on X ·{" "}
        <a href="https://github.com/pyco404/oxude" className="text-red" target="_blank" rel="noreferrer">
          source
        </a>
      </p>
    </footer>
  );
}
