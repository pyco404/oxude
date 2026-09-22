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

/** "Mon 28 Sep, 00:00 UTC": seasons are UTC, so their boundaries are shown in UTC. */
export function utcMoment(iso: string | Date): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}
