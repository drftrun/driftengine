/**
 * Where a drawn surface was last frame, written into the reconstruction's motion target.
 *
 * **A pass of its own rather than a second output on every material.** The alternative is a second
 * colour attachment on every generated fragment stage, which `ARCHITECTURE.md` §1 prices at 196,910
 * gzipped bytes for one flag — and it would be paid by every consumer, including the ones who never
 * reconstruct anything. This draws only the meshes a caller said had moved, with one small shader
 * over the position buffer alone.
 *
 * **What a pixel carries**: the offset from where it is now to where its surface was, in the uv the
 * resolve measures in; the view depth it had then, which is what the disocclusion compares against
 * last frame's depth; and a flag. `recon/resolve.ts`'s `historyWeight` is the reader, and a texel
 * this pass did not write is a zero flag, which means *derive the camera's motion from the depth* —
 * so a scene that says nothing about its movers is exactly the scene this pass never ran for.
 *
 * **The rasterisation matrix is handed over whole, and that is deliberate.** The scene is drawn by
 * shaders `naga` generated, every one of which ends its vertex stage with `gl_Position.y = -y`, and
 * `CLIP_CORRECTION` carries a negation to cancel it — §3 rows 56 and 57. This shader is hand
 * written and has no such negation, so rather than reason about halves of that pair per draw, the
 * renderer multiplies the two together once a frame and passes the product. The vertex stage then
 * has one job: put the position exactly where the scene put it, so the depth test compares like
 * with like.
 *
 * **The motion itself is measured from the *unjittered* matrices**, which is the whole of §3 row
 * 121: the history stands for a picture of the scene as it would have been drawn with no jitter, so
 * a motion vector that carried the jitter difference would move every sample by a fraction of a
 * pixel in a pattern that repeats with the jitter period — shimmer, diagnosed as anything but its
 * cause.
 */

/** Floats in the per-frame block: three matrices. */
export const MOTION_FRAME_FLOATS = 48;

/**
 * Bytes a draw's own block takes.
 *
 * Two matrices is 128, and a dynamic uniform offset must be a multiple of 256 — the same alignment
 * §3 row 50's neighbours are about. So each draw takes a whole 256 and half of it is padding, which
 * is the cheaper half of the trade against a bind group per draw inside the frame loop.
 */
export const MOTION_DRAW_STRIDE = 256;

/** Floats a draw actually writes inside that stride. */
export const MOTION_DRAW_FLOATS = 32;

/** The motion target's format. Half float holds a uv to a hundredth of a pixel and a view depth. */
export const MOTION_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';

export const RECON_MOTION_WGSL = /* wgsl */ `
struct MotionFrame {
  /* The scene's own clip transform, with the generated shaders' y negation already folded in. */
  raster: mat4x4<f32>,
  /* This frame's and last frame's view-projections, unjittered, in the matrices' own convention. */
  viewProj: mat4x4<f32>,
  previousViewProj: mat4x4<f32>,
}

struct MotionDraw {
  model: mat4x4<f32>,
  previousModel: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> frame: MotionFrame;
@group(0) @binding(1) var<uniform> draw: MotionDraw;

struct Varyings {
  @builtin(position) clip: vec4<f32>,
  /* Clip positions rather than uv: an interpolator divides by w for us, so dividing these by their
     own interpolated w in the fragment stage is the perspective-correct answer at every pixel. */
  @location(0) now: vec4<f32>,
  @location(1) was: vec4<f32>,
}

@vertex
fn motionVert(@location(0) position: vec3<f32>) -> Varyings {
  let world = draw.model * vec4<f32>(position, 1.0);
  let wasWorld = draw.previousModel * vec4<f32>(position, 1.0);
  var out: Varyings;
  out.clip = frame.raster * world;
  out.now = frame.viewProj * world;
  out.was = frame.previousViewProj * wasWorld;
  return out;
}

/* Normalised device coordinates to the uv the resolve measures in: v increases upward, as the
   references' images do, and the accessor that reads this target is what flips the texture's rows. */
fn motionUv(clip: vec4<f32>) -> vec2<f32> {
  return clip.xy / clip.w * 0.5 + vec2<f32>(0.5);
}

/*
 * The skinned stage: the joints this frame and last frame, read from two palette textures of the
 * frame's ring. The same four weighted products in the same order as the scene's own skinning, so
 * the depth this stage produces is the depth the scene wrote.
 */
@group(1) @binding(0) var palette: texture_2d<f32>;
@group(1) @binding(1) var previousPalette: texture_2d<f32>;

fn jointOf(source: texture_2d<f32>, index: i32) -> mat4x4<f32> {
  let x = index * 4;
  return mat4x4<f32>(
    textureLoad(source, vec2<i32>(x, 0), 0),
    textureLoad(source, vec2<i32>(x + 1, 0), 0),
    textureLoad(source, vec2<i32>(x + 2, 0), 0),
    textureLoad(source, vec2<i32>(x + 3, 0), 0));
}

fn skinOf(source: texture_2d<f32>, joints: vec4<f32>, weights: vec4<f32>) -> mat4x4<f32> {
  return jointOf(source, i32(joints.x)) * weights.x
       + jointOf(source, i32(joints.y)) * weights.y
       + jointOf(source, i32(joints.z)) * weights.z
       + jointOf(source, i32(joints.w)) * weights.w;
}

@vertex
fn motionSkinnedVert(
  @location(0) position: vec3<f32>,
  @location(11) joints: vec4<f32>,
  @location(12) weights: vec4<f32>,
) -> Varyings {
  let world = draw.model * (skinOf(palette, joints, weights) * vec4<f32>(position, 1.0));
  let wasWorld =
    draw.previousModel * (skinOf(previousPalette, joints, weights) * vec4<f32>(position, 1.0));
  var out: Varyings;
  out.clip = frame.raster * world;
  out.now = frame.viewProj * world;
  out.was = frame.previousViewProj * wasWorld;
  return out;
}

/*
 * The rewritten stage: a mesh whose vertices were rewritten this frame reads last frame's rows from
 * a second buffer of the same stride, so each vertex carries both of its positions.
 */
@vertex
fn motionDynamicVert(
  @location(0) position: vec3<f32>,
  @location(1) previousPosition: vec3<f32>,
) -> Varyings {
  let world = draw.model * vec4<f32>(position, 1.0);
  let wasWorld = draw.previousModel * vec4<f32>(previousPosition, 1.0);
  var out: Varyings;
  out.clip = frame.raster * world;
  out.now = frame.viewProj * world;
  out.was = frame.previousViewProj * wasWorld;
  return out;
}

/*
 * The instanced stage: each instance's matrix this frame and last frame, read from the batch's
 * placement and the copy of last frame's it kept. Slot for slot, so an instance is paired with
 * itself; the per-draw matrices are not read.
 */
@vertex
fn motionInstancedVert(
  @location(0) position: vec3<f32>,
  @location(2) m0: vec4<f32>,
  @location(3) m1: vec4<f32>,
  @location(4) m2: vec4<f32>,
  @location(5) m3: vec4<f32>,
  @location(6) p0: vec4<f32>,
  @location(7) p1: vec4<f32>,
  @location(8) p2: vec4<f32>,
  @location(9) p3: vec4<f32>,
) -> Varyings {
  let world = mat4x4<f32>(m0, m1, m2, m3) * vec4<f32>(position, 1.0);
  let wasWorld = mat4x4<f32>(p0, p1, p2, p3) * vec4<f32>(position, 1.0);
  var out: Varyings;
  out.clip = frame.raster * world;
  out.now = frame.viewProj * world;
  out.was = frame.previousViewProj * wasWorld;
  return out;
}

@fragment
fn motionFrag(in: Varyings) -> @location(0) vec4<f32> {
  /*
   * A surface behind last frame's eye has a w that is not positive, and there is no uv for it. The
   * flag stays set: the disocclusion refuses a depth that is not positive, so the resolve drops the
   * history rather than reading it from wherever a divide by a negative w would have pointed.
   */
  let offset = select(vec2<f32>(0.0), motionUv(in.was) - motionUv(in.now), in.was.w > 0.0);
  return vec4<f32>(offset, in.was.w, 1.0);
}
`;
