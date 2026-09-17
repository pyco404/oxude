import {
  CLASSIC_STAKES,
  expectedNet,
  makeStrategy,
  PRESET_NAMES,
  PRESET_PARAMS,
  seatAveragedNet,
  type Action,
  type Agent,
  type FoldThreshold,
  type PresetName,
  type Stakes,
  type StrategyParams,
  type TurnOrder,
} from "../src/index.js";
import { analyse, fmt, MAX_PROBE_BEATS, NAMES, PROBES, SPREAD_LIMIT, TIE } from "./analysis.js";
import { writeFileSync } from "node:fs";
import { selfCheck, tableFor, tableSeatAveraged, type DecisionTable } from "./table-eval.js";

// Exact search for preset parameters that meet the ship criteria across an
// ante range (every criterion must hold at the low end, the centre and the
// high end; the points in between are then checked and reported).
//
// Usage: npm run search -- [--turns simultaneous|alternating] [--ante 4] [--range 1]
//                          [--base 10] [--raise 20] [--top 3]
// Env: ANY_BLUFF=1 drops the bluffer requirement; ANY_TRICKY=1 lets Tricky react to pressure.
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const num = (name: string, fallback: number) => Number(flag(name) ?? fallback);
const TURNS = (flag("--turns") ?? "simultaneous") as TurnOrder;
if (TURNS !== "simultaneous" && TURNS !== "alternating") throw new Error(`--turns must be simultaneous or alternating`);
const ANTE = num("--ante", 4);
const RANGE = num("--range", 1);
const BASE = num("--base", CLASSIC_STAKES.baseBet);
const RAISE = num("--raise", CLASSIC_STAKES.raisedBet);
const TOP = num("--top", 3);
const SAVE = flag("--save");
const REQUIRE_BLUFF = !process.env.ANY_BLUFF;
const TRICKY_IGNORES_PRESSURE = !process.env.ANY_TRICKY;

const stakesAt = (ante: number): Stakes => ({ ante, baseBet: BASE, raisedBet: RAISE });
const round2 = (x: number) => Math.round(x * 100) / 100;
const HARD = [ANTE - RANGE, ANTE, ANTE + RANGE];
// Between pot-odds flips every value is linear in the ante; the extra points
// cover both sides of the centre, where flips happen with base 10 / raise 20.
const EXTRA = [ANTE - RANGE / 2, ANTE - 0.001, ANTE + 0.001, ANTE + RANGE / 2];
const SWEEP = Array.from({ length: Math.round(RANGE * 20) + 1 }, (_, k) => round2(ANTE - RANGE + k * 0.1));

const T: FoldThreshold[] = [0, 0.35, 0.45, 0.55, 0.65, 0.75, "pot-odds"];
const GRID = {
  foldBelow: T,
  raiseAtOrAbove: [0.25, 0.35, 0.45, 0.55, 0.65, 1],
  bluffAtOrBelow: [null, 0.32, 0.42, 0.52],
  bluffUnderPressure: [false, true],
  pressureFoldBelow: [null, 0.35, 0.45, 0.6, 0.65, 0.75, "pot-odds"] as (FoldThreshold | null)[],
  foldToRaiseBelow: (TURNS === "alternating" ? [null, ...T.slice(1)] : [null]) as (FoldThreshold | null)[],
};

// Table rows: [pressured][facing none, call, raise][edge 0.3..0.7]
const row = (t: DecisionTable, p: number, f: number) => Array.from(t.subarray((p * 3 + f) * 5, (p * 3 + f) * 5 + 5));
const ACT = ["f", "c", "r"];
const code = (t: DecisionTable) =>
  (TURNS === "alternating" ? [row(t, 0, 0), row(t, 1, 0), row(t, 0, 2)] : [row(t, 0, 0), row(t, 1, 0)])
    .map((r) => r.map((a) => ACT[a]).join(""))
    .join("/");

function degeneracies(t: DecisionTable): string[] {
  const acting = [row(t, 0, 0), row(t, 1, 0), row(t, 0, 1), row(t, 1, 1)].flat();
  const flags: string[] = [];
  if (![...acting, ...(TURNS === "alternating" ? row(t, 0, 2) : [])].includes(0)) flags.push("never folds");
  if (!acting.includes(2)) flags.push("never raises");
  if (new Set(row(t, 0, 0)).size === 1) flags.push("ignores its edge");
  if (TURNS === "alternating" && row(t, 0, 2).every((a) => a === 0)) flags.push("folds to every raise");
  return flags;
}
/** A bluff: raising at some edge while not raising at a stronger one (when acting first or facing a call). */
const bluffRow = (r: number[]) => r.some((a, i) => a === 2 && r.slice(i + 1).some((b) => b !== 2));
const bluffs = (t: DecisionTable) => [row(t, 0, 0), row(t, 1, 0), row(t, 0, 1), row(t, 1, 1)].some(bluffRow);
const ignoresPressure = (t: DecisionTable) => [0, 1, 2].every((f) => row(t, 0, f).join() === row(t, 1, f).join());

// ---- Candidates ----
type Cand = { agent: Agent; tables: Map<number, DecisionTable>; key: string; params: StrategyParams[] };
const tableAt = (c: Cand, ante: number) => {
  let t = c.tables.get(ante);
  if (!t) c.tables.set(ante, (t = tableFor(c.agent, stakesAt(ante))));
  return t;
};
const byKey = new Map<string, Cand>();
for (const foldBelow of GRID.foldBelow)
  for (const raiseAtOrAbove of GRID.raiseAtOrAbove)
    for (const bluffAtOrBelow of GRID.bluffAtOrBelow)
      for (const bluffUnderPressure of GRID.bluffUnderPressure)
        for (const pressureFoldBelow of GRID.pressureFoldBelow)
          for (const foldToRaiseBelow of GRID.foldToRaiseBelow) {
            const params: StrategyParams = { foldBelow, raiseAtOrAbove, bluffAtOrBelow, bluffUnderPressure, pressureFoldBelow, foldToRaiseBelow };
            const agent = makeStrategy(params);
            const c: Cand = { agent, tables: new Map(), key: "", params: [params] };
            c.key = HARD.map((a) => code(tableAt(c, a))).join(" ");
            const existing = byKey.get(c.key);
            if (existing) existing.params.push(params);
            else byKey.set(c.key, c);
          }

const probeTables = PROBES.map(([, p]) => new Map(HARD.map((a) => [a, tableFor(p, stakesAt(a))] as const)));
const probeCodes = new Set(probeTables.flatMap((m) => [...m.values()].map(code)));
const rejected = { degenerate: 0, probe: 0 };
const cands: Cand[] = [];
for (const c of byKey.values()) {
  const ts = HARD.map((a) => tableAt(c, a));
  if (ts.some((t) => degeneracies(t).length > 0)) rejected.degenerate++;
  else if (ts.some((t) => probeCodes.has(code(t)))) rejected.probe++;
  else cands.push(c);
}
const N = cands.length;
const isBluffer = cands.map((c) => HARD.every((a) => bluffs(tableAt(c, a))));
const trickyOk = cands.map((c) => !TRICKY_IGNORES_PRESSURE || HARD.every((a) => ignoresPressure(tableAt(c, a))));

// ---- Verify the fast evaluator on this search's own candidates ----
{
  const sample: [Agent, Agent][] = [];
  for (let k = 0; k < 60; k++) sample.push([cands[(k * 7919) % N]!.agent, cands[(k * 104729 + 13) % N]!.agent]);
  sample.push([() => "raise", cands[0]!.agent], [PROBES[1]![1], cands[N - 1]!.agent]);
  for (const a of [...HARD, ...EXTRA]) selfCheck(sample, stakesAt(a), TURNS);
}

const started = Date.now();
// ---- Exact matrices at the hard antes ----
const M = HARD.map(() => new Float64Array(N * N));
const PV = HARD.map(() => PROBES.map(() => new Float64Array(N)));
HARD.forEach((ante, h) => {
  const s = stakesAt(ante);
  const ts = cands.map((c) => tableAt(c, ante));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const v = tableSeatAveraged(ts[i]!, ts[j]!, s, TURNS);
      M[h]![i * N + j] = v;
      M[h]![j * N + i] = -v;
    }
    PROBES.forEach((_, k) => (PV[h]![k]![i] = tableSeatAveraged(probeTables[k]!.get(ante)!, ts[i]!, s, TURNS)));
  }
});
const matrixSeconds = (Date.now() - started) / 1000;

// Lazy values at the extra antes.
const extraMemo = new Map<string, number>();
function valueAt(i: number, j: number, ante: number): number {
  const h = HARD.indexOf(ante);
  if (h >= 0) return M[h]![i * N + j]!;
  if (i === j) return 0;
  const key = `${ante}:${Math.min(i, j)}:${Math.max(i, j)}`;
  let v = extraMemo.get(key);
  if (v === undefined) {
    const [a, b] = [Math.min(i, j), Math.max(i, j)];
    v = tableSeatAveraged(tableAt(cands[a]!, ante), tableAt(cands[b]!, ante), stakesAt(ante), TURNS);
    extraMemo.set(key, v);
  }
  return i < j ? v : -v;
}
function probeAt(k: number, i: number, ante: number): number {
  const h = HARD.indexOf(ante);
  if (h >= 0) return PV[h]![k]![i]!;
  const key = `p${ante}:${k}:${i}`;
  let v = extraMemo.get(key);
  if (v === undefined) {
    v = tableSeatAveraged(tableFor(PROBES[k]![1], stakesAt(ante)), tableAt(cands[i]!, ante), stakesAt(ante), TURNS);
    extraMemo.set(key, v);
  }
  return v;
}

type Check = { ok: boolean; margin: number; binding: string };
/** All five criteria for [Reckless, Steady, Patient, Tricky] at one ante. Margin = smallest slack. */
function check(ids: number[], ante: number): Check {
  const [r, s, p, t] = ids as [number, number, number, number];
  const slacks: [string, number, "strict" | "weak"][] = [
    ["Reckless>Patient", valueAt(r, p, ante), "strict"],
    ["Steady>Reckless", valueAt(s, r, ante), "strict"],
    ["Steady>Patient", valueAt(s, p, ante), "strict"],
    ["Patient>Tricky", valueAt(p, t, ante), "strict"],
    ["Tricky>Reckless", valueAt(t, r, ante), "strict"],
    ["Tricky>Steady", valueAt(t, s, ante), "strict"],
  ];
  const avgs = ids.map((i) => ids.reduce((acc, j) => acc + valueAt(i, j, ante), 0) / 4);
  const spread = Math.max(...avgs) - Math.min(...avgs);
  slacks.push(["spread", SPREAD_LIMIT - spread, "strict"]);
  let beatsOk = true;
  PROBES.forEach(([name], k) => {
    const vals = ids.map((i) => probeAt(k, i, ante));
    slacks.push([`${name} avg`, -vals.reduce((a, b) => a + b, 0) / 4, "weak"]);
    if (k > 0 && vals.filter((x) => x > TIE).length > MAX_PROBE_BEATS) beatsOk = false;
  });
  const worst = slacks.reduce((w, x) => (x[1] < w[1] ? x : w));
  const ok = beatsOk && slacks.every(([, v, kind]) => (kind === "strict" ? v > TIE : v >= -TIE));
  return { ok, margin: worst[1], binding: beatsOk ? worst[0] : "probe beats > 2" };
}

// ---- Loop enumeration: loop must hold at every hard ante ----
const W = Math.ceil(N / 32);
const beats = new Uint32Array(N * W);
const beaten = new Uint32Array(N * W);
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++) {
    if (i !== j && M.every((m) => m[i * N + j]! > TIE)) {
      beats[i * W + (j >>> 5)]! |= 1 << (j & 31);
      beaten[j * W + (i >>> 5)]! |= 1 << (i & 31);
    }
  }
const each = (buf: Uint32Array, off: number, fn: (x: number) => void) => {
  for (let w = 0; w < W; w++) {
    let x = buf[off + w]!;
    while (x) {
      const b = x & -x;
      fn(w * 32 + 31 - Math.clz32(b));
      x ^= b;
    }
  }
};
const cost = PRESET_NAMES.map((role) =>
  cands.map((c) => Math.min(...c.params.map((p) => changedKeys(p, PRESET_PARAMS[role]).length))),
);
function changedKeys(p: StrategyParams, o: StrategyParams) {
  return (Object.keys(o) as (keyof StrategyParams)[]).filter((k) => p[k] !== o[k]);
}

type Sol = { ids: number[]; cost: number; worst: number; allPass: boolean };
const sols: Sol[] = [];
let loops = 0;
const ts = new Uint32Array(W);
const sp = new Uint32Array(W);
const pr = new Uint32Array(W);
for (let t = 0; t < N; t++) {
  if (!trickyOk[t]) continue;
  each(beats, t * W, (s) => {
    for (let w = 0; w < W; w++) {
      ts[w] = beats[t * W + w]! & beats[s * W + w]!;
      sp[w] = beats[s * W + w]! & beaten[t * W + w]!;
    }
    each(ts, 0, (r) => {
      for (let w = 0; w < W; w++) pr[w] = sp[w]! & beats[r * W + w]!;
      each(pr, 0, (p) => {
        loops++;
        if (REQUIRE_BLUFF && !(isBluffer[r] || isBluffer[s] || isBluffer[p] || isBluffer[t])) return;
        const ids = [r, s, p, t];
        let worst = Infinity;
        for (const a of HARD) {
          const c = check(ids, a);
          if (!c.ok) return;
          worst = Math.min(worst, c.margin);
        }
        sols.push({ ids, cost: ids.reduce((acc, id, k) => acc + cost[k]![id]!, 0), worst, allPass: false });
      });
    });
  });
}
for (const sol of sols) {
  const extra = EXTRA.map((a) => check(sol.ids, a));
  sol.allPass = extra.every((c) => c.ok);
  sol.worst = Math.min(sol.worst, ...extra.map((c) => c.margin));
}
sols.sort((a, b) => +b.allPass - +a.allPass || b.worst - a.worst || a.cost - b.cost);
const robust = sols.filter((s) => s.allPass);

console.log(`Turn order: ${TURNS}. Stakes base ${BASE} / raise ${RAISE}; ante ${HARD[0]}..${HARD[2]} around ${ANTE}.`);
console.log(`Constraints: ${REQUIRE_BLUFF ? "at least one bluffer" : "no bluffer required"}; ${TRICKY_IGNORES_PRESSURE ? "Tricky ignores pressure" : "Tricky unconstrained"}.`);
console.log(`${byKey.size} distinct behaviours; rejected ${rejected.degenerate} degenerate, ${rejected.probe} probe-identical; ${N} searched (${isBluffer.filter(Boolean).length} bluffers).`);
console.log(`Fast evaluator verified against the exact calculator. Matrices ${matrixSeconds.toFixed(0)}s, total ${((Date.now() - started) / 1000).toFixed(0)}s.`);
console.log(`${loops} loops hold at antes ${HARD.join(", ")}; ${sols.length} sets pass all criteria there; ${robust.length} also pass at ${EXTRA.join(", ")}.`);

// A bluff "lands" when an opponent in the set folds to it in the same round
// while holding the stronger edge (the complement of the bluffer's edge).
function landedBluffs(ids: number[]): string[] {
  if (TURNS !== "alternating") return [];
  const out: string[] = [];
  ids.forEach((x, xi) => {
    const tx = tableAt(cands[x]!, ANTE);
    [0, 1].forEach((pressured) => {
      const r = row(tx, pressured, 0);
      r.forEach((a, e) => {
        if (a !== 2 || !r.slice(e + 1).some((b) => b !== 2)) return;
        ids.forEach((y, yi) => {
          if (y === x) return;
          const opp = 4 - e;
          if (opp > 2 && row(tableAt(cands[y]!, ANTE), 0, 2)[opp] === 0) {
            out.push(`${PRESET_NAMES[xi]} bluff@${(0.3 + e / 10).toFixed(1)}${pressured ? "(pressured)" : ""} folds ${PRESET_NAMES[yi]}@${(0.3 + opp / 10).toFixed(1)}`);
          }
        });
      });
    });
  });
  return out;
}
const landing = sols.map((s) => landedBluffs(s.ids));
console.log(`${landing.filter((l) => l.length > 0).length} of ${sols.length} passing sets contain a bluff that folds an opponent holding the stronger edge.`);

if (SAVE) {
  const bestParams = (id: number, role: PresetName) =>
    cands[id]!.params.reduce((b, q) => (changedKeys(q, PRESET_PARAMS[role]).length < changedKeys(b, PRESET_PARAMS[role]).length ? q : b));
  const out = sols.map((sol, i) => ({
    cost: sol.cost,
    worst: sol.worst,
    allPass: sol.allPass,
    landedBluffs: landing[i],
    presets: Object.fromEntries(PRESET_NAMES.map((role, k) => [role, bestParams(sol.ids[k]!, role)])),
    codes: Object.fromEntries(PRESET_NAMES.map((role, k) => [role, code(tableAt(cands[sol.ids[k]!]!, ANTE))])),
    bluffers: PRESET_NAMES.filter((_, k) => isBluffer[sol.ids[k]!]),
  }));
  writeFileSync(SAVE, JSON.stringify({ turns: TURNS, ante: ANTE, range: RANGE, base: BASE, raise: RAISE, loops, sets: out }, null, 1));
  console.log(`Saved ${out.length} sets to ${SAVE}`);
}

// ---- Report ----
const pad = (s: string, n = 12) => s.padStart(n);
const fmtT = (x: FoldThreshold | null) => (x === null ? "off" : x === "pot-odds" ? "pot-odds" : String(x));
const fmtParams = (p: StrategyParams) =>
  `fold<${fmtT(p.foldBelow)} raise>=${p.raiseAtOrAbove >= 1 ? "never" : p.raiseAtOrAbove} bluff<=${p.bluffAtOrBelow ?? "off"}` +
  `${p.bluffUnderPressure ? "(+pressure)" : ""} pressureFold<${fmtT(p.pressureFoldBelow)}` +
  (TURNS === "alternating" ? ` foldToRaise<${fmtT(p.foldToRaiseBelow)}` : "");
const always = (a: Action): Agent => () => a;

/** Value of leading round 1 (and so round 3) in a mirror match. */
export const leadValue = (a: Agent, stakes: Stakes) => expectedNet(a, a, { stakes, turnOrder: "alternating", firstLeader: "A" });

function report(sol: Sol, rank: number) {
  console.log(`\n#${rank}: ${sol.cost} parameter changes; ${sol.allPass ? "passes at every checked ante" : "FAILS at an in-between ante"}; worst margin ${fmt(sol.worst)}`);
  const presets = {} as Record<PresetName, Agent>;
  const stakes = stakesAt(ANTE);
  PRESET_NAMES.forEach((role, k) => {
    const c = cands[sol.ids[k]!]!;
    const p = c.params.reduce((b, q) => (changedKeys(q, PRESET_PARAMS[role]).length < changedKeys(b, PRESET_PARAMS[role]).length ? q : b));
    presets[role] = c.agent;
    const tags = [isBluffer[sol.ids[k]!] ? "bluffs" : "", HARD.some((a) => code(tableAt(c, a)) !== code(tableAt(c, ANTE))) ? "adapts to ante" : ""].filter(Boolean);
    console.log(`  ${pad(role, 8)} ${fmtParams(p)}${tags.length ? `  [${tags.join(", ")}]` : ""}`);
    console.log(`  ${pad("", 8)} @${ANTE}: ${code(tableAt(c, ANTE))}   changed: ${changedKeys(p, PRESET_PARAMS[role]).join(", ") || "none"}`);
  });
  const landed = landedBluffs(sol.ids);
  console.log(`  Bluffs that fold an opponent holding the stronger edge: ${landed.length ? landed.join("; ") : "none"}`);
  const a = analyse(stakes, presets, TURNS);
  console.log(`  Exact matrix at ante ${ANTE} (general calculator):`);
  console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join("") + pad("vs presets"));
  const extra: [string, Agent][] = [["AlwaysFold", always("fold")], ["AlwaysCall", always("call")]];
  const rows: [string, number[]][] = [
    ...a.matrix.map((r, i): [string, number[]] => [NAMES[i]!, r]),
    ...extra.map(([n, ag]): [string, number[]] => [n, PRESET_NAMES.map((pn) => seatAveragedNet(ag, presets[pn], { stakes, turnOrder: TURNS }))]),
  ];
  rows.forEach(([name, r], i) => {
    if (i === PRESET_NAMES.length) console.log(pad("-- others --"));
    const avg = r.reduce((x, y) => x + y, 0) / r.length;
    console.log(pad(name) + r.map((x) => pad(fmt(x))).join("") + pad(fmt(avg)) + (i >= PRESET_NAMES.length ? `  beats ${r.filter((x) => x > TIE).length}/4` : ""));
  });
  if (TURNS === "alternating") {
    console.log(`  Value of leading round 1 in a mirror match: ` + PRESET_NAMES.map((n) => `${n} ${fmt(leadValue(presets[n], stakes))}`).join(", "));
  }
  console.log(`  Ante sweep (margin = smallest slack across all criteria):`);
  for (const ante of SWEEP) {
    const c = check(sol.ids, ante);
    console.log(`    ante ${ante.toFixed(1)}  ${c.ok ? "PASS" : "FAIL"}  margin ${fmt(c.margin)}  (${c.binding})`);
  }
}

console.log(`\nKey: rows = acting first / acting first under pressure${TURNS === "alternating" ? " / facing a raise" : ""}; edges 0.3..0.7; f=fold c=call r=raise.`);
sols.slice(0, TOP).forEach((s, i) => report(s, i + 1));
