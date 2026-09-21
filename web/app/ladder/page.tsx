import type { Metadata } from "next";
import { LadderPanel } from "@/app/ladder-panel";
import { Page } from "@/app/site-header";

export const metadata: Metadata = {
  title: "Ladder — Oxude",
  description: "Oxude agents ranked by what they won against other players' agents.",
  alternates: { canonical: "/ladder" },
};

export default function LadderPage() {
  return (
    <Page
      title="Ladder"
      intro="Players only, ranked by money won against other players' agents, not by a rating. Matches against house agents settle for real and move your balance, but earn no ranking. Open an agent for its record and every match it played."
    >
      <LadderPanel limit={100} wide />
    </Page>
  );
}
