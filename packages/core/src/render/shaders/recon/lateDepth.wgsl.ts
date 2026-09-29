/**
 * The render's depth, taken up to the output size for the draws that land after the upscale.
 *
 * **The nearest of the four render texels around each output pixel**, so a translucent draw is
 * never let through an opaque edge the render did cover. What it gives up: where a translucent
 * surface crosses an opaque silhouette, the edge steps at the render's resolution.
 *
 * Hand-written, and built by concatenation rather than a template literal: the reconstruction's
 * passes have no WebGL2 twin (the AGENTS.md exception for them), and a `${}` inside WGSL source is
 * the thing that rule forbids.
 */
import { REVERSED_DEPTH } from '../../depthConvention.ts';

/** The nearer of two stored depths: the larger in a reversed buffer. */
const NEARER = REVERSED_DEPTH ? 'max' : 'min';
/** Where the search for the nearest starts: the far plane. */
const FARTHEST = REVERSED_DEPTH ? '0.0' : '1.0';

export const LATE_DEPTH_WGSL =
  '@group(0) @binding(0) var source: texture_depth_2d;\n' +
  '@group(0) @binding(1) var<uniform> sizes: vec4<f32>;\n' +
  '\n' +
  '@vertex\n' +
  'fn lateDepthVert(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {\n' +
  '  let x = f32((index << 1u) & 2u);\n' +
  '  let y = f32(index & 2u);\n' +
  '  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);\n' +
  '}\n' +
  '\n' +
  '@fragment\n' +
  'fn lateDepthFrag(@builtin(position) at: vec4<f32>) -> @builtin(frag_depth) f32 {\n' +
  '  let centre = at.xy * sizes.xy / sizes.zw - vec2<f32>(0.5);\n' +
  '  let base = vec2<i32>(floor(centre));\n' +
  '  let top = vec2<i32>(sizes.xy) - vec2<i32>(1);\n' +
  '  var nearest = ' +
  FARTHEST +
  ';\n' +
  '  for (var y = 0; y < 2; y += 1) {\n' +
  '    for (var x = 0; x < 2; x += 1) {\n' +
  '      let texel = clamp(base + vec2<i32>(x, y), vec2<i32>(0), top);\n' +
  '      nearest = ' +
  NEARER +
  '(nearest, textureLoad(source, texel, 0));\n' +
  '    }\n' +
  '  }\n' +
  '  return nearest;\n' +
  '}\n';
