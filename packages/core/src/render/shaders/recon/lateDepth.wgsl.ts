/**
 * The render's depth, taken up to the output size for the draws that land after the upscale.
 *
 * `recon/lateDepth.ts` is the same arithmetic and says why: **each of the four render texels about
 * the pixel carries its surface on to the pixel's unjittered centre** along a slope the minmod
 * limiter takes — the smaller of its two differences on an axis, none where they disagree — and the
 * nearest of the four so carried stands, less a quarter of its slope. On a plane that is the plane's
 * own depth at the pixel whatever the jitter; at an edge no slope crosses the jump, so a
 * translucent draw is never let through an opaque edge the render covered.
 *
 * Hand-written, and built by concatenation rather than a template literal: the reconstruction's
 * passes have no WebGL2 twin (the AGENTS.md exception for them), and a `${}` inside WGSL source is
 * the thing that rule forbids.
 */
import { REVERSED_DEPTH } from '../../depthConvention.ts';

/** The nearer of two stored depths: the larger in a reversed buffer. */
const NEARER = REVERSED_DEPTH ? 'max' : 'min';
/** Toward the far side: down in a reversed buffer. */
const FARWARD = REVERSED_DEPTH ? '-' : '+';
/** Where the search for the nearest starts: the far plane. */
const FARTHEST = REVERSED_DEPTH ? '0.0' : '1.0';

export const LATE_DEPTH_WGSL =
  '@group(0) @binding(0) var source: texture_depth_2d;\n' +
  '/* The render size and the output size; then the frame jitter, in render texels. */\n' +
  '@group(0) @binding(1) var<uniform> sizes: array<vec4<f32>, 2>;\n' +
  '\n' +
  '@vertex\n' +
  'fn lateDepthVert(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {\n' +
  '  let x = f32((index << 1u) & 2u);\n' +
  '  let y = f32(index & 2u);\n' +
  '  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);\n' +
  '}\n' +
  '\n' +
  'fn tap(base: vec2<i32>, x: i32, y: i32) -> f32 {\n' +
  '  let top = vec2<i32>(sizes[0].xy) - vec2<i32>(1);\n' +
  '  return textureLoad(source, clamp(base + vec2<i32>(x, y), vec2<i32>(0), top), 0);\n' +
  '}\n' +
  '\n' +
  '/* The smaller of two differences, or none where they disagree in sign. */\n' +
  'fn minmod(a: f32, b: f32) -> f32 {\n' +
  '  if (a * b <= 0.0) {\n' +
  '    return 0.0;\n' +
  '  }\n' +
  '  return select(b, a, abs(a) < abs(b));\n' +
  '}\n' +
  '\n' +
  '@fragment\n' +
  'fn lateDepthFrag(@builtin(position) at: vec4<f32>) -> @builtin(frag_depth) f32 {\n' +
  '  /* A texel stands at its index plus a half less the jitter, as the resolve places it. */\n' +
  '  let centre = at.xy * sizes[0].xy / sizes[0].zw - vec2<f32>(0.5) + sizes[1].xy;\n' +
  '  let base = vec2<i32>(floor(centre));\n' +
  '  let f = centre - floor(centre);\n' +
  '  var depth = ' +
  FARTHEST +
  ';\n' +
  '  for (var oy = 0; oy < 2; oy += 1) {\n' +
  '    for (var ox = 0; ox < 2; ox += 1) {\n' +
  '      let d = tap(base, ox, oy);\n' +
  '      let gx = minmod(tap(base, ox + 1, oy) - d, d - tap(base, ox - 1, oy));\n' +
  '      let gy = minmod(tap(base, ox, oy + 1) - d, d - tap(base, ox, oy - 1));\n' +
  '      let carried = d + gx * (f.x - f32(ox)) + gy * (f.y - f32(oy));\n' +
  '      depth = ' +
  NEARER +
  '(depth, carried ' +
  FARWARD +
  ' 0.25 * max(abs(gx), abs(gy)));\n' +
  '    }\n' +
  '  }\n' +
  '  return clamp(depth, 0.0, 1.0);\n' +
  '}\n';
