/**
 * Baked regions as one streamed container: the kit, then each region's assemblies and the
 * prototypes its furniture is copies of, in the order a stream needs them.
 *
 * **The order is the container's**: each region's new meshes in region order — the kit's pieces it
 * is first to copy, then its assemblies, then any prototype it is first to place — so a stream
 * has the walker's regions whole without the rest of the city's kit. **Only the pieces the kept
 * regions copy are written**, renumbered, so a file of one district carries that district's kit
 * and not the city's. Pieces and prototypes are quantised
 * (`MSHQ`); an assembly is already its copies.
 *
 * **A region's levels are its finest, exact, and its coarse level** (`coarse.ts`) at that level's
 * error, where the caller made one; its occluders and collision come with the coarse level
 * (`occluders.ts`).
 */
import { expandAssembly, writeDrft } from '@driftengine/drft';
import type {
  DrftAssembly,
  EntsScene,
  DrftLight,
  DrftLightVolume,
  DrftRegion,
  DrftTextureSource,
  MeshData,
} from '@driftengine/drft';

import { COARSE_ERROR } from '../mesh/region.ts';
import type { BakedCity, BakedRegion, MaterialClass } from '../mesh/region.ts';
import type { CoarseCity } from './coarse.ts';
import type { MoverKind } from './movers.ts';
import { welded } from './occluders.ts';

export interface WriteOptions {
  /** Which regions to write; every one unless given. */
  readonly keep?: (region: BakedRegion) => boolean;
  /**
   * Where the walker starts, (x, z): the regions are written nearest it first, by the distance to
   * their boxes, so a stream has the ground under the walker before anything else. In the bake's
   * order unless given.
   */
  readonly first?: readonly [number, number];
  /** Each region's coarse level and occluders, from `coarseLevels`; its collision is made from it. */
  readonly coarse?: CoarseCity;
  /** The lights the runtime selects near the eye (`LITE`), and the volume past them (`LVOL`). */
  readonly lights?: readonly DrftLight[];
  readonly lightVolume?: DrftLightVolume;
  /** What the runtime needs beyond geometry and light (`scene.ts`), as `ENTS`. */
  readonly scene?: EntsScene;
  /** The movers' meshes, first in the file in the order the scene counts them (`movers.ts`). */
  readonly movers?: readonly MoverKind[];
  /** The pictures, ahead of the geometry: every region wears the same arrays (`pictures.ts`). */
  readonly pictures?: readonly DrftTextureSource[];
}

function renumbered(assembly: DrftAssembly, remap: ReadonlyMap<number, number>): DrftAssembly {
  const pieces = new Uint32Array(assembly.pieces.length);
  assembly.pieces.forEach((p, i) => {
    const to = remap.get(p);
    if (to === undefined) throw new Error(`piece ${p} is not in the written kit`);
    pieces[i] = to;
  });
  return { ...assembly, pieces };
}

/** The container for the regions `keep` accepts, or every region. */
export function writeCity(city: BakedCity, options: WriteOptions = {}): ArrayBuffer {
  const regions = city.regions.filter(options.keep ?? (() => true));
  const first = options.first;
  if (first !== undefined) {
    const away = (r: BakedRegion): number => {
      const b = r.bounds;
      const dx = Math.max((b[0] as number) - first[0], 0, first[0] - (b[3] as number));
      const dz = Math.max((b[2] as number) - first[1], 0, first[1] - (b[5] as number));
      return Math.hypot(dx, dz);
    };
    regions.sort((a, b) => away(a) - away(b));
  }
  const coarseOf = (r: BakedRegion) => options.coarse?.levels.get(r.id) ?? [];
  const piece = (o: number): MeshData => city.kit.pieces[o] as MeshData;
  const remap = new Map<number, number>();
  const meshes: (MeshData | DrftAssembly)[] = [];
  for (const kind of options.movers ?? []) for (const m of kind.meshes) meshes.push(m.mesh);
  const kit: number[] = [];
  const prototypes = new Map<number, number>();
  const written: DrftRegion[] = [];
  for (const r of regions) {
    /* The pieces this region is first to copy, ahead of the assemblies that copy them. */
    const fresh = new Set<number>();
    for (const a of [...r.assemblies, ...coarseOf(r)]) {
      for (const p of a.assembly.pieces) if (!remap.has(p)) fresh.add(p);
    }
    for (const p of [...fresh].sort((a, b) => a - b)) {
      meshes.push(city.kit.pieces[p] as MeshData);
      remap.set(p, meshes.length - 1);
      kit.push(meshes.length - 1);
    }
    const level: number[] = [];
    for (const a of r.assemblies) {
      meshes.push(renumbered(a.assembly, remap));
      level.push(meshes.length - 1);
    }
    const coarse: number[] = [];
    for (const a of coarseOf(r)) {
      meshes.push(renumbered(a.assembly, remap));
      coarse.push(meshes.length - 1);
    }
    const instances = r.groups.map((g) => {
      let ordinal = prototypes.get(g.prototype);
      if (ordinal === undefined) {
        meshes.push((city.prototypes[g.prototype] as { mesh: MeshData }).mesh);
        ordinal = meshes.length - 1;
        prototypes.set(g.prototype, ordinal);
      }
      return { mesh: ordinal, transforms: g.transforms };
    });
    written.push({
      id: r.id,
      bounds: r.bounds,
      levels:
        options.coarse === undefined
          ? [{ error: 0, meshes: level }]
          : [
              { error: 0, meshes: level },
              { error: COARSE_ERROR, meshes: coarse },
            ],
      instances,
      occluders: new Float32Array(options.coarse?.occluders.get(r.id) ?? []),
      collision: collisionOf(coarseOf(r), piece),
    });
  }
  return writeDrft({
    head: { name: 'sprawl', generator: 'sprawl bake' },
    meshes,
    kit,
    regions: written,
    quantise: true,
    ...(options.lights === undefined ? {} : { lights: options.lights }),
    ...(options.lightVolume === undefined ? {} : { lightVolume: options.lightVolume }),
    ...(options.scene === undefined ? {} : { entities: options.scene }),
    ...(options.pictures === undefined ? {} : { textures: options.pictures, texturesFirst: true }),
  });
}

/** A region's collision: its coarse level's opaque assemblies, welded; none without one. */
function collisionOf(
  coarse: readonly { cls: MaterialClass; assembly: DrftAssembly }[],
  piece: (ordinal: number) => MeshData,
): { positions: Float32Array; indices: Uint32Array } | null {
  const solid = coarse.filter((a) => a.cls.blend === 'opaque');
  if (solid.length === 0) return null;
  return welded(solid.map((a) => expandAssembly(a.assembly, piece)));
}
