/**
 * The district's lights: wherever the source draws something glowing, a light sheds what it glows.
 *
 * **The source draws its lights and lights almost none of them.** It has twenty-five lamps of its
 * own and thousands of fixtures — road lamps, deck tubes, neon edges, holoboards, shop ceilings —
 * each a mesh with a glowing material and nothing to shed the glow. So every glowing triangle gives
 * its light to the cell of a `CELL`-metre grid it falls in, one cell a kind, and each cell becomes
 * one point light: a lamp is a light where its lens is, a neon edge along a deck is a row of them
 * in its own colour, and a billboard tints the street in front of it.
 *
 * **How strong is the source's own arithmetic**, not a number a kind is given: a surface of glow
 * `L` and area `A` emits `π L A` in Blender's units, and an isotropic point light shedding that
 * much has an intensity of a quarter of it; one of the source's own lamps of `W` watts has `W / 4π`.
 * A deck tube is then weaker than a road lamp because it is smaller, and a shop's whole ceiling is
 * stronger than either. What a kind decides is only how that arithmetic is judged at night, by a
 * gain the runtime applies (`district.ts`), and it is the one place a look enters.
 *
 * **Each light sits a little off its surface**, `LIFT` along the cell's mean normal, because the
 * falloff is inverse-square and a light on its own surface lights that surface without limit.
 *
 * What it gives up: a fixture's shape — a tube is points `CELL` apart — and its direction, since a
 * shop ceiling sheds downward and the light it becomes sheds every way. What would make it wrong is
 * a cell so large that a pool of light visibly sits between two fixtures.
 */
import type { DrftLight } from '@driftengine/drft';

import { judged, reachOf } from '../lighting.ts';
import type { LightKind } from '../lighting.ts';
import type { KitPiece } from './kit.ts';
import type { GlowKind, Materials } from './materials.ts';
import type { Sampler } from './sample.ts';
import type { DistrictScene, Placement } from './scene.ts';

const CELL = 3;
const LIFT = 0.3;
/** Below this intensity a cell sheds nothing worth a slot. */
const FLOOR = 1e-4;

/** The kinds whose glow is shed as light: everything but lit windows, glass and the coarse row. */
const SHEDS: ReadonlySet<GlowKind> = new Set(['lamp', 'neon', 'screen', 'plain']);

interface Input {
  readonly scene: DistrictScene;
  readonly statics: readonly Placement[];
  readonly copies: ReadonlyMap<string, readonly Placement[]>;
  readonly pieces: ReadonlyMap<string, KitPiece>;
  readonly rowOf: ReadonlyMap<string, number>;
  readonly materials: Materials;
  readonly sampler: Sampler;
  readonly keep: ((x: number, z: number) => boolean) | undefined;
}

/** A cell's sums: intensity per channel, intensity-weighted position, area-weighted normal. */
interface Cell {
  kind: LightKind;
  r: number;
  g: number;
  b: number;
  x: number;
  y: number;
  z: number;
  weight: number;
  nx: number;
  ny: number;
  nz: number;
  /** The glowing area summed, against which the normals' sum says whether the faces agree. */
  area: number;
}

/** A part's glow per vertex, times what its material's strength past one adds; null where dark. */
type Glows = Float32Array | null;

export async function fixtureLights(
  input: Input,
  log: (line: string) => void,
): Promise<DrftLight[]> {
  const cells = new Map<string, Cell>();
  const glowsOf = new Map<string, Glows>();
  const glows = async (piece: KitPiece, p: number, row: number): Promise<Glows> => {
    const key = `${piece.key}#${p}#${row}`;
    if (glowsOf.has(key)) return glowsOf.get(key) ?? null;
    const surface = input.materials.surfaceOf(row);
    const source = input.materials.sources[row] ?? null;
    let out: Glows = null;
    /* A glow that is its own colour map is a surface drawn self-lit, not a light: see `materials.ts`. */
    const kind = input.materials.rows[row]?.kind;
    const selfLit =
      surface !== null &&
      kind !== 'neon' &&
      kind !== 'screen' &&
      surface.emissionMap !== null &&
      surface.emissionMap.image.offset === surface.baseColorMap?.image.offset;
    /*
     * A plain glow sheds light only where it is one colour, a strip or a panel: one with a picture
     * is a facade's lit windows, which the city has a quarter of a million of, and which glow
     * rather than light the street — shed, they were nine in ten of the district's lights.
     */
    const windows = kind === 'plain' && surface !== null && surface.emissionMap !== null;
    if (
      surface !== null &&
      source !== null &&
      surface.emissionStrength > 0 &&
      !selfLit &&
      !windows
    ) {
      const painted = await input.sampler.paint(
        (piece.parts[p] as KitPiece['parts'][number]).mesh,
        source,
      );
      const past = surface.emissionStrength / Math.min(1, surface.emissionStrength);
      let any = false;
      for (let i = 0; i < painted.glows.length; i++) {
        const v = (painted.glows[i] as number) * past;
        painted.glows[i] = v;
        if (v > 0) any = true;
      }
      out = any ? painted.glows : null;
    }
    glowsOf.set(key, out);
    return out;
  };

  const shed = (
    kind: LightKind,
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    nx: number,
    ny: number,
    nz: number,
  ): void => {
    if (input.keep !== undefined && !input.keep(x, z)) return;
    const key = `${kind}:${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { kind, r: 0, g: 0, b: 0, x: 0, y: 0, z: 0, weight: 0, nx: 0, ny: 0, nz: 0, area: 0 };
      cells.set(key, cell);
    }
    const w = Math.max(r, g, b);
    cell.r += r;
    cell.g += g;
    cell.b += b;
    cell.x += x * w;
    cell.y += y * w;
    cell.z += z * w;
    cell.weight += w;
    cell.nx += nx;
    cell.ny += ny;
    cell.nz += nz;
    cell.area += Math.hypot(nx, ny, nz);
  };

  const place = async (placement: Placement): Promise<void> => {
    const piece = input.pieces.get(placement.key);
    if (piece === undefined) return;
    const m = placement.world;
    for (let p = 0; p < piece.parts.length; p++) {
      const row = input.rowOf.get(`${placement.name}#${p}`);
      if (row === undefined) continue;
      const kind = input.materials.rows[row]?.kind;
      if (kind === undefined || !SHEDS.has(kind)) continue;
      const lit = await glows(piece, p, row);
      if (lit === null) continue;
      const mesh = (piece.parts[p] as KitPiece['parts'][number]).mesh;
      const pos = mesh.positions;
      const idx = mesh.indices;
      const world = (v: number, out: number[]): void => {
        const [x, y, z] = [
          pos[v * 3] as number,
          pos[v * 3 + 1] as number,
          pos[v * 3 + 2] as number,
        ];
        out[0] =
          (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
        out[1] =
          (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
        out[2] =
          (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
      };
      const a = [0, 0, 0];
      const b = [0, 0, 0];
      const c = [0, 0, 0];
      for (let t = 0; t < idx.length; t += 3) {
        const [i, j, k] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
        const gr = ((lit[i * 3] as number) + (lit[j * 3] as number) + (lit[k * 3] as number)) / 3;
        const gg =
          ((lit[i * 3 + 1] as number) + (lit[j * 3 + 1] as number) + (lit[k * 3 + 1] as number)) /
          3;
        const gb =
          ((lit[i * 3 + 2] as number) + (lit[j * 3 + 2] as number) + (lit[k * 3 + 2] as number)) /
          3;
        if (gr <= 0 && gg <= 0 && gb <= 0) continue;
        world(i, a);
        world(j, b);
        world(k, c);
        const ux = (b[0] as number) - (a[0] as number);
        const uy = (b[1] as number) - (a[1] as number);
        const uz = (b[2] as number) - (a[2] as number);
        const vx = (c[0] as number) - (a[0] as number);
        const vy = (c[1] as number) - (a[1] as number);
        const vz = (c[2] as number) - (a[2] as number);
        /* Twice the area along the face normal; the area weights the normal. */
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const area = Math.hypot(nx, ny, nz) / 2;
        /* π L A emitted, a quarter of it as an isotropic point's intensity. */
        const scale = (Math.PI * area) / 4;
        shed(
          kind as LightKind,
          ((a[0] as number) + (b[0] as number) + (c[0] as number)) / 3,
          ((a[1] as number) + (b[1] as number) + (c[1] as number)) / 3,
          ((a[2] as number) + (b[2] as number) + (c[2] as number)) / 3,
          gr * scale,
          gg * scale,
          gb * scale,
          nx / 2,
          ny / 2,
          nz / 2,
        );
      }
    }
  };
  for (const p of input.statics) await place(p);
  for (const list of input.copies.values()) for (const p of list) await place(p);

  const out: DrftLight[] = [];
  for (const l of input.scene.lights) {
    if (l.kind === 'sun' || l.kind === 'area') continue;
    if (input.keep !== undefined && !input.keep(l.position[0], l.position[2])) continue;
    const intensity = l.watts / (4 * Math.PI);
    out.push(light('source', l.position, l.color, intensity));
  }
  const counts = new Map<LightKind, { n: number; values: number[] }>();
  for (const cell of cells.values()) {
    const peak = Math.max(cell.r, cell.g, cell.b);
    if (peak < FLOOR || cell.weight <= 0) continue;
    /*
     * Off the surface along the cell's mean normal, or straight down where its faces look every way
     * and the normals cancel — a tube, a bulb, a sign lit both sides — since a light hung there
     * lights what is under it and a light left inside it lights the ceiling it is fixed to.
     */
    const n = Math.hypot(cell.nx, cell.ny, cell.nz);
    const facing = n > 0.3 * cell.area;
    const [ox, oy, oz] = facing
      ? [(cell.nx / n) * LIFT, (cell.ny / n) * LIFT, (cell.nz / n) * LIFT]
      : [0, -LIFT, 0];
    const position: [number, number, number] = [
      cell.x / cell.weight + ox,
      cell.y / cell.weight + oy,
      cell.z / cell.weight + oz,
    ];
    out.push(light(cell.kind, position, [cell.r / peak, cell.g / peak, cell.b / peak], peak));
    const tally = counts.get(cell.kind) ?? { n: 0, values: [] };
    tally.n++;
    tally.values.push(peak);
    counts.set(cell.kind, tally);
  }
  for (const [kind, { n, values }] of counts) {
    values.sort((x, y) => x - y);
    const at = (q: number): string =>
      (values[Math.min(values.length - 1, Math.floor(q * values.length))] as number).toPrecision(2);
    log(`  ${kind}: ${n} lights, intensity median ${at(0.5)}, 90% ${at(0.9)}, max ${at(1)}`);
  }
  return out;
}

/**
 * A point light of `kind` at the source's own intensity, named for its kind so the runtime can judge
 * it, and reaching as far as the night judges it worth shading.
 */
function light(
  kind: LightKind,
  position: readonly [number, number, number],
  color: readonly [number, number, number],
  intensity: number,
): DrftLight {
  const range = reachOf(judged(kind, intensity));
  return {
    kind: 'point',
    name: `night:${kind}`,
    position: [...position],
    direction: [0, -1, 0],
    color: [...color],
    intensity,
    range,
    innerConeRad: 0,
    outerConeRad: 0,
  };
}
