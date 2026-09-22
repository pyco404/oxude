import { writeFileSync } from "node:fs";
import { EDGE_KEYS, SITUATIONS, type Policy, type Situation } from "../src/agents/policy.js";
import { snapshotPreset } from "../src/db/runner.js";
import { PRESET_DESCRIPTIONS, PRESET_NAMES } from "../src/presets.js";
import { portrait, type Portrait } from "../src/character/portrait.js";
import type { Action } from "../src/types.js";

/**
 * A review sheet for the portrait generator: ten faces for each preset and a
 * handful of brief-written tables, each at the sizes the site uses - 24 and
 * 32 px in ladder rows and the feed, 64 on the owner's card, 256 on the agent
 * page. Written to a standalone HTML file, never served by the site.
 *
 *   npx tsx scripts/portrait-gallery.ts [out.html]
 */

const out = process.argv[2] ?? "portrait-gallery.html";

/** A table from one row pattern per situation, weakest edge first: "r c c c r". */
function table(rows: Partial<Record<Situation, string>>, fallback: string): Policy {
  const letter = { f: "fold", c: "call", r: "raise" } as const;
  return Object.fromEntries(
    SITUATIONS.map((s) => {
      const acts = (rows[s] ?? fallback).split(" ").map((l) => letter[l as "f" | "c" | "r"]) as Action[];
      return [s, Object.fromEntries(EDGE_KEYS.map((k, i) => [k, acts[i]!]))];
    }),
  ) as Policy;
}

/** Tables a brief might plausibly produce, chosen to cover the corners the presets leave empty. */
const BRIEFS: { label: string; note: string; table: Policy }[] = [
  {
    label: "The caller",
    note: "Never raises, never folds unless raised at with the worst hand.",
    table: table({ vsRaise: "f c c c c", vsRaiseUnderPressure: "f c c c c" }, "c c c c c"),
  },
  {
    label: "The maniac",
    note: "Raises every hand, calls every raise.",
    table: table({ vsRaise: "c c c c c", vsRaiseUnderPressure: "c c c c c" }, "r r r r r"),
  },
  {
    label: "Folds under fire",
    note: "Plays like Anchor until raised at, then folds all but the best.",
    table: table(
      { leadUnderPressure: "f f f c r", vsCallUnderPressure: "f f f c r", vsRaise: "f f c c c", vsRaiseUnderPressure: "f f f f c" },
      "c c c r r",
    ),
  },
  {
    label: "Pushes back",
    note: "Calm by default; once raised at, raises everything it holds.",
    table: table({ leadUnderPressure: "r r r r r", vsCallUnderPressure: "r r r r r", vsRaise: "f c c c c" }, "c c c r r"),
  },
  {
    label: "Sometimes bluffs",
    note: "Bluffs its second-worst hand when leading, plays straight otherwise.",
    table: table({ lead: "c r c c r", vsRaise: "f f c c c", vsRaiseUnderPressure: "f f c c c" }, "c c c r r"),
  },
  {
    label: "Nearly Anchor",
    note: "Anchor's table with the strongest hand merely called.",
    table: table({ vsRaise: "f f c c c", vsRaiseUnderPressure: "f f c c c", leadUnderPressure: "f c c r c" }, "c c c r c"),
  },
];

const style = (p: Portrait) =>
  `aggr ${p.style.aggression.toFixed(2)} · bluff ${p.style.bluff.toFixed(2)} · pressure ${p.style.pressure >= 0 ? "+" : ""}${p.style.pressure.toFixed(2)} · backs down ${p.style.backsDown.toFixed(2)}`;

const tile = (p: Portrait, caption: string) => `
  <figure class="tile">
    <div class="large">${p.svg}</div>
    <div class="sizes">
      <span style="width:64px;height:64px">${p.svg}</span>
      <span style="width:32px;height:32px">${p.svg}</span>
      <span style="width:24px;height:24px">${p.svg}</span>
    </div>
    <figcaption><b>${caption}</b><br>${style(p)}<br><code>${p.fingerprint}</code></figcaption>
  </figure>`;

const IDS = [
  "3f1c2a90-77b2-4c1e-9a0d-1b2c3d4e5f60", "58c52619-0bb1-215c-7faf-0e1530b96efe", "a1b2c3d4-0000-4000-8000-000000000001",
  "9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0", "0b7f1d22-6c3e-4f9a-8b12-9c4e5d6f7a81", "c0ffee00-1234-4abc-9def-0123456789ab",
  "7d3a9b1e-2f4c-4d6e-8a0b-1c2d3e4f5a6b", "e4d5c6b7-a890-4123-b456-7890abcdef12", "12345678-9abc-4def-8123-456789abcdef",
  "fedcba98-7654-4321-8fed-cba987654321",
];

let sections = "";
let strip = "";
for (const name of PRESET_NAMES) {
  const faces = IDS.map((id) => portrait(`${name}:${id}`, snapshotPreset(name)));
  sections += `<section><h2>${name}</h2><p class="note">${PRESET_DESCRIPTIONS[name]}</p><div class="grid">${faces.map((p, i) => tile(p, `${name} #${i + 1}`)).join("")}</div></section>`;
  strip += faces.map((p, i) => `<li><span class="face">${p.svg}</span><span>${name} #${i + 1}</span><span class="num">${(i * 7 - 20) >= 0 ? "+" : "−"}${Math.abs(i * 7 - 20)}</span></li>`).join("");
}
const briefFaces = BRIEFS.map((b, i) => ({ b, p: portrait(`brief:${IDS[i]}`, b.table) }));
sections += `<section><h2>Brief-written tables</h2><p class="note">A face comes from what the table does, not a preset name. Each of these is a table a brief could produce.</p><div class="grid">${briefFaces.map(({ b, p }) => tile(p, `${b.label} — ${b.note}`)).join("")}</div></section>`;
strip += briefFaces.map(({ b, p }) => `<li><span class="face">${p.svg}</span><span>${b.label}</span><span class="num">+0</span></li>`).join("");

const html = `<title>Oxude Portrait Review</title>
<style>
  :root { --ink:#09090a; --panel:#111113; --panel2:#16161a; --line:#26262c; --text:#e9e7e4; --muted:#8a8a93; --red:#ff2d2d; color-scheme: dark; }
  body { background: var(--ink); color: var(--text); font: 13px/1.5 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; padding-inline: 16px; padding-block: 24px 48px; }
  main { max-width: 1180px; margin: 0 auto; display: grid; gap: 40px; }
  header h1 { font-size: 22px; letter-spacing: 0.18em; color: var(--red); margin: 0 0 8px; }
  header p { color: var(--muted); max-width: 70ch; margin: 0 0 6px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.14em; margin: 0 0 4px; }
  .note { color: var(--muted); margin: 0 0 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .tile { margin: 0; background: var(--panel); border: 1px solid var(--line); padding: 12px; display: grid; gap: 10px; }
  .large { width: 100%; max-width: 256px; aspect-ratio: 1; margin: 0 auto; }
  .large svg, .sizes svg, .face svg { width: 100%; height: 100%; display: block; }
  .sizes { display: flex; gap: 14px; align-items: flex-end; justify-content: center; padding: 8px; background: var(--panel2); }
  .sizes span { display: block; }
  figcaption { color: var(--muted); font-size: 11px; line-height: 1.5; }
  figcaption b { color: var(--text); font-weight: 600; }
  code { color: var(--muted); font-size: 10px; }
  .strip { background: var(--panel); border: 1px solid var(--line); padding: 4px 12px; margin: 0; list-style: none; columns: 2 300px; column-gap: 32px; }
  .strip li { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--line); break-inside: avoid; font-size: 13px; }
  .strip .face { width: 24px; height: 24px; flex: none; }
  .strip .num { margin-left: auto; font-variant-numeric: tabular-nums; }
</style>
<main>
  <header>
    <h1>OXUDE PORTRAITS</h1>
    <p>Generator v1, for review. Every face is drawn from the agent's decision table (how it carries itself) and its id (horns, ears, crest, markings, split side). The same agent always gets the same face.</p>
    <p>What to look for: Anchor calm and heavy, Hammer and Bully sharp and forward, Mirage two-faced, and every face still readable at 24 px.</p>
  </header>
  <section><h2>At ladder size</h2><p class="note">24 px, as a ladder row or feed line would show them. The numbers are placeholders.</p><ul class="strip">${strip}</ul></section>
  ${sections}
</main>`;

writeFileSync(out, html);
console.log(`wrote ${out}`);
