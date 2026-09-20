import { expect, test } from 'vitest';

import { VERTEX_FLOATS } from '../../backend/webgpu/gpuDrivenPass.ts';
import { GPU_DRIVEN_VERTEX_FLOATS } from '../../gpudriven/sceneUpload.ts';
import { RELIEF_ROUGHNESS, preambleGlsl } from '../flat/preamble.ts';
import { BLEND_RASTER_WGSL } from './blendRaster.wgsl.ts';
import { SHADE_MATERIAL_WGSL } from './shade.wgsl.ts';
import { VISBUFFER_RASTER_WGSL } from './visbufferRaster.wgsl.ts';

/**
 * **The vertex stride was written in three places and one of them was a bare literal.** The raster
 * read `index * 9u` while the shading module declared its own `9u` and the upload its own `9`. A
 * stride that changes in two of three draws every triangle from somebody else's vertices, which is
 * a picture of noise with nothing to say why.
 */
test('the upload, the raster and the shading pass agree about how wide a vertex is', () => {
  expect(VERTEX_FLOATS).toBe(GPU_DRIVEN_VERTEX_FLOATS);
  expect(SHADE_MATERIAL_WGSL).toContain(`const VERTEX_FLOATS: u32 = ${GPU_DRIVEN_VERTEX_FLOATS}u;`);
  expect(VISBUFFER_RASTER_WGSL).toContain(`index * ${GPU_DRIVEN_VERTEX_FLOATS}u`);
  expect(VISBUFFER_RASTER_WGSL).not.toMatch(/index \* 9u/);
  /* The fourth reader, which the three above did not name until the vertex grew a glow. */
  expect(BLEND_RASTER_WGSL).toContain(`index * ${GPU_DRIVEN_VERTEX_FLOATS}u`);
});

test('BOTH SHADERS READ A VERTEX\u2019S GLOW AT FLOAT ELEVEN AND ADD IT TO THE MATERIAL\u2019S', () => {
  /*
   * The compute shading and the blended raster are the two places a surface is lit, and a glow
   * one of them reads at a different offset is a torch that lights opaque stone and not the glass
   * beside it. Added rather than replacing: a mesh that carries none reads zero, which is the
   * material's own glow and every scene before this.
   */
  expect(SHADE_MATERIAL_WGSL).toContain('return vertices[vertex * VERTEX_FLOATS + 11u];');
  expect(SHADE_MATERIAL_WGSL).toContain(
    'let glow = emissiveOf(i0) * weights.c.x + emissiveOf(i1) * weights.c.y + emissiveOf(i2) * weights.c.z;',
  );
  expect(SHADE_MATERIAL_WGSL).toContain('litSurface.emissive = entry.tint.w + glow;');
  expect(BLEND_RASTER_WGSL).toContain('out.emissive = vertices[at + 11u];');
  expect(BLEND_RASTER_WGSL).toContain('surface.emissive = entry.tint.w + in.emissive;');
});

test('the shading pass declares the decode resources where the pass binds them', () => {
  for (const expected of [
    '@binding(14) var decodeLatents',
    '@binding(15) var decodeClampSampler',
    '@binding(16) var decodeRepeatSampler',
    '@binding(17) var<uniform> decodeNodes',
    '@binding(18) var<uniform> decodeWeights',
    'fn decodeLatentSize() -> f32',
    'fn decodeProgram(',
    'programs: vec4<u32>,',
  ]) {
    expect(SHADE_MATERIAL_WGSL).toContain(expected);
  }
});

test('A NORMAL MAP WIDENS THE ROUGHNESS BY THE NUMBER THE FORWARD PATH WIDENS IT BY', () => {
  /*
   * flat/main.ts adds uNormalStrength * RELIEF_ROUGHNESS to every roughness it reads once a map is
   * bound; the textured second pipeline adds its own strength times the same constant. One number,
   * interpolated into both shaders, so neither can move alone.
   */
  expect(preambleGlsl({ maxLights: 4, maxAreaLights: 1 })).toContain(
    `#define RELIEF_ROUGHNESS ${RELIEF_ROUGHNESS}`,
  );
  expect(SHADE_MATERIAL_WGSL).toContain(
    `let surfaceRoughness = clamp(roughness + entry.maps.z * ${RELIEF_ROUGHNESS}, 0.0, 1.0);`,
  );
  expect(SHADE_MATERIAL_WGSL).toContain('litSurface.roughness = surfaceRoughness;');
  expect(SHADE_MATERIAL_WGSL).toContain('let lod = clamp(surfaceRoughness * maxLod, 0.0, maxLod);');
});
