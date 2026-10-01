/**
 * The monorail as the reference's host builds it from its own templates: each line a run of beams
 * swept along Hermite spans between the layout's samples, pylons under it at the line's gap, and a
 * station at every stop.
 *
 * **A beam is placed in the world and draws itself along the line**: its spans are the line's own
 * samples, each tangent the Catmull-Rom estimate from its neighbours, so a straight run stays
 * straight and a fillet bends through it; the posts along it find the line by distance through
 * `AlongSpline`, against a spline entity this module registers for each line. A beam covers the
 * line's `span_length`. **A pylon stands beside the track** and reaches its cross head `reach`
 * over to it, as its template draws it; **a station stands on the track**, its platform to the
 * side, its stair down to the street. Both are lifted by whatever the line has climbed over its
 * cruising height.
 *
 * **What would make it wrong** is a capture where the reference's pylons stand under the beam, or
 * change side along a line.
 */
import type { Value } from '../script/values.ts';
import type { ScriptWorld } from '../script/world.ts';
import type { RailLine, RailStop } from '../layout/monorail.ts';
import type { CityLayout } from '../layout/layout.ts';
import type { Instance } from './instances.ts';
import { chunks, spansOf, splineEntity } from './spans.ts';
import type { P3 } from './spans.ts';

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });
const i32 = (v: number): Value => ({ k: 'num', type: 'i32', v: Math.round(v) });
const nameOf = (v: Value | undefined, fallback: string): string =>
  v?.k === 'entity' ? (v.entity?.name ?? fallback) : fallback;

/** The unit direction from `a` to `b` in plan, and its yaw for a template drawn along local +x. */
function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

export function railInstances(layout: CityLayout, world: ScriptWorld): Instance[] {
  const out: Instance[] = [];
  for (const line of layout.rail.lines) {
    const row = line.row;
    const pts = line.path.map((p, i) => [p[0], line.height[i] ?? 0, p[1]] as P3);
    const n = pts.length;
    if (n < 3) continue;
    const path = splineEntity(world, `rail_path_${line.name}`, pts);
    const cruise = row.n('track_y', 14);
    const at = (i: number): P3 => pts[((i % (n - 1)) + (n - 1)) % (n - 1)] as P3;
    for (const [i0, i1] of chunks(line.along, row.n('span_length', 40))) {
      const s0 = line.along[i0] ?? 0;
      const s1 = line.along[i1] ?? s0;
      out.push({
        name: nameOf(row.v('span'), 'MonoBeam'),
        props: new Map([
          ['path', { k: 'entity', entity: path }],
          ['s0', f32(s0)],
          ['s1', f32(s1)],
          ['posts', i32(Math.max(2, Math.round((s1 - s0) / 8.5)))],
          ['spans', spansOf(pts, true, i0, i1)],
        ]),
        position: [0, 0],
        y: 0,
        yaw: 0,
        source: 'rail',
      });
    }
    /* Pylons at the line's gap, beside the track: right of it — up × tangent — by their reach. */
    const gap = row.n('pylon_gap', 36);
    const reach = 8;
    for (let s = gap / 2; s < line.length; s += gap) {
      let i = 0;
      while (i < n - 2 && (line.along[i + 1] ?? 0) < s) i++;
      const [a, b] = [at(i), at(i + 1)];
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      const t = Math.min(Math.max((s - (line.along[i] ?? 0)) / len, 0), 1);
      const [dx, dz] = [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
      const [rx, rz] = [dz, -dx];
      const height = a[1] + (b[1] - a[1]) * t;
      out.push({
        name: nameOf(row.v('pylon'), 'MonoPylon'),
        props: new Map([
          ['reach', f32(reach)],
          ['lift', f32(Math.max(0, height - cruise))],
        ]),
        position: [a[0] + (b[0] - a[0]) * t + rx * reach, a[2] + (b[2] - a[2]) * t + rz * reach],
        y: 0,
        /* Local +x from the column back over to the track. */
        yaw: yawOf(-rx, -rz),
        source: 'rail',
      });
    }
  }
  for (const stop of layout.rail.stops) out.push(stationOf(stop, layout));
  return out;
}

/** A station on the track at its stop, its platform and stair to one side. */
function stationOf(stop: RailStop, layout: CityLayout): Instance {
  const line = layout.rail.lines.find((l) => l.name === stop.line);
  const cruise = line?.row.n('track_y', 14) ?? 14;
  let height = cruise;
  if (line !== undefined) {
    let i = 0;
    while (i < line.along.length - 2 && (line.along[i + 1] ?? 0) < stop.along) i++;
    height = line.height[i] ?? cruise;
  }
  const props = new Map<string, Value>([['lift', f32(Math.max(0, height - cruise))]]);
  const tint = line?.row.v('tint');
  if (tint !== undefined) props.set('tint', tint);
  return {
    name: 'MonoStation',
    props,
    position: stop.position,
    y: 0,
    /* The heading points local +x along the platform; the template runs its track along +z. */
    yaw: stop.heading + Math.PI / 2,
    source: 'station',
  };
}
