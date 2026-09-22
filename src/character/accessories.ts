import { ngon, oval, pair, pts, shape, stroke, type Anchors, type Ctx, type Pt } from "./draw.js";

/**
 * Accessories, placed from a character's anchors so any of them can go on any
 * head that has room: a hat on top, something across the face, something at
 * the neck. Drawn after the character, so they sit in front of it.
 */

// Weighted by repetition: "none" comes up most, so an accessory stays a mark of
// the individual rather than a motif every face shares.
export const HATS = ["none", "none", "none", "top", "beret", "beanie", "bowler", "circlet"] as const;
export const FACES = ["none", "none", "none", "scar", "monocle", "gem"] as const;
export const NECKS = ["none", "none", "none", "collar", "bow", "scarf", "chain"] as const;
export type Accessories = { hat: (typeof HATS)[number]; face: (typeof FACES)[number]; neck: (typeof NECKS)[number] };

export function drawHat(ctx: Ctx, hat: Accessories["hat"], a: Anchors): void {
  const { pal } = ctx;
  const t = a.top;
  const w = Math.max(10, a.topW + 6);
  if (hat === "top") {
    shape(ctx, [[50 - w - 6, t + 2], [50 + w + 6, t + 2], [50 + w + 4, t - 2], [50 - w - 4, t - 2]], pal.dark);
    shape(ctx, [[50 - w + 2, t - 2], [50 + w - 2, t - 2], [50 + w - 4, t - 24], [50 - w + 4, t - 24]], pal.dark);
    if (!ctx.small) shape(ctx, [[50 - w + 2, t - 7], [50 + w - 2, t - 7], [50 + w - 2.4, t - 11], [50 - w + 2.4, t - 11]], pal.second, false);
  } else if (hat === "beret") {
    shape(ctx, [[50 - w - 2, t + 2], [50 - w + 2, t - 8], [50 + 4, t - 12], [50 + w + 8, t - 6], [50 + w + 4, t + 2]], pal.second);
    shape(ctx, [[50 + 2, t - 12], [50 + 4, t - 17], [50 + 6, t - 12]], pal.second);
  } else if (hat === "beanie") {
    shape(ctx, [[50 - w, t + 4], [50 - w + 2, t - 8], [50, t - 14], [50 + w - 2, t - 8], [50 + w, t + 4]], pal.accent);
    shape(ctx, [[50 - w - 1, t + 4], [50 + w + 1, t + 4], [50 + w + 1, t - 1], [50 - w - 1, t - 1]], pal.second);
    shape(ctx, ngon(50, t - 16, 3.4, 6), pal.second);
  } else if (hat === "bowler") {
    shape(ctx, [[50 - w - 5, t + 3], [50 + w + 5, t + 3], [50 + w + 3, t - 1], [50 - w - 3, t - 1]], pal.dark);
    shape(ctx, [...oval(50, t - 6, w - 1, 9, 12, Math.PI).slice(0, 7)], pal.dark);
  } else if (hat === "circlet") {
    shape(ctx, [[50 - w, t + 2], [50 + w, t + 2], [50 + w, t - 3], [50 - w, t - 3]], pal.second);
    shape(ctx, [[50 - 3, t - 3], [50, t - 9], [50 + 3, t - 3]], pal.accent);
  }
}

export function drawFace(ctx: Ctx, face: Accessories["face"], a: Anchors): void {
  if (ctx.small) return;
  const { pal } = ctx;
  const x = 50 - a.eyeDx;
  if (face === "scar") {
    stroke(ctx, [[x - 6, a.eyeY - 10], [x + 5, a.eyeY + 10]], pal.dark, 1.6);
    // Stitches across the cut.
    for (const f of [-0.5, 0, 0.5]) {
      const cx = x - 0.5 + f * 11;
      const cy = a.eyeY + f * 20;
      stroke(ctx, [[cx - 3, cy + 1], [cx + 3, cy - 1]], pal.dark, 1);
    }
  } else if (face === "monocle") {
    const ring = ngon(100 - x, a.eyeY, 7.5, 12);
    ctx.out.push(`<polygon points="${pts(ring)}" fill="none" stroke="${pal.accent}" stroke-width="1.6"/>`);
    stroke(ctx, [[100 - x + 7, a.eyeY + 2], [100 - x + 10, a.eyeY + 18]], pal.accent, 0.9);
  } else if (face === "gem" && !ctx.small) {
    shape(ctx, [[50, a.top + 4], [53, a.top + 8], [50, a.top + 12], [47, a.top + 8]], pal.accent);
  }
}

export function drawNeck(ctx: Ctx, neck: Accessories["neck"], a: Anchors): void {
  const { pal } = ctx;
  const y = Math.min(a.chin, 90);
  const w = Math.max(10, a.chinW + 10);
  if (neck === "collar") {
    pair(ctx, [[50 - w, y - 2], [50 - 1, y + 2], [50 - 1, y + 9], [50 - w - 4, y + 6]], pal.light);
    if (!ctx.small) for (const sx of [-1, 1]) shape(ctx, [[50 + sx * (w - 2), y + 1], [50 + sx * (w + 1), y - 6], [50 + sx * (w + 4), y + 2]], pal.light);
  } else if (neck === "bow") {
    shape(ctx, [[50, y + 3], [40, y - 3], [40, y + 9]], pal.second);
    shape(ctx, [[50, y + 3], [60, y - 3], [60, y + 9]], pal.second);
    shape(ctx, ngon(50, y + 3, 2.6, 6), pal.accent);
  } else if (neck === "scarf") {
    shape(ctx, [[50 - w - 2, y - 3], [50 + w + 2, y - 3], [50 + w, y + 6], [50 - w, y + 6]], pal.second);
    if (!ctx.small) shape(ctx, [[50 + w - 8, y + 4], [50 + w - 2, y + 4], [50 + w, y + 14], [50 + w - 8, y + 12]], pal.second);
  } else if (neck === "chain" && !ctx.small) {
    const links: Pt[] = [];
    for (let i = 0; i <= 8; i++) links.push([50 - w + (i * w * 2) / 8, y + 2 + Math.sin((i / 8) * Math.PI) * 6]);
    stroke(ctx, links, pal.accent, 1.8);
    shape(ctx, [[50, y + 7], [53, y + 11], [50, y + 15], [47, y + 11]], pal.accent);
  }
}
