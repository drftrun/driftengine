/**
 * Props: the street furniture the reference's prop table decides — along every sidewalk, over the
 * market's streets, inside parks, squares and yards, down alleys and on high roofs.
 *
 * **The table's own rules**: each run takes a prop every `propSpacing<District>` on average (drawn
 * from half to one and a half of it), kept `propEndMargin` from the run's ends and clear of lamp
 * poles; a share `propWallChance` stand against the building line, the rest at the kerb. A prop is
 * drawn by weight from the rows of its context whose district mask allows the district (0 is any),
 * and must leave its `clear` of walkway beside it — a row that cannot is redrawn, then the slot
 * left empty. Places take `prop<Kind>Density` props per 1000 m²; alleys one every
 * `propAlleySpacing`; the streets of a district with a `propSpanFactor` a lantern string across
 * every `propLanternFactor` spacings; roofs
 * above `propRoofMinHeight` a prop at `propRoofChance`.
 *
 * Signs and shopfront props hang on a building's sign mounts, which exist only once the building
 * is instantiated, so they are placed with the buildings, not here.
 */
import type { Value } from '../script/values.ts';
import type { Block } from './blocks.ts';
import type { Building } from './buildings.ts';
import { drawByWeight } from './buildings.ts';
import type { Placed, SidewalkRun } from './furniture.ts';
import { roadPoint, towardRoad } from './furniture.ts';
import type { BlockPlan } from './lots.ts';
import { lineStops } from './spans.ts';
import type { LineRun } from './spans.ts';
import { area, bounds } from './plane.ts';
import type { Vec2 } from './plane.ts';
import { pairTargets, rows } from './rows.ts';
import type { Row } from './rows.ts';
import type { CityTables } from './tables.ts';
import type { ScriptWorld } from '../script/world.ts';

interface PropDef {
  readonly row: Row;
  readonly context: string;
  readonly districts: number;
  readonly weight: number;
  readonly template: string;
}

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });
const i32 = (v: number): Value => ({ k: 'num', type: 'i32', v: v | 0 });

function sixProps(
  seed: number,
  district: number,
  w: number,
  h: number,
  tint: Value,
): Map<string, Value> {
  return new Map<string, Value>([
    ['seed', i32(seed)],
    ['kind', i32(-1)],
    ['dist', i32(district)],
    ['w', f32(w)],
    ['h', f32(h)],
    ['tint', tint],
  ]);
}

function placedFrom(
  def: PropDef,
  position: Vec2,
  y: number,
  yaw: number,
  props: Map<string, Value>,
): Placed {
  const r = def.row;
  const light = r.n('light', 0);
  return {
    template: def.template,
    position,
    y,
    yaw,
    props,
    ...(light > 0
      ? { light: { intensity: light, range: r.n('light_range', 10), y: y + r.n('light_y', 3) } }
      : {}),
    ...(r.n('glow', 0) > 0 ? { glow: r.n('glow') } : {}),
  };
}

export function placeProps(
  world: ScriptWorld,
  tables: CityTables,
  runs: readonly SidewalkRun[],
  lamps: readonly Placed[],
  blocks: readonly Block[],
  plans: readonly BlockPlan[],
  buildings: readonly Building[],
  random: () => number,
): Placed[] {
  const defs: PropDef[] = rows(world, 'PropDef').map((r) => ({
    row: r,
    context: r.s('context'),
    districts: r.n('districts', 0),
    weight: r.n('weight', 1),
    template: pairTargets(r.entity, 'PropUses')[0] ?? '',
  }));
  const allowed = (context: string, district: number): PropDef[] =>
    defs.filter(
      (d) =>
        d.context === context &&
        d.template !== '' &&
        (d.districts === 0 || (d.districts & (1 << district)) !== 0),
    );
  const seed = (): number => 1 + Math.floor(random() * 2147483646);
  const out: Placed[] = [];
  const districtAt = (p: Vec2): number | null => {
    const block = blocks.find(
      (b) =>
        p[0] >= b.bounds.x0 && p[0] <= b.bounds.x1 && p[1] >= b.bounds.z0 && p[1] <= b.bounds.z1,
    );
    return block ? tables.district(block.district).index : null;
  };
  const accent = (index: number): Value => {
    const a = tables.districts[index]?.accent ?? [255, 255, 255, 255];
    return {
      k: 'struct',
      fields: new Map(
        ['r', 'g', 'b', 'a'].map((k, i) => [
          k,
          { k: 'num', type: 'u8', v: a[i] as number } as Value,
        ]),
      ),
      items: [],
    };
  };
  const margin = tables.value('propEndMargin');
  const wallChance = tables.value('propWallChance');
  const poles = lamps.filter((l) => l.light === undefined);
  for (const run of runs) {
    const probe = roadPoint(run.road, (run.from + run.to) / 2, run.side * (run.edge + 3));
    const district = districtAt(probe);
    if (district === null) continue;
    const spacing = tables.value(`propSpacing${tables.districts[district]?.short ?? ''}`);
    const sidewalk = run.edge - run.kerb;
    const toward = towardRoad(run.road, run.side);
    const yaw = Math.atan2(toward[0], toward[1]);
    for (
      let along = run.from + margin + random() * spacing;
      along < run.to - margin;
      along += spacing * (0.5 + random())
    ) {
      const wall = random() < wallChance;
      const pool = allowed(wall ? 'PropWall' : 'PropCurb', district);
      if (pool.length === 0) continue;
      let def: PropDef | null = null;
      for (let tries = 0; tries < 3 && def === null; tries += 1) {
        const pick = drawByWeight(pool, (d) => d.weight, random);
        const reach = pick.row.n('offset', 0) + pick.row.n('d', 1) / 2;
        if (sidewalk - reach >= pick.row.n('clear', 1.5)) def = pick;
      }
      if (def === null) continue;
      const across =
        run.side * (wall ? run.edge - def.row.n('offset', 0) : run.kerb + def.row.n('offset', 0));
      const at = roadPoint(run.road, along, across);
      if (!wall && poles.some((p) => Math.hypot(p.position[0] - at[0], p.position[1] - at[1]) < 3))
        continue;
      out.push(
        placedFrom(
          def,
          at,
          0,
          yaw,
          sixProps(seed(), district, def.row.n('w', 1), def.row.n('d', 1), accent(district)),
        ),
      );
    }
  }
  /*
   * Lantern strings and sign spans, over the streets of a district the scripts give a span factor
   * for — every so far along the street, counted across its blocks rather than afresh on each
   * (`spans.ts`). One count a street line and district, since the spacing is the district's.
   */
  const spanRuns: { run: SidewalkRun; district: number; line: LineRun }[] = [];
  for (const run of runs) {
    if (run.side !== 1) continue;
    const district = districtAt(
      roadPoint(run.road, (run.from + run.to) / 2, run.side * (run.edge + 3)),
    );
    if (district === null) continue;
    if (!tables.constants.has(`propSpanFactor${tables.districts[district]?.short ?? ''}`)) continue;
    const line = `${run.road.vertical ? 'v' : 'h'}${run.road.at}|${district}`;
    spanRuns.push({ run, district, line: { line, from: run.from, to: run.to } });
  }
  for (const district of [...new Set(spanRuns.map((r) => r.district))].sort((a, b) => a - b)) {
    const short = tables.districts[district]?.short ?? '';
    const lanterns = allowed('PropLantern', district);
    if (lanterns.length === 0) continue;
    const mine = spanRuns.filter((r) => r.district === district);
    const gap = tables.value(`propSpacing${short}`) * tables.value('propLanternFactor');
    for (const stop of lineStops(
      mine.map((r) => r.line),
      gap,
    )) {
      const { run } = mine[stop.run] as { run: SidewalkRun };
      const def = drawByWeight(lanterns, (d) => d.weight, random);
      const span = run.road.cls.width * tables.value(`propSpanFactor${short}`);
      out.push(
        placedFrom(
          def,
          roadPoint(run.road, stop.along, 0),
          tables.value('propLanternHeight'),
          /* Across the street: the scripts give a span the road's width, along its local x. */
          run.road.vertical ? 0 : Math.PI / 2,
          sixProps(seed(), district, span, def.row.n('d', 1), accent(district)),
        ),
      );
    }
  }
  const places: Record<string, [string, string]> = {
    BlockPark: ['PropPark', 'propParkDensity'],
    BlockPlaza: ['PropPlaza', 'propPlazaDensity'],
    BlockYard: ['PropYard', 'propYardDensity'],
  };
  for (const block of blocks) {
    const place = places[block.kind];
    if (place === undefined) continue;
    const district = tables.district(block.district).index;
    const pool = allowed(place[0], district);
    const count = Math.round((Math.abs(area(block.outline)) / 1000) * tables.value(place[1]));
    const { x0, z0, x1, z1 } = block.bounds;
    for (let i = 0; i < count && pool.length > 0; i += 1) {
      const def = drawByWeight(pool, (d) => d.weight, random);
      const at: Vec2 = [x0 + 3 + random() * (x1 - x0 - 6), z0 + 3 + random() * (z1 - z0 - 6)];
      const yaw = (Math.floor(random() * 4) * Math.PI) / 2;
      out.push(
        placedFrom(
          def,
          at,
          0,
          yaw,
          sixProps(seed(), district, def.row.n('w', 1), def.row.n('d', 1), accent(district)),
        ),
      );
    }
  }
  for (const plan of plans) {
    if (plan.alley === null) continue;
    const block = blocks[plan.block] as Block;
    const district = tables.district(block.district).index;
    const pool = allowed('PropAlley', district);
    const b = bounds(plan.alley);
    const alongX = b.x1 - b.x0 >= b.z1 - b.z0;
    const [s0, s1] = alongX ? [b.x0, b.x1] : [b.z0, b.z1];
    const mid = alongX ? (b.z0 + b.z1) / 2 : (b.x0 + b.x1) / 2;
    for (
      let s = s0 + tables.value('propAlleySpacing') / 2;
      pool.length > 0 && s < s1;
      s += tables.value('propAlleySpacing')
    ) {
      const def = drawByWeight(pool, (d) => d.weight, random);
      const at: Vec2 = alongX ? [s, mid] : [mid, s];
      out.push(
        placedFrom(
          def,
          at,
          0,
          alongX ? 0 : Math.PI / 2,
          sixProps(seed(), district, def.row.n('w', 1), def.row.n('d', 1), accent(district)),
        ),
      );
    }
  }
  const roofs = buildings.length > 0 ? tables.value('propRoofMinHeight') : Infinity;
  for (const b of buildings) {
    if (b.height < roofs || random() >= tables.value('propRoofChance')) continue;
    const district = tables.district(b.style.district).index;
    const pool = allowed('PropRoof', district).filter(
      (d) => d.row.n('min_w', 0) <= Math.min(b.width, b.depth),
    );
    if (pool.length === 0) continue;
    const def = drawByWeight(pool, (d) => d.weight, random);
    out.push(
      placedFrom(
        def,
        b.position,
        b.height,
        b.yaw,
        sixProps(seed(), district, b.width, b.depth, accent(district)),
      ),
    );
  }
  return out;
}
