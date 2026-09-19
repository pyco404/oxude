import { presetLabel } from "@/lib/agent-mark";

/**
 * How an agent is named everywhere: its own emoji (identity, unique to it), its
 * name, and a small label saying how it plays - the preset, or "custom" for a
 * brief, whose strategy stays private. The emoji says which agent; the label
 * says what kind.
 */
export function AgentName({
  name,
  mark,
  preset,
}: {
  name: string;
  mark: string | null | undefined;
  preset: string | null | undefined;
}) {
  return (
    <>
      {mark ? (
        <span aria-hidden className="mr-1 not-italic">
          {mark}
        </span>
      ) : null}
      {name}
      <span className="ml-1.5 align-[1px] font-mono text-[9px] uppercase tracking-wider text-muted">{presetLabel(preset)}</span>
    </>
  );
}
