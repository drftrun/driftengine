/**
 * A part's primitive as a solid in its own frame, by the reference's conventions — which phase 1's
 * solids were built to: a box by its full extents, centred; a cylinder, cone and capsule along Y
 * with a unit diameter unless a radius is given; a hemisphere domed up from its base; a quad in XY
 * facing +Z; an extrusion up from 0, or centred; a lathe's profile `(r, y)` about +Y.
 *
 * **A CSG group is meshed once per shape**: its operands' kinds, sizes and relative placements are
 * the key, and every group sharing them — every instance of an arch of one size — takes the one
 * result, as the scripts say the reference does ("every instance of a size shares one generated
 * mesh"). Operands combine left to right from the first, each by its own operation.
 *
 * What gives: a primitive this module does not know returns null and is counted; the corpus's
 * trees and swept spans are generated elsewhere.
 */
import {
  boxBooleanCells,
  emptySolid,
  mergeSolids,
  solidBoxBoolean,
  smoothSolidNormals,
  solidBox,
  solidCapsule,
  solidCone,
  solidCylinder,
  solidExtrude,
  solidFrustum,
  solidHemisphere,
  solidIcosphere,
  solidIntersect,
  solidLathe,
  solidPrism,
  solidQuad,
  solidRoundedBox,
  solidSphere,
  solidSubtract,
  solidTorus,
  solidTube,
  solidUnion,
  transformSolid,
} from '@driftengine/core';
import type { BoxOperation, Solid } from '@driftengine/core';

import type { Value } from '../script/values.ts';
import type { Part } from './flatten.ts';

/** A grid boolean larger than this many cells goes to the BSP instead. */
const GRID_CELLS = 2_000_000;

type Box6 = BoxOperation['box'];

/**
 * A box part as its extent, or null if it is not a box or is turned off the axes: a matrix whose
 * upper 3×3 has one non-zero in every row and column only permutes and scales them.
 */
export function axisBox(part: Part): Box6 | null {
  if (part.kind !== 'Box' || part.csg !== null) return null;
  const m = part.matrix;
  for (let row = 0; row < 3; row += 1) {
    let live = 0;
    /* A quarter turn in f32 leaves 4e-8 where a zero belongs: that is still on the axes. */
    for (let col = 0; col < 3; col += 1) if (Math.abs(m[col * 4 + row] as number) > 1e-6) live += 1;
    if (live !== 1) return null;
  }
  const half = [
    field(part.spec, 'x', 1) / 2,
    field(part.spec, 'y', 1) / 2,
    field(part.spec, 'z', 1) / 2,
  ];
  const extent = (row: number): number => {
    let e = 0;
    for (let col = 0; col < 3; col += 1)
      e += Math.abs(m[col * 4 + row] as number) * (half[col] as number);
    return e;
  };
  const [x, y, z] = [m[12] as number, m[13] as number, m[14] as number];
  return [x - extent(0), y - extent(1), z - extent(2), x + extent(0), y + extent(1), z + extent(2)];
}

/** The operands as box operations, applied in order, or null if any is not an axis-aligned box. */
export function axisBoxes(operands: readonly { part: Part; op: string }[]): BoxOperation[] | null {
  const out: BoxOperation[] = [];
  for (const [index, { part, op }] of operands.entries()) {
    const box = axisBox(part);
    if (box === null) return null;
    out.push({
      box,
      op:
        index === 0 || op === 'CsgUnion'
          ? 'union'
          : op === 'CsgDifference'
            ? 'subtract'
            : 'intersect',
    });
  }
  return out;
}

const field = (spec: Value, key: string, fallback: number): number => {
  const f = spec.k === 'struct' ? spec.fields?.get(key) : undefined;
  return f?.k === 'num' ? f.v : fallback;
};

/** A profile written as positional pairs, flattened: `[a0, b0, a1, b1, …]`. */
function pairs(spec: Value, key: string): number[] {
  const v = spec.k === 'struct' ? spec.fields?.get(key) : undefined;
  if (v?.k !== 'vector') return [];
  const out: number[] = [];
  for (const item of v.items) {
    if (item.k !== 'struct') continue;
    const values = item.fields ? [...item.fields.values()] : item.items;
    for (const x of values.slice(0, 2)) out.push(x.k === 'num' ? x.v : 0);
  }
  return out;
}

/** The solid a primitive component describes, in its entity's frame; null for one not made here. */
export function primitiveSolid(kind: string, spec: Value): Solid | null {
  const n = (key: string, fallback: number): number => field(spec, key, fallback);
  const segments = Math.max(3, Math.round(n('segments', 12)));
  const smooth = n('smooth', 0) !== 0;
  switch (kind) {
    case 'Box':
      return solidBox(n('x', 1), n('y', 1), n('z', 1));
    case 'Cylinder':
      return solidCylinder(0.5, n('length', 1), segments, smooth);
    case 'Cone':
      return solidCone(0.5, n('length', 1), segments, smooth);
    case 'Frustum':
      return solidFrustum(
        n('radius_bottom', 0.5),
        n('radius_top', 0.5),
        n('length', 1),
        segments,
        smooth,
      );
    case 'Tube':
      return solidTube(n('radius', 0.5), n('thickness', 0.1), n('length', 1), segments, smooth);
    case 'Sphere':
      return solidSphere(n('radius', 0.5), segments, smooth);
    case 'HemiSphere':
      return solidHemisphere(n('radius', 0.5), segments, smooth);
    case 'IcoSphere':
      return solidIcosphere(n('radius', 0.5), Math.max(0, Math.round(n('segments', 1))), smooth);
    case 'Capsule':
      return solidCapsule(n('radius', 0.5), n('length', 1), segments, smooth);
    case 'Torus':
      return solidTorus(
        n('radius', 0.5),
        n('tube', 0.1),
        segments,
        Math.max(3, Math.round(n('rings', 6))),
        smooth,
      );
    case 'RoundedBox':
      return solidRoundedBox(
        n('x', 1),
        n('y', 1),
        n('z', 1),
        n('radius', 0.05),
        Math.max(1, Math.round(n('segments', 2))),
      );
    case 'Quad':
      return solidQuad(n('x', 1), n('y', 1));
    case 'TrianglePrism':
      return solidPrism(n('x', 1), n('y', 1), n('z', 1));
    case 'RightTrianglePrism':
      return solidPrism(n('x', 1), n('y', 1), n('z', 1), true);
    case 'Lathe':
      return solidLathe(pairs(spec, 'profile'), segments, smooth);
    case 'Extrude':
      return solidExtrude(pairs(spec, 'profile'), n('height', 1), n('center', 0) !== 0);
    default:
      return null;
  }
}

/** Solids for parts, CSG results shared by shape. */
export class SolidCache {
  private readonly groups = new Map<string, Solid>();
  /** Parts whose primitive this cache cannot mesh, by kind. */
  readonly unmade = new Map<string, number>();
  hits = 0;

  /** What makes a CSG group's shape: its operations, operands, sizes and relative placements. */
  keyOf(part: Pick<Part, 'smooth' | 'csg'>): string {
    return JSON.stringify([
      part.csg?.op ?? '',
      part.smooth,
      (part.csg?.operands ?? []).map((o) => [
        o.op,
        o.part.kind,
        specKey(o.part.spec),
        [...o.part.matrix].map((v) => Math.round(v * 1e4)),
      ]),
    ]);
  }

  /** `part`'s solid in its own frame, smoothed where it asks; null where none is made here. */
  solid(part: Pick<Part, 'kind' | 'spec' | 'smooth' | 'csg'>): Solid | null {
    if (part.csg === null) {
      const solid = primitiveSolid(part.kind, part.spec);
      if (solid === null) {
        this.unmade.set(part.kind, (this.unmade.get(part.kind) ?? 0) + 1);
        return null;
      }
      return part.smooth === null ? solid : smoothSolidNormals(solid, part.smooth);
    }
    const key = this.keyOf(part);
    const cached = this.groups.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    /* A union of solids sharing one material looks, from outside, exactly as the solids merged: the
       boolean only removes faces nobody sees, and it fragments every face it cuts — a lamp head of
       seven frustums came back as 22,644 triangles. So only a group with a difference or an
       intersection in it is cut; a union is merged, each operand keeping its own normals. */
    if (part.csg.operands.every((o) => o.op !== 'CsgDifference' && o.op !== 'CsgIntersection')) {
      const placed: Solid[] = [];
      for (const { part: operand } of part.csg.operands) {
        const own = this.solid(operand);
        if (own !== null) placed.push(transformSolid(own, operand.matrix));
      }
      const merged = mergeSolids(placed);
      this.groups.set(key, merged);
      return merged;
    }
    /* Boxes that keep their axes take the exact grid boolean: the BSP made a cut wall of 27
       boxes 325,187 triangles in a minute, where the grid makes a few hundred in milliseconds. */
    const boxes = axisBoxes(part.csg.operands);
    if (boxes !== null && boxBooleanCells(boxes) <= GRID_CELLS) {
      const exact = solidBoxBoolean(boxes);
      this.groups.set(key, exact);
      return exact;
    }
    const result = this.cut(part.csg.operands);
    const out =
      result === null
        ? emptySolid()
        : part.smooth === null
          ? result
          : smoothSolidNormals(result, part.smooth);
    this.groups.set(key, out);
    return out;
  }

  /**
   * Operands combined, the BSP kept to what only it can do. The corpus writes its groups as
   * unions and then differences; for that shape the order is free, so the boxes among the unions
   * and the cuts are taken together on the grid, a union of other shapes is joined by the BSP and
   * then cut once by all the box cutters built on the grid, and only the round cutters go through
   * the BSP one at a time — on a few hundred faces, not on the fragments of every earlier cut. An
   * arch window made of eighty-six boxes and four cylinders came back as 325,187 triangles cut in
   * order. Any other order of operations is applied as written.
   */
  private cut(operands: readonly { part: Part; op: string }[]): Solid | null {
    const placed = (o: { part: Part }): Solid | null => {
      const own = this.solid(o.part);
      return own === null ? null : transformSolid(own, o.part.matrix);
    };
    const inOrder = (): Solid | null => {
      let result: Solid | null = null;
      for (const o of operands) {
        const solid = placed(o);
        if (solid === null) continue;
        if (result === null) result = solid;
        else if (o.op === 'CsgDifference') result = solidSubtract(result, solid);
        else if (o.op === 'CsgIntersection') result = solidIntersect(result, solid);
        else result = solidUnion(result, solid);
      }
      return result;
    };
    const firstCut = operands.findIndex((o, i) => i > 0 && o.op !== 'CsgUnion');
    const unions = firstCut < 0 ? operands : operands.slice(0, firstCut);
    const cuts = firstCut < 0 ? [] : operands.slice(firstCut);
    if (!cuts.every((o) => o.op === 'CsgDifference')) return inOrder();
    const unionBoxes = unions.map((o) => axisBox(o.part));
    const cutBoxes = cuts.map((o) => axisBox(o.part));
    const boxCutters = cutBoxes.filter((b): b is Box6 => b !== null);
    const roundCutters = cuts.filter((_, i) => cutBoxes[i] === null);
    let result: Solid | null;
    if (unionBoxes.every((b) => b !== null)) {
      const all: BoxOperation[] = [
        ...unionBoxes.map((box): BoxOperation => ({ box: box as Box6, op: 'union' })),
        ...boxCutters.map((box): BoxOperation => ({ box, op: 'subtract' })),
      ];
      if (boxBooleanCells(all) > GRID_CELLS) return inOrder();
      result = solidBoxBoolean(all);
    } else {
      result = null;
      for (const o of unions) {
        const solid = placed(o);
        if (solid !== null) result = result === null ? solid : solidUnion(result, solid);
      }
      const cutter: BoxOperation[] = boxCutters.map((box) => ({ box, op: 'union' }));
      if (result !== null && cutter.length > 0) {
        result =
          boxBooleanCells(cutter) <= GRID_CELLS
            ? solidSubtract(result, solidBoxBoolean(cutter))
            : cuts
                .filter((_, i) => cutBoxes[i] !== null)
                .reduce<Solid>((r, o) => {
                  const solid = placed(o);
                  return solid === null ? r : solidSubtract(r, solid);
                }, result);
      }
    }
    for (const o of roundCutters) {
      const solid = placed(o);
      if (result !== null && solid !== null) result = solidSubtract(result, solid);
    }
    return result;
  }
}

function specKey(spec: Value): unknown {
  if (spec.k === 'num') return Math.round(spec.v * 1e4);
  if (spec.k === 'struct') {
    return spec.fields
      ? [...spec.fields].map(([k, v]) => [k, specKey(v)])
      : spec.items.map(specKey);
  }
  if (spec.k === 'vector') return spec.items.map(specKey);
  if (spec.k === 'symbol') return spec.name;
  return spec.k;
}
