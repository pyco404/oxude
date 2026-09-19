import { agentMark } from "@/lib/agent-mark";
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
          (() => {
            // Lead with whoever came out ahead on money - the number a reader
            // reads first must be the positive one, or a win looks like a loss.
            const aheadSeat = summary.netA > 0 ? "A" : summary.netB > 0 ? "B" : null;
            // Each name carries its playstyle mark, as everywhere else on the site.
            const marked = (seat: "A" | "B") =>
              `${agentMark(seat === "A" ? data?.match.agentA.presetName : data?.match.agentB.presetName).emoji} ${summary.names[seat]}`;
            const ahead = aheadSeat === null ? null : marked(aheadSeat);
            const behind = aheadSeat === null ? null : marked(aheadSeat === "A" ? "B" : "A");
            const amount = aheadSeat === "A" ? summary.netA : summary.netB;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                {ahead ? (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: 56, display: "flex" }}>{ahead}</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
                      <span style={{ fontSize: 104, color: "#ff2d2d", fontWeight: 700 }}>{signed(amount)}</span>
                      <span style={{ fontSize: 38, color: "#8a8a93" }}>from {behind}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontSize: 52, display: "flex", gap: 18, alignItems: "baseline" }}>
                      <span>{marked("A")}</span>
                      <span style={{ color: "#8a8a93", fontSize: 34 }}>vs</span>
                      <span>{marked("B")}</span>
                    </div>
                    <div style={{ fontSize: 96, color: "#8a8a93", fontWeight: 700, display: "flex" }}>Level</div>
                  </div>
                )}
                {summary.headline ? (
                  <div style={{ fontSize: 34, color: "#ff2d2d", display: "flex" }}>{summary.headline}</div>
                ) : (
                  <div style={{ fontSize: 34, color: "#8a8a93", display: "flex" }}>Over {summary.rounds} rounds</div>
                )}
              </div>
            );
          })()
        ) : (
          <div style={{ fontSize: 48, color: "#8a8a93", display: "flex" }}>Match not found</div>
        )}

        <div style={{ fontSize: 26, color: "#8a8a93", display: "flex" }}>
          {data?.match.exhibition
            ? "Exhibition between house agents. Nothing staked."
            : "Agent versus agent. Both hands shown, every round."}
        </div>
      </div>
    ),
    // The image renderer has no emoji font of its own: draw emoji as Twemoji images.
    { ...size, emoji: "twemoji" },
  );
}
