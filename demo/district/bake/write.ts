/**
 * The district as one streamed container and the scene file beside it.
 *
 * **Regions nearest the spawn first**, each introducing the prototype parts it is first to copy and
 * then its merged statics, so a stream has the street under the walker before it has the far side
 * of the city. The pictures go ahead of all of it (`texturesFirst`): every region wears the same
 * table, and a surface that lands before its picture draws white.
 *
 * **The scene file says what the container has no field for**: which material row each mesh and
 * each copy group wears — a prototype's geometry is written once and worn in every colour the
 * source gives it, which `MATL`'s one material a mesh cannot say — how strongly each row glows and
 * what kind of light it is, where the walker starts and the views the source's cameras frame.
 */
import { writeDrft } from '@driftengine/drft';
import type {
  DrftLight,
  DrftLightVolume,
  DrftMaterial,
  DrftRegion,
  DrftTextureSource,
  MeshData,
} from '@driftengine/drft';

import type { KitPiece } from './kit.ts';
import type { DistrictMaterial } from './materials.ts';
import type { BakedRegion } from './regions.ts';
import type { SceneView } from './scene.ts';
import type { DistrictWater } from './water.ts';

export interface SceneFile {
  readonly version: 1;
  readonly regionSize: number;
  readonly spawn: { x: number; y: number; z: number; yaw: number };
  readonly views: readonly SceneView[];
  readonly materials: readonly (Omit<DistrictMaterial, 'drft'> & { drft: DrftMaterial })[];
  /** The material row each mesh of the container wears, by ordinal. */
  readonly meshMaterial: number[];
  /** The material row each copy group of a region wears, by region id then group index. */
  readonly groupMaterial: Record<number, number[]>;
  /** The material row each part of a region's levels wears, by region id, level, then part. */
  readonly levelMaterial: Record<number, number[][]>;
  /** What one unit of a light's intensity is in the volume and the exact lights alike. */
  readonly lightUnit: number;
  /** The source's water as bodies of the engine's, or null where it has none. */
  readonly water: DistrictWater | null;
  /** The regions outside the core, whose every level is a clustering: drawn at the level chosen and no other. */
  readonly skyline: readonly number[];
}

export interface WriteInput {
  readonly regions: readonly BakedRegion[];
  readonly pieces: ReadonlyMap<string, KitPiece>;
  readonly materials: readonly DistrictMaterial[];
  readonly textures: readonly DrftTextureSource[];
  readonly lights: readonly DrftLight[];
  readonly lightVolume?: DrftLightVolume;
  readonly spawn: SceneFile['spawn'];
  readonly views: readonly SceneView[];
  readonly regionSize: number;
  readonly lightUnit: number;
  /** The row the coarse levels wear, and each coarse level's error, metres. */
  readonly coarseRow: number;
  readonly levelErrors: readonly number[];
  /** A skyline region's levels' errors, metres. */
  readonly skylineErrors: readonly number[];
  readonly water: DistrictWater | null;
}

export function writeDistrict(input: WriteInput): { container: ArrayBuffer; scene: SceneFile } {
  const { spawn } = input;
  const away = (r: BakedRegion): number => {
    const b = r.bounds;
    const dx = Math.max((b[0] as number) - spawn.x, 0, spawn.x - (b[3] as number));
    const dz = Math.max((b[2] as number) - spawn.z, 0, spawn.z - (b[5] as number));
    return Math.hypot(dx, dz);
  };
  const regions = [...input.regions].sort((a, b) => away(a) - away(b));
  const rows = input.materials;
  const meshes: MeshData[] = [];
  const materials: DrftMaterial[] = [];
  const meshMaterial: number[] = [];
  const prototype = new Map<string, number>();
  const written: DrftRegion[] = [];
  const groupMaterial: Record<number, number[]> = {};
  const levelMaterial: Record<number, number[][]> = {};
  const skyline: number[] = [];

  for (const region of regions) {
    /*
     * **The ground before the props.** A region's meshes stream in the order they are written, so
     * what a walker stands on and the buildings around it come first, its coarse levels next, and
     * its thousand copies of litter and lamps last; written the other way, a street arrived as a
     * cloud of props over nothing for the first seconds of every visit.
     */
    const level: number[] = [];
    for (const s of region.statics) {
      meshes.push(s.mesh);
      materials.push((rows[s.material] as DistrictMaterial).drft);
      meshMaterial.push(s.material);
      level.push(meshes.length - 1);
    }
    /*
     * Each coarse level is one mesh in the coarse row, coloured by its vertices. A skyline region
     * is nothing else: its nearest clustering is its first level, at its own error.
     */
    const levels = region.skyline ? [] : [{ error: 0, meshes: level }];
    const rowsOfLevels = region.skyline ? [] : [region.statics.map((s) => s.material)];
    const errors = region.skyline ? input.skylineErrors : input.levelErrors;
    region.coarse.forEach((mesh, i) => {
      if (mesh === null) return;
      meshes.push(mesh);
      materials.push((rows[input.coarseRow] as DistrictMaterial).drft);
      meshMaterial.push(input.coarseRow);
      levels.push({ error: errors[i] as number, meshes: [meshes.length - 1] });
      rowsOfLevels.push([input.coarseRow]);
    });
    if (levels.length === 0) continue;
    if (region.skyline) skyline.push(region.id);
    /*
     * A region names each mesh in one group only, so where two of its groups wear one geometry in
     * two materials the second takes a second copy of it: copy `k` of a geometry is shared by every
     * region needing `k + 1` variants of it at once, so a geometry is written as many times as the
     * most variants of it any one region holds, and no more.
     */
    const variants = new Map<string, number>();
    const instances = region.groups.map((group) => {
      const base = `${group.piece}#${group.part}`;
      const copy = variants.get(base) ?? 0;
      variants.set(base, copy + 1);
      const key = `${base}#${copy}`;
      let ordinal = prototype.get(key);
      if (ordinal === undefined) {
        const piece = input.pieces.get(group.piece) as KitPiece;
        meshes.push((piece.parts[group.part] as KitPiece['parts'][number]).mesh);
        materials.push((rows[group.material] as DistrictMaterial).drft);
        meshMaterial.push(group.material);
        ordinal = meshes.length - 1;
        prototype.set(key, ordinal);
      }
      return { mesh: ordinal, transforms: group.transforms };
    });
    groupMaterial[region.id] = region.groups.map((g) => g.material);
    levelMaterial[region.id] = rowsOfLevels;
    written.push({
      id: region.id,
      bounds: region.bounds,
      levels,
      instances,
      occluders: new Float32Array(0),
      collision: region.collision,
    });
  }

  const container = writeDrft({
    head: { name: 'district', generator: 'district bake' },
    meshes,
    materials,
    regions: written,
    textures: input.textures,
    texturesFirst: true,
    quantise: true,
    lights: input.lights,
    ...(input.lightVolume === undefined ? {} : { lightVolume: input.lightVolume }),
  });
  const scene: SceneFile = {
    version: 1,
    regionSize: input.regionSize,
    spawn,
    views: input.views,
    materials: rows.map((row) => ({ ...row })),
    meshMaterial,
    groupMaterial,
    levelMaterial,
    lightUnit: input.lightUnit,
    water: input.water,
    skyline,
  };
  return { container, scene };
}
