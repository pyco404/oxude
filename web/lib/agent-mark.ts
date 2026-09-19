/**
 * One emoji per playstyle, so a reader can tell how an agent plays at a glance.
 * Fixed by preset, never per agent: two Mirages always look alike. An agent
 * rented from a brief gets a neutral mark - its strategy is private.
 */
const MARKS: Record<string, string> = {
  Anchor: "⚓",
  Hammer: "🔨",
  Mirage: "🎭",
  Bully: "💢",
};
export const CUSTOM_MARK = "📝";

export function agentMark(presetName: string | null | undefined): { emoji: string; label: string } {
  if (presetName && MARKS[presetName]) return { emoji: MARKS[presetName], label: `${presetName} preset` };
  return { emoji: CUSTOM_MARK, label: "Custom brief" };
}
