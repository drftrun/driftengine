/**
 * The material table's layout, declared once for everything that reads it.
 *
 * **Two shaders read this table now and they used to be one.** The shading pass has always read a
 * material; since the raster gained an alpha test it reads one too, because a pixel learns which
 * triangle owns it there and a discard any later is a discard after the visibility buffer already
 * held the leaf. A second copy of the struct would be twenty lanes maintained in two places, which
 * is the failure `cluster-check.mjs`'s header describes at length: two declarations of one decision
 * drift invisibly, and the thing that breaks is a scalar read as a program index.
 *
 * `gpudriven/materialTable.ts` writes the lanes these fields land on and its own header says why
 * some of them are written through a `DataView`.
 */

import { DECODE_NO_PROGRAM } from './decode.wgsl.ts';

/**
 * How many materials the table holds, and it is a declared ceiling rather than a discovered one.
 *
 * A uniform array in WGSL is fixed length, and the table is a uniform rather than a storage buffer
 * because a compute stage may bind only **eight** storage buffers by default — this pass needed
 * twelve when it was first written, and the device said so at pipeline creation. Sixty-four
 * materials is 2 kB of the 64 kB a uniform buffer may hold; a scene wanting more wants a storage
 * buffer and one of the eight slots back from somewhere.
 */
export const MATERIAL_SLOTS = 64;

/** The struct and the sentinel, for any module that binds the table. */
export const MATERIAL_TABLE_WGSL = /* wgsl */ `
struct Material {
  /** rgb is the tint, w is the emissive gain. */
  tint: vec4<f32>,
  /** x is the roughness, y the specular reflectance, z the environment's and w the metalness. */
  surface: vec4<f32>,
  /** Base colour, normal, ORM and emissive programs; NO_PROGRAM where there is none. */
  programs: vec4<u32>,
  /** u scale, v scale, normal strength, occlusion strength. */
  maps: vec4<f32>,
  /** Roughness scale, metallic scale, the alpha cutoff, and non-zero where this one blends. */
  orm: vec4<f32>,
  /** The blended opacity, and three spare. */
  extra: vec4<f32>,
}

const NO_PROGRAM: u32 = ${DECODE_NO_PROGRAM}u;
`;
