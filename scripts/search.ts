import {
  makeStrategy,
  PRESET_NAMES,
  PRESET_PARAMS,
  seatAveragedNet,
  CLASSIC_STAKES,
  type Action,
  type Agent,
  type FoldThreshold,
  type PresetName,
  type Stakes,
  type StrategyParams,
} from "../src/index.js";
import { analyse, fmt, MAX_PROBE_BEATS, NAMES, PROBES, SPREAD_LIMIT, TIE } from "./analysis.js";

// Exact search for preset parameters meeting the ship criteria at one ante,
// ranked by how well they hold across an ante sweep around it.
// Usage: npm run search [-- --ante 4 --base 10 --raise 20 --spread-ante 1 --top 3]
// Env: ANY_BLUFF=1 drops the bluffer requirement, ANY_TRICKY=1 lets Tricky react to pressure,
// WINDOWS=1 prints each passing set's contiguous passing ante window.
const arg = (flag: string, fallback: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const ANTE = arg("--ante", 4);
const BASE = arg("--base", CLASSIC_STAKES.baseBet);
const RAISE = arg("--raise", CLASSIC_STAKES.raisedBet);
const HALF_WIDTH = arg("--spread-ante", 1);
const TOP = arg("--top", 3);
const stakesAt = (ante: number): Stakes => ({ ante, baseBet: BASE, raisedBet: RAISE });

// Sweep points for reporting; the ranking points add both sides of the search ante,
// where pot-odds thresholds can flip. Between flips every value is linear in the ante.
const round2 = (x: number) => Math.round(x * 100) / 100;
const SWEEP = Array.from({ length: Math.round(HALF_WIDTH * 20) + 1 }, (_, k) => round2(ANTE - HALF_WIDTH + k * 0.1));
const RANK_ANTES = [...new Set([ANTE - HALF_WIDTH, ANTE - HALF_WIDTH / 2, ANTE - 0.001, ANTE, ANTE + 0.001, ANTE + HALF_WIDTH / 2, ANTE + HALF_WIDTH])];
const BEHAVIOUR_ANTES = [ANTE - HALF_WIDTH, ANTE, ANTE + HALF_WIDTH];

const EDGE_VALUES = [0.3, 0.4, 0.5, 0.6, 0.7];
const T: FoldThreshold[] = [0, 0.35, 0.45, 0.55, 0.65, 0.75, "pot-odds"];
const GRID = {
  foldBelow: T,
  raiseAtOrAbove: [0.25, 0.35, 0.45, 0.55, 0.65, 1],
  bluffAtOrBelow: [null, 0.32, 0.42, 0.52],
  bluffUnderPressure: [false, true],
  pressureFoldBelow: [null, 0.35, 0.45, 0.6, 0.65, 0.75, "pot-odds"] as (FoldThreshold | null)[],
};

type Table = { unpressured: Action[]; pressured: Action[] };
const tableOf = (agent: Agent, ante: number): Table => {
  const at = (raised: boolean) =>
    EDGE_VALUES.map((myEdge) =>
      agent({ myEdge, oppRaisedLastRound: raised, oppRaiseCount: +raised, myRoundsWon: 0, oppRoundsWon: 0, roundNumber: 2, myNet: 0, stakes: stakesAt(ante) }),
    );
  return { unpressured: at(false), pressured: at(true) };
};
const code = (t: Table) => `${t.unpressured.map((a) => a[0]).join("")}/${t.pressured.map((a) => a[0]).join("")}`;

function degeneracies(t: Table): string[] {
  const all = [...t.unpressured, ...t.pressured];
  const flags: string[] = [];
  if (!all.includes("fold")) flags.push("never folds");
  if (!all.includes("raise")) flags.push("never raises");
  if (new Set(t.unpressured).size === 1) flags.push("ignores its edge");
  return flags;
}
/** A bluff: raising at some edge while not raising at a stronger one. */
const bluffsIn = (row: Action[]) => row.some((a, i) => a === "raise" && row.slice(i + 1).some((b) => b !== "raise"));
const bluffs = (t: Table) => bluffsIn(t.unpressured) || bluffsIn(t.pressured);

type Cand = { agent: Agent; tables: Table[]; codes: string; params: StrategyParams[] };
const probeCodes = new Set(PROBES.map(([, p]) => code(tableOf(p, ANTE))));
const byKey = new Map<string, Cand>();
let rejected = { degenerate: 0, probe: 0 };
for (const foldBelow of GRID.foldBelow)
  for (const raiseAtOrAbove of GRID.raiseAtOrAbove)
    for (const bluffAtOrBelow of GRID.bluffAtOrBelow)
      for (const bluffUnderPressure of GRID.bluffUnderPressure)
        for (const pressureFoldBelow of GRID.pressureFoldBelow) {
          const params: StrategyParams = { foldBelow, raiseAtOrAbove, bluffAtOrBelow, bluffUnderPressure, pressureFoldBelow };
          const agent = makeStrategy(params);
          const tables = BEHAVIOUR_ANTES.map((a) => tableOf(agent, a));
          const codes = tables.map(code).join(" ");
          const existing = byKey.get(codes);
          if (existing) {
            existing.params.push(params);
            continue;
          }
          byKey.set(codes, { agent, tables, codes, params: [params] });
        }
const cands: Cand[] = [];
for (const c of byKey.values()) {
  if (c.tables.some((t) => degeneracies(t).length > 0)) rejected.degenerate++;
  else if (c.tables.some((t) => probeCodes.has(code(t)))) rejected.probe++;
  else cands.push(c);
}
const N = cands.length;
const searchTable = (c: Cand) => c.tables[BEHAVIOUR_ANTES.indexOf(ANTE)]!;
const isBluffer = cands.map((c) => bluffs(searchTable(c)));
// Tricky never reacts to pressure, at any ante in the sweep.
const ignoresPressure = cands.map((c) => c.tables.every((t) => t.pressured.join() === t.unpressured.join()));

const changes = (p: StrategyParams, o: StrategyParams) =>
  (Object.keys(o) as (keyof StrategyParams)[]).filter((k) => p[k] !== o[k]);
const nearest = (c: Cand, o: StrategyParams) =>
  c.params.reduce((best, p) => (changes(p, o).length < changes(best, o).length ? p : best));
const cost = PRESET_NAMES.map((role) => cands.map((c) => changes(nearest(c, PRESET_PARAMS[role]), PRESET_PARAMS[role]).length));

// Exact values, memoised per ante.
const memo = new Map<number, Map<number, number>>();
function vs(i: number, j: number, ante: number): number {
  if (i === j) return 0;
  let m = memo.get(ante);
  if (!m) memo.set(ante, (m = new Map()));
  const key = i < j ? i * N + j : j * N + i;
  let v = m.get(key);
  if (v === undefined) {
    v = seatAveragedNet(cands[Math.min(i, j)]!.agent, cands[Math.max(i, j)]!.agent, { stakes: stakesAt(ante) });
    m.set(key, v);
  }
  return i < j ? v : -v;
}
const probeMemo = new Map<string, number>();
function probeVs(k: number, i: number, ante: number): number {
  const key = `${k}:${i}:${ante}`;
  let v = probeMemo.get(key);
  if (v === undefined) {
    v = seatAveragedNet(PROBES[k]![1], cands[i]!.agent, { stakes: stakesAt(ante) });
    probeMemo.set(key, v);
  }
  return v;
}

const started = Date.now();
const WORDS = Math.ceil(N / 32);
const beatsBits = new Uint32Array(N * WORDS); // i beats j
const beatenBits = new Uint32Array(N * WORDS); // j beats i
for (let i = 0; i < N; i++)
  for (let j = i + 1; j < N; j++) {
    const v = vs(i, j, ANTE);
    if (v > TIE) {
      beatsBits[i * WORDS + (j >>> 5)]! |= 1 << (j & 31);
      beatenBits[j * WORDS + (i >>> 5)]! |= 1 << (i & 31);
    } else if (v < -TIE) {
      beatsBits[j * WORDS + (i >>> 5)]! |= 1 << (i & 31);
      beatenBits[i * WORDS + (j >>> 5)]! |= 1 << (j & 31);
    }
  }
const arAt = (i: number) => probeVs(0, i, ANTE);
const bits = (row: Uint32Array, base: number, out: number[]) => {
  out.length = 0;
  for (let w = 0; w < WORDS; w++) {
    let x = row[base + w]!;
    while (x) {
      const b = x & -x;
      out.push(w * 32 + 31 - Math.clz32(b));
      x ^= b;
    }
  }
  return out;
};

type Check = { ok: boolean; margin: number; binding: string };
/** All criteria for a set [R, S, P, Tr] at one ante; margin is the smallest slack. */
function check(ids: number[], ante: number): Check {
  const [r, s, p, t] = ids as [number, number, number, number];
  const loop: [string, number][] = [
    ["Reckless>Patient", vs(r, p, ante)],
    ["Steady>Reckless", vs(s, r, ante)],
    ["Steady>Patient", vs(s, p, ante)],
    ["Patient>Tricky", vs(p, t, ante)],
    ["Tricky>Reckless", vs(t, r, ante)],
    ["Tricky>Steady", vs(t, s, ante)],
  ];
  const avgs = ids.map((i) => ids.reduce((acc, j) => acc + vs(i, j, ante), 0) / 4);
  const spread = Math.max(...avgs) - Math.min(...avgs);
  const slacks: [string, number][] = [...loop, [`spread ${spread.toFixed(3)}`, SPREAD_LIMIT - spread]];
  let beatsOk = true;
  PROBES.forEach(([name], k) => {
    const row = ids.map((i) => probeVs(k, i, ante));
    const avg = row.reduce((a, b) => a + b, 0) / 4;
    slacks.push([`${name} avg`, -avg]);
    if (k > 0 && row.filter((x) => x > TIE).length > MAX_PROBE_BEATS) beatsOk = false;
  });
  const worst = slacks.reduce((w, x) => (x[1] < w[1] ? x : w));
  const ok = beatsOk && slacks.every(([label, v]) => (label.startsWith("spread") ? v > 0 : label.includes("avg") ? v >= -TIE : v > TIE));
  return { ok, margin: worst[1], binding: beatsOk ? worst[0] : "probe beats > 2" };
}

type Sol = { ids: number[]; cost: number; robust: number; worst: number };
const passing: Sol[] = [];
let loops = 0;
const S: number[] = [], R: number[] = [], P: number[] = [];
for (let t = 0; t < N; t++) {
  if (!ignoresPressure[t] && !process.env.ANY_TRICKY) continue;
  for (const s of bits(beatsBits, t * WORDS, S)) {
    const tsRow = new Uint32Array(WORDS);
    for (let w = 0; w < WORDS; w++) tsRow[w] = beatsBits[t * WORDS + w]! & beatsBits[s * WORDS + w]!;
    for (const r of bits(tsRow, 0, R)) {
      const pRow = new Uint32Array(WORDS);
      for (let w = 0; w < WORDS; w++) {
        pRow[w] = beatsBits[r * WORDS + w]! & beatsBits[s * WORDS + w]! & beatenBits[t * WORDS + w]!;
      }
      for (const p of bits(pRow, 0, P)) {
        loops++;
        if (!(isBluffer[r] || isBluffer[s] || isBluffer[p] || isBluffer[t]) && !process.env.ANY_BLUFF) continue;
        if (arAt(r) + arAt(s) + arAt(p) + arAt(t) > 4 * TIE) continue;
        const ids = [r, s, p, t];
        if (!check(ids, ANTE).ok) continue;
        passing.push({ ids, cost: ids.reduce((acc, id, k) => acc + cost[k]![id]!, 0), robust: 0, worst: 0 });
      }
    }
  }
}
for (const sol of passing) {
  const results = RANK_ANTES.map((a) => check(sol.ids, a));
  sol.robust = results.filter((x) => x.ok).length;
  sol.worst = Math.min(...results.map((x) => x.margin));
}
passing.sort((a, b) => b.robust - a.robust || b.worst - a.worst || a.cost - b.cost);
const fullyRobust = passing.filter((s) => s.robust === RANK_ANTES.length);

console.log(`Search: ante ${ANTE}, base ${BASE}, raise ${RAISE}. Robustness over ante ${SWEEP[0]}..${SWEEP[SWEEP.length - 1]}.`);
console.log(`${byKey.size} distinct behaviours (over antes ${BEHAVIOUR_ANTES.join(", ")}); rejected ${rejected.degenerate} degenerate, ${rejected.probe} probe-identical; ${N} searched.`);
console.log(`${loops} loops found; ${passing.length} sets pass every criterion at ante ${ANTE}${process.env.ANY_BLUFF ? "" : " with a bluffer"}${process.env.ANY_TRICKY ? " (Tricky may react to pressure)" : ""}; ${fullyRobust.length} also pass at every ranking ante (${RANK_ANTES.join(", ")}). ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (passing.length > 0) {
  const cheapest = passing.reduce((b, s) => (s.cost < b.cost ? s : b));
  console.log(`Fewest changes among passing sets: ${cheapest.cost}; fewest among fully robust: ${fullyRobust.length ? Math.min(...fullyRobust.map((s) => s.cost)) : "n/a"}.`);
}

const pad = (s: string, n = 12) => s.padStart(n);
const fmtT = (x: FoldThreshold | null) => (x === null ? "off" : x === "pot-odds" ? "pot-odds" : String(x));
const fmtParams = (p: StrategyParams) =>
  `fold<${fmtT(p.foldBelow)} raise>=${p.raiseAtOrAbove >= 1 ? "never" : p.raiseAtOrAbove} bluff<=${p.bluffAtOrBelow ?? "off"}` +
  `${p.bluffUnderPressure ? " (also under pressure)" : ""} pressureFold<${fmtT(p.pressureFoldBelow)}`;
const always = (a: Action): Agent => () => a;

function report(sol: Sol, rank: number) {
  console.log(`\n#${rank}: ${sol.cost} parameter changes; passes at ${sol.robust}/${RANK_ANTES.length} ranking antes; worst margin ${fmt(sol.worst)}`);
  const presets = {} as Record<PresetName, Agent>;
  PRESET_NAMES.forEach((role, k) => {
    const c = cands[sol.ids[k]!]!;
    const p = nearest(c, PRESET_PARAMS[role]);
    presets[role] = c.agent;
    const changed = changes(p, PRESET_PARAMS[role]);
    const traits = [isBluffer[sol.ids[k]!] ? "bluffs" : "", c.tables.some((t, i) => i > 0 && code(t) !== code(c.tables[0]!)) ? "adapts to ante" : ""].filter(Boolean);
    console.log(`  ${pad(role, 8)} ${fmtParams(p)}`);
    console.log(`  ${pad("", 8)} behaviour @${BEHAVIOUR_ANTES.join("/")}: ${c.codes}  ${changed.length ? `changed: ${changed.join(", ")}` : "unchanged"}${traits.length ? `  [${traits.join(", ")}]` : ""}`);
  });
  const stakes = stakesAt(ANTE);
  const a = analyse(stakes, presets);
  console.log(`  Exact matrix at ante ${ANTE}:`);
  console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join("") + pad("vs presets"));
  const extra: [string, Agent][] = [["AlwaysFold", always("fold")], ["AlwaysCall", always("call")]];
  const rows: [string, number[]][] = [
    ...a.matrix.map((row, i): [string, number[]] => [NAMES[i]!, row]),
    ...extra.map(([n, ag]): [string, number[]] => [n, PRESET_NAMES.map((pn) => seatAveragedNet(ag, presets[pn], { stakes }))]),
  ];
  rows.forEach(([name, row], i) => {
    if (i === PRESET_NAMES.length) console.log(pad("-- others --"));
    const avg = row.reduce((s, x) => s + x, 0) / row.length;
    const won = row.filter((x) => x > TIE).length;
    console.log(pad(name) + row.map((x) => pad(fmt(x))).join("") + pad(fmt(avg)) + (i >= PRESET_NAMES.length ? `  beats ${won}/4` : ""));
  });
  console.log(`  Ante sweep (margin = smallest slack across all criteria; binding criterion shown):`);
  for (const ante of SWEEP) {
    const c = check(sol.ids, ante);
    console.log(`    ante ${ante.toFixed(1)}  ${c.ok ? "PASS" : "FAIL"}  margin ${fmt(c.margin)}  (${c.binding})`);
  }
}

if (process.env.WINDOWS) {
  // For each passing set: the contiguous passing window around the search ante, and margins inside it.
  const rows = passing.map((sol) => {
    const res = SWEEP.map((a) => ({ a, ...check(sol.ids, a) }));
    const at = res.findIndex((x) => x.a === ANTE);
    let lo = at, hi = at;
    while (lo > 0 && res[lo - 1]!.ok) lo--;
    while (hi < res.length - 1 && res[hi + 1]!.ok) hi++;
    const inside = res.slice(lo, hi + 1);
    const probe1 = PROBES.map((_, k) => sol.ids.reduce((acc, i) => acc + probeVs(k, i, ANTE), 0) / 4);
    return { lo: res[lo]!.a, hi: res[hi]!.a, width: res[hi]!.a - res[lo]!.a, min: Math.min(...inside.map((x) => x.margin)), probe: probe1, cost: sol.cost };
  });
  rows.sort((x, y) => y.width - x.width || y.min - x.min);
  const widths = new Map<string, number>();
  for (const r of rows) widths.set(r.width.toFixed(1), (widths.get(r.width.toFixed(1)) ?? 0) + 1);
  console.log("window widths:", [...widths].map(([w, n]) => `${w}:${n}`).join(" "));
  console.log("fold-0.3 probe avg at search ante, range:", Math.min(...rows.map((r) => r.probe[1]!)).toFixed(4), "..", Math.max(...rows.map((r) => r.probe[1]!)).toFixed(4));
  console.log("largest in-window margin:", Math.max(...rows.map((r) => r.min)).toFixed(4));
  for (const r of rows.slice(0, 5)) console.log(`  ${r.lo}..${r.hi} min ${fmt(r.min)} probes ${r.probe.map((x) => fmt(x)).join(" ")} cost ${r.cost}`);
}

console.log("\nKey: behaviour = actions for edges 0.3..0.7, unpressured/pressured (f=fold c=call r=raise).");
passing.slice(0, TOP).forEach((s, i) => report(s, i + 1));
