import { presetLabel } from "@/lib/agent-mark";
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getMatch } from "./data";
import { portraitDataUri } from "@/lib/og";

// Generated per match: both faces, the two names, the final net, and the headline beat.
export const runtime = "nodejs";
export const alt = "An Oxude match";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getMatch(id);
  const summary = data?.summary;
  // Both faces, the one that came out ahead first.
  const first = summary && summary.netB > 0 ? data?.match.agentB : data?.match.agentA;
  const second = first === data?.match.agentA ? data?.match.agentB : data?.match.agentA;
  const faces = await Promise.all([first, second].map((a) => (a ? portraitDataUri(a.id) : Promise.resolve(null))));
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <img src={mark} width={64} height={64} alt="" />
            <div style={{ fontSize: 34, letterSpacing: 10, color: "#ff2d2d", fontWeight: 700 }}>OXUDE</div>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            {faces.map((f, i) => (f ? <img key={i} src={f} width={170} height={170} alt="" /> : null))}
          </div>
        </div>

        {summary ? (
          (() => {
            // Lead with whoever came out ahead on money - the number a reader
            // reads first must be the positive one, or a win looks like a loss.
            const aheadSeat = summary.netA > 0 ? "A" : summary.netB > 0 ? "B" : null;
            // Each name carries its playstyle mark, as everywhere else on the site.
            const side = (seat: "A" | "B") => (seat === "A" ? data?.match.agentA : data?.match.agentB);
            const marked = (seat: "A" | "B") => `${side(seat)?.mark ? `${side(seat)!.mark} ` : ""}${summary.names[seat]}`;
            const label = (seat: "A" | "B") => presetLabel(side(seat)?.presetName);
            const ahead = aheadSeat === null ? null : marked(aheadSeat);
            const behind = aheadSeat === null ? null : marked(aheadSeat === "A" ? "B" : "A");
            const amount = aheadSeat === "A" ? summary.netA : summary.netB;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                {ahead ? (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: 56, display: "flex", alignItems: "baseline", gap: 18 }}>
                      <span>{ahead}</span>
                      <span style={{ fontSize: 22, color: "#8a8a93", letterSpacing: 3 }}>{label(aheadSeat!).toUpperCase()}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
                      <span style={{ fontSize: 104, color: "#ff2d2d", fontWeight: 700 }}>{signed(amount)}</span>
                      <span style={{ fontSize: 38, color: "#8a8a93" }}>
                        from {behind} · {label(aheadSeat === "A" ? "B" : "A")}
                      </span>
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
