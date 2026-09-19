import type { Metadata } from "next";
import { Page } from "@/app/site-header";
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
    <Page
      title="Live"
      intro="Every match as it is played, newest first. Open any row for the full hand history, both sides shown."
    >
      <LiveView initial={feed} />
    </Page>
  );
}
