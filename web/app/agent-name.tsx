import { agentMark } from "@/lib/agent-mark";

/** An agent's playstyle mark, for beside its name. Labelled for screen readers. */
export function AgentMark({ preset, className = "" }: { preset: string | null | undefined; className?: string }) {
  const { emoji, label } = agentMark(preset);
  return (
    <span role="img" aria-label={label} title={label} className={`mr-1 not-italic ${className}`}>
      {emoji}
    </span>
  );
}
