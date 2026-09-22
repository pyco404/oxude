/** "4 min", "1 h 12 min", "5 d 7 h": a duration, rounded to what a person reads. */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m ? `${hours} h ${m} min` : `${hours} h`;
  }
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

/**
 * A moment in the viewer's own time, with UTC beside it: seasons turn over at
 * 00:00 UTC, which is rarely anyone's midnight. "Mon 28 Sep, 1:00 AM your time
 * (00:00 UTC)", with the UTC day named too when it isn't the same day locally
 * ("Sun 27 Sep, 8:00 PM your time (Mon 00:00 UTC)"). A viewer on UTC gets it once.
 *
 * Uses the browser's zone and locale, so call it only in the browser: a server
 * render would show the server's time.
 */
export function localMoment(iso: string | Date): string {
  const d = new Date(iso);
  const local = d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const utcTime = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const utcDay = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const localDay = d.toLocaleDateString("en-GB", { weekday: "short" });
  if (d.getTimezoneOffset() === 0) return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}, ${utcTime} UTC`;
  return `${local} your time (${utcDay === localDay ? "" : `${utcDay} `}${utcTime} UTC)`;
}
