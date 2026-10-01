/**
 * The street grid: every sector cut into equal blocks, and the lines between them merged across
 * sectors.
 *
 * **The rule** is the reference's, found by the notes from its hand-authored monorail waypoints,
 * which land on these lines and nowhere else: a sector `span` wide at a street `spacing` has
 * `round(span / spacing)` equal blocks on that axis, streets on the divisions and on the sector's
 * edges. Two neighbouring sectors round independently, so a street may stop at a sector edge — a
 * T-junction, as the reference's own map shows.
 *
 * A cell never straddles two sectors, so each has one district: its sector's, unless the caller
 * overrides it. **The reference's own city map disagrees with its sector table in 50 of 460 cells**
 * — whole patches, the same on two captures — so the sectors decide the grain of the streets and a
 * per-cell table, where the data folder carries one, decides the districts the player sees.
 */
import { cRound } from '../script/numeric.ts';
import type { CityTables, Sector } from './tables.ts';

export interface Cell {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly district: string;
  readonly sector: number;
}

/** One straight street line at `at` (x for a vertical line, z for a horizontal one). */
export interface StreetLine {
  readonly vertical: boolean;
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** A district for the cell whose centre is at (x, z). */
export interface CellDistrict {
  readonly x: number;
  readonly z: number;
  readonly district: string;
}

export interface Grid {
  readonly cells: readonly Cell[];
  /** Merged lines: one entry per unbroken run at one coordinate. */
  readonly lines: readonly StreetLine[];
}

/** Positions of a sector's streets along one axis: its edges and its divisions. */
export function divisions(from: number, to: number, spacing: number): number[] {
  const count = Math.max(1, cRound((to - from) / spacing));
  const out: number[] = [];
  for (let i = 0; i <= count; i += 1) out.push(i === count ? to : from + ((to - from) * i) / count);
  return out;
}

/** Coordinates within this distance are one line: sector edges are exact, divisions are not. */
const SAME = 1e-3;

function merge(lines: StreetLine[]): StreetLine[] {
  const byLine = new Map<string, StreetLine[]>();
  for (const line of lines) {
    const key = `${line.vertical ? 'x' : 'z'}${Math.round(line.at / SAME)}`;
    const list = byLine.get(key) ?? [];
    list.push(line);
    byLine.set(key, list);
  }
  const out: StreetLine[] = [];
  for (const list of byLine.values()) {
    list.sort((a, b) => a.from - b.from);
    let run = list[0] as StreetLine;
    for (const next of list.slice(1)) {
      if (next.from <= run.to + SAME) {
        run = { ...run, to: Math.max(run.to, next.to) };
      } else {
        out.push(run);
        run = next;
      }
    }
    out.push(run);
  }
  return out.sort(
    (a, b) => Number(a.vertical) - Number(b.vertical) || a.at - b.at || a.from - b.from,
  );
}

export function buildGrid(tables: CityTables, overrides: readonly CellDistrict[] = []): Grid {
  const cells: Cell[] = [];
  const override = (x: number, z: number): string | undefined =>
    overrides.find((o) => Math.abs(o.x - x) < 1 && Math.abs(o.z - z) < 1)?.district;
  const lines: StreetLine[] = [];
  tables.sectors.forEach((sector: Sector, index) => {
    const xs = divisions(sector.x0, sector.x1, sector.spacing);
    const zs = divisions(sector.z0, sector.z1, sector.spacing);
    for (const x of xs) lines.push({ vertical: true, at: x, from: sector.z0, to: sector.z1 });
    for (const z of zs) lines.push({ vertical: false, at: z, from: sector.x0, to: sector.x1 });
    for (let i = 0; i + 1 < xs.length; i += 1) {
      for (let j = 0; j + 1 < zs.length; j += 1) {
        const x0 = xs[i] as number;
        const x1 = xs[i + 1] as number;
        const z0 = zs[j] as number;
        const z1 = zs[j + 1] as number;
        const district = override((x0 + x1) / 2, (z0 + z1) / 2) ?? sector.district;
        cells.push({ x0, x1, z0, z1, district, sector: index });
      }
    }
  });
  /* The avenues are sector edges already; a line the table names is a street whatever the
     sectors say, so each runs the city's full width. */
  const lo = (vertical: boolean): number =>
    Math.min(...tables.sectors.map((s) => (vertical ? s.z0 : s.x0)));
  const hi = (vertical: boolean): number =>
    Math.max(...tables.sectors.map((s) => (vertical ? s.z1 : s.x1)));
  for (const avenue of tables.avenues) {
    lines.push({
      vertical: avenue.vertical,
      at: avenue.pos,
      from: lo(avenue.vertical),
      to: hi(avenue.vertical),
    });
  }
  return { cells, lines: merge(lines) };
}
