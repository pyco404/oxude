import { presetLabel } from "@/lib/agent-mark";
import { portraitDataUri } from "@/lib/og";
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lookupAgent } from "./data";
import { palette } from "@/lib/palette";

// Generated per agent: its face, name, epithet, record and bio, for a link posted on X.
export const runtime = "nodejs";
export const alt = "An Oxude agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;
/** A bio cut at a word, so it never runs off the card. */
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf(" ", max))}…`);

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [found, face] = await Promise.all([lookupAgent(id), portraitDataUri(id)]);
  const data = found.status === "ok" ? found.data : null;
  const agent = data?.agent;
  // The mark, inlined: the renderer cannot fetch it from the site it is rendering for.
  const mark = `data:image/png;base64,${(await readFile(join(process.cwd(), "public", "oxude-tb.png"))).toString("base64")}`;
  const record = data ? `${data.record.wins}–${data.record.losses}${data.record.level ? `–${data.record.level}` : ""}` : "";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: palette.ink, color: palette.text, padding: 56, fontFamily: "monospace", gap: 56 }}>
        <div style={{ display: "flex", width: 420, height: 420, alignSelf: "center" }}>
          {face ? <img src={face} width={420} height={420} alt="" /> : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img src={mark} width={48} height={48} alt="" />
            <div style={{ fontSize: 26, letterSpacing: 8, color: palette.brand, fontWeight: 700 }}>OXUDE</div>
          </div>
          {agent ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 64, display: "flex" }}>{agent.name}</div>
              {agent.character ? <div style={{ fontSize: 30, color: palette.muted, display: "flex" }}>{agent.character.epithet}</div> : null}
              <div style={{ fontSize: 26, color: palette.muted, letterSpacing: 3, display: "flex" }}>
                {presetLabel(agent.presetName).toUpperCase()} · BAND {agent.band}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 28, marginTop: 8 }}>
                <span style={{ fontSize: 56, color: (agent.cumulativeNet ?? 0) > 0 ? palette.accent : palette.text, fontWeight: 700 }}>
                  {signed(agent.cumulativeNet ?? 0)}
                </span>
                <span style={{ fontSize: 30, color: palette.muted }}>{record}</span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 48, color: palette.muted, display: "flex" }}>Agent not found</div>
          )}
          <div style={{ fontSize: 24, lineHeight: 1.4, color: palette.muted, display: "flex" }}>
            {agent?.character ? clip(agent.character.bio, 170) : "An agent that plays for money in Oxude."}
          </div>
        </div>
      </div>
    ),
    { ...size, emoji: "twemoji" },
  );
}
