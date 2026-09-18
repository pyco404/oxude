import { ROUNDS_TO_WIN } from "./round.js";
import type { Action, MatchLog, RoundLog, Seat } from "./types.js";

/**
 * Turns a stored match log into readable prose. It is given the log and the two
 * display names and nothing else, so a transcript cannot leak a brief or a
 * decision table: only what each agent held and what it did.
 */
export type TranscriptNames = { A: string; B: string };

export type Beat =
  | { kind: "bluff-worked"; seat: Seat; edge: number; oppEdge: number; won: number }
  | { kind: "bluff-called"; seat: Seat; edge: number; oppEdge: number; survived: boolean; amount: number }
  | { kind: "fold-with-better-hand"; seat: Seat; edge: number; oppEdge: number; cost: number }
  | { kind: "decided-match"; seat: Seat; amount: number }
  | { kind: "biggest-swing"; seat: Seat; amount: number };

const other = (seat: Seat): Seat => (seat === "A" ? "B" : "A");
const verb: Record<Action, string> = { fold: "folds", call: "calls", raise: "raises" };

/** Who raised this round while holding the weaker hand, if anyone. */
function bluffer(round: RoundLog): Seat | null {
  for (const [i, move] of round.sequence.entries()) {
    const answering = round.sequence[i - 1]?.action === "raise";
    if (move.action !== "raise" || answering) continue;
    if (round.edges[move.seat] < round.edges[other(move.seat)]) return move.seat;
  }
  return null;
}

/** The moments worth calling out in a round. */
export function beatsFor(log: MatchLog, index: number): Beat[] {
  const round = log.rounds[index]!;
  const beats: Beat[] = [];
  const bluff = bluffer(round);

  if (bluff !== null) {
    const opp = other(bluff);
    const edges = { edge: round.edges[bluff], oppEdge: round.edges[opp] };
    if (round.outcome === "one-folded" && round.winner === bluff) {
      beats.push({ kind: "bluff-worked", seat: bluff, ...edges, won: round.bet });
    } else if (round.outcome === "flipped") {
      beats.push({
        kind: "bluff-called",
        seat: bluff,
        ...edges,
        survived: round.winner === bluff,
        amount: round.bet,
      });
    }
  }

  if (round.outcome === "one-folded" && round.winner !== null) {
    const folder = other(round.winner);
    // Folding the better hand is a different mistake from folding a weak one.
    if (round.edges[folder] > round.edges[round.winner] && bluff === null) {
      beats.push({
        kind: "fold-with-better-hand",
        seat: folder,
        edge: round.edges[folder],
        oppEdge: round.edges[round.winner],
        cost: round.bet,
      });
    }
  }

  if (round.winner !== null && round.roundsWon[round.winner] >= ROUNDS_TO_WIN) {
    beats.push({ kind: "decided-match", seat: round.winner, amount: round.bet });
  }

  // Only a raised pot counts as "the biggest", and only a real reversal counts
  // as turning the lead: level to ahead is not a swing.
  const biggest = Math.max(...log.rounds.map((r) => r.bet));
  const isBiggest =
    round.bet === biggest && biggest >= log.stakes.raisedBet && log.rounds.filter((r) => r.bet === biggest).length === 1;
  const before = index > 0 ? log.rounds[index - 1]!.nets.A : 0;
  const swung = before !== 0 && Math.sign(before) !== Math.sign(round.nets.A) && round.nets.A !== 0;
  if (isBiggest && swung && round.winner !== null) {
    beats.push({ kind: "biggest-swing", seat: round.winner, amount: round.bet });
  }
  return beats;
}

function describeBeat(beat: Beat, names: TranscriptNames): string {
  const name = (seat: Seat) => names[seat];
  switch (beat.kind) {
    case "bluff-worked":
      return `A bluff that worked: ${name(beat.seat)} raised on ${beat.edge.toFixed(2)} and ${name(other(beat.seat))} folded the better hand at ${beat.oppEdge.toFixed(2)}, handing over ${beat.won}.`;
    case "bluff-called":
      return beat.survived
        ? `The bluff was called: ${name(beat.seat)} raised on ${beat.edge.toFixed(2)} into ${beat.oppEdge.toFixed(2)} and got away with it, taking ${beat.amount}.`
        : `The bluff was called: ${name(beat.seat)} raised on ${beat.edge.toFixed(2)} into ${beat.oppEdge.toFixed(2)} and paid ${beat.amount} for it.`;
    case "fold-with-better-hand":
      return `${name(beat.seat)} folded the better hand, ${beat.edge.toFixed(2)} against ${beat.oppEdge.toFixed(2)}, for ${beat.cost}.`;
    case "decided-match":
      return `That takes the match for ${name(beat.seat)}.`;
    case "biggest-swing":
      return `The biggest pot of the match, and it turned the lead: ${beat.amount} to ${name(beat.seat)}.`;
  }
}

/**
 * The one line worth putting on a shared card: the most dramatic thing that
 * happened, or null for a match where nothing stood out.
 */
export function headlineFor(log: MatchLog, names: TranscriptNames = log.names): string | null {
  const order: Beat["kind"][] = ["bluff-worked", "bluff-called", "fold-with-better-hand", "biggest-swing"];
  const beats = log.rounds.flatMap((_, i) => beatsFor(log, i));
  for (const kind of order) {
    const beat = beats.find((b) => b.kind === kind);
    if (!beat) continue;
    const who = names[beat.seat];
    switch (beat.kind) {
      case "bluff-worked":
        // Both edges, or "bluffed on 0.60" reads as a strong hand rather than the weaker one.
        return `${who} raised ${beat.edge.toFixed(2)} into ${beat.oppEdge.toFixed(2)} and took it`;
      case "bluff-called":
        return beat.survived
          ? `${who} raised ${beat.edge.toFixed(2)} into ${beat.oppEdge.toFixed(2)}, got called, and won anyway`
          : `${who} raised ${beat.edge.toFixed(2)} into ${beat.oppEdge.toFixed(2)} and got called`;
      case "fold-with-better-hand":
        return `${who} folded the better hand at ${beat.edge.toFixed(2)}`;
      case "biggest-swing":
        return `${who} took the biggest pot and the lead`;
    }
  }
  return null;
}

function describeRound(log: MatchLog, index: number, names: TranscriptNames): string[] {
  const round = log.rounds[index]!;
  const name = (seat: Seat) => names[seat];
  const lines: string[] = [];

  const held = (["A", "B"] as Seat[]).map((s) => `${name(s)} holds ${round.edges[s].toFixed(2)}`).join("; ");
  lines.push(
    round.leader === null
      ? `Round ${round.roundNumber}. ${held}. Both choose at once.`
      : `Round ${round.roundNumber}. ${name(round.leader)} acts first. ${held}.`,
  );
  lines.push("  " + round.sequence.map((m) => `${name(m.seat)} ${verb[m.action]}`).join(", then ") + ".");

  if (round.outcome === "both-folded") {
    lines.push("  Both fold: no flip, no money moves, the round is skipped.");
  } else if (round.outcome === "one-folded") {
    const winner = round.winner!;
    lines.push(`  ${name(other(winner))} pays the ante of ${round.bet} and loses the round.`);
  } else {
    const chance = round.flip!.probabilityAWins;
    const forA = `${(chance * 100).toFixed(0)}%`;
    lines.push(
      `  The coin is flipped for ${round.bet}: ${name("A")} to win it ${forA} of the time. ` +
        `${name(round.winner!)} takes it.`,
    );
  }

  for (const beat of beatsFor(log, index)) lines.push("  " + describeBeat(beat, names));
  lines.push(
    `  Running: ${name("A")} ${signed(round.nets.A)}, ${name("B")} ${signed(round.nets.B)} ` +
      `(rounds ${round.roundsWon.A}-${round.roundsWon.B}).`,
  );
  return lines;
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** The whole match as prose. */
export function renderTranscript(log: MatchLog, names: TranscriptNames = log.names): string {
  const { stakes } = log;
  const header = [
    `${names.A} vs ${names.B}`,
    `${log.turnOrder === "alternating" ? "Alternating turns" : "Simultaneous"}, ` +
      `${log.deal === "independent" ? "independent draws" : "complementary draws"}, ` +
      `ante ${stakes.ante}, bets ${stakes.baseBet} and ${stakes.raisedBet}.`,
  ];

  const body = log.rounds.flatMap((_, i) => [...describeRound(log, i, names), ""]);

  const winner = log.winner;
  const closing = [
    winner === null
      ? `No one reached ${ROUNDS_TO_WIN} rounds: the match ends level at ${log.roundsWon.A}-${log.roundsWon.B}.`
      : `${names[winner]} wins the match ${log.roundsWon[winner]}-${log.roundsWon[other(winner)]}.`,
    `Final: ${names.A} ${signed(log.nets.A)}, ${names.B} ${signed(log.nets.B)}.`,
  ];
  return [...header, "", ...body, ...closing].join("\n");
}
