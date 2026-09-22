import { eyes, mirror, mouth, ngon, oval, pair, shape, stroke, type Anchors, type Ctx, type Pt } from "./draw.js";

/**
 * Creatures, drawn geometric and face-on: fox, wolf, owl, raven, serpent,
 * boar, lynx, shark, cat. Each has its own outline - ears, tufts, fins, tusks,
 * a beak - so two of them never read as the same animal at a glance.
 */

const sym = (left: Pt[]): Pt[] => [...left, ...left.slice().reverse().map(mirror)];

export function fox(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const ear = [0, 4, -3][v]!;
  pair(ctx, [[28, 34], [22 - ear, 8], [42, 26]], pal.main);
  if (!ctx.small) pair(ctx, [[29, 30], [25 - ear, 14], [38, 27]], pal.dark, false);
  shape(ctx, sym([[36, 24], [22, 38], [18, 56], [34, 70], [46, 84], [50, 86]]), pal.main);
  // White cheeks meeting at the muzzle.
  shape(ctx, sym([[20, 54], [34, 60], [44, 74], [50, 78]]), pal.light, false);
  eyes(ctx, { y: 46, dx: 11, size: 4.2, kind: "almond", skin: pal.main, iris: pal.second });
  shape(ctx, [[46, 80], [54, 80], [50, 85]], pal.dark);
  if (!ctx.small) mouth(ctx, 50, 76, 8, pal.dark);
  return { top: 24, topW: 12, eyeY: 46, eyeDx: 11, chin: 86, chinW: 4 };
}

export function wolf(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // A ragged mane behind the head.
  if (!ctx.small || v !== 1) {
    shape(ctx, sym([[26, 30], [12, 42], [18, 50], [8, 62], [20, 66], [16, 80], [32, 78], [40, 90], [50, 84]]), pal.second);
  }
  pair(ctx, [[30, 32], [26, 10], [42, 26]], pal.main);
  shape(ctx, sym([[34, 22], [24, 36], [24, 58], [36, 66], [40, 82], [50, 84]]), pal.main);
  shape(ctx, sym([[40, 60], [42, 80], [50, 82]]), pal.light, false);
  eyes(ctx, { y: 46, dx: 11, size: 4, kind: "almond", skin: pal.main, iris: pal.accent });
  shape(ctx, [[45, 76], [55, 76], [53, 81], [47, 81]], pal.dark);
  if (!ctx.small) mouth(ctx, 50, 70, 10, pal.dark);
  return { top: 22, topW: 14, eyeY: 46, eyeDx: 11, chin: 84, chinW: 8 };
}

export function owl(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const tuft = [0, 6, -4][v]!;
  pair(ctx, [[26, 30], [22, 12 - tuft], [38, 24]], pal.main);
  shape(ctx, ngon(50, 54, 30, 8, Math.PI / 8), pal.main);
  if (!ctx.small) {
    for (const y of [74, 80]) shape(ctx, [[42, y], [50, y + 4], [58, y], [58, y + 2], [50, y + 6], [42, y + 2]], pal.second, false);
  }
  // Discs around the eyes, the widest thing on an owl's face.
  pair(ctx, ngon(38, 48, 12, 8, Math.PI / 8), pal.light);
  eyes(ctx, { y: 48, dx: 12, size: 5.5, kind: "round", skin: pal.light, iris: pal.accent, brows: false });
  shape(ctx, [[46, 56], [54, 56], [50, 66]], pal.second);
  return { top: 24, topW: 16, eyeY: 48, eyeDx: 12, chin: 82, chinW: 12 };
}

export function raven(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // A crest of feathers, the sleek head, and the long beak.
  const crest: Pt[] = v === 2 ? [[40, 22], [34, 6], [46, 18], [50, 4], [54, 18], [66, 6], [60, 22]] : [[42, 22], [52, 6], [50, 16], [62, 8], [58, 22]];
  shape(ctx, crest, pal.second);
  shape(ctx, sym([[40, 18], [26, 30], [24, 52], [32, 70], [42, 80], [50, 82]]), pal.main);
  eyes(ctx, { y: 44, dx: 11, size: 4, kind: "round", skin: pal.main, iris: pal.accent });
  const beak: Pt[] = v === 1 ? [[42, 52], [58, 52], [72, 72], [50, 62]] : [[42, 52], [58, 52], [52, 76], [50, 88], [48, 76]];
  shape(ctx, beak, pal.dark);
  if (!ctx.small) stroke(ctx, [[44, 56], [50, 58], [56, 56]], pal.light, 1);
  return { top: 18, topW: 10, eyeY: 44, eyeDx: 11, chin: 82, chinW: 8 };
}

export function serpent(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // A flared hood on some, then the diamond head.
  if (v === 2) shape(ctx, sym([[36, 30], [12, 44], [10, 70], [30, 88], [50, 90]]), pal.second);
  shape(ctx, sym([[50, 16], [30, 30], [22, 48], [30, 68], [44, 80], [50, 82]]), pal.main);
  if (!ctx.small) {
    for (const [x, y] of [[42, 28], [58, 28], [50, 34], [40, 64], [60, 64], [50, 70]] as Pt[]) shape(ctx, [[x, y - 3], [x + 3, y], [x, y + 3], [x - 3, y]], pal.second, false);
  }
  eyes(ctx, { y: 46, dx: 12, size: 4.2, kind: "slit", skin: pal.main, iris: pal.accent });
  // The tongue, forked, out of the mouth.
  if (!ctx.small) shape(ctx, [[49, 80], [51, 80], [51, 88], [55, 94], [50, 90], [45, 94], [49, 88]], pal.accent, false);
  return { top: 16, topW: 6, eyeY: 46, eyeDx: 12, chin: 82, chinW: 6 };
}

export function boar(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  pair(ctx, [[24, 34], [18, 20], [34, 28]], pal.main);
  if (v !== 0) shape(ctx, [[40, 20], [44, 10], [48, 18], [52, 8], [56, 18], [60, 12], [62, 22]], pal.dark);
  shape(ctx, sym([[36, 20], [20, 32], [16, 54], [24, 74], [38, 84], [50, 86]]), pal.main);
  // The snout, the widest part, and tusks up from its sides.
  shape(ctx, oval(50, 68, 13, 9, 8, 0), pal.light);
  pair(ctx, [[36, 72], [30, 58], [34, 60], [40, 70]], pal.light);
  shape(ctx, ngon(45, 68, 2.4, 6), pal.dark, false);
  shape(ctx, ngon(55, 68, 2.4, 6), pal.dark, false);
  eyes(ctx, { y: 44, dx: 12, size: 3.6, kind: "almond", skin: pal.main, iris: pal.accent });
  return { top: 20, topW: 14, eyeY: 44, eyeDx: 12, chin: 86, chinW: 10 };
}

export function lynx(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // Tall ears with tufts, and a ruff at the cheeks.
  pair(ctx, [[28, 32], [30, 8], [44, 26]], pal.main);
  pair(ctx, [[29, 10], [30, 0], [32, 10]], pal.dark);
  shape(ctx, sym([[36, 24], [24, 36], [20, 54], [10, 60], [20, 66], [12, 74], [28, 76], [38, 84], [50, 86]]), pal.main);
  if (!ctx.small) shape(ctx, sym([[26, 60], [34, 66], [40, 76], [50, 78]]), pal.light, false);
  eyes(ctx, { y: 48, dx: 11, size: 4.4, kind: "slit", skin: pal.main, iris: v === 1 ? pal.second : pal.accent });
  shape(ctx, [[46, 62], [54, 62], [50, 67]], pal.dark);
  if (!ctx.small) mouth(ctx, 50, 72, 8, pal.dark);
  return { top: 24, topW: 12, eyeY: 48, eyeDx: 11, chin: 86, chinW: 8 };
}

export function shark(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  // The fin rises from the top of the head.
  const lean = [0, 8, -8][v]!;
  shape(ctx, [[42, 26], [54 + lean, 4], [60, 26]], pal.main);
  shape(ctx, sym([[46, 18], [28, 30], [18, 50], [22, 70], [36, 82], [50, 84]]), pal.main);
  shape(ctx, sym([[24, 66], [36, 78], [50, 80]]), pal.light, false);
  if (!ctx.small) for (const x of [26, 29, 32]) pair(ctx, [[x, 52], [x + 1.4, 52], [x + 1.8, 62], [x + 0.4, 62]], pal.dark, false);
  eyes(ctx, { y: 44, dx: 16, size: 3.6, kind: "round", skin: pal.main, iris: pal.dark });
  // A wide mouth with a row of teeth, fierce or not.
  shape(ctx, [[34, 64], [66, 64], [58, 72], [42, 72]], pal.dark);
  if (!ctx.small) {
    const teeth: Pt[] = [];
    for (let i = 0; i <= 8; i++) teeth.push([35 + i * 3.75, 64 + (i % 2 ? 3.4 : 0)]);
    shape(ctx, [...teeth, [65, 63.6], [35, 63.6]], pal.light, false);
  }
  return { top: 18, topW: 8, eyeY: 44, eyeDx: 16, chin: 84, chinW: 8 };
}

export function cat(ctx: Ctx, v: number): Anchors {
  const { pal } = ctx;
  const ear = [0, 5, -2][v]!;
  pair(ctx, [[24, 38], [22 - ear, 14], [42, 28]], pal.main);
  if (!ctx.small) pair(ctx, [[27, 34], [25 - ear, 20], [37, 29]], pal.second, false);
  shape(ctx, ngon(50, 54, 28, 8, Math.PI / 8).map(([x, y]) => [x, y * 0.95 + 3] as Pt), pal.main);
  eyes(ctx, { y: 50, dx: 11, size: 4.6, kind: "slit", skin: pal.main, iris: pal.accent });
  shape(ctx, [[46, 60], [54, 60], [50, 64]], pal.second);
  if (!ctx.small) {
    mouth(ctx, 50, 68, 8, pal.dark);
    for (const dy of [-2, 2]) {
      stroke(ctx, [[40, 64 + dy], [26, 62 + dy * 2]], pal.light, 0.9);
      stroke(ctx, [[60, 64 + dy], [74, 62 + dy * 2]], pal.light, 0.9);
    }
  }
  return { top: 28, topW: 16, eyeY: 50, eyeDx: 11, chin: 82, chinW: 12 };
}
