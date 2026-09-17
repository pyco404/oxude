import { readFileSync } from "node:fs";
import {
  advanceState,
  dealOutcomes,
  decideRound,
  expectedNet,
  freezeStakes,
  initialState,
  isMatchOver,
  makeStrategy,
  PRESET_NAMES,
  resolveActions,
  seatAveragedNet,
  type Action,
  type Agent,
  type MatchState,
  type PresetName,
  type Seat,
  type Stakes,
  type StrategyParams,
  type Deal,
  type TurnOrder,
  winProbabilityA,
} from "../src/index.js";
import { analyse, fmt, NAMES, TIE } from "./analysis.js";

// Deep inspection of one preset set: bluff outcomes, position value, matrix, ante sweep.
// Usage: npm run inspect -- <sets.json> [--index 0]   (sets.json as written by search --save)

const file = process.argv[2];
if (!file) throw new Error("usage: inspect <sets.json> [--index n]");
const idxFlag = process.argv.indexOf("--index");
const saved = JSON.parse(readFileSync(file, "utf8")) as {
  turns: TurnOrder;
  deal?: Deal;
  ante: number;
  range: number;
  base: number;
  raise: number;
  sets: { presets: Record<PresetName, StrategyParams>; codes: Record<PresetName, string> }[];
};
const set = saved.sets[idxFlag >= 0 ? Number(process.argv[idxFlag + 1]) : 0]!;
const turnOrder = saved.turns;
const deal: Deal = saved.deal ?? "complementary";
const stakesAt = (ante: number): Stakes => ({ ante, baseBet: saved.base, raisedBet: saved.raise });
const stakes = stakesAt(saved.ante);
const presets = Object.fromEntries(PRESET_NAMES.map((n) => [n, makeStrategy(set.presets[n])])) as Record<PresetName, Agent>;
const pad = (s: string, n = 12) => s.padStart(n);

// ---- Exact event walk ----
type Tally = {
  rounds: number;
  bluffs: number; // raises made while holding the weaker edge (< 0.5), not as an answer
  bluffFolds: number; // ... that the opponent folded to in the same round
  bluffFoldsWhileAhead: number; // ... where the folder held the higher edge
  bluffFoldWinnings: number; // what those folds paid the bluffer
  bluffCalledEV: number; // expected result of bluffs that were not folded to
  leaderTransfer: number; // expected money moved to the round's leader
};
const zero = (): Tally => ({ rounds: 0, bluffs: 0, bluffFolds: 0, bluffFoldsWhileAhead: 0, bluffFoldWinnings: 0, bluffCalledEV: 0, leaderTransfer: 0 });

/** Probability-weighted event counts for `bluffer` (seat A) against B. */
function walk(a: Agent, b: Agent, s: Stakes, firstLeader: Seat | null, maxRounds = Infinity): Tally {
  const frozen = freezeStakes(s);
  const t = zero();
  const go = (state: MatchState, prob: number) => {
    if (isMatchOver(state) || state.roundNumber > maxRounds) return;
    for (const outcome of dealOutcomes(deal)) {
      const p = prob * outcome.p;
      const edges = { A: outcome.A, B: outcome.B };
      const { actions, sequence } = decideRound(a, b, state, edges, frozen);
      const res = resolveActions(actions, frozen);
      const pWin = winProbabilityA(edges, deal);
      t.rounds += p;
      // A's bluff: a raise by A with the weaker edge that is not an answer to B's raise.
      const bluffIdx = sequence.findIndex((x, i) => x.seat === "A" && x.action === "raise" && sequence[i - 1]?.action !== "raise");
      const isBluff = bluffIdx >= 0 && edges.A < 0.5; // raising while more likely to lose than win
      const leader = state.nextLeader;
      const branch = (winner: Seat | null, bet: number, q: number) => {
        const toA = winner === "A" ? bet : winner === "B" ? -bet : 0;
        if (isBluff) {
          if (res.outcome === "one-folded" && winner === "A") {
            t.bluffFolds += p * q;
            if (edges.B > edges.A) t.bluffFoldsWhileAhead += p * q;
            t.bluffFoldWinnings += p * q * toA;
          } else t.bluffCalledEV += p * q * toA;
        }
        if (leader) t.leaderTransfer += p * q * (leader === "A" ? toA : -toA);
        go(advanceState(state, actions, winner, bet), p * q);
      };
      if (isBluff) t.bluffs += p;
      if (res.outcome === "both-folded") branch(null, 0, 1);
      else if (res.outcome === "one-folded") branch(res.winner, res.bet, 1);
      else {
        branch("A", res.bet, pWin);
        branch("B", res.bet, 1 - pWin);
      }
    }
  };
  if (firstLeader !== null || turnOrder === "simultaneous") go(initialState(firstLeader), 1);
  else {
    // Fair coin for the round-1 leader.
    for (const l of ["A", "B"] as const) {
      const sub = walk(a, b, s, l, maxRounds);
      for (const k of Object.keys(t) as (keyof Tally)[]) t[k] += sub[k] / 2;
    }
  }
  return t;
}

console.log(`Turn order ${turnOrder}, deal ${deal}, stakes ante ${stakes.ante} / base ${stakes.baseBet} / raise ${stakes.raisedBet}`);
for (const n of PRESET_NAMES) console.log(`  ${pad(n, 8)} ${JSON.stringify(set.presets[n])}  ${set.codes[n]}`);

// ---- 1. Bluffs ----
console.log("\n1. Bluffs (raises with an edge below 0.5, not answering a raise), per match, exact:");
console.log("   folded = opponent folded in the same round; ahead % = share of those folds where the folder held the higher edge;");
console.log("   won/fold = what a fold paid the bluffer; EV called = average result of bluffs that were not folded to.");
console.log(`${pad("bluffer", 10)}${pad("vs", 10)}${pad("bluffs", 9)}${pad("folded", 9)}${pad("fold %", 9)}${pad("ahead %", 9)}${pad("won/fold", 10)}${pad("EV called", 11)}`);
const bluffers: PresetName[] = [];
for (const x of PRESET_NAMES) {
  for (const y of PRESET_NAMES) {
    if (x === y) continue;
    const t = walk(presets[x], presets[y], stakes, null);
    if (t.bluffs < 1e-12) continue;
    if (!bluffers.includes(x)) bluffers.push(x);
    const called = t.bluffs - t.bluffFolds;
    console.log(
      pad(x, 10) + pad(y, 10) + pad(t.bluffs.toFixed(3), 9) + pad(t.bluffFolds.toFixed(3), 9) +
        pad(((100 * t.bluffFolds) / t.bluffs).toFixed(1) + "%", 9) +
        pad(t.bluffFolds > 0 ? ((100 * t.bluffFoldsWhileAhead) / t.bluffFolds).toFixed(0) + "%" : "-", 9) +
        pad(t.bluffFolds > 0 ? (t.bluffFoldWinnings / t.bluffFolds).toFixed(2) : "-", 10) +
        pad(called > 0 ? (t.bluffCalledEV / called).toFixed(2) : "-", 11),
    );
  }
}
// Counterfactual: the same bluffer with bluffing switched off.
for (const x of bluffers) {
  const honest = makeStrategy({ ...set.presets[x], bluffAtOrBelow: null });
  const field = (agent: Agent) =>
    PRESET_NAMES.filter((y) => y !== x).reduce((acc, y) => acc + seatAveragedNet(agent, presets[y], { stakes, turnOrder, deal }), 0) / 3;
  const withBluff = field(presets[x]);
  const without = field(honest);
  console.log(`  ${x}: avg vs other presets ${fmt(withBluff)} with bluffs, ${fmt(without)} with bluffAtOrBelow off -> bluffing is worth ${fmt(withBluff - without)} per match`);
}
if (bluffers.length === 0) console.log("  (no preset in this set raises with the weaker edge)");

// ---- 2. Position ----
if (turnOrder === "alternating") {
  console.log("\n2. Position (mirror matches, exact):");
  console.log(`${pad("preset", 10)}${pad("1 round", 10)}${pad("per round", 11)}${pad("match A-1st", 13)}${pad("match coin", 12)}`);
  for (const n of PRESET_NAMES) {
    const one = walk(presets[n], presets[n], stakes, "A", 1);
    const full = walk(presets[n], presets[n], stakes, "A");
    // Seat-A-leads-first full match, and the fair-coin match the engine plays.
    const fixed = expectedNet(presets[n], presets[n], { stakes, turnOrder, deal, firstLeader: "A" });
    const coin = expectedNet(presets[n], presets[n], { stakes, turnOrder, deal });
    console.log(
      pad(n, 10) + pad(fmt(one.leaderTransfer), 10) + pad(fmt(full.leaderTransfer / full.rounds), 11) + pad(fmt(fixed), 13) + pad(fmt(coin), 12),
    );
  }
  console.log("  1 round = leader's expected result in a single round; per round = averaged over all rounds played;");
  console.log("  match A-1st = seat A's result when A always leads round 1 (so rounds 1 and 3); match coin = the engine's rule.");
  console.log("  Non-mirror pairs, value to the row preset of leading round 1 over a full match:");
  console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join(""));
  for (const x of PRESET_NAMES) {
    const cells = PRESET_NAMES.map((y) => {
      const lead = expectedNet(presets[x], presets[y], { stakes, turnOrder, deal, firstLeader: "A" });
      const follow = expectedNet(presets[x], presets[y], { stakes, turnOrder, deal, firstLeader: "B" });
      return pad(fmt((lead - follow) / 2));
    });
    console.log(pad(x) + cells.join(""));
  }
}

// ---- 3. Matrix, probes, baselines, sweep ----
const a = analyse(stakes, presets, turnOrder, deal);
console.log(`\n3. Exact matrix at ante ${stakes.ante} (row vs column, both seatings):`);
console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join("") + pad("vs presets"));
const always = (act: Action): Agent => () => act;
const rows: [string, number[]][] = [
  ...a.matrix.map((r, i): [string, number[]] => [NAMES[i]!, r]),
  ...(["fold", "call"] as const).map((act): [string, number[]] => [
    act === "fold" ? "AlwaysFold" : "AlwaysCall",
    PRESET_NAMES.map((n) => seatAveragedNet(always(act), presets[n], { stakes, turnOrder, deal })),
  ]),
];
rows.forEach(([name, r], i) => {
  if (i === PRESET_NAMES.length) console.log(pad("-- others --"));
  const avg = r.reduce((x, y) => x + y, 0) / r.length;
  console.log(pad(name) + r.map((x) => pad(fmt(x))).join("") + pad(fmt(avg)) + (i >= PRESET_NAMES.length ? `  beats ${r.filter((x) => x > TIE).length}/4` : ""));
});
for (const c of a.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}: ${c.detail}`);

console.log(`\nAnte sweep ${saved.ante - saved.range}..${saved.ante + saved.range} (exact, general calculator):`);
console.log(`${pad("ante", 6)}  result  ${pad("AlwaysRaise", 12)}${pad("probe .3", 10)}${pad("probe .5", 10)}${pad("spread", 8)}  weakest loop link`);
for (let k = 0; k <= Math.round(saved.range * 20); k++) {
  const ante = Math.round((saved.ante - saved.range + k * 0.1) * 100) / 100;
  const r = analyse(stakesAt(ante), presets, turnOrder, deal);
  const ok = r.checks.every((c) => c.ok);
  const f = r.field.slice(PRESET_NAMES.length);
  const weakest = r.loop.reduce((w, x) => (x.margin < w.margin ? x : w));
  console.log(
    `${pad(ante.toFixed(1), 6)}  ${ok ? "PASS  " : "FAIL  "}  ${pad(fmt(f[0]!.avg), 12)}${pad(fmt(f[1]!.avg), 10)}${pad(fmt(f[2]!.avg), 10)}${pad(r.spread.toFixed(3), 8)}  ${weakest.winner}>${weakest.loser} ${fmt(weakest.margin)}`,
  );
}
