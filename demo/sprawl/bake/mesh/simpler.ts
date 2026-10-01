/**
 * What a copy stands as in a region's coarse level: itself, or something simpler that the level's
 * error allows.
 *
 * **A piece made by cutting stands as what it was cut from**: a group's first operand and every
 * operand it joins, each a primitive copy of its own, and none of what it subtracts. A crenellated
 * wall is its wall, a pierced screen its panel — at 1,357 triangles a copy for the city's walls,
 * against 12 for each box. **A rounded box stands as its box.** What it gives up is what the cut
 * removed and what the rounding took off, both filled back in; a cut larger than the level's error
 * — a gate — is filled too. What an intersection leaves is none of its operands, so it stands as it
 * is.
 */
import { multiply } from './flatten.ts';
import type { Kit, CopyOf, Shape } from './kit.ts';
import type { Surface } from './materials.ts';

export function simpler(kit: Kit, part: Shape, surface: Surface, copy: CopyOf): CopyOf[] {
  if (part.csg !== null) {
    const operands = part.csg.operands;
    if (operands.some((o) => o.op === 'CsgIntersection')) return [copy];
    const out: CopyOf[] = [];
    operands.forEach((o, i) => {
      if (i > 0 && o.op === 'CsgDifference') return;
      const made = kit.copyOf({ ...o.part, matrix: multiply(part.matrix, o.part.matrix) }, surface);
      if (made !== null) out.push(made);
    });
    return out;
  }
  if (part.kind === 'RoundedBox') {
    const square = kit.copyOf({ ...part, kind: 'Box' }, surface);
    return square === null ? [copy] : [square];
  }
  return [copy];
}
