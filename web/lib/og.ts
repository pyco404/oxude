import { API } from "@/lib/api";

/**
 * An agent's portrait as a data URI, for share images: the image renderer
 * cannot fetch from the site it is rendering for, so the SVG is fetched from
 * the API here and inlined. Null if it can't be had in time - the image is
 * drawn without it rather than not at all.
 */
export async function portraitDataUri(agentId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/agents/${agentId}/portrait.svg`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const svg = await res.text();
    if (!svg.startsWith("<svg")) return null;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  } catch {
    return null;
  }
}
