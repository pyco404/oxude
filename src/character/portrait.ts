import { mulberry32, type Rng } from "../rng.js";
import type { Policy } from "../agents/policy.js";
import { styleOf, type Style } from "./style.js";

/**
 * Procedural portraits: an angular bull-mask face in the Oxude mark's style -
 * red, white and black, hard polygons, a red-over-black outline around the
 * whole silhouette, the face split down the middle.
 *
 * Deterministic: the same agent id and table always give the same SVG, byte
 * for byte. The table sets the character (how the face carries itself); the id
 * sets the individual (which horns, which markings), so no two agents share a
 * face. Presentation only - nothing that plays or pays reads this.
 */

export const PORTRAIT_VERSION = 1;

const RED = "#ff2d2d";
const WHITE = "#e9e7e4";
const BLACK = "#09090a";
const DIM = "#7f1414";

type Pt = [number, number];

/** Draw space to frame: the face's full reach, horns and outline included, fits 100 x 100. */
const FIT = "translate(10 14) scale(0.8)";

/** The discrete choices an id makes. Together with the style bins, the fingerprint. */
export type Features = {
  horns: 0 | 1 | 2 | 3;
  ears: 0 | 1 | 2;
  crest: 0 | 1 | 2 | 3;
  marking: 0 | 1 | 2 | 3 | 4 | 5;
  nostrils: 0 | 1 | 2;
  ring: 0 | 1;
  /** Which half is red: left (0) or right (1). */
  side: 0 | 1;
  eyeSet: 0 | 1 | 2;
  build: 0 | 1 | 2;
};

export type Portrait = { svg: string; fingerprint: string; features: Features; style: Style };

/** FNV-1a over the id and salt: a stable 32-bit seed. */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pick = (rng: Rng, n: number) => Math.floor(rng() * n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mirror = ([x, y]: Pt): Pt => [100 - x, y];
const pts = (p: Pt[]) => p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");
const poly = (p: Pt[], fill: string) => `<polygon points="${pts(p)}" fill="${fill}"/>`;

/** Style bins that enter the fingerprint: coarse, so a retune of the reading does not reshuffle every face. */
const styleBins = (s: Style) =>
  `${Math.round(s.aggression * 4)}${s.bluff >= 0.5 ? 1 : 0}${s.pressure > 0.2 ? 2 : s.pressure < -0.2 ? 0 : 1}${s.backsDown > 0.5 ? 1 : 0}`;

/**
 * The portrait for an agent. `salt` re-rolls the id's choices while keeping
 * the character: used only when a face would duplicate one already taken.
 */
export function portrait(agentId: string, policy: Policy, salt = 0): Portrait {
  const style = styleOf(policy);
  const rng = mulberry32(seedOf(`${agentId}#${salt}`));
  const f: Features = {
    horns: pick(rng, 4) as Features["horns"],
    ears: pick(rng, 3) as Features["ears"],
    crest: pick(rng, 4) as Features["crest"],
    marking: pick(rng, 6) as Features["marking"],
    nostrils: pick(rng, 3) as Features["nostrils"],
    ring: pick(rng, 2) as Features["ring"],
    side: pick(rng, 2) as Features["side"],
    eyeSet: pick(rng, 3) as Features["eyeSet"],
    build: pick(rng, 3) as Features["build"],
  };
  const fingerprint = `v${PORTRAIT_VERSION}-${styleBins(style)}-${Object.values(f).join("")}`;
  return { svg: draw(style, f, rng), fingerprint, features: f, style };
}

function draw(s: Style, f: Features, rng: Rng): string {
  // Stretched: the presets sit between 0.4 and 0.8, and a face has to tell 0.4
  // from 0.6 at a glance. Anchor and Mirage read calm, Hammer sharp, Bully sharpest.
  const sharp = clamp((s.aggression - 0.3) / 0.5, 0, 1);
  const calm = 1 - sharp; // heavy and steady at 1, sharp and forward at 0
  const twoFaced = s.bluff >= 0.5;
  const build = [-2, 0, 2][f.build]!;

  // --- The head: a symmetric outline, top to chin, as half-widths at each level.
  // Calm widens the jaw and shortens the face; aggression narrows the chin and
  // draws it down to a point.
  const chinY = 86 + sharp * 6;
  const levels: { y: number; w: number }[] = [
    { y: 30, w: 17 + build },
    { y: 34, w: 21 + build },
    { y: 41, w: 31 + build + calm * 2 },
    { y: 47, w: 24 + calm * 4 },
    { y: 62, w: 15 + calm * 8 + build / 2 },
    { y: 76, w: 11 + calm * 7 },
    { y: chinY, w: 5 + calm * 8 - sharp * 2 },
  ];
  const left = levels.map(({ y, w }): Pt => [50 - w, y]);
  const right = levels.map(({ y, w }): Pt => [50 + w, y]);
  const head = [...left, ...right.slice().reverse()];

  // --- Horns, from the upper side of the head outward. The id picks the family;
  // the style sets the set of them: calm keeps them low and heavy, aggression
  // lifts them steep and hooks them forward.
  const base: [Pt, Pt] = [
    [50 - levels[0]!.w + 3, levels[0]!.y + 1],
    [50 - levels[2]!.w + 6, levels[2]!.y - 3],
  ];
  const reach = 22 + calm * 8;
  const lift = 6 + sharp * 20;
  const x0 = 50 - levels[1]!.w;
  let horn: Pt[];
  if (f.horns === 0) {
    // Hook, as on the mark: out wide, then up and in.
    const elbow: Pt = [x0 - reach, 36 - lift * 0.2];
    const tip: Pt = [elbow[0] + 8 + sharp * 6, 30 - lift];
    horn = [base[0], [elbow[0] + 10, elbow[1] - 6], [tip[0] + 2, tip[1] + 10], tip, [elbow[0] - 1, elbow[1] - 4], elbow, base[1]];
  } else if (f.horns === 1) {
    // Sweep: one long blade up and out.
    const tip: Pt = [x0 - reach * 0.85, 28 - lift - 4];
    horn = [base[0], tip, [x0 - reach * 0.55, 38 - lift * 0.3], base[1]];
  } else if (f.horns === 2) {
    // Low: flat and wide, the tip barely rising.
    const tip: Pt = [x0 - reach * 1.05, 34 - lift * 0.45];
    horn = [base[0], [x0 - reach * 0.6, 30 - lift * 0.2], tip, [x0 - reach * 0.7, 40 - lift * 0.1], base[1]];
  } else {
    // Forked: a hook with a second, shorter point off the elbow.
    const elbow: Pt = [x0 - reach * 0.9, 38 - lift * 0.2];
    const tip: Pt = [elbow[0] + 6 + sharp * 6, 30 - lift];
    const spur: Pt = [elbow[0] - 7, elbow[1] - 10 - sharp * 4];
    horn = [base[0], [elbow[0] + 9, elbow[1] - 6], tip, [elbow[0] + 3, elbow[1] - 9], spur, [elbow[0] - 2, elbow[1] + 1], base[1]];
  }

  // --- Ears, under the horns. They droop in an agent that backs down to a raise.
  const droop = s.backsDown > 0.5 ? 6 : 0;
  const ear: Pt[] | null =
    f.ears === 0
      ? null
      : f.ears === 1
        ? [[50 - levels[2]!.w + 2, 40], [50 - levels[2]!.w - 9, 46 + droop], [50 - levels[3]!.w + 1, 47]]
        : [[50 - levels[2]!.w + 2, 40], [50 - levels[2]!.w - 8, 44 + droop], [50 - levels[2]!.w - 4, 47 + droop], [50 - levels[3]!.w + 1, 47]];

  const silhouette: Pt[][] = [horn, horn.map(mirror), head];
  if (ear) silhouette.push(ear, ear.map(mirror));

  // --- The split. Straight down the middle, as on the mark; a bluffer's is
  // twisted - its two halves do not agree about which way the face is turned.
  const twist = twoFaced ? 8 + rng() * 5 : 0;
  const splitTop = 50 + (f.side ? twist : -twist);
  const splitBottom = 50 - (f.side ? twist : -twist);
  const splitAt = (y: number, w: number) => clamp(splitTop + ((splitBottom - splitTop) * (y - 30)) / (chinY - 30), 50 - w + 1, 50 + w - 1);
  const leftHalf: Pt[] = [...left, ...levels.map(({ y, w }): Pt => [splitAt(y, w), y]).reverse()];
  const rightHalf: Pt[] = [...levels.map(({ y, w }): Pt => [splitAt(y, w), y]), ...right.slice().reverse()];
  const [leftColour, rightColour] = f.side ? [WHITE, RED] : [RED, WHITE];

  const out: string[] = [];
  // The outline: red outside, black inside, around the whole silhouette.
  out.push(`<g fill="${RED}" stroke="${RED}" stroke-width="10" stroke-linejoin="miter">${silhouette.map((p) => `<polygon points="${pts(p)}"/>`).join("")}</g>`);
  out.push(`<g fill="${BLACK}" stroke="${BLACK}" stroke-width="4.5" stroke-linejoin="miter">${silhouette.map((p) => `<polygon points="${pts(p)}"/>`).join("")}</g>`);
  out.push(poly(horn, leftColour), poly(horn.map(mirror), rightColour));
  if (ear) out.push(poly(ear, leftColour), poly(ear.map(mirror), rightColour));
  out.push(poly(leftHalf, leftColour), poly(rightHalf, rightColour));

  // --- Crest on the forehead: a spike, three, or a plate. Taller when aggressive.
  const crestH = 5 + sharp * 6;
  if (f.crest === 1) out.push(poly([[46, 31], [50, 31 - crestH], [54, 31], [50, 36]], BLACK));
  if (f.crest === 2) {
    for (const dx of [-7, 0, 7]) out.push(poly([[50 + dx - 3, 32], [50 + dx, 32 - crestH * (dx ? 0.7 : 1)], [50 + dx + 3, 32]], BLACK));
  }
  if (f.crest === 3) out.push(poly([[40, 33], [60, 33], [57, 37], [43, 37]], BLACK));

  // --- Markings, before the eyes so the eyes sit on top.
  const eyeY = 49;
  const eyeDx = [11, 12.5, 14][f.eyeSet]!;
  if (f.marking === 1 && !twoFaced) out.push(poly([[48.5, 38], [51.5, 38], [51, 72], [49, 72]], BLACK));
  const both = (shape: Pt[], fill: string) => out.push(poly(shape, fill), poly(shape.map(mirror), fill));
  if (f.marking === 2) both([[31, 56], [39, 60], [31, 64], [34, 60]], BLACK);
  if (f.marking === 3) out.push(poly([[50, 37], [54, 42], [50, 47], [46, 42]], DIM));
  if (f.marking === 4) out.push(poly([[50 - eyeDx - 7, eyeY - 9], [50 - eyeDx - 5, eyeY - 10], [50 - eyeDx + 8, eyeY + 9], [50 - eyeDx + 6, eyeY + 10]], BLACK));
  if (f.marking === 5) both([[50 - eyeDx - 1, eyeY + 5], [50 - eyeDx + 2, eyeY + 5], [50 - eyeDx + 0.5, eyeY + 11]], BLACK);

  // --- A bluffer wears a half-mask over one eye: the face it shows is not the whole face.
  // Which eye the mask covers follows which half is red, so it varies between bluffers.
  const maskedSide = f.side;
  if (twoFaced) {
    const mask: Pt[] = [[50 - eyeDx - 9, eyeY - 6], [50 - 1, eyeY - 7], [50 - 1, eyeY + 5], [50 - eyeDx - 4, eyeY + 8]];
    out.push(poly(maskedSide ? mask.map(mirror) : mask, BLACK));
  }

  // --- Eyes. Calm: level slits under a heavy lid. Aggressive: cut in a slant,
  // low at the centre, like the mark's scowl. A bluffer's do not match.
  const slant = 1 + sharp * 5;
  // A level slit is symmetric, so it needs no direction.
  const calmEye = (cx: number): Pt[] => [[cx - 6.5, eyeY], [cx - 4, eyeY - 2.6], [cx + 4, eyeY - 2.6], [cx + 6.5, eyeY], [cx + 4, eyeY + 2.2], [cx - 4, eyeY + 2.2]];
  const sharpEye = (cx: number, dir: number): Pt[] => [[cx - 6.5 * dir, eyeY - slant], [cx + 6.5 * dir, eyeY + slant * 0.5], [cx + 2.5 * dir, eyeY + 3.4], [cx - 5 * dir, eyeY + 1.4]];
  const wideEye = (cx: number): Pt[] => [[cx - 6.5, eyeY], [cx, eyeY - 5.5], [cx + 6.5, eyeY], [cx, eyeY + 5.5]];
  const eyeFor = (cx: number, dir: number) => (sharp > 0.5 ? sharpEye(cx, dir) : calmEye(cx));
  const leftEye = eyeFor(50 - eyeDx, 1);
  const rightEye = twoFaced ? wideEye(50 + eyeDx) : eyeFor(50 + eyeDx, -1);
  const [leftEyeFinal, rightEyeFinal] = twoFaced && maskedSide ? [wideEye(50 - eyeDx), eyeFor(50 + eyeDx, -1)] : [leftEye, rightEye];
  const eyeColour = (onLeft: boolean) => (twoFaced && onLeft === !maskedSide ? WHITE : BLACK);
  out.push(poly(leftEyeFinal, eyeColour(true)), poly(rightEyeFinal, eyeColour(false)));
  // Pupils: a red point in each.
  for (const cx of [50 - eyeDx, 50 + eyeDx]) out.push(poly([[cx - 1.8, eyeY], [cx, eyeY - 1.8], [cx + 1.8, eyeY], [cx, eyeY + 1.8]], RED));

  // --- Brows carry pressure: pushed down to a V when it pushes back, raised at
  // the centre when it is rattled, level when it holds. Heavier when calm.
  const tilt = -s.pressure * 4 - sharp * 1.5;
  const browT = 3 + calm * 2;
  const brow = (cx: number, dir: number): Pt[] => [[cx - 7.5 * dir, eyeY - 6.5 + tilt * 0.2], [cx + 7.5 * dir, eyeY - 6.5 - tilt], [cx + 7.5 * dir, eyeY - 6.5 - tilt + browT], [cx - 7.5 * dir, eyeY - 6.5 + tilt * 0.2 + browT]];
  out.push(poly(brow(50 - eyeDx, -1), BLACK), poly(brow(50 + eyeDx, 1), BLACK));

  // --- The muzzle: nostrils, and sometimes a ring through them.
  const noseY = chinY - 12;
  const nostril = (cx: number, dir: number): Pt[] =>
    f.nostrils === 0
      ? [[cx - 1.5, noseY - 2], [cx + 1.5, noseY - 2], [cx + 1.5, noseY + 2], [cx - 1.5, noseY + 2]]
      : f.nostrils === 1
        ? [[cx, noseY - 3], [cx + 2 * dir, noseY + 2], [cx - 2 * dir, noseY + 2]]
        : [[cx - 2.4 * dir, noseY - 1], [cx + 2 * dir, noseY - 2.4], [cx + 1 * dir, noseY + 2]];
  const nx = 4 + calm * 2;
  out.push(poly(nostril(50 - nx, 1), BLACK), poly(nostril(50 + nx, -1), BLACK));
  if (f.ring) {
    const ry = noseY + 6;
    out.push(`<polygon points="${pts([[50 - 3, ry - 2.5], [50 + 3, ry - 2.5], [50 + 4.5, ry + 1], [50 + 2, ry + 4], [50 - 2, ry + 4], [50 - 4.5, ry + 1]])}" fill="none" stroke="${BLACK}" stroke-width="1.8" stroke-linejoin="miter"/>`);
  }

  // Everything is drawn on a 100-unit face; one fixed transform brings the
  // widest horns and the lowest chin inside the frame with the outline, so
  // every face is drawn at the same scale and ladder rows line up.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="geometricPrecision"><g transform="${FIT}">${out.join("")}</g></svg>`;
}

/**
 * A portrait whose face no other agent has: re-rolls the id's choices, keeping
 * the character, until the fingerprint is not in `taken`. The same way marks
 * are made unique - with a store's unique index behind it in production.
 */
export function uniquePortrait(agentId: string, policy: Policy, taken: ReadonlySet<string>): Portrait & { salt: number } {
  for (let salt = 0; salt < 1000; salt++) {
    const p = portrait(agentId, policy, salt);
    if (!taken.has(p.fingerprint)) return { ...p, salt };
  }
  throw new Error(`no unused portrait for ${agentId}`);
}

