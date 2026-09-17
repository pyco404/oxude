import { CLASSIC_STAKES, type Stakes } from "../src/index.js";
import { analyse, fmt, PROBES, SPREAD_LIMIT, TIE, type Analysis } from "./analysis.js";

// Exact sweep over stakes. Usage: npm run sweep [-- --antes 3-9 --raises 15,20,25]
function parseList(flag: string, fallback: number[]): number[] {
  const i = process.argv.indexOf(flag);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  if (raw === undefined) return fallback;
  return raw.split(",").flatMap((part) => {
    const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(part);
    if (!range) return [Number(part)];
    const out: number[] = [];
    for (let v = Number(range[1]); v <= Number(range[2]); v++) out.push(v);
    return out;
  });
}

const antes = parseList("--antes", [3, 4, 5, 6, 7, 8, 9, 10]);
const raises = parseList("--raises", [CLASSIC_STAKES.raisedBet]);
const baseBet = CLASSIC_STAKES.baseBet;

const probeNames = PROBES.map(([n]) => n);
const header = ["ante", "raise", ...probeNames.map((n) => `${n} (beats)`), "loop", "weakest link", "spread", "target"];
const rows: string[][] = [];
const winners: Analysis[] = [];

for (const raisedBet of raises) {
  for (const ante of antes) {
    const stakes: Stakes = { ante, baseBet, raisedBet };
    const a = analyse(stakes);
    const probeCells = probeNames.map((_, k) => {
      const f = a.field[a.field.length - PROBES.length + k]!;
      return `${fmt(f.avg)} (${f.beats}/4)`;
    });
    const weakest = a.loop.reduce((w, x) => (x.margin < w.margin ? x : w));
    const ar = a.field[a.field.length - PROBES.length]!;
    const target = ar.avg <= TIE && a.loopHolds && a.spread < SPREAD_LIMIT;
    if (target) winners.push(a);
    rows.push([
      String(ante),
      String(raisedBet),
      ...probeCells,
      a.loopHolds ? "holds" : "BROKEN",
      `${weakest.winner}>${weakest.loser} ${fmt(weakest.margin)}`,
      a.spread.toFixed(3),
      target ? "MET" : "-",
    ]);
  }
}

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
console.log(`Exact sweep, base bet ${baseBet}. Target: AlwaysRaise <= 0, loop holds, spread < ${SPREAD_LIMIT}.\n`);
console.log(line(header));
for (const r of rows) console.log(line(r));
console.log(
  winners.length === 0
    ? "\nNo stakes in this sweep meet the target."
    : `\nMeet the target: ${winners.map((w) => `ante ${w.stakes.ante}/raise ${w.stakes.raisedBet}`).join(", ")}`,
);
