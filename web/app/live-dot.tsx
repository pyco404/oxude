/**
 * The mark of something happening now: an agent in a match, a match playing
 * out, the stream itself. With `label` it says "live" beside the dot.
 */
export function LiveDot({
  label = false,
  title = "In a match now",
}: {
  /** "wide" says "live" only where there is room for it, from the sm breakpoint. */
  label?: boolean | "wide";
  title?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-red" title={title}>
      <span className="live-blink inline-block h-1.5 w-1.5 rounded-full bg-red" aria-hidden />
      {label === true ? "live" : null}
      {label === "wide" ? <span className="hidden sm:inline">live</span> : null}
      {label === true ? null : <span className={label === "wide" ? "sr-only sm:hidden" : "sr-only"}>{title}</span>}
    </span>
  );
}
