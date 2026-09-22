import type { Rng } from "../rng.js";
import type { Style } from "./style.js";

/**
 * Shared drawing for portraits: points, polygons, palettes and the expression
 * a table gives a face. Everything is flat polygons on a 100-unit square, so a
 * face is plain shapes - no text, no links, nothing fetched.
 */

export type Pt = [number, number];

const r1 = (n: number) => Math.round(n * 10) / 10;
export const pts = (p: Pt[]) => p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");
export const mirror = ([x, y]: Pt): Pt => [100 - x, y];
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A regular polygon: circles and discs, kept angular. */
export function ngon(cx: number, cy: number, r: number, n: number, rotation = 0): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = rotation + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as Pt;
  });
}
/** An ellipse as a polygon. */
export function oval(cx: number, cy: number, rx: number, ry: number, n = 10, rotation = -Math.PI / 2): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = rotation + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Pt;
  });
}

/**
 * A curated colour scheme. `ground` is the plate behind the character; `main`
 * and `second` are its body; `accent` its eyes and ornaments; `dark` the
 * outline and shadow; `light` highlights.
 */
export type Palette = { name: string; ground: string; main: string; second: string; accent: string; dark: string; light: string };

/**
 * Broad on purpose: a neighbour on the ladder should differ by its main colour
 * at a glance, so no two schemes share a ground and a body. None is the
 * mark's red and white.
 */
export const PALETTES: Palette[] = [
  { name: "tide", ground: "#123c3a", main: "#2a9d8f", second: "#e9c46a", accent: "#f4f1de", dark: "#081c1b", light: "#bfe7e1" },
  { name: "orchid", ground: "#2b1740", main: "#8e5bd0", second: "#c6f16d", accent: "#f7e36b", dark: "#130a1d", light: "#e3d2f7" },
  { name: "coral", ground: "#1b2a4a", main: "#f08a5d", second: "#f7d6bf", accent: "#5ee3e0", dark: "#0c1426", light: "#ffe9dc" },
  { name: "bullion", ground: "#3a1f2f", main: "#d4a24c", second: "#7b3f61", accent: "#fff1c4", dark: "#1d0e17", light: "#f5deaa" },
  { name: "fern", ground: "#18301f", main: "#5c9a4b", second: "#e8b04a", accent: "#fbf3d5", dark: "#0a170e", light: "#cfe8b8" },
  { name: "glacier", ground: "#1c2733", main: "#9fc6d9", second: "#46647a", accent: "#62f0ff", dark: "#0b1118", light: "#eaf6fb" },
  { name: "rust", ground: "#2e1b12", main: "#c4622d", second: "#efd9b4", accent: "#8fd1c1", dark: "#150b06", light: "#f6e7cf" },
  { name: "neon", ground: "#1a1033", main: "#3d3b8e", second: "#ff6fb5", accent: "#7df9ff", dark: "#0a0618", light: "#d9d6ff" },
  { name: "olive", ground: "#2a2a14", main: "#8a8b3c", second: "#f28f3b", accent: "#fff5d6", dark: "#12120a", light: "#e4e4b5" },
  { name: "slate", ground: "#20242b", main: "#5b6573", second: "#d6dbe2", accent: "#ffcc3d", dark: "#0d0f13", light: "#eef1f5" },
  { name: "wine", ground: "#2a0f19", main: "#8c2f4b", second: "#e8c9a0", accent: "#b5f5a8", dark: "#130609", light: "#f4dfe5" },
  { name: "lagoon", ground: "#0c2b3d", main: "#17a2b8", second: "#0e4f63", accent: "#fff27a", dark: "#05131c", light: "#c7f3fa" },
  { name: "mustard", ground: "#161616", main: "#e0b42f", second: "#3b3b3b", accent: "#f5f5f0", dark: "#070707", light: "#fff3c2" },
  { name: "sage", ground: "#233026", main: "#a3b899", second: "#b5523b", accent: "#f7efe0", dark: "#0f1510", light: "#e3ecdf" },
  { name: "cobalt", ground: "#0f1d45", main: "#2f5bd3", second: "#ffd23f", accent: "#ffffff", dark: "#060d22", light: "#cdd9ff" },
  { name: "magenta", ground: "#16081f", main: "#c2185b", second: "#29b6f6", accent: "#fce4ec", dark: "#0a030e", light: "#f8bbd0" },
  { name: "moss", ground: "#1f2615", main: "#6b7f3a", second: "#c9a7e8", accent: "#f2f0e6", dark: "#0c1008", light: "#dbe5c3" },
  { name: "copper", ground: "#1d2a2e", main: "#b8733f", second: "#3fa7a0", accent: "#fbe7c6", dark: "#0b1113", light: "#f1d2b3" },
];

/** What a table does to a face, whichever character wears it. */
export type Mood = "calm" | "fierce" | "sly";
export type Expression = {
  mood: Mood;
  /** Backs down to a raise: raised inner brows, small pupils. Layered on any mood. */
  wary: boolean;
  /** 0..1: how far the mood is pushed. */
  intensity: number;
};

export function expressionOf(s: Style): Expression {
  const sharp = clamp((s.aggression - 0.3) / 0.5, 0, 1);
  // Bluffing leads: a bluffer's face is its most telling thing, however it raises otherwise.
  const mood: Mood = s.bluff >= 0.5 ? "sly" : sharp >= 0.5 ? "fierce" : "calm";
  const wary = s.backsDown > 0.5 || s.pressure < -0.6;
  const intensity = mood === "sly" ? s.bluff : mood === "fierce" ? sharp : 1 - sharp;
  return { mood, wary, intensity };
}

/** What a character type draws with: its colours, the table's mood, and where to put things. */
export type Ctx = {
  rng: Rng;
  pal: Palette;
  expr: Expression;
  /** The simplified drawing for 24-32 px: silhouette and eyes only, heavier outline. */
  small: boolean;
  out: string[];
  /** Outline width. */
  ol: number;
};

/** A filled shape, outlined in the palette's dark colour unless `line` is false. */
export function shape(ctx: Ctx, p: Pt[], fill: string, line = true): void {
  ctx.out.push(
    line
      ? `<polygon points="${pts(p)}" fill="${fill}" stroke="${ctx.pal.dark}" stroke-width="${ctx.ol}" stroke-linejoin="round"/>`
      : `<polygon points="${pts(p)}" fill="${fill}"/>`,
  );
}
/** Both sides of a symmetric feature: the shape as given and its mirror. */
export function pair(ctx: Ctx, p: Pt[], fill: string, line = true): void {
  shape(ctx, p, fill, line);
  shape(ctx, p.map(mirror), fill, line);
}
/** A plain stroke: cracks, whiskers, stitches. */
export function stroke(ctx: Ctx, p: Pt[], colour: string, width: number): void {
  ctx.out.push(`<polyline points="${pts(p)}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`);
}

/** Where a character's head sits, so accessories can be placed on any of them. */
export type Anchors = {
  /** Top of the head and its half-width there: where a hat sits. */
  top: number;
  topW: number;
  eyeY: number;
  eyeDx: number;
  /** Bottom of the face: where a collar sits. */
  chin: number;
  chinW: number;
};

export type EyeKind = "almond" | "round" | "glow" | "pixel" | "slit" | "hole";

/**
 * A pair of eyes carrying the mood. Calm: heavy lids, level. Fierce: slanted
 * down to the centre under a V of brows. Sly: they do not match - one narrowed,
 * the other wide with its brow raised, both glancing aside. Wary: wide, small
 * pupils, brows raised at the centre.
 */
export function eyes(
  ctx: Ctx,
  a: { y: number; dx: number; size: number; kind: EyeKind; skin: string; iris?: string; brows?: boolean },
): void {
  const { mood, wary, intensity } = ctx.expr;
  const s = ctx.small ? a.size * 1.35 : a.size;
  const iris = a.iris ?? ctx.pal.accent;
  const sides: { cx: number; dir: number; narrow: number; lift: number }[] = [
    { cx: 50 - a.dx, dir: 1, narrow: 0, lift: 0 },
    { cx: 50 + a.dx, dir: -1, narrow: 0, lift: 0 },
  ];
  if (mood === "calm") for (const e of sides) e.narrow = 0.45;
  if (mood === "fierce") for (const e of sides) e.narrow = 0.25 + intensity * 0.15;
  if (mood === "sly") {
    sides[0]!.narrow = 0.6;
    sides[1]!.lift = 1;
  }
  if (wary) for (const e of sides) e.narrow = Math.min(e.narrow, 0.1);
  const glance = mood === "sly" ? s * 0.35 : 0;

  for (const e of sides) {
    const h = s * (1 - e.narrow * 0.7);
    // Fierce eyes tilt down toward the centre; the others sit level.
    const tilt = mood === "fierce" ? s * 0.45 * e.dir * -1 : 0;
    let eye: Pt[];
    if (a.kind === "round" || a.kind === "hole") {
      eye = oval(e.cx, a.y, s, h, 10).map(([x, y]) => [x, y + ((x - e.cx) / s) * tilt * 0.6] as Pt);
    } else if (a.kind === "pixel") {
      eye = [[e.cx - s, a.y - h], [e.cx + s, a.y - h], [e.cx + s, a.y + h], [e.cx - s, a.y + h]];
      eye = eye.map(([x, y]) => [x, y + ((x - e.cx) / s) * tilt * 0.6] as Pt);
    } else {
      // Almond, slit and glow share the pointed shape.
      eye = [
        [e.cx - s * 1.3, a.y - tilt * 0.6],
        [e.cx - s * 0.2, a.y - h],
        [e.cx + s * 0.6, a.y - h * 0.9],
        [e.cx + s * 1.3, a.y + tilt * 0.6],
        [e.cx + s * 0.2, a.y + h * 0.9],
        [e.cx - s * 0.6, a.y + h],
      ];
    }
    const fill = a.kind === "glow" || a.kind === "pixel" ? iris : a.kind === "hole" ? ctx.pal.dark : ctx.pal.light;
    shape(ctx, eye, fill, a.kind !== "glow" && a.kind !== "hole");
    if (a.kind === "almond" || a.kind === "round" || a.kind === "slit") {
      const pr = wary ? s * 0.28 : s * 0.5;
      const px = e.cx + glance;
      const pupil = a.kind === "slit" ? [[px, a.y - h * 0.95], [px + pr * 0.45, a.y], [px, a.y + h * 0.95], [px - pr * 0.45, a.y]] as Pt[] : ngon(px, a.y, Math.min(pr, h * 0.9), 6);
      shape(ctx, pupil, a.kind === "slit" ? ctx.pal.dark : iris, false);
      if (a.kind !== "slit") shape(ctx, ngon(px, a.y, Math.min(pr, h) * 0.45, 4), ctx.pal.dark, false);
    }
    if (a.kind === "hole" || a.kind === "glow") {
      // A point of light in a dark eye: glowing eyes in a hood, the gaze behind a mask.
      shape(ctx, ngon(e.cx + glance, a.y, Math.min(s * 0.35, h * 0.7), 4), a.kind === "glow" ? ctx.pal.light : iris, false);
    }
    // Heavy lids for a calm face: skin drawn down over the top of the eye.
    if (mood === "calm" && !wary && a.kind !== "pixel") {
      shape(ctx, [[e.cx - s * 1.45, a.y - h * 1.3], [e.cx + s * 1.45, a.y - h * 1.3], [e.cx + s * 1.4, a.y - h * 0.15], [e.cx - s * 1.4, a.y - h * 0.15]], a.skin, false);
    }
    if (a.brows !== false && !ctx.small) {
      const by = a.y - h - s * 0.9 - e.lift * s * 0.8;
      // Inner end down for fierce, up for wary, level for calm; the sly face lifts one.
      const inner = mood === "fierce" ? s * 0.9 : wary ? -s * 0.8 : 0;
      const w = s * 1.5;
      const t = s * (mood === "calm" ? 0.55 : 0.4);
      // The inner end is the one toward the centre of the face.
      const outerX = e.cx - w * e.dir;
      const innerX = e.cx + w * e.dir;
      shape(ctx, [[outerX, by], [innerX, by + inner], [innerX, by + inner + t], [outerX, by + t]], ctx.pal.dark, false);
    }
  }
}

/** A mouth in the mood: flat and set, bared, a lopsided smirk, or small and tight when wary. */
export function mouth(ctx: Ctx, cx: number, y: number, w: number, colour: string): void {
  const { mood, wary } = ctx.expr;
  if (ctx.small) {
    shape(ctx, [[cx - w * 0.6, y - 1], [cx + w * 0.6, y - 1], [cx + w * 0.6, y + 1.2], [cx - w * 0.6, y + 1.2]], colour, false);
    return;
  }
  if (wary && mood !== "fierce") {
    shape(ctx, oval(cx, y, w * 0.28, w * 0.2, 8), colour, false);
    return;
  }
  if (mood === "calm") {
    shape(ctx, [[cx - w * 0.55, y - 0.8], [cx + w * 0.55, y - 0.8], [cx + w * 0.5, y + 1], [cx - w * 0.5, y + 1]], colour, false);
  } else if (mood === "fierce") {
    shape(ctx, [[cx - w * 0.6, y - 1], [cx + w * 0.6, y - 1], [cx + w * 0.4, y + w * 0.35], [cx - w * 0.4, y + w * 0.35]], colour, false);
    const teeth: Pt[] = [];
    for (let i = 0; i <= 6; i++) teeth.push([cx - w * 0.55 + (i * w * 1.1) / 6, y - 1 + (i % 2 ? w * 0.16 : 0)]);
    shape(ctx, [...teeth, [cx + w * 0.55, y - 1.2], [cx - w * 0.55, y - 1.2]], ctx.pal.light, false);
  } else {
    // Sly: up at one corner only.
    shape(ctx, [[cx - w * 0.5, y + 0.6], [cx + w * 0.2, y + 0.4], [cx + w * 0.6, y - w * 0.28], [cx + w * 0.52, y + 1.6], [cx - w * 0.45, y + 1.8]], colour, false);
  }
}
