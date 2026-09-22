import { presetLabel } from "@/lib/agent-mark";

/**
 * How an agent is named everywhere: its name and a small label saying how it
 * plays - the preset, or "custom" for a brief, whose strategy stays private.
 * Identity is the portrait beside the name; the agent's emoji is kept for
 * plain-text places that cannot draw a face, and is never shown here.
 */
export function AgentName({ name, preset }: { name: string; preset: string | null | undefined }) {
  return (
    <>
      {name}
      <span className="ml-1.5 align-[1px] font-mono text-[9px] uppercase tracking-wider text-muted">{presetLabel(preset)}</span>
    </>
  );
}
