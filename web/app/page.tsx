import Home from "@/app/home";
import { API, type Feed } from "@/lib/api";

// Rendered per request, so the first paint already shows matches being played.
export const dynamic = "force-dynamic";

async function initialFeed(): Promise<Feed | null> {
  try {
    const res = await fetch(`${API}/matches?limit=12`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as Feed) : null;
  } catch {
    // The page still works without it; the client fetches the feed itself.
    return null;
  }
}

export default async function Page() {
  return <Home initialFeed={await initialFeed()} />;
}
