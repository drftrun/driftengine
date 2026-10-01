/**
 * Buildings: which style stands on each lot, how tall, in which colours, with which tenants — the
 * reference's building protocol, as its scripts document it.
 *
 * For each lot, in block order: the styles of its district whose footprint range the lot fits
 * (after the style's inset, quantised to `sizeStep`), whose rarity cap allows one here, and whose
 * shape matches (a polygon lot takes only polygon styles); one drawn by weight. Its height is
 * drawn in its range, biased by its centrality: `f = t · (1 − c · r)`, `t` uniform, `r` the lot's
 * distance from its district's seed over the district's reach — so `c = 1` is tall in the middle
 * and short at the edge, `c = 0` flat. Floors round from that, and the roof is exactly
 * `gh + floors · fh`. A palette is drawn by weight, never the one the previous lot on the block
 * drew; a share of buildings stay dark; tenants are every group-0 slot and one of each other group
 * by weight. Last, the tallest towers whose style ranks for it take the city's sky decks.
 *
 * What gives: the height bias is ours — the scripts say only "0 flat, 1 tall in the middle" — and
 * so is the reach it measures against. A capture of the reference's skyline settles both.
 */
import type { Value } from '../script/values.ts';
import type { Lot } from './lots.ts';
import { area } from './plane.ts';
import type { Vec2 } from './plane.ts';
import type { BuildingStyle, Palette, VenueSlot } from './styleTables.ts';
import type { CityTables } from './tables.ts';

export interface Building {
  readonly lot: number;
  readonly style: BuildingStyle;
  /** The footprint's centre, and the turn that points its local +z at the street. */
  readonly position: Vec2;
  readonly yaw: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly palette: Palette;
  readonly venues: readonly VenueSlot[];
  /** Every prop the protocol hands the template, as script values. */
  readonly props: Map<string, Value>;
}

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });
const i32 = (v: number): Value => ({ k: 'num', type: 'i32', v: v | 0 });

/** One of `items` drawn by `weight`; the first when every weight is zero. */
export function drawByWeight<T>(
  items: readonly T[],
  weight: (t: T) => number,
  random: () => number,
): T {
  const total = items.reduce((sum, t) => sum + Math.max(0, weight(t)), 0);
  let at = random() * total;
  for (const t of items) {
    at -= Math.max(0, weight(t));
    if (at < 0) return t;
  }
  return items[items.length - 1] as T;
}

function centroid(outline: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cz = 0;
  const a = area(outline);
  for (let i = 0; i < outline.length; i += 1) {
    const p = outline[i] as Vec2;
    const q = outline[(i + 1) % outline.length] as Vec2;
    const cross = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * cross;
    cz += (p[1] + q[1]) * cross;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/** A world point into the lot's frame: origin at `centre`, +z along `facing`. */
function toLocal(p: Vec2, centre: Vec2, facing: Vec2): Vec2 {
  const dx = p[0] - centre[0];
  const dz = p[1] - centre[1];
  /* Local x is facing turned a quarter clockwise seen from above: (fz, −fx). */
  return [dx * facing[1] - dz * facing[0], dx * facing[0] + dz * facing[1]];
}

/**
 * A building on every lot some style fits; the rest are vacant — a sliver the diagonal left, or a
 * piece too large for any polygon style once it is turned to face the diagonal — and are paved as
 * open ground.
 */
export function placeBuildings(
  lots: readonly Lot[],
  styles: readonly BuildingStyle[],
  tables: CityTables,
  random: () => number,
): { buildings: Building[]; vacant: Lot[] } {
  const step = tables.value('sizeStep');
  const snap = (v: number): number => Math.floor(v / step) * step;
  const reach = new Map<string, number>();
  for (const lot of lots) {
    const seed = tables.district(lot.district).seed;
    const c = centroid(lot.outline);
    const r = Math.hypot(c[0] - seed[0], c[1] - seed[1]);
    reach.set(lot.district, Math.max(reach.get(lot.district) ?? 0, r));
  }
  const placed = new Map<string, Vec2[]>();
  const lastPalette = new Map<number, string>();
  const buildings: Building[] = [];
  const vacant: Lot[] = [];
  for (const lot of lots) {
    const centre = centroid(lot.outline);
    const local = lot.outline.map((p) => toLocal(p, centre, lot.facing));
    const across = Math.max(...local.map((p) => p[0])) - Math.min(...local.map((p) => p[0]));
    const deep = Math.max(...local.map((p) => p[1])) - Math.min(...local.map((p) => p[1]));
    const fits = styles.filter((s) => {
      if (s.district !== lot.district || s.polygon !== lot.polygon) return false;
      const inset = s.row.n('inset', 0);
      const w = snap(across - 2 * inset);
      const d = snap(deep - 2 * inset);
      if (
        w < s.row.n('min_w') ||
        w > s.row.n('max_w') ||
        d < s.row.n('min_d') ||
        d > s.row.n('max_d')
      ) {
        return false;
      }
      if (s.rarity === null) return true;
      const others = placed.get(s.name) ?? [];
      if (others.length >= s.rarity.maxCount) return false;
      const spacing = s.rarity.minSpacing;
      return others.every((o) => Math.hypot(o[0] - centre[0], o[1] - centre[1]) >= spacing);
    });
    if (fits.length === 0) {
      vacant.push(lot);
      continue;
    }
    const style = drawByWeight(fits, (s) => s.weight, random);
    const r = style.row;
    const inset = r.n('inset', 0);
    const w = snap(across - 2 * inset);
    const d = snap(deep - 2 * inset);
    const seedPoint = tables.district(lot.district).seed;
    const distance = Math.hypot(centre[0] - seedPoint[0], centre[1] - seedPoint[1]);
    const radial = Math.min(1, distance / Math.max(1, reach.get(lot.district) ?? 1));
    const f = random() * (1 - r.n('centrality', 0) * radial);
    const gh = r.n('ground_floor');
    const fh = r.n('floor_height');
    const raw = r.n('height_min') + f * (r.n('height_max') - r.n('height_min'));
    const floors = Math.min(
      r.n('max_floors'),
      Math.max(r.n('min_floors'), Math.round((raw - gh) / fh)),
    );
    const height = gh + floors * fh;
    const previous = lastPalette.get(lot.block);
    const choices =
      style.palettes.length > 1
        ? style.palettes.filter((p) => p.name !== previous)
        : style.palettes;
    const palette = drawByWeight(choices, (p) => p.weight, random);
    lastPalette.set(lot.block, palette.name);
    const dark = random() < r.n('dark_chance', 0);
    const offset = random() * 0.2;
    const seed = 1 + Math.floor(random() * 2147483646);
    const venues = style.venues.filter((v) => v.group === 0);
    const groups = [...new Set(style.venues.map((v) => v.group).filter((g) => g > 0))].sort(
      (a, b) => a - b,
    );
    for (const group of groups) {
      venues.push(
        drawByWeight(
          style.venues.filter((v) => v.group === group),
          (v) => v.weight,
          random,
        ),
      );
    }
    const colWidth = r.n('col_width');
    const props = new Map<string, Value>([
      ['w', f32(w)],
      ['d', f32(d)],
      ['h', f32(height)],
      ['floors', i32(floors)],
      ['gh', f32(gh)],
      ['fh', f32(fh)],
      ['colsW', f32(Math.max(1, Math.round(w / colWidth)))],
      ['colsD', f32(Math.max(1, Math.round(d / colWidth)))],
      ['seed', i32(seed)],
      ['lit', f32(dark ? 0 : r.n('lit') * palette.lit)],
      ['offset', f32(offset)],
      ['skyport', i32(0)],
      ['tint', palette.wall],
      ['trim', palette.trim],
      ['winCol', palette.window],
      ['accent', palette.accent],
      ['variant', i32(palette.variant)],
    ]);
    for (const slot of ['a', 'b', 'c', 'd']) {
      const mat = r.v(`mat_${slot}`);
      if (mat !== undefined) props.set(`mat${slot.toUpperCase()}`, mat);
      props.set(`var${slot.toUpperCase()}`, f32(r.n(`var_${slot}`, 0)));
    }
    if (lot.polygon) {
      for (let i = 0; i < 6; i += 1) {
        const p = local[Math.min(i, local.length - 1)] as Vec2;
        props.set(`px${i}`, f32(p[0]));
        props.set(`pz${i}`, f32(p[1]));
      }
    }
    const list = placed.get(style.name) ?? [];
    list.push(centre);
    placed.set(style.name, list);
    buildings.push({
      lot: lot.id,
      style,
      position: centre,
      yaw: Math.atan2(lot.facing[0], lot.facing[1]),
      width: w,
      depth: d,
      height,
      palette,
      venues,
      props,
    });
  }
  const decks = tables.value('skyports');
  const ranked = buildings
    .filter((b) => b.style.row.n('skyport_rank', 0) > 0)
    .sort(
      (a, b) =>
        b.height - a.height ||
        b.style.row.n('skyport_rank') - a.style.row.n('skyport_rank') ||
        a.lot - b.lot,
    );
  for (const b of ranked.slice(0, decks)) b.props.set('skyport', i32(1));
  return { buildings, vacant };
}
