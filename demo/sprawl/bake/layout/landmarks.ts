/**
 * Landmarks: each landmark style placed once, highest priority first, on the site that suits it.
 *
 * A site is a block, measured cell to cell (street centre to street centre), or two neighbouring
 * blocks of one district merged across the street between them, which is then closed. The spec's
 * decision for the tallest landmark, whose minimum is larger than any single cell: two cells
 * merged — which only works if a minimum is met by a site's longer side, so that is how it is
 * measured; every other landmark's minimum fits its district's cells either way. A style takes the
 * unclaimed site in its district that meets its minimum and whose
 * distance from the district's seed, over the district's reach, is nearest `1 − centrality` — so
 * `1` wants the middle — and no landmark stands next to another. A merged site is only taken where
 * no single one fits.
 *
 * The site's front faces its widest street. The style's fractions become the template's metres:
 * the plot `w × d` (capped by the style's maximum), the building `bw × bd`, the forecourt `front`
 * in metres, and `bz`, the building's centre, held back from the rear by the setback.
 *
 * What gives: `foot_w` and `foot_d` are read and unused — nothing in the scripts says what they
 * scale. What would make it wrong: a capture where a landmark stands far from where this puts it.
 */
import type { Value } from '../script/values.ts';
import type { ScriptWorld } from '../script/world.ts';
import type { Block } from './blocks.ts';
import type { Vec2 } from './plane.ts';
import type { RoadNetwork } from './roads.ts';
import { pairTargets, rows } from './rows.ts';
import type { Row } from './rows.ts';
import type { CityTables } from './tables.ts';

export interface Landmark {
  readonly style: Row;
  readonly template: string;
  readonly label: string | null;
  /** The name of the open space in front of it: the style's one labelled child. */
  readonly square: string | null;
  readonly blocks: readonly number[];
  readonly position: Vec2;
  readonly yaw: number;
  readonly width: number;
  readonly depth: number;
  readonly props: Map<string, Value>;
}

interface Site {
  readonly blocks: readonly number[];
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  /** The ground it builds on: the blocks' inset extent, the closed street included. */
  readonly inner: { x0: number; z0: number; x1: number; z1: number };
  readonly closes: readonly number[];
}

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });

function sites(blocks: readonly Block[], roads: RoadNetwork): Site[] {
  const usable = blocks.filter((b) => b.rect && b.kind === 'building');
  const out: Site[] = usable.map((b) => ({
    blocks: [b.id],
    ...b.cell,
    inner: { ...b.bounds },
    closes: [],
  }));
  for (const a of usable) {
    for (const b of usable) {
      if (b.id <= a.id || a.district !== b.district) continue;
      const beside = a.cell.x1 === b.cell.x0 && a.cell.z0 === b.cell.z0 && a.cell.z1 === b.cell.z1;
      const above = a.cell.z1 === b.cell.z0 && a.cell.x0 === b.cell.x0 && a.cell.x1 === b.cell.x1;
      if (!beside && !above) continue;
      const between = roads.roads.filter((r) =>
        beside
          ? r.vertical && r.at === a.cell.x1 && r.from >= a.cell.z0 && r.to <= a.cell.z1
          : !r.vertical && r.at === a.cell.z1 && r.from >= a.cell.x0 && r.to <= a.cell.x1,
      );
      if (between.some((r) => r.avenue)) continue;
      out.push({
        blocks: [a.id, b.id],
        x0: a.cell.x0,
        z0: a.cell.z0,
        x1: b.cell.x1,
        z1: b.cell.z1,
        inner: {
          x0: a.bounds.x0,
          z0: a.bounds.z0,
          x1: b.bounds.x1,
          z1: b.bounds.z1,
        },
        closes: between.map((r) => r.id),
      });
    }
  }
  return out;
}

/**
 * Places every landmark style. Where `anchors` names a style, it takes the fitting site nearest
 * that point instead of the one its centrality suggests: **the reference's own map marks each
 * landmark**, and no reading of centrality puts them where it does — the host evidently decides
 * otherwise, possibly with its own draws — so the data folder may carry where they stand.
 */
export function placeLandmarks(
  world: ScriptWorld,
  blocks: Block[],
  roads: RoadNetwork,
  tables: CityTables,
  random: () => number,
  anchors: ReadonlyMap<string, Vec2> = new Map(),
): { landmarks: Landmark[]; closed: Set<number> } {
  const styles = rows(world, 'LandmarkStyle').sort((a, b) => b.n('priority') - a.n('priority'));
  const all = sites(blocks, roads);
  const claimed = new Set<number>();
  const closed = new Set<number>();
  const landmarks: Landmark[] = [];
  const reach = new Map<string, number>();
  for (const block of blocks) {
    const seed = tables.district(block.district).seed;
    const cx = (block.cell.x0 + block.cell.x1) / 2;
    const cz = (block.cell.z0 + block.cell.z1) / 2;
    reach.set(
      block.district,
      Math.max(reach.get(block.district) ?? 0, Math.hypot(cx - seed[0], cz - seed[1])),
    );
  }
  const near = (site: Site): boolean =>
    site.blocks.some((id) => {
      const c = (blocks[id] as Block).cell;
      return [...claimed].some((other) => {
        const o = (blocks[other] as Block).cell;
        return (
          c.x0 <= o.x1 + 1e-6 && o.x0 <= c.x1 + 1e-6 && c.z0 <= o.z1 + 1e-6 && o.z0 <= c.z1 + 1e-6
        );
      });
    });
  for (const style of styles) {
    const district = style.s('district');
    const minimum = style.n('min_size');
    const seed = tables.district(district).seed;
    const target = 1 - style.n('centrality', 0);
    /* An anchored landmark may stand beside another: the map says where, and two do. */
    const anchor = anchors.get(style.entity.name);
    const taken = (s: Site): boolean => s.blocks.some((id) => claimed.has(id));
    const fitting = all.filter(
      (s) =>
        (blocks[s.blocks[0] as number] as Block).district === district &&
        Math.max(s.x1 - s.x0, s.z1 - s.z0) >= minimum &&
        (anchor === undefined ? !near(s) : !taken(s)),
    );
    const singles = fitting.filter((s) => s.blocks.length === 1);
    const pool = singles.length > 0 ? singles : fitting;
    if (pool.length === 0) continue;
    const score = (s: Site): number => {
      const cx = (s.x0 + s.x1) / 2;
      const cz = (s.z0 + s.z1) / 2;
      if (anchor !== undefined) return Math.hypot(cx - anchor[0], cz - anchor[1]);
      const r = Math.hypot(cx - seed[0], cz - seed[1]);
      return Math.abs(r / Math.max(1, reach.get(district) ?? 1) - target);
    };
    const site = pool.reduce((best, s) => (score(s) < score(best) ? s : best));
    for (const id of site.blocks) {
      claimed.add(id);
      (blocks[id] as Block).kind = 'landmark';
    }
    for (const id of site.closes) closed.add(id);
    const { inner } = site;
    const sides: { facing: Vec2; width: number }[] = [
      { facing: [0, -1], width: roads.width(false, site.z0, site.x0, site.x1) },
      { facing: [0, 1], width: roads.width(false, site.z1, site.x0, site.x1) },
      { facing: [-1, 0], width: roads.width(true, site.x0, site.z0, site.z1) },
      { facing: [1, 0], width: roads.width(true, site.x1, site.z0, site.z1) },
    ];
    const centre: Vec2 = [(inner.x0 + inner.x1) / 2, (inner.z0 + inner.z1) / 2];
    const toward = (f: Vec2): number =>
      -(f[0] * (seed[0] - centre[0]) + f[1] * (seed[1] - centre[1]));
    const front = sides.reduce((best, s) =>
      s.width > best.width || (s.width === best.width && toward(s.facing) < toward(best.facing))
        ? s
        : best,
    ).facing;
    const across = front[0] === 0 ? inner.x1 - inner.x0 : inner.z1 - inner.z0;
    const deep = front[0] === 0 ? inner.z1 - inner.z0 : inner.x1 - inner.x0;
    const w = Math.min(style.n('max_w'), across);
    const d = Math.min(style.n('max_d'), deep);
    const bw = w * style.n('build_w');
    const bd = d * style.n('build_d');
    const forecourt = d * (1 - style.n('front'));
    const bz = Math.max(d / 2 - forecourt - bd / 2, -d / 2 + style.n('setback', 0) + bd / 2);
    const yaw = Math.atan2(front[0], front[1]);
    const props = new Map<string, Value>([
      ['w', f32(w)],
      ['d', f32(d)],
      ['bw', f32(bw)],
      ['bd', f32(bd)],
      ['bz', f32(bz)],
      ['h', f32(style.n('height'))],
      ['front', f32(forecourt)],
      ['cx', f32(centre[0])],
      ['cz', f32(centre[1])],
      ['yaw', f32(yaw)],
      ['seed', { k: 'num', type: 'i32', v: 1 + Math.floor(random() * 2147483646) }],
      ['lit', f32(style.n('lit', 1))],
      ['offset', f32(style.n('offset', 0))],
    ]);
    for (const slot of ['a', 'b', 'c', 'd']) {
      const mat = style.v(`mat_${slot}`);
      if (mat !== undefined) props.set(`mat${slot.toUpperCase()}`, mat);
      props.set(`var${slot.toUpperCase()}`, f32(style.n(`var_${slot}`, 0)));
    }
    for (const key of ['tint', 'trim', 'accent', 'glow']) {
      const colour = style.v(key);
      if (colour !== undefined) props.set(key, colour);
    }
    const template = pairTargets(style.entity, 'LandmarkBuildsWith')[0];
    if (template === undefined) throw new Error(`landmark ${style.entity.name} names no template`);
    landmarks.push({
      style,
      template,
      label: style.entity.label,
      square: style.entity.children.find((c) => c.label !== null)?.label ?? null,
      blocks: site.blocks,
      position: centre,
      yaw,
      width: w,
      depth: d,
      props,
    });
  }
  return { landmarks, closed };
}
