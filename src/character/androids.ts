import { eyes, mouth, ngon, pair, shape, stroke, type Anchors, type Ctx, type Pt } from "./draw.js";

/**
 * Androids: a visor across the eyes, antennae over a boxed head, a face on a
 * screen, a head plated and beaten. The mood reads in the eyes whatever they
 * are made of.
 */

export function visor(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const w = [24, 21, 27][v]!;
  // Ear pods, then the head, then the band of the visor.
  pair(ctx, [[50 - w - 7, 40], [50 - w + 1, 38], [50 - w + 1, 62], [50 - w - 7, 60]], pal.main);
  shape(ctx, [[50 - w + 8, 20], [50 + w - 8, 20], [50 + w, 30], [50 + w, 72], [50 + w - 10, 84], [50 - w + 10, 84], [50 - w, 72], [50 - w, 30]], pal.second);
  shape(ctx, [[50 - w - 2, 40], [50 + w + 2, 40], [50 + w, 56], [50 - w, 56]], pal.dark);
  eyes(ctx, { y: 48, dx: 11, size: 4.5, kind: "glow", skin: pal.dark, brows: false });
  if (!ctx.small) {
    for (const dy of [0, 4, 8]) shape(ctx, [[42, 68 + dy], [58, 68 + dy], [58, 69.6 + dy], [42, 69.6 + dy]], pal.dark, false);
  }
  return { top: 20, topW: w - 8, eyeY: 48, eyeDx: 11, chin: 84, chinW: w - 10 };
}

export function antenna(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const count = [1, 2, 3][v]!;
  const xs = count === 1 ? [50] : count === 2 ? [38, 62] : [36, 50, 64];
  for (const [i, x] of xs.entries()) {
    const lean = (x - 50) * 0.4;
    stroke(ctx, [[x, 30], [x + lean, 12 + (i % 2) * 4]], pal.dark, 2.4);
    shape(ctx, ngon(x + lean, 11 + (i % 2) * 4, 4, 6), pal.accent);
  }
  shape(ctx, [[24, 30], [76, 30], [76, 82], [24, 82]], pal.main);
  if (!ctx.small) shape(ctx, [[24, 30], [76, 30], [72, 36], [28, 36]], pal.light, false);
  // Sockets for the eyes.
  pair(ctx, [[30, 40], [46, 40], [46, 56], [30, 56]], pal.dark, false);
  eyes(ctx, { y: 48, dx: 12, size: 5, kind: "round", skin: pal.dark, iris: pal.accent });
  if (!ctx.small) {
    shape(ctx, [[36, 64], [64, 64], [64, 75], [36, 75]], pal.dark, false);
    for (let x = 39; x < 64; x += 5) shape(ctx, [[x, 66], [x + 2, 66], [x + 2, 73], [x, 73]], pal.second, false);
  }
  return { top: 30, topW: 26, eyeY: 48, eyeDx: 12, chin: 82, chinW: 26 };
}

export function screen(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const [w, h] = ([[30, 24], [26, 26], [32, 22]] as const)[v]!;
  // A stand, then the monitor, then what is on its screen.
  shape(ctx, [[44, 50 + h - 2], [56, 50 + h - 2], [60, 90], [40, 90]], pal.second);
  shape(ctx, [[50 - w, 48 - h], [50 + w, 48 - h], [50 + w, 48 + h], [50 - w, 48 + h]], pal.main);
  shape(ctx, [[50 - w + 5, 48 - h + 5], [50 + w - 5, 48 - h + 5], [50 + w - 5, 48 + h - 5], [50 - w + 5, 48 + h - 5]], pal.dark, false);
  eyes(ctx, { y: 42, dx: 11, size: 4.2, kind: "pixel", skin: pal.dark, iris: pal.accent, brows: false });
  if (!ctx.small) {
    // A mouth in pixels.
    const { mood } = ctx.expr;
    const row = mood === "fierce" ? [1, 0, 1, 0, 1] : mood === "sly" ? [0, 0, 0, 1, 1] : [1, 1, 1, 1, 1];
    for (const [i, on] of row.entries()) {
      const x = 39 + i * 4.6;
      const y = mood === "sly" && i >= 3 ? 55 : 58;
      if (on || mood !== "fierce") shape(ctx, [[x, y], [x + 3.6, y], [x + 3.6, y + 3.2], [x, y + 3.2]], pal.accent, false);
    }
  }
  return { top: 48 - h, topW: w - 4, eyeY: 42, eyeDx: 11, chin: 48 + h, chinW: w - 8 };
}

export function battleworn(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const head: Pt[] = [[30, 22], [58, 18], [74, 28], [78, 52], [70, 76], [54, 86], [36, 84], [24, 66], [22, 40]];
  shape(ctx, head, pal.second);
  if (!ctx.small) {
    // Plates, one of them patched over an eye, and a crack.
    shape(ctx, [[30, 22], [58, 18], [60, 32], [34, 34]], pal.main);
    shape(ctx, [[24, 66], [36, 62], [54, 70], [54, 86], [36, 84]], pal.main);
    for (const [x, y] of [[33, 26], [56, 22], [28, 62], [52, 82]] as Pt[]) shape(ctx, ngon(x, y, 1.4, 6), pal.dark, false);
    stroke(ctx, [[66, 30], [62, 40], [68, 46], [64, 56]], pal.dark, 1.3);
  }
  const patched = v === 2;
  eyes(ctx, { y: 48, dx: 12, size: 4.8, kind: "glow", skin: pal.second, brows: false });
  if (patched) shape(ctx, [[30, 40], [46, 38], [46, 56], [30, 56]], pal.main);
  if (!ctx.small) mouth(ctx, 50, 70, 14, pal.dark);
  return { top: 20, topW: 16, eyeY: 48, eyeDx: 12, chin: 86, chinW: 10 };
}
