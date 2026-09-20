/** A GPU-driven material as the shading pass reads it: five blocks, one of them integers. */

import type { GpuDrivenMaterial } from '../backend/webgpu/gpuDrivenPass.ts';
import { DECODE_NO_PROGRAM } from '../shaders/gpudriven/decode.wgsl.ts';
import type { GpuDrivenProgram } from './decodeTables.ts';

/**
 * **The forward path's maps, as decode programs.** `SurfaceMaterial` binds an albedo, a normal and
 * an occlusion-roughness-metallic image, and its scales and strengths mean what they mean there —
 * the ORM map *replaces* roughness and the scale gives the scaling back, and occlusion strength is
 * a mix from one rather than a multiply. Defaults are `SurfaceMaterial`'s.
 */
export interface GpuDrivenTextures {
  readonly baseColour?: GpuDrivenProgram;
  readonly normal?: GpuDrivenProgram;
  /** Occlusion in R, roughness in G, metallic in B — glTF's packing, as `SurfaceMaterial.orm`. */
  readonly orm?: GpuDrivenProgram;
  /**
   * Where the surface glows, in colour, as `SurfaceMaterial.emissive`'s map: the glow is the albedo
   * times this times the material's `emissive`, so a black texel glows nowhere and the scalar
   * still says how brightly the rest does. **glTF's rule and flat/main.ts's**, which the facade of
   * a city at dusk needed — lit windows in a wall that does not glow — and the pipeline could not
   * say until 2026-09-18.
   */
  readonly emissive?: GpuDrivenProgram;
  readonly uScale?: number;
  readonly vScale?: number;
  /** Defaults to 1 when a `normal` program is given and 0 when it is not. */
  readonly normalStrength?: number;
  readonly roughnessScale?: number;
  readonly metallicScale?: number;
  readonly occlusionStrength?: number;
}

/**
 * Words a material entry: tint and emissive, the surface scalars, four program indices, the UV
 * scale and two strengths, the two ORM scales with the cutout and blend flags, and
 * the opacity with three spare.
 *
 * **It was eight until 2026-09-17**, and metalness took its last spare lane the same day, so the
 * programs and the scales needed three more blocks rather than squeezing into what was left. It
 * became twenty-four on 2026-09-18, when transparency arrived and there was nowhere left to put an
 * opacity: the cutout took lane 18 and the blend flag took 19, and lane 11 is a reserved program
 * slot rather than a gap. A sixteen-byte block is 1 kB across the whole table, against the 64 kB a
 * uniform buffer may hold.
 */
export const GPU_DRIVEN_MATERIAL_FLOATS = 24;

/**
 * Below this base-colour alpha the raster discards a fragment. Zero means no test.
 *
 * **Lane 18 rather than lane 11**, which looks spare and is not: the loop below initialises lanes
 * 8 to 11 to `DECODE_NO_PROGRAM`, so eleven is a fourth program slot somebody reserved rather than
 * a gap, and a scalar written there would be read back as a program index. Taking 18 leaves the
 * reservation alone and leaves 19 after it.
 */
export const MATERIAL_ALPHA_CUTOFF = 18;

/**
 * Non-zero where this material's clusters are drawn blended rather than into the visibility buffer.
 *
 * **The last spare lane of twenty**, and a flag rather than an opacity because the opacity is the
 * tint's fourth component. What this selects is which of the two halves of the frame a cluster
 * belongs to, which the cut asks once per cluster.
 */
export const MATERIAL_BLEND = 19;

/**
 * How much of a blended surface is its own colour rather than what is behind it. One is opaque.
 *
 * **It is not the tint's fourth component**, which is the emissive gain and has been since the
 * table was eight floats, and it is not `alphaCutoff`, which decides whether a fragment exists at
 * all. A material that does not blend never reads this.
 */
export const MATERIAL_OPACITY = 20;

/**
 * Where a material's emissive program is: the fourth program lane, which the table reserved and
 * initialised to none before anything used it.
 */
export const MATERIAL_EMISSIVE_PROGRAM = 11;

/** Program lanes a material, and the stride `collectPrograms` writes its indices at. */
const PROGRAM_LANES = 4;

export interface MaterialPrograms {
  readonly programs: readonly GpuDrivenProgram[];
  /** Four a material — base colour, normal, ORM, emissive — each an index into `programs` or none. */
  readonly indices: Uint32Array;
}

/** Every program the materials name, once each by identity, and where each material's are. */
export function collectPrograms(materials: readonly GpuDrivenMaterial[]): MaterialPrograms {
  const programs: GpuDrivenProgram[] = [];
  const known = new Map<GpuDrivenProgram, number>();
  const indexOf = (program: GpuDrivenProgram | undefined): number => {
    if (program === undefined) return DECODE_NO_PROGRAM;
    const found = known.get(program);
    if (found !== undefined) return found;
    programs.push(program);
    known.set(program, programs.length - 1);
    return programs.length - 1;
  };
  const indices = new Uint32Array(materials.length * PROGRAM_LANES);
  materials.forEach((material, m) => {
    indices[m * PROGRAM_LANES] = indexOf(material.textures?.baseColour);
    indices[m * PROGRAM_LANES + 1] = indexOf(material.textures?.normal);
    indices[m * PROGRAM_LANES + 2] = indexOf(material.textures?.orm);
    indices[m * PROGRAM_LANES + 3] = indexOf(material.textures?.emissive);
  });
  return { programs, indices };
}

/**
 * The table, `slots` entries long.
 *
 * **Written through a `DataView` because one block is integers.** A program index written as a
 * float would be read by `vec4<u32>` as the float's bits, which names a program four billion
 * places away and draws nothing — or, clamped, the last program in the table.
 */
export function writeMaterialTable(
  materials: readonly GpuDrivenMaterial[],
  indices: Uint32Array,
  slots: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(slots * GPU_DRIVEN_MATERIAL_FLOATS * 4);
  const view = new DataView(buffer);
  const float = (m: number, lane: number, value: number): void =>
    view.setFloat32((m * GPU_DRIVEN_MATERIAL_FLOATS + lane) * 4, value, true);
  const word = (m: number, lane: number, value: number): void =>
    view.setUint32((m * GPU_DRIVEN_MATERIAL_FLOATS + lane) * 4, value, true);

  for (let m = 0; m < slots; m += 1) {
    for (let lane = 8; lane < 12; lane += 1) word(m, lane, DECODE_NO_PROGRAM);
  }
  materials.forEach((material, m) => {
    float(m, 0, material.tint[0]);
    float(m, 1, material.tint[1]);
    float(m, 2, material.tint[2]);
    float(m, 3, material.emissive);
    /* Roughness one and specular zero: the matte this pipeline drew before either existed. */
    float(m, 4, material.roughness ?? 1);
    float(m, 5, material.specular ?? 0);
    float(m, 6, material.reflectivity ?? 0);
    float(m, 7, material.metalness ?? 0);
    for (let lane = 0; lane < PROGRAM_LANES; lane += 1) {
      word(m, 8 + lane, indices[m * PROGRAM_LANES + lane] as number);
    }
    const textures = material.textures;
    float(m, 12, textures?.uScale ?? 1);
    float(m, 13, textures?.vScale ?? 1);
    float(m, 14, textures?.normal === undefined ? 0 : (textures.normalStrength ?? 1));
    float(m, 15, textures?.occlusionStrength ?? 1);
    float(m, 16, textures?.roughnessScale ?? 1);
    float(m, 17, textures?.metallicScale ?? 1);
    /* Zero is off, so a material that says nothing about cutout writes the table it wrote before. */
    float(m, MATERIAL_ALPHA_CUTOFF, material.alphaCutoff ?? 0);
    /* Zero is opaque, so a material that says nothing about blending stays in the opaque half. */
    float(m, MATERIAL_BLEND, material.blend === true ? 1 : 0);
    /* One, so a material that asked to blend and said nothing else is as solid as an opaque one. */
    float(m, MATERIAL_OPACITY, material.opacity ?? 1);
  });
  return buffer;
}
