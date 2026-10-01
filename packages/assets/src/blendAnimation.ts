/**
 * What an object's animation says at a frame: its F-curves read from its action or its NLA strips,
 * and evaluated as Blender evaluates them.
 *
 * **Two ways an action stores its curves.** Before 4.4 an action was a list of F-curves; from 4.4 it
 * is layered — layers of strips, each strip's keyframes in channel bags, one bag a slot — so one
 * action can animate several objects, each reading the bag its slot names. Both are read here into
 * the same `Curve`, and nothing above this module knows which a file used.
 *
 * **What is evaluated, Blender's way**: constant, linear and Bézier keys, the Bézier handles
 * corrected so a segment cannot loop back in time (as Blender corrects them before it draws one),
 * constant or linear extrapolation past the ends, and the Cycles modifier, which is how a looping
 * action is made. **NLA strips** map scene time into each strip's action time by its start, scale
 * and repeats, and hold their ends as their extend mode says.
 *
 * What it gives up, and says through `unread`: the easing modes past Bézier (back, bounce, elastic
 * and the rest, drawn as Bézier), every F-curve modifier but Cycles, drivers, blending between NLA
 * strips other than replacing, and the influence of a strip below one. A file using them animates
 * here as the nearest of what is read, which a bake should check against Blender's own export.
 */

import type { BlendStruct } from './blendData.ts';

/** One keyframed property of one animated datablock. */
export interface Curve {
  /** Blender's data path: `location`, `rotation_euler`, `pose.bones["Spine"].rotation_quaternion`. */
  readonly path: string;
  readonly index: number;
  evaluate(frame: number): number;
  /** The first and last keyed frames. */
  readonly range: readonly [number, number];
}

const BEZT_IPO_CONST = 0;
const BEZT_IPO_LIN = 1;
const FCURVE_EXTRAPOLATE_LINEAR = 1;
/* F-curve modifier types: generator 1, function 2, envelope 3, cycles 4, noise 5. */
const FMODIFIER_TYPE_CYCLES = 4;
const FCM_EXTRAPOLATE_NONE = 0;
const FCM_EXTRAPOLATE_CYCLIC_OFFSET = 2;
const FCM_EXTRAPOLATE_MIRROR = 3;
const NLASTRIP_EXTEND_HOLD = 0;
const NLASTRIP_EXTEND_HOLD_FORWARD = 1;
const NLASTRIP_FLAG_MUTED = 1 << 12;
const NLATRACK_MUTED = 1 << 4;

interface Key {
  x: number;
  y: number;
  /** Left handle, then right. */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  ipo: number;
}

/** The parameter where a cubic's x is `x`, by bisection then Newton: the curve is monotonic. */
function solveBezier(x0: number, x1: number, x2: number, x3: number, x: number): number {
  let lo = 0;
  let hi = 1;
  let t = (x - x0) / (x3 - x0 || 1);
  for (let i = 0; i < 24; i++) {
    const u = 1 - t;
    const at = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
    if (Math.abs(at - x) < 1e-7) return t;
    if (at < x) lo = t;
    else hi = t;
    const slope = 3 * u * u * (x1 - x0) + 6 * u * t * (x2 - x1) + 3 * t * t * (x3 - x2);
    const next = slope !== 0 ? t - (at - x) / slope : (lo + hi) / 2;
    t = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  return t;
}

/** Blender's correction of a Bézier segment's handles, so its x never runs backwards. */
function correct(k0: Key, k1: Key): [number, number, number, number] {
  let h1x = k0.rx - k0.x;
  let h1y = k0.ry - k0.y;
  let h2x = k1.x - k1.lx;
  let h2y = k1.y - k1.ly;
  const span = k1.x - k0.x;
  const total = h1x + h2x;
  if (total > span && total > 0) {
    const f = span / total;
    h1x *= f;
    h1y *= f;
    h2x *= f;
    h2y *= f;
  }
  return [k0.x + h1x, k0.y + h1y, k1.x - h2x, k1.y - h2y];
}

function readKeys(curve: BlendStruct): Key[] {
  const count = curve.int('totvert');
  if (count === 0 || curve.ptr('bezt') === 0n) return [];
  return curve.array('bezt', 'BezTriple', count).map((b) => {
    const v = b.floats('vec');
    return {
      lx: v[0] as number,
      ly: v[1] as number,
      x: v[3] as number,
      y: v[4] as number,
      rx: v[6] as number,
      ry: v[7] as number,
      ipo: b.int('ipo'),
    };
  });
}

/** One F-curve, ready to evaluate. */
export function readCurve(curve: BlendStruct, unread: Set<string>): Curve | null {
  const keys = readKeys(curve);
  if (keys.length === 0) return null;
  const extend = curve.int('extend');
  let cycles: { before: number; after: number } | null = null;
  for (const modifier of curve.list('modifiers')) {
    if (modifier.int('type') === FMODIFIER_TYPE_CYCLES) {
      const data = modifier.deref('data', 'FMod_Cycles');
      cycles = { before: data?.int('before_mode') ?? 1, after: data?.int('after_mode') ?? 1 };
    } else unread.add(`F-curve modifier ${modifier.int('type')}`);
  }
  for (const key of keys) if (key.ipo > 2) unread.add('easing past Bézier');
  const first = keys[0] as Key;
  const last = keys[keys.length - 1] as Key;
  const span = last.x - first.x;

  const plain = (frame: number): number => {
    if (frame <= first.x || keys.length === 1) {
      if (extend !== FCURVE_EXTRAPOLATE_LINEAR || keys.length === 1) return first.y;
      const next = keys[1] as Key;
      const slope =
        first.ipo === BEZT_IPO_BEZ_SLOPE
          ? (first.y - first.ly) / (first.x - first.lx || 1)
          : (next.y - first.y) / (next.x - first.x || 1);
      return first.y + (frame - first.x) * slope;
    }
    if (frame >= last.x) {
      if (extend !== FCURVE_EXTRAPOLATE_LINEAR) return last.y;
      const prev = keys[keys.length - 2] as Key;
      const slope =
        last.ipo === BEZT_IPO_BEZ_SLOPE
          ? (last.ry - last.y) / (last.rx - last.x || 1)
          : (last.y - prev.y) / (last.x - prev.x || 1);
      return last.y + (frame - last.x) * slope;
    }
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((keys[mid] as Key).x <= frame) lo = mid;
      else hi = mid;
    }
    const a = keys[lo] as Key;
    const b = keys[hi] as Key;
    if (a.ipo === BEZT_IPO_CONST) return a.y;
    if (a.ipo === BEZT_IPO_LIN) return a.y + ((frame - a.x) / (b.x - a.x || 1)) * (b.y - a.y);
    const [x1, y1, x2, y2] = correct(a, b);
    const t = solveBezier(a.x, x1, x2, b.x, frame);
    const u = 1 - t;
    return u * u * u * a.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * b.y;
  };

  const evaluate =
    cycles === null || span <= 0
      ? plain
      : (frame: number): number => {
          const before = frame < first.x;
          const mode = before ? cycles.before : cycles.after;
          if ((frame >= first.x && frame <= last.x) || mode === FCM_EXTRAPOLATE_NONE)
            return plain(frame);
          const offset = frame - first.x;
          const cycle = Math.floor(offset / span);
          let local = offset - cycle * span;
          if (mode === FCM_EXTRAPOLATE_MIRROR && cycle % 2 !== 0) local = span - local;
          const value = plain(first.x + local);
          return mode === FCM_EXTRAPOLATE_CYCLIC_OFFSET
            ? value + cycle * (last.y - first.y)
            : value;
        };
  return {
    path: curve.text('rna_path'),
    index: curve.int('array_index'),
    evaluate,
    range: [first.x, last.x],
  };
}

/** Bézier keys whose handles give the slope at an end. */
const BEZT_IPO_BEZ_SLOPE = 2;

/** The F-curves an action holds for `slot`: its channel bag in a layered action, every curve otherwise. */
export function actionCurves(action: BlendStruct, slot: number, unread: Set<string>): Curve[] {
  const out: Curve[] = [];
  const legacy = action.has('curves') ? action.list('curves') : [];
  for (const curve of legacy) {
    const read = readCurve(curve, unread);
    if (read !== null) out.push(read);
  }
  if (!action.has('strip_keyframe_data_array') || action.int('strip_keyframe_data_array_num') === 0)
    return out;
  const scope = action.scope;
  const file = action.file;
  const data = action.pointers(
    'strip_keyframe_data_array',
    action.int('strip_keyframe_data_array_num'),
  );
  for (const address of data) {
    const keyframes = file.at(address, scope, 'ActionStripKeyframeData');
    if (keyframes === null) continue;
    for (const bagAddress of keyframes.pointers(
      'channelbag_array',
      keyframes.int('channelbag_array_num'),
    )) {
      const bag = file.at(bagAddress, scope, 'ActionChannelBag');
      if (bag === null || bag.int('slot_handle') !== slot) continue;
      for (const curveAddress of bag.pointers('fcurve_array', bag.int('fcurve_array_num'))) {
        const curve = file.at(curveAddress, scope, 'FCurve');
        const read = curve === null ? null : readCurve(curve, unread);
        if (read !== null) out.push(read);
      }
    }
  }
  return out;
}

/** An NLA strip's or the active action's curves, and how scene time maps into them. */
interface Source {
  readonly curves: readonly Curve[];
  /** Action time at a scene frame, or null where the strip says nothing then. */
  readonly time: (frame: number) => number | null;
  readonly range: readonly [number, number];
}

function stripSource(strip: BlendStruct, unread: Set<string>): Source | null {
  const action = strip.deref('act');
  if (action === null) return null;
  const curves = actionCurves(
    action,
    strip.has('action_slot_handle') ? strip.int('action_slot_handle') : 0,
    unread,
  );
  if (curves.length === 0) return null;
  const start = strip.float('start');
  const end = strip.float('end');
  const actStart = strip.float('actstart');
  const actEnd = strip.float('actend');
  const scale = Math.abs(strip.float('scale')) || 1;
  const repeat = strip.float('repeat') || 1;
  const length = actEnd - actStart || 1;
  const extend = strip.int('extendmode');
  const time = (frame: number): number | null => {
    if (frame < start) return extend === NLASTRIP_EXTEND_HOLD ? actStart : null;
    if (frame > end)
      return extend === NLASTRIP_EXTEND_HOLD || extend === NLASTRIP_EXTEND_HOLD_FORWARD
        ? actStart + (repeat % 1 === 0 ? length : ((end - start) / scale) % length)
        : null;
    /* At the very end of a whole number of repeats, the end of the action rather than its start. */
    if (frame === end && repeat === Math.floor(repeat)) return actStart + length;
    return (
      actStart +
      ((((frame - start) % (length * scale)) + length * scale) % (length * scale)) / scale
    );
  };
  return { curves, time, range: [start, end] };
}

/** Everything that animates a datablock: its active action, then its NLA tracks bottom to top. */
export class Animation {
  private readonly sources: Source[] = [];
  readonly unread = new Set<string>();

  constructor(id: BlendStruct) {
    const adt = id.has('adt') ? id.deref('adt') : null;
    if (adt === null) return;
    for (const track of adt.list('nla_tracks')) {
      if ((track.int('flag') & NLATRACK_MUTED) !== 0) continue;
      for (const strip of track.list('strips')) {
        if ((strip.int('flag') & NLASTRIP_FLAG_MUTED) !== 0) continue;
        const source = stripSource(strip, this.unread);
        if (source !== null) this.sources.push(source);
      }
    }
    const action = adt.deref('action');
    if (action !== null) {
      const curves = actionCurves(
        action,
        adt.has('slot_handle') ? adt.int('slot_handle') : 0,
        this.unread,
      );
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of curves) {
        lo = Math.min(lo, c.range[0]);
        hi = Math.max(hi, c.range[1]);
      }
      if (curves.length > 0) this.sources.push({ curves, time: (frame) => frame, range: [lo, hi] });
    }
    if (adt.list('drivers').length > 0) this.unread.add('drivers');
  }

  get animated(): boolean {
    return this.sources.length > 0;
  }

  /** The scene frames anything here animates over. */
  get range(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.sources) {
      lo = Math.min(lo, s.range[0]);
      hi = Math.max(hi, s.range[1]);
    }
    return [lo, hi];
  }

  /** Every animated value at `frame`, by `path[index]`; the last source to speak wins. */
  values(frame: number, out: Map<string, number>): Map<string, number> {
    out.clear();
    for (const source of this.sources) {
      const t = source.time(frame);
      if (t === null) continue;
      for (const curve of source.curves)
        out.set(`${curve.path}[${curve.index}]`, curve.evaluate(t));
    }
    return out;
  }
}
