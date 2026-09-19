/**
 * The playstyle label shown beside every agent's name: its preset, or "custom"
 * for an agent rented from a brief. Identity is the agent's own emoji, which the
 * API assigns (src/marks.ts); this is behaviour.
 */
export function presetLabel(presetName: string | null | undefined): string {
  return presetName ? presetName.toLowerCase() : "custom";
}
