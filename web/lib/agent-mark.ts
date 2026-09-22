/**
 * The playstyle label shown beside every agent's name: its preset, or "custom"
 * for an agent rented from a brief. Identity is the agent's portrait, drawn from
 * its id (src/character/portrait.ts); this is behaviour. The agent's emoji
 * (src/marks.ts) is no longer drawn where a portrait is - it is kept for
 * plain-text places that have no room for a face.
 */
export function presetLabel(presetName: string | null | undefined): string {
  return presetName ? presetName.toLowerCase() : "custom";
}
