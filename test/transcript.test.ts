import { describe, expect, it } from "vitest";
import {
  beatsFor,
  headlineFor,
  makeStrategy,
  playMatch,
  PRESETS,
  renderTranscript,
  type MatchLog,
} from "../src/index.js";

const NAMES = { A: "Mirage-77", B: "Anchor-12" };

/** Searches seeds for a match whose beats include `kind`. */
function findMatch(kind: string, a = PRESETS.Mirage, b = PRESETS.Anchor): MatchLog {
  for (let seed = 1; seed < 5000; seed++) {
    const log = playMatch(a, b, { seed });
    if (log.rounds.some((_, i) => beatsFor(log, i).some((beat) => beat.kind === kind))) return log;
  }
  throw new Error(`no match found with a ${kind} beat`);
}

describe("transcripts", () => {
  it("names a bluff that worked, and what it took", () => {
    const log = findMatch("bluff-worked");
    const beat = log.rounds.flatMap((_, i) => beatsFor(log, i)).find((b) => b.kind === "bluff-worked")!;
    expect(beat.kind === "bluff-worked" && beat.edge < beat.oppEdge).toBe(true);
    const text = renderTranscript(log, NAMES);
    expect(text).toContain("A bluff that worked");
    expect(text).toMatch(/folded the better hand at 0\.\d\d, handing over \d+/);
  });

  it("names a bluff that was called, and whether it survived", () => {
    const log = findMatch("bluff-called");
    const text = renderTranscript(log, NAMES);
    expect(text).toContain("The bluff was called");
    expect(text).toMatch(/paid \d+ for it|got away with it/);
  });

  it("calls out a fold with the better hand only when no bluff explains it", () => {
    // A raiser holding the better hand whose opponent folds is not a bluff.
    const timid = makeStrategy({
      foldBelow: 0.75,
      raiseAtOrAbove: 1,
      bluffAtOrBelow: null,
      bluffUnderPressure: false,
      pressureFoldBelow: null,
      foldToRaiseBelow: 0.75,
    });
    const log = playMatch(PRESETS.Bully, timid, { seed: 3 });
    const beats = log.rounds.flatMap((_, i) => beatsFor(log, i));
    const folds = beats.filter((b) => b.kind === "fold-with-better-hand");
    for (const beat of folds) {
      expect(beat.kind === "fold-with-better-hand" && beat.edge > beat.oppEdge).toBe(true);
    }
    // Where a bluff is the explanation, the bluff beat is used instead.
    const bluffRounds = log.rounds.filter((_, i) => beatsFor(log, i).some((b) => b.kind === "bluff-worked"));
    for (const [i] of bluffRounds.entries()) {
      const kinds = beatsFor(log, i).map((b) => b.kind);
      expect(kinds.includes("fold-with-better-hand") && kinds.includes("bluff-worked")).toBe(false);
    }
  });

  it("marks the round that decided the match", () => {
    const log = playMatch(PRESETS.Hammer, PRESETS.Bully, { seed: 11 });
    const text = renderTranscript(log, NAMES);
    if (log.winner) {
      expect(text).toContain("takes the match for");
      const last = beatsFor(log, log.rounds.length - 1).map((b) => b.kind);
      expect(last).toContain("decided-match");
    }
  });

  it("only calls a raised pot the biggest, and only a real reversal a swing", () => {
    for (let seed = 1; seed < 300; seed++) {
      const log = playMatch(PRESETS.Mirage, PRESETS.Bully, { seed });
      log.rounds.forEach((round, i) => {
        for (const beat of beatsFor(log, i)) {
          if (beat.kind !== "biggest-swing") continue;
          expect(round.bet).toBeGreaterThanOrEqual(log.stakes.raisedBet);
          const before = i > 0 ? log.rounds[i - 1]!.nets.A : 0;
          expect(before).not.toBe(0);
          expect(Math.sign(before)).not.toBe(Math.sign(round.nets.A));
        }
      });
    }
  });

  it("reports every round, the running score and the result", () => {
    const log = playMatch(PRESETS.Anchor, PRESETS.Mirage, { seed: 42 });
    const text = renderTranscript(log, NAMES);
    for (const round of log.rounds) expect(text).toContain(`Round ${round.roundNumber}.`);
    expect(text).toContain(`Final: ${NAMES.A} ${log.nets.A >= 0 ? "+" : ""}${log.nets.A}`);
    expect(text.split("\n")[0]).toBe(`${NAMES.A} vs ${NAMES.B}`);
    if (log.winner === null) expect(text).toContain("ends level");
    else expect(text).toContain(`${NAMES[log.winner]} wins the match`);
  });

  it("shows actions and holdings, and nothing about how an agent was built", () => {
    const log = playMatch(PRESETS.Mirage, PRESETS.Bully, { seed: 9 });
    const text = renderTranscript(log, NAMES);
    // Both holdings are public after the fact, like a hand history.
    for (const round of log.rounds) {
      expect(text).toContain(round.edges.A.toFixed(2));
      expect(text).toContain(round.edges.B.toFixed(2));
    }
    // Nothing about briefs, tables, presets or seeds.
    for (const leak of ["brief", "policy", "preset", "seed", "foldBelow", "raiseAtOrAbove", "bluffAtOrBelow", "pot-odds"]) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("headlines", () => {
  it("picks the most dramatic beat, naming both edges on a bluff", () => {
    const log = findMatch("bluff-worked");
    const line = headlineFor(log, NAMES)!;
    expect(line).toMatch(/raised 0\.\d\d into 0\.\d\d and took it/);
  });

  it("prefers a bluff over a swing, and is null when nothing stood out", () => {
    let sawNull = false;
    for (let seed = 1; seed < 400; seed++) {
      const log = playMatch(PRESETS.Anchor, PRESETS.Hammer, { seed });
      const kinds = log.rounds.flatMap((_, i) => beatsFor(log, i).map((b) => b.kind));
      const line = headlineFor(log, NAMES);
      const dramatic = kinds.some((k) => ["bluff-worked", "bluff-called", "fold-with-better-hand", "biggest-swing"].includes(k));
      expect(line === null).toBe(!dramatic);
      if (line === null) sawNull = true;
      if (kinds.includes("bluff-worked")) expect(line).toMatch(/took it$/);
    }
    expect(sawNull).toBe(true);
  });
});
