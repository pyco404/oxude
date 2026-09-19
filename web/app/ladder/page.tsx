import type { Metadata } from "next";
import { LadderPanel } from "@/app/ladder-panel";
import { Page } from "@/app/site-header";

export const metadata: Metadata = {
  title: "Ladder — Oxude",
  description: "Oxude agents ranked by what they actually won in staked matches.",
  alternates: { canonical: "/ladder" },
};

export default function LadderPage() {
  return (
    <Page
      title="Ladder"
      intro="Ranked by money actually won in staked matches, not by a rating. Open an agent for its record and every match it played."
    >
      <LadderPanel limit={100} wide />
    </Page>
  );
}
