/**
 * Lots: every building block cut into plots along its street frontages.
 *
 * **This is the one stage the notes could not recover from the reference, so it is designed here**,
 * from the three numbers the scripts give it — each district's nominal lot, the alley width and
 * minimum block, the court minimum — and the one figure they quote, "eight thousand lots":
 *
 * - A block whose short side takes two lots' depth and a court is a **ring**: perimeter lots
 *   `lotDepth` deep on all four sides, the long sides running corner to corner, and a court inside.
 * - Else, a block at least `alleyMinBlock` across has an **alley** down its long axis, the
 *   district's alley width, between two back-to-back strips that run street to street — where each
 *   strip keeps three quarters of a lot's depth. A district's big lots on another's fine grain
 *   (the reference's map gives the industrial district cells of the market's spacing) make one
 *   deep strip rather than two too shallow for any of its styles.
 * - Else its two strips meet back to back, or it is one strip if it is barely a lot deep.
 *
 * A strip is cut along its street into `round(length / lotWidth)` equal lots, each edge snapped to
 * `lotStep`; its end lots are corner lots. A ring's short end that cannot hold six tenths of a lot
 * is merged into the court rather than cut into slivers no style fits. A piece the diagonal cut is one polygon lot facing the
 * diagonal, which is what the reference's polygon styles take.
 *
 * What would make it wrong: a lot count far from eight thousand, or a capture of the reference
 * whose streets are lined with plots of another rhythm.
 */
import type { Block } from './blocks.ts';
import { area, bounds, rect } from './plane.ts';
import type { Bounds, Vec2 } from './plane.ts';
import type { CityTables } from './tables.ts';

export interface Lot {
  readonly id: number;
  readonly block: number;
  readonly district: string;
  readonly outline: readonly Vec2[];
  readonly bounds: Bounds;
  /** Unit direction from the lot toward its street: a building's local +z. */
  readonly facing: Vec2;
  /** Along the frontage, and back from it. */
  readonly width: number;
  readonly depth: number;
  readonly corner: boolean;
  readonly polygon: boolean;
}

export interface BlockPlan {
  readonly block: number;
  readonly form: 'ring' | 'alley' | 'pair' | 'single' | 'polygon';
  readonly alley: readonly Vec2[] | null;
  readonly court: readonly Vec2[] | null;
}

interface Strip {
  /** Along the frontage: from a to b; the street is on the side `facing` points to. */
  readonly a: number;
  readonly b: number;
  readonly frontAt: number;
  readonly depth: number;
  readonly alongX: boolean;
  readonly facing: Vec2;
  readonly corners: boolean;
}

const snap = (v: number, step: number): number => Math.round(v / step) * step;

/** A ring's end shorter than this share of a lot width is merged into its court. */
const REMAINDER = 0.6;

/** An alley is only cut where each strip keeps this share of the district's lot depth. */
const SHALLOWEST = 0.75;

function cut(
  strip: Strip,
  lotWidth: number,
  step: number,
  emit: (lot: Omit<Lot, 'id' | 'block' | 'district'>) => void,
): void {
  const length = strip.b - strip.a;
  const count = Math.max(1, Math.round(length / lotWidth));
  let from = strip.a;
  for (let i = 0; i < count; i += 1) {
    const to = i === count - 1 ? strip.b : strip.a + snap((length * (i + 1)) / count, step);
    const back = strip.frontAt - strip.depth * (strip.alongX ? strip.facing[1] : strip.facing[0]);
    const [lo, hi] = strip.frontAt < back ? [strip.frontAt, back] : [back, strip.frontAt];
    const outline = strip.alongX ? rect(from, lo, to, hi) : rect(lo, from, hi, to);
    emit({
      outline,
      bounds: bounds(outline),
      facing: strip.facing,
      width: to - from,
      depth: strip.depth,
      corner: strip.corners && (i === 0 || i === count - 1),
      polygon: false,
    });
    from = to;
  }
}

export function buildLots(
  blocks: readonly Block[],
  tables: CityTables,
): { lots: Lot[]; plans: BlockPlan[] } {
  const lots: Lot[] = [];
  const plans: BlockPlan[] = [];
  const step = tables.value('lotStep');
  const alleyMin = tables.value('alleyMinBlock');
  const courtMin = tables.value('courtyardMin');
  for (const block of blocks) {
    if (block.kind !== 'building') continue;
    const district = tables.district(block.district);
    const emit = (lot: Omit<Lot, 'id' | 'block' | 'district'>): void => {
      lots.push({ ...lot, id: lots.length, block: block.id, district: block.district });
    };
    if (!block.rect) {
      emit(polygonLot(block));
      plans.push({ block: block.id, form: 'polygon', alley: null, court: null });
      continue;
    }
    const { x0, z0, x1, z1 } = block.bounds;
    const alongX = x1 - x0 >= z1 - z0;
    const short = alongX ? z1 - z0 : x1 - x0;
    const [s0, s1] = alongX ? [x0, x1] : [z0, z1];
    const [t0, t1] = alongX ? [z0, z1] : [x0, x1];
    const low: Vec2 = alongX ? [0, -1] : [-1, 0];
    const high: Vec2 = alongX ? [0, 1] : [1, 0];
    const alleyWidth =
      tables.alleys.find((a) => a.district === block.district)?.row.n('width') ??
      tables.value('alleyWidth');
    const depth = district.lotDepth;
    const strips: Strip[] = [];
    let form: BlockPlan['form'];
    let alley: Vec2[] | null = null;
    let court: Vec2[] | null = null;
    if (short >= 2 * depth + courtMin) {
      form = 'ring';
      strips.push({ a: s0, b: s1, frontAt: t0, depth, alongX, facing: low, corners: true });
      strips.push({ a: s0, b: s1, frontAt: t1, depth, alongX, facing: high, corners: true });
      const endFacing0: Vec2 = alongX ? [-1, 0] : [0, -1];
      const endFacing1: Vec2 = alongX ? [1, 0] : [0, 1];
      /* A remainder too short to hold a lot is not a strip: it joins the court. */
      const ends = t1 - t0 - 2 * depth >= REMAINDER * district.lotWidth;
      const inner = ends ? depth : 0;
      if (ends) {
        const end = { a: t0 + depth, b: t1 - depth, depth, alongX: !alongX, corners: false };
        strips.push({ ...end, frontAt: s0, facing: endFacing0 });
        strips.push({ ...end, frontAt: s1, facing: endFacing1 });
      }
      court = alongX
        ? rect(s0 + inner, t0 + depth, s1 - inner, t1 - depth)
        : rect(t0 + depth, s0 + inner, t1 - depth, s1 - inner);
    } else if (short >= alleyMin && (short - alleyWidth) / 2 >= SHALLOWEST * depth) {
      form = 'alley';
      const half = (short - alleyWidth) / 2;
      strips.push({ a: s0, b: s1, frontAt: t0, depth: half, alongX, facing: low, corners: true });
      strips.push({ a: s0, b: s1, frontAt: t1, depth: half, alongX, facing: high, corners: true });
      const mid = (t0 + t1) / 2;
      alley = alongX
        ? rect(s0, mid - alleyWidth / 2, s1, mid + alleyWidth / 2)
        : rect(mid - alleyWidth / 2, s0, mid + alleyWidth / 2, s1);
    } else if (short >= 1.5 * depth) {
      form = 'pair';
      strips.push({
        a: s0,
        b: s1,
        frontAt: t0,
        depth: short / 2,
        alongX,
        facing: low,
        corners: true,
      });
      strips.push({
        a: s0,
        b: s1,
        frontAt: t1,
        depth: short / 2,
        alongX,
        facing: high,
        corners: true,
      });
    } else {
      form = 'single';
      strips.push({ a: s0, b: s1, frontAt: t1, depth: short, alongX, facing: high, corners: true });
    }
    for (const strip of strips) cut(strip, district.lotWidth, step, emit);
    plans.push({ block: block.id, form, alley, court });
  }
  return { lots, plans };
}

/** A diagonal piece as one lot, facing across its longest edge that is not on the grid. */
function polygonLot(block: Block): Omit<Lot, 'id' | 'block' | 'district'> {
  const pts = block.outline;
  let best = 0;
  let facing: Vec2 = [0, 1];
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i] as Vec2;
    const q = pts[(i + 1) % pts.length] as Vec2;
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const length = Math.hypot(dx, dz);
    const slanted = Math.abs(dx) > 1e-6 && Math.abs(dz) > 1e-6;
    if (slanted && length > best) {
      best = length;
      /* Outward for the outline order `rect` makes: (dz, -dx). */
      facing = [dz / length, -dx / length];
    }
  }
  const b = block.bounds;
  return {
    outline: pts,
    bounds: b,
    facing,
    width: best,
    depth: Math.abs(area(pts)) / Math.max(best, 1),
    corner: true,
    polygon: true,
  };
}
