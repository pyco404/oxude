import { mulberry32 } from "../rng.js";
import type { Policy } from "../agents/policy.js";
import { styleOf, type Style } from "./style.js";
import { expressionOf, ngon, PALETTES, pts, type Anchors, type Ctx, type Expression, type Pt } from "./draw.js";
import { carnival, cracked, hooded, plague, porcelain, theatre } from "./masks.js";
import { antenna, battleworn, screen, visor } from "./androids.js";
import { boar, cat, fox, lynx, owl, raven, serpent, shark, wolf } from "./creatures.js";
import { drawFace, drawHat, drawNeck, FACES, HATS, NECKS, type Accessories } from "./accessories.js";

/**
 * Procedural portraits. Each agent gets a character - a masked player, an
 * android or a creature - in its own colour scheme, on its own plate, with its
 * own head shape and accessories, all chosen from its id. Its decision table
 * sets the expression that character wears: sly for a bluffer, steady for a
 * calm player, fierce for an aggressor, wary for one that backs down.
 *
 * Deterministic: the same id and table always give the same SVG, byte for
 * byte. Nothing here is the Oxude mark - no bull, no horns, no red-and-white
 * split. Presentation only: nothing that plays or pays reads this.
 */

export const PORTRAIT_VERSION = 2;

type Draw = (ctx: Ctx, variant: number) => Anchors;
/**
 * Every character type, with what it has room for: a hat where there are no
 * ears, antennae or hood in the way; a monocle or scar where there is a face
 * to put one on.
 */
export const CHARACTER_TYPES: { name: string; family: "mask" | "android" | "creature"; draw: Draw; hat: boolean; face: boolean }[] = [
  { name: "theatre", family: "mask", draw: theatre, hat: true, face: false },
  { name: "carnival", family: "mask", draw: carnival, hat: false, face: false },
  { name: "porcelain", family: "mask", draw: porcelain, hat: true, face: true },
  { name: "cracked", family: "mask", draw: cracked, hat: true, face: false },
  { name: "plague", family: "mask", draw: plague, hat: false, face: false },
  { name: "hooded", family: "mask", draw: hooded, hat: false, face: false },
  { name: "visor", family: "android", draw: visor, hat: true, face: false },
  { name: "antenna", family: "android", draw: antenna, hat: false, face: false },
  { name: "screen", family: "android", draw: screen, hat: true, face: false },
  { name: "battleworn", family: "android", draw: battleworn, hat: true, face: true },
  { name: "fox", family: "creature", draw: fox, hat: false, face: true },
  { name: "wolf", family: "creature", draw: wolf, hat: false, face: true },
  { name: "owl", family: "creature", draw: owl, hat: true, face: true },
  { name: "raven", family: "creature", draw: raven, hat: true, face: true },
  { name: "serpent", family: "creature", draw: serpent, hat: true, face: true },
  { name: "boar", family: "creature", draw: boar, hat: true, face: true },
  { name: "lynx", family: "creature", draw: lynx, hat: false, face: true },
  { name: "shark", family: "creature", draw: shark, hat: true, face: true },
  { name: "cat", family: "creature", draw: cat, hat: true, face: true },
];

/** The plate behind the character: its shape is one more thing that tells neighbours apart. */
const PLATES: { name: string; points: Pt[] }[] = [
  { name: "hex", points: ngon(50, 50, 48, 6, -Math.PI / 2) },
  { name: "round", points: ngon(50, 50, 47, 20) },
  { name: "diamond", points: [[50, 1], [99, 50], [50, 99], [1, 50]] },
  { name: "shield", points: [[6, 5], [94, 5], [94, 54], [50, 97], [6, 54]] },
  { name: "tile", points: [[14, 3], [86, 3], [97, 14], [97, 86], [86, 97], [14, 97], [3, 86], [3, 14]] },
];

/**
 * Characters are drawn on a 100-unit square and set inside the plate at one
 * fixed scale. The small drawing sits larger - at 24 px the face is what
 * matters, and a hat brim or an ear tip may run to the edge.
 */
const FIT = "translate(9 10) scale(0.82)";
const FIT_SMALL = "translate(4 3) scale(0.92)";

export type Features = { type: string; palette: string; plate: string; variant: number; accessories: Accessories };

export type Portrait = {
  /** The full drawing, for 64 px and up. */
  svg: string;
  /** The simplified drawing for 24-32 px: silhouette, colours and eyes, heavier outline. */
  svgSmall: string;
  /** Every choice, so two agents never share a face. */
  fingerprint: string;
  /** Character type and colour scheme: what tells two faces apart at a glance. Kept distinct first. */
  lookKey: string;
  features: Features;
  style: Style;
  expression: Expression;
};

/** FNV-1a over the id and salt: a stable 32-bit seed. */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type Choice = { type: (typeof CHARACTER_TYPES)[number]; palette: (typeof PALETTES)[number]; plate: (typeof PLATES)[number]; variant: number; accessories: Accessories };

/** The id's choices, without drawing anything: cheap, so finding an unused face costs nothing. */
function choose(agentId: string, salt: number): Choice {
  const rng = mulberry32(seedOf(`${agentId}#${salt}`));
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
  const type = pick(CHARACTER_TYPES);
  const palette = pick(PALETTES);
  const plate = pick(PLATES);
  const variant = Math.floor(rng() * 3);
  const want = { hat: pick(HATS), face: pick(FACES), neck: pick(NECKS) };
  // What the head has no room for is dropped, not squeezed on.
  const accessories: Accessories = { hat: type.hat ? want.hat : "none", face: type.face || want.face === "gem" ? want.face : "none", neck: want.neck };
  return { type, palette, plate, variant, accessories };
}

const keys = (c: Choice, e: Expression) => {
  const a = c.accessories;
  return {
    fingerprint: `v${PORTRAIT_VERSION}-${c.type.name}-${c.palette.name}-${c.plate.name}-${c.variant}-${a.hat}-${a.face}-${a.neck}-${e.mood}${e.wary ? "-wary" : ""}`,
    lookKey: `${c.type.name}-${c.palette.name}`,
  };
};

/**
 * The portrait for an agent. `salt` re-rolls the id's choices while keeping
 * the expression: used only when a face would repeat one already taken.
 */
export function portrait(agentId: string, policy: Policy, salt = 0): Portrait {
  const style = styleOf(policy);
  const expression = expressionOf(style);
  const c = choose(agentId, salt);

  const render = (small: boolean) => {
    // Each drawing gets its own stream from the same seed, so the small one is
    // the same character as the large one, not a re-roll.
    const ctx: Ctx = { rng: mulberry32(seedOf(`${agentId}#${salt}#draw`)), pal: c.palette, expr: expression, small, out: [], ol: small ? 3.4 : 1.8 };
    const anchors = c.type.draw(ctx, c.variant);
    drawFace(ctx, c.accessories.face, anchors);
    drawNeck(ctx, c.accessories.neck, anchors);
    drawHat(ctx, c.accessories.hat, anchors);
    const ground = `<polygon points="${pts(c.plate.points)}" fill="${c.palette.ground}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="geometricPrecision">${ground}<g transform="${small ? FIT_SMALL : FIT}">${ctx.out.join("")}</g></svg>`;
  };
  return {
    svg: render(false),
    svgSmall: render(true),
    ...keys(c, expression),
    features: { type: c.type.name, palette: c.palette.name, plate: c.plate.name, variant: c.variant, accessories: c.accessories },
    style,
    expression,
  };
}

/**
 * A portrait no other agent has. Neighbours should look nothing alike, so the
 * first thing kept distinct is the look - character type and colour scheme,
 * 342 of them - and only once those are hard to find does it settle for a
 * face that differs in plate, shape or accessories. `taken` holds both kinds
 * of key: add a portrait's `lookKey` and `fingerprint` once it is used.
 */
export function uniquePortrait(agentId: string, policy: Policy, taken: ReadonlySet<string>): Portrait & { salt: number } {
  const expression = expressionOf(styleOf(policy));
  for (let salt = 0; salt < 5000; salt++) {
    const k = keys(choose(agentId, salt), expression);
    if (!taken.has(k.fingerprint) && (!taken.has(k.lookKey) || salt >= 400)) return { ...portrait(agentId, policy, salt), salt };
  }
  throw new Error(`no unused portrait for ${agentId}`);
}
