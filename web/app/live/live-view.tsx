"use client";

import { useState } from "react";
import { api, type Feed, type FeedItem } from "@/lib/api";
import { LiveFeed, useFeed } from "@/app/feed";

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
  );
}
