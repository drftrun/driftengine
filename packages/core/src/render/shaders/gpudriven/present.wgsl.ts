/**
 * Putting the GPU-driven pipeline's colour into the frame it was invited to draw in.
 *
 * **A contributed pass cannot write into the frame's attachment directly and should not want
 * to.** `pass.ts` refuses a declared write-set for a reason it states at length; what a pass gets
 * instead is a target of its own and a draw call at the point the caller put it. So the pipeline
 * fills a storage texture in `prepare` and this puts it on the screen in `draw` — one triangle, no
 * sampler, and `textureLoad` at the fragment's own pixel.
 *
 * **`textureLoad` rather than a sampler, because there is nothing to filter.** The target is the
 * frame's own size and the mapping is one texel to one pixel; a sampler would add a filtering mode
 * to choose and a half-pixel offset to get wrong, in exchange for nothing. It also means the
 * texture needs no `filterable` sample type, which `rgba16float` has but which a future `r32float`
 * would not.
 *
 * **It grades where nothing after it will**, as every pass in this engine does: the pipeline shades
 * linear light into its own target, and `PassContext.outputTransform` is 0 where the frame's resolve
 * grades and the frame's code where it does not. The colour is premultiplied by its coverage, so it
 * is graded as a colour and covered again: a pane against the sky keeps the share it had.
 */

/**
 * `applyOutputTransform` in WGSL: the WGSL twin of `OUTPUT_TRANSFORM_BODY_GLSL` in
 * `shaders/outputTransform.ts`, for a blit the generator cannot reach because it is hand-written —
 * it reads a storage texture and writes depth, which the GLSL path has no form for. **Two copies of
 * one curve**, held together by `present.test.ts`, which reads every constant out of both and asks
 * that they be the same numbers in the same order. Code 4, the filmic curve, never arrives here: a
 * forward grade is never the composite's own (`forwardTransformCode`).
 */
export const GRADE_WGSL = `
struct Grade {
  transform: i32,
  exposure: f32,
}

@group(0) @binding(2) var<uniform> grade: Grade;

fn rrtAndOdtFit(v: vec3<f32>) -> vec3<f32> {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

fn acesFilmic(colour: vec3<f32>) -> vec3<f32> {
  let x = colour * grade.exposure;
  let acesInput = mat3x3<f32>(
    vec3<f32>(0.59719, 0.07600, 0.02840),
    vec3<f32>(0.35458, 0.90834, 0.13383),
    vec3<f32>(0.04823, 0.01566, 0.83777),
  );
  let acesOutput = mat3x3<f32>(
    vec3<f32>(1.60475, -0.10208, -0.00327),
    vec3<f32>(-0.53108, 1.10813, -0.07276),
    vec3<f32>(-0.07367, -0.00605, 1.07602),
  );
  return clamp(acesOutput * rrtAndOdtFit(acesInput * x), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let low = c * 12.92;
  let high = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3<f32>(0.0031308));
}

fn highlightShoulder(c: vec3<f32>) -> vec3<f32> {
  let m = max(c.r, max(c.g, c.b));
  if (m <= 0.8) { return c; }
  let e = m - 0.8;
  return c * ((0.8 + 0.2 * e / (e + 0.2)) / m);
}

fn applyOutputTransform(colour: vec3<f32>) -> vec3<f32> {
  var c = colour;
  if (grade.transform == 2) { c = acesFilmic(c); }
  if (grade.transform == 3) { c = highlightShoulder(c * grade.exposure); }
  return linearToSrgb(c);
}

/* Premultiplied in and out: the colour graded, its coverage kept. Untouched at code 0. */
fn graded(texel: vec4<f32>) -> vec4<f32> {
  if (grade.transform == 0) { return texel; }
  return vec4<f32>(applyOutputTransform(texel.rgb / texel.a) * texel.a, texel.a);
}
`;

export const GPU_DRIVEN_BLIT_WGSL = `
struct Varying {
  @builtin(position) position: vec4<f32>,
}

@group(0) @binding(0) var source: texture_2d<f32>;
${GRADE_WGSL}
@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> Varying {
  /* One triangle covering the frame rather than two: no shared edge, no diagonal seam, and the
     third of the area outside the viewport costs nothing. */
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: Varying;
  out.position = vec4<f32>(corners[vertex], 0.0, 1.0);
  return out;
}

@fragment
fn fragmentMain(in: Varying) -> @location(0) vec4<f32> {
  /* The fragment's own pixel. Clamped rather than trusted: a frame larger than the pass's target
     is a caller that did not resize, and reading out of bounds is a zero this would draw as a
     black band nobody could place. */
  let size = textureDimensions(source);
  let at = min(vec2<u32>(in.position.xy), size - vec2<u32>(1u, 1u));
  let texel = textureLoad(source, at, 0);
  /*
   * **Nothing was drawn here, so nothing is written — and that is a cost, not a correctness
   * guard.** The target is cleared to zero and a zero laid over anything premultiplied is that
   * thing, so the pixel would come out the same either way; this spares every pixel the pipeline
   * did not cover a blend. Removing it left "depth-share-check.mjs" green on 2026-09-18, which is
   * what says so. Alpha is the coverage: the shading writes one and a blended surface adds its own.
   *
   * **Returned as it is, premultiplied, and the pipeline blends it over.** Where the visibility
   * buffer covered the pixel the coverage is one and over is a plain write. Where only a pane did,
   * it is the pane's coverage, and the frame behind it — the sky — has to show through by the rest.
   * This used to discard below a half and write the colour as opaque, which painted a heavy pane
   * over black and dropped a light one altogether.
   */
  if (texel.a <= 0.0) { discard; }
  return graded(texel);
}
`;

/**
 * The same blit, handing the frame the pass's depth as well as its colour.
 *
 * **Two pipelines in one frame need one depth buffer.** The blit above presents colour and nothing
 * else, which is right for a consumer whose whole scene is this pipeline — and wrong for one that
 * draws its own geometry beside it, because then a forward-path mesh behind GPU-driven geometry has
 * nothing to be hidden by. No ordering fixes that: drawn before the blit it is painted over, drawn
 * after it floats in front of a hill.
 *
 * **The formats already agree.** The pass's depth texture and the frame's both take `DEPTH_FORMAT`
 * and `DEPTH_COMPARE` from `depthConvention.ts`, so this is the same format and the same reversed
 * convention and there is no conversion to get wrong. `gpuDrivenPass.ts` asserts that rather than
 * trusting it, because a backend that ever differed would produce a depth test that is silently
 * inverted instead of one that fails.
 *
 * **A pixel the pipeline did not cover is discarded before it writes**, exactly as above, so the
 * sky keeps the depth the frame already had rather than being pushed to the near plane. A pixel
 * only a pane covered writes the depth the pass cleared to, which is the frame's own clear — the
 * pipeline compares "or equal" so that it passes over the sky, and what it writes there is the
 * value already there.
 */
export const GPU_DRIVEN_BLIT_DEPTH_WGSL = /* wgsl */ `
struct Varying {
  @builtin(position) position: vec4<f32>,
}

struct Presented {
  @location(0) colour: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceDepth: texture_depth_2d;
${GRADE_WGSL}
@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> Varying {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: Varying;
  out.position = vec4<f32>(corners[vertex], 0.0, 1.0);
  return out;
}

@fragment
fn fragmentMain(in: Varying) -> Presented {
  let size = textureDimensions(source);
  let at = min(vec2<u32>(in.position.xy), size - vec2<u32>(1u, 1u));
  let texel = textureLoad(source, at, 0);
  /* A cost here too: the depth the pass cleared to passes only where the frame holds that same
     clear, so the write would change nothing. The colour blit above says how that was measured. */
  if (texel.a <= 0.0) { discard; }
  var out: Presented;
  out.colour = graded(texel);
  /* The depth this pixel was rastered at, so the frame tests against the surface it can see. */
  out.depth = textureLoad(sourceDepth, at, 0);
  return out;
}
`;
