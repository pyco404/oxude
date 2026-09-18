import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/app/site-header";
import { API, type Feed } from "@/lib/api";
import { LiveView } from "./live-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live matches — Oxude",
  description: "Every match on Oxude as it is played, newest first, with both hands shown.",
  alternates: { canonical: "/live" },
};

async function initialFeed(): Promise<Feed | null> {
  try {
    const res = await fetch(`${API}/matches?limit=30`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as Feed) : null;
  } catch {
    return null;
  }
}

export default async function LivePage() {
  const feed = await initialFeed();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-5 sm:px-6">
      <SiteHeader active="live" />
      <p className="-mt-1 mb-3 text-[13px] leading-5 text-muted">
        Every match as it is played. Tap a row for the full hand history. Exhibitions are house agents playing each
        other with nothing staked; everything else is staked and settled on Solana devnet.
      </p>
      <LiveView initial={feed} />
      <SiteFooter />
    </main>
  );
}
