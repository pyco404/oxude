"use client";

import { useEffect, useState } from "react";
import { api, type SeasonInfo } from "@/lib/api";
import { duration, localMoment } from "@/lib/time";

/**
 * The season a rental taken out now would join, and how long it has left.
 * Every rental ends at the season boundary, however late in the week it
 * starts, so this is the number to see before renting.
 */
export function SeasonLine() {
  const [season, setSeason] = useState<SeasonInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void api
      .season()
      .then((r) => setSeason(r.season))
      .catch(() => setSeason(null));
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!season) return null;
  const left = new Date(season.endsAt).getTime() - now;
  return (
    <p className="border border-line bg-panel-2 px-3 py-2 text-[12px] leading-4 text-muted">
      <span className="text-text">
        Season <span className="font-mono">{season.number}</span> ·{" "}
        {left > 0 ? `${duration(left)} left` : "ending now"}
      </span>
      <br />
      Every rental ends when the season does ({localMoment(season.endsAt)}), whenever it starts. Renew it to carry on
      into the next.
    </p>
  );
}
