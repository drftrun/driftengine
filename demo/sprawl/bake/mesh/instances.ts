/**
 * The seam between the layout and the meshing: every placement the layout made, as the template or
 * prefab to instantiate, the props to hand it, and where it stands.
 *
 * The props follow each template family's own protocol, as its scripts declare it: a block kind
 * takes its block's size and world centre and its style's material and number slots; an alley is
 * authored along +x and turned a quarter for one that runs along z; the wall and its moat take the
 * ring as a polyline and its gates, towers and lamps as positions along it, each gate carrying the
 * cross-section of the street that passes through it. A lot no style fits is paved with its
 * district's square.
 */
import type { Value } from '../script/values.ts';
import type { CityLayout } from '../layout/layout.ts';
import type { Vec2 } from '../layout/plane.ts';
import type { GroundKind } from '../layout/tables.ts';
import { slab } from './roads.ts';

export interface Instance {
  /** A template, instantiated with `props`; or a prefab, which the entity takes as its base. */
  readonly name: string;
  readonly props: ReadonlyMap<string, Value>;
  readonly position: Vec2;
  readonly y: number;
  readonly yaw: number;
  /** What placed it, for the report. */
  readonly source: string;
  /**
   * Prefabs the entity is also based on, by name: the material a road slab's host gives it, which
   * its template leaves to whoever places it.
   */
  readonly bases?: readonly string[];
  /**
   * A light its host gives it, not its template: a street lamp's bulb, lit by its road's style, and
   * a prop its table says shines. Where it shines is the instance's place at `y`, in the world.
   */
  readonly light?: { readonly intensity: number; readonly range: number; readonly y: number };
}

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });
const i32 = (v: number): Value => ({ k: 'num', type: 'i32', v: v | 0 });
const record = (fields: Record<string, Value>): Value => ({
  k: 'struct',
  fields: new Map(Object.entries(fields)),
  items: [],
});
const vector = (items: Value[]): Value => ({ k: 'vector', items });

function blockProps(
  kind: GroundKind,
  w: number,
  d: number,
  centre: Vec2,
  seed: number,
): Map<string, Value> {
  const props = new Map<string, Value>([
    ['w', f32(w)],
    ['d', f32(d)],
    ['cx', f32(centre[0])],
    ['cz', f32(centre[1])],
    ['seed', i32(seed)],
    ['varA', f32(kind.row.n('var_a', 0))],
    ['varB', f32(kind.row.n('var_b', 0))],
  ]);
  const a = kind.row.v('mat_a');
  const b = kind.row.v('mat_b');
  if (a !== undefined) props.set('matA', a);
  if (b !== undefined) props.set('matB', b);
  return props;
}

export function cityInstances(layout: CityLayout, random: () => number): Instance[] {
  const t = layout.tables;
  const out: Instance[] = [];
  const seed = (): number => 1 + Math.floor(random() * 2147483646);
  for (const b of layout.buildings) {
    out.push({
      name: b.style.template,
      props: b.props,
      position: b.position,
      y: 0,
      yaw: b.yaw,
      source: 'building',
    });
  }
  for (const l of layout.landmarks) {
    out.push({
      name: l.template,
      props: l.props,
      position: l.position,
      y: 0,
      yaw: l.yaw,
      source: 'landmark',
    });
  }
  for (const block of layout.blocks) {
    if (block.ground === null) continue;
    const { x0, z0, x1, z1 } = block.bounds;
    const centre: Vec2 = [(x0 + x1) / 2, (z0 + z1) / 2];
    out.push({
      name: block.ground.template,
      props: blockProps(block.ground, x1 - x0, z1 - z0, centre, seed()),
      position: centre,
      y: 0,
      yaw: 0,
      source: 'ground',
    });
  }
  for (const plan of layout.plans) {
    const block = layout.blocks[plan.block];
    if (block === undefined) continue;
    const court = plan.court ? t.courts.find((c) => c.district === block.district) : undefined;
    if (plan.court && court) {
      const [a, , c] = plan.court as [Vec2, Vec2, Vec2, Vec2];
      const centre: Vec2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      out.push({
        name: court.template,
        props: blockProps(court, c[0] - a[0], c[1] - a[1], centre, seed()),
        position: centre,
        y: 0,
        yaw: 0,
        source: 'court',
      });
    }
    const alley = plan.alley ? t.alleys.find((a) => a.district === block.district) : undefined;
    if (plan.alley && alley) {
      const [a, , c] = plan.alley as [Vec2, Vec2, Vec2, Vec2];
      const alongX = c[0] - a[0] >= c[1] - a[1];
      const centre: Vec2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const props = blockProps(alley, 0, 0, centre, seed());
      props.delete('w');
      props.delete('d');
      props.set('len', f32(alongX ? c[0] - a[0] : c[1] - a[1]));
      props.set('width', f32(alongX ? c[1] - a[1] : c[0] - a[0]));
      out.push({
        name: alley.template,
        props,
        position: centre,
        y: 0,
        yaw: alongX ? 0 : Math.PI / 2,
        source: 'alley',
      });
    }
  }
  const aprons = [...layout.drones.depots, ...layout.skyports.sites];
  const yards = new Set(aprons.map((d) => d.lot));
  for (const d of aprons) {
    const { x0, z0, x1, z1 } = d.lot.bounds;
    const size = { len: x1 - x0, width: z1 - z0, tu: (x1 - x0) / 3, tv: (z1 - z0) / 3 };
    out.push({
      ...slab('WalkSlab', 'Paving', size, (x0 + x1) / 2, (z0 + z1) / 2, false),
      source: 'vacant',
    });
  }
  for (const lot of layout.vacant) {
    if (yards.has(lot)) continue;
    const square =
      t.grounds.find((g) => g.district === lot.district && g.kind === 'BlockPlaza') ??
      t.grounds.find((g) => g.kind === 'BlockPlaza');
    if (square === undefined) continue;
    const { x0, z0, x1, z1 } = lot.bounds;
    const centre: Vec2 = [(x0 + x1) / 2, (z0 + z1) / 2];
    out.push({
      name: square.template,
      props: blockProps(square, x1 - x0, z1 - z0, centre, seed()),
      position: centre,
      y: 0,
      yaw: 0,
      source: 'vacant',
    });
  }
  for (const [list, source] of [
    [layout.lamps, 'lamp'],
    [layout.signals, 'signal'],
    [layout.props, 'prop'],
    [layout.drones.parts, 'prop'],
    [layout.skyports.parts, 'prop'],
    [layout.drones.pads, 'prop'],
  ] as const) {
    for (const p of list)
      out.push({
        name: p.template,
        props: p.props,
        position: p.position,
        y: p.y,
        yaw: p.yaw,
        source,
        ...(p.light === undefined ? {} : { light: p.light }),
      });
  }
  const wall = layout.wall;
  if (wall !== null) {
    const path = vector(wall.path.map(([x, z]) => record({ x: f32(x), y: f32(z) })));
    const gates = vector(
      wall.gates.map((g) => {
        const c = g.road.cls;
        const carriage = 2 * c.lanes * c.laneWidth + c.median;
        const twin = c.median > 0;
        const ca = twin ? c.lanes * c.laneWidth + 0.3 : carriage + 0.6;
        return record({
          s: f32(g.s),
          w: f32(c.width),
          rh: f32(3.6),
          lanes: i32(c.lanes),
          lanew: f32(c.laneWidth),
          med: f32(c.median),
          walk: f32(c.sidewalk),
          nca: i32(twin ? 2 : 1),
          ca: f32(ca),
          cx: f32(twin ? (c.median + ca) / 2 : 0),
          pa: f32(Math.min(c.sidewalk - 0.6, 2.2)),
          px: f32(carriage / 2 + c.sidewalk / 2),
        });
      }),
    );
    const towers = vector(wall.towers.map((w) => record({ s: f32(w.s), w: f32(w.r) })));
    const lamps = vector(wall.lamps.map((s) => record({ s: f32(s) })));
    const common: [string, Value][] = [
      ['path', path],
      ['gates', gates],
      ['n', i32(wall.path.length)],
      ['ng', i32(wall.gates.length)],
      ['t', f32(t.value('wallThickness'))],
      ['seed', i32(seed())],
    ];
    out.push({
      name: 'CityWall',
      props: new Map([
        ...common,
        ['towers', towers],
        ['lamps', lamps],
        ['nt', i32(wall.towers.length)],
        ['nl', i32(wall.lamps.length)],
        ['h', f32(t.value('wallHeight'))],
      ]),
      position: [0, 0],
      y: 0,
      yaw: 0,
      source: 'wall',
    });
    out.push({
      name: 'MoatRing',
      props: new Map([...common, ['width', f32(t.value('wallMoatWidth'))]]),
      position: [0, 0],
      y: 0,
      yaw: 0,
      source: 'wall',
    });
  }
  return out;
}
