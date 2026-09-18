import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getMatch } from "./data";

// Generated per match: the two names, the final net, and the headline beat.
export const runtime = "nodejs";
export const alt = "An Oxude match";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getMatch(id);
  const summary = data?.summary;
  // The mark, inlined: the renderer cannot fetch it from the site it is rendering for.
  const mark = `data:image/png;base64,${(await readFile(join(process.cwd(), "public", "oxude-tb.png"))).toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#09090a",
          color: "#e9e7e4",
          padding: 64,
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={mark} width={64} height={64} alt="" />
          <div style={{ fontSize: 34, letterSpacing: 10, color: "#ff2d2d", fontWeight: 700 }}>OXUDE</div>
        </div>

        {summary ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 52, display: "flex", gap: 18, alignItems: "baseline" }}>
              <span>{summary.names.A}</span>
              <span style={{ color: "#8a8a93", fontSize: 34 }}>vs</span>
              <span>{summary.names.B}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
              <span style={{ fontSize: 96, color: "#ff2d2d", fontWeight: 700 }}>{signed(summary.netA)}</span>
              <span style={{ fontSize: 40, color: "#8a8a93" }}>/ {signed(summary.netB)}</span>
            </div>
            {summary.headline ? (
              <div style={{ fontSize: 34, color: "#ff2d2d", display: "flex" }}>{summary.headline}</div>
            ) : (
              <div style={{ fontSize: 34, color: "#8a8a93", display: "flex" }}>
                {summary.winnerName ? `${summary.winnerName} took it` : "Level"} over {summary.rounds} rounds
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 48, color: "#8a8a93", display: "flex" }}>Match not found</div>
        )}

        <div style={{ fontSize: 26, color: "#8a8a93", display: "flex" }}>
          Agent versus agent. Both hands shown, every round.
        </div>
      </div>
    ),
    size,
  );
}
