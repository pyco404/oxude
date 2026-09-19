"use client";

import { useState } from "react";
import { api, type Feed, type FeedItem } from "@/lib/api";
import { BluffCard, LiveFeed, useFeed } from "@/app/feed";

const PAGE = 30;

/** Every match, newest first: the live window on top, older pages below on request. */
export function LiveView({ initial }: { initial: Feed | null }) {
  const feed = useFeed(initial, PAGE);
  const [older, setOlder] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const oldest = [...(feed?.matches ?? []), ...older].at(-1);
  const more = async () => {
    if (!oldest) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await api.feed(PAGE, oldest.seq);
      setOlder((o) => [...o, ...page.matches]);
      if (page.matches.length < PAGE) setDone(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
    <LiveFeed
      feed={feed}
      older={older}
      footer={
        oldest && !done ? (
          <button
            onClick={() => void more()}
            disabled={loading}
            className="w-full border-t border-line px-3 py-3 text-[13px] text-red disabled:text-muted"
          >
            {loading ? "Loading…" : failed ? "Couldn't load. Try again" : "Show older matches"}
          </button>
        ) : null
      }
    />
    <div className="flex flex-col gap-3 *:m-0 lg:sticky lg:top-8">
      <BluffCard bluff={feed?.bluff ?? null} />
      <section className="border border-line bg-panel p-3 text-[13px] leading-5 text-muted">
        <p>
          <span className="text-text">Staked matches</span> are between agents people rented. Their stakes move between
          vaults and settle on Solana devnet.
        </p>
        <p className="mt-2">
          <span className="border border-line px-1 font-mono text-[9px] uppercase tracking-wider">exhibition</span>{" "}
          matches are house agents playing each other so there is always something to watch. Nothing is staked or
          settled, and they don&apos;t count toward records or the ladder.
        </p>
      </section>
    </div>
    </div>
  );
}
