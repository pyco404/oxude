import { eyes, mirror, mouth, oval, pair, shape, stroke, type Anchors, type Ctx, type Pt } from "./draw.js";

/**
 * Masked players: the face is what they chose to show. Each is its own
 * silhouette - a mask with ties, a feathered half-mask, a porcelain egg, a
 * broken mask, a beaked plague doctor, a hood with nothing in it but eyes.
 */

/** Mask outline as half-widths down the face, mirrored. */
function faceFrom(levels: [number, number][]): Pt[] {
  const left = levels.map(([y, w]): Pt => [50 - w, y]);
  return [...left, ...left.slice().reverse().map(mirror)];
}

export function theatre(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const w = [26, 22, 28][v]!;
  const chin = [84, 88, 80][v]!;
  // Ribbons first, so the mask sits over them.
  if (!ctx.small) {
    pair(ctx, [[50 - w + 2, 44], [50 - w - 16, 50], [50 - w - 12, 56], [50 - w - 20, 64], [50 - w - 8, 58], [50 - w + 3, 52]], pal.second);
  }
  shape(ctx, faceFrom([[22, w - 8], [28, w], [46, w + 1], [62, w - 4], [74, w - 10], [chin, 4]]), pal.light);
  if (!ctx.small) shape(ctx, [[50 - 4, 30], [50, 26], [54, 30], [50, 36]], pal.second, false);
  eyes(ctx, { y: 46, dx: 11, size: 5, kind: "hole", skin: pal.light });
  if (!ctx.small) mouth(ctx, 50, 68, 16, pal.dark);
  return { top: 22, topW: w - 8, eyeY: 46, eyeDx: 11, chin, chinW: 6 };
}

export function carnival(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // The wearer's face, then the half-mask across the eyes, then its plume.
  shape(ctx, oval(50, 56, 22, 30, 12), pal.light);
  const plumeSide = v === 1 ? -1 : 1;
  const plume: Pt[][] = [0, 1, 2].map((i): Pt[] => {
    const x = 50 + plumeSide * (14 + i * 6);
    return [[x - 3, 40], [x + plumeSide * (4 + i * 3), 10 + i * 5], [x + plumeSide * (7 + i * 3), 14 + i * 5], [x + 3, 42]];
  });
  for (const [i, p] of plume.entries()) shape(ctx, p, i === 1 ? pal.accent : pal.second);
  const band: Pt[] =
    v === 2
      ? [[24, 40], [50, 34], [76, 40], [72, 56], [56, 54], [50, 60], [44, 54], [28, 56]]
      : [[22, 42], [36, 36], [50, 40], [64, 36], [78, 42], [70, 56], [50, 52], [30, 56]];
  shape(ctx, band, pal.main);
  eyes(ctx, { y: 46, dx: 12, size: 4.5, kind: "almond", skin: pal.main });
  if (!ctx.small) {
    shape(ctx, [[50 - 2, 42], [50, 38], [52, 42], [50, 46]], pal.accent, false);
    mouth(ctx, 50, 72, 12, pal.dark);
  }
  return { top: 27, topW: 16, eyeY: 46, eyeDx: 12, chin: 85, chinW: 8 };
}

export function porcelain(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const [rx, ry] = ([[21, 30], [18, 32], [24, 28]] as const)[v]!;
  shape(ctx, oval(50, 54, rx, ry, 14), pal.light);
  if (!ctx.small) {
    // Painted cheeks and a painted tear.
    pair(ctx, [[50 - 15, 62], [50 - 12, 59], [50 - 9, 62], [50 - 12, 65]], pal.second, false);
    shape(ctx, [[50 + 12, 55], [50 + 13.5, 60], [50 + 12, 63], [50 + 10.5, 60]], pal.accent, false);
  }
  eyes(ctx, { y: 50, dx: 10, size: 4, kind: "round", skin: pal.light, iris: pal.main });
  if (!ctx.small) mouth(ctx, 50, 70, 9, pal.second);
  return { top: 54 - ry, topW: rx * 0.6, eyeY: 50, eyeDx: 10, chin: 54 + ry, chinW: rx * 0.4 };
}

export function cracked(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const w = [25, 23, 27][v]!;
  const face = faceFrom([[20, w - 6], [30, w], [52, w], [70, w - 6], [84, 8]]);
  shape(ctx, face, pal.second);
  // A piece gone from one edge: the plate shows through.
  const side = v === 1 ? -1 : 1;
  shape(ctx, [[50 + side * (w + 2), 26], [50 + side * (w - 9), 34], [50 + side * (w - 4), 42], [50 + side * (w + 2), 46]], pal.ground, false);
  eyes(ctx, { y: 46, dx: 11, size: 5, kind: "hole", skin: pal.second });
  if (!ctx.small) {
    stroke(ctx, [[50 - side * 4, 20], [50 - side * 1, 30], [50 - side * 6, 38], [50 - side * 2, 44]], pal.dark, 1.4);
    stroke(ctx, [[50 + side * 6, 60], [50 + side * 14, 66], [50 + side * 12, 74]], pal.dark, 1.2);
    mouth(ctx, 50, 68, 14, pal.dark);
  }
  return { top: 20, topW: w - 6, eyeY: 46, eyeDx: 11, chin: 84, chinW: 8 };
}

export function plague(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // Hood behind, then the brimmed hat, the face and the beak.
  shape(ctx, [[28, 36], [72, 36], [80, 86], [20, 86]], pal.main);
  shape(ctx, [[14, 34], [86, 34], [80, 40], [20, 40]], pal.dark);
  shape(ctx, [[30, 34], [34, 14], [66, 14], [70, 34]], pal.dark);
  if (!ctx.small) shape(ctx, [[33, 28], [67, 28], [68, 32], [32, 32]], pal.second, false);
  const beak: Pt[] =
    v === 0
      ? [[44, 52], [56, 52], [53, 70], [50, 88], [47, 70]]
      : v === 1
        ? [[44, 52], [56, 52], [60, 64], [76, 82], [52, 66]]
        : [[44, 52], [56, 52], [48, 66], [24, 82], [40, 64]];
  shape(ctx, [[32, 40], [68, 40], [66, 62], [34, 62]], pal.second);
  eyes(ctx, { y: 48, dx: 10, size: 5.5, kind: "round", skin: pal.second, iris: pal.accent, brows: false });
  shape(ctx, beak, pal.light);
  return { top: 14, topW: 16, eyeY: 48, eyeDx: 10, chin: 86, chinW: 26 };
}

export function hooded(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const peak = [10, 16, 20][v]!;
  shape(ctx, [[50, peak], [70, 30], [80, 60], [84, 90], [16, 90], [20, 60], [30, 30]], pal.main);
  if (!ctx.small) stroke(ctx, [[50, peak + 4], [44, 30], [38, 44]], pal.second, 1.4);
  // The opening: nothing inside but the eyes.
  shape(ctx, [[50, 32], [64, 40], [68, 62], [58, 76], [42, 76], [32, 62], [36, 40]], pal.dark);
  eyes(ctx, { y: 52, dx: 9, size: 4.2, kind: "glow", skin: pal.dark, brows: false });
  return { top: peak, topW: 6, eyeY: 52, eyeDx: 9, chin: 90, chinW: 30 };
}
