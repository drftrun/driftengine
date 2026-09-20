import { GPU_DRIVEN_VERTEX_FLOATS } from '../../gpudriven/sceneUpload.ts';
import { EMISSIVE_SHADOW_SHARE, MIN_LOBE_ALPHA } from '../flat/lobes.ts';
import { RELIEF_ROUGHNESS } from '../flat/preamble.ts';
import { DECODE_WGSL, decodeResourcesWgsl } from './decode.wgsl.ts';
import { FOG_WGSL } from './fog.wgsl.ts';
import { FRAME_BLOCK_WGSL } from './frameBlock.wgsl.ts';
import { MATERIAL_SLOTS, MATERIAL_TABLE_WGSL } from './materialTable.wgsl.ts';
import { MESH_TRANSFORM_WGSL } from './meshTransform.wgsl.ts';
import { ENVIRONMENT_WGSL } from './environment.wgsl.ts';
import { SHADE_SHADOW_WGSL } from './shadow.wgsl.ts';

/**
 * Rebuilding a pixel's surface from the triangle it recorded, on the device.
 *
 * **The same arithmetic as `gpudriven/shadeBins.ts`, term for term**, and
 * `scripts/gpu-parity.mjs` runs both over generated triangles until they agree. That is the whole
 * safety property of this file: a visibility buffer's interpolation is the only part of the
 * shading that differs between the two pipelines, so it is the only part that can drift, and the
 * check is on the part that can drift.
 *
 * **The lighting is not here and must not arrive here.** What this pass produces is a surface — a
 * position, a normal, texture coordinates and their screen gradients — and the lit expression that
 * consumes it is the forward path's own, wired in when the pipeline is assembled. A second copy of
 * the lighting would drift from the first and the parity gate would be the only thing that
 * noticed; the plan says so in those words and it is right.
 *
 * **Gradients are derived, not differenced.** A fragment shader gets `dpdx` and `dpdy` because it
 * runs in quads of four; a compute invocation has no neighbours and no derivative at all. Without
 * an analytic one a texture read picks a fixed level, which is blurry everywhere, or level zero,
 * which sparkles — and neither reads as a missing derivative.
 */

/**
 * The interpolation itself, with no bindings and no layout in it.
 *
 * **Its own string because two shaders do this and only one of them can be checked.** The
 * reconstruction below is run against `shadeBins.ts` over generated triangles by
 * `gpu-parity.mjs`; the pipeline's real shading pass reads different buffers and writes a colour,
 * so nothing can compare it to a reference. Sharing the *text* is what makes the checked one
 * speak for both — a second copy of the quotient rule would be the half nobody is watching, which
 * is precisely the arrangement this wave keeps finding and refusing.
 *
 * Takes clip positions and pixel centres and answers weights and their two gradients. `valid` is
 * false for a degenerate triangle or a perspective denominator at zero, which is a visibility
 * identifier for a triangle the rasteriser never drew.
 */
export const SHADE_SURFACE_WGSL = `
struct Screen {
  x: f32,
  y: f32,
  invW: f32,
}

struct Weights {
  /** The perspective-correct barycentric weights. */
  c: vec3<f32>,
  /** How each of them changes with screen x, and with screen y. */
  gx: vec3<f32>,
  gy: vec3<f32>,
  valid: bool,
}

fn screenOf(clip: vec4<f32>, width: f32, height: f32) -> Screen {
  let inv = 1.0 / clip.w;
  var out: Screen;
  out.x = (clip.x * inv * 0.5 + 0.5) * width;
  out.y = (clip.y * inv * 0.5 + 0.5) * height;
  out.invW = inv;
  return out;
}

fn surfaceWeights(s0: Screen, s1: Screen, s2: Screen, px: f32, py: f32) -> Weights {
  var out: Weights;
  out.valid = false;

  let area = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (abs(area) < 1e-12) { return out; }
  let inverse = 1.0 / area;

  /* Screen-space weights. A point outside the triangle gets a negative one rather than a clamp:
     clamping shades a pixel beyond an edge as though it were on the triangle. */
  let l1 = ((px - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (py - s0.y)) * inverse;
  let l2 = ((s1.x - s0.x) * (py - s0.y) - (px - s0.x) * (s1.y - s0.y)) * inverse;
  let l0 = 1.0 - l1 - l2;

  let n0 = l0 * s0.invW;
  let n1 = l1 * s1.invW;
  let n2 = l2 * s2.invW;
  let sum = n0 + n1 + n2;
  if (abs(sum) < 1e-20) { return out; }
  let invSum = 1.0 / sum;
  out.c = vec3<f32>(n0 * invSum, n1 * invSum, n2 * invSum);

  /* The screen weights' gradients, constant over the triangle. */
  let d1dx = (s2.y - s0.y) * inverse;
  let d1dy = (s0.x - s2.x) * inverse;
  let d2dx = (s0.y - s1.y) * inverse;
  let d2dy = (s1.x - s0.x) * inverse;
  let d0dx = -d1dx - d2dx;
  let d0dy = -d1dy - d2dy;

  let dSumDx = d0dx * s0.invW + d1dx * s1.invW + d2dx * s2.invW;
  let dSumDy = d0dy * s0.invW + d1dy * s1.invW + d2dy * s2.invW;

  /* Quotient rule, per weight, with the shared denominator factored out. */
  out.gx = vec3<f32>(
    (d0dx * s0.invW - n0 * invSum * dSumDx) * invSum,
    (d1dx * s1.invW - n1 * invSum * dSumDx) * invSum,
    (d2dx * s2.invW - n2 * invSum * dSumDx) * invSum,
  );
  out.gy = vec3<f32>(
    (d0dy * s0.invW - n0 * invSum * dSumDy) * invSum,
    (d1dy * s1.invW - n1 * invSum * dSumDy) * invSum,
    (d2dy * s2.invW - n2 * invSum * dSumDy) * invSum,
  );
  out.valid = true;
  return out;
}

/* surfaceFrame.ts surfaceLod: the longer screen-axis UV step, in texels, as a power of two. */
fn surfaceLod(gradX: vec2<f32>, gradY: vec2<f32>, size: f32) -> f32 {
  let footprint = max(length(gradX), length(gradY)) * size;
  return max(log2(max(footprint, 1e-30)), 0.0);
}

struct TangentFrame {
  t: vec3<f32>,
  b: vec3<f32>,
}

/* surfaceFrame.ts derivedTangentFrame, which is tangentFrame.ts's derived branch term for term. */
fn derivedTangentFrame(
  n: vec3<f32>,
  dp1: vec3<f32>,
  dp2: vec3<f32>,
  duv1: vec2<f32>,
  duv2: vec2<f32>,
) -> TangentFrame {
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let dt = dp2perp * duv1.x + dp1perp * duv2.x;
  let db = dp2perp * duv1.y + dp1perp * duv2.y;
  let det = duv1.x * duv2.y - duv2.x * duv1.y;
  let handed = select(1.0, -1.0, det < 0.0);
  let scale = inverseSqrt(max(max(dot(dt, dt), dot(db, db)), 1e-12)) * handed;
  var frame: TangentFrame;
  frame.t = dt * scale;
  frame.b = db * scale;
  return frame;
}
`;

/**
 * One invocation a pixel of one material's bin.
 *
 * `settings` is the bin's offset, its length, the screen width and the screen height. A dispatch
 * is issued per material from the blocks `materialBin.wgsl.ts` wrote, so the bin this reads is
 * whichever one the caller bound — the shader does not choose.
 *
 * The outputs here are the reconstruction rather than a colour, because that is what can be
 * compared against a reference. In the assembled pipeline the same values feed the lit expression
 * and the colour is what lands.
 */
export const SHADE_RECONSTRUCT_WGSL = `${SHADE_SURFACE_WGSL}
const VIS_TRIANGLE_BITS: u32 = 7u;
const VIS_EMPTY: u32 = 0xffffffffu;

/** binOffset, binCount, width, height. */
@group(0) @binding(0) var<storage, read> settings: array<u32, 4>;
@group(0) @binding(1) var<storage, read> binPixels: array<u32>;
@group(0) @binding(2) var<storage, read> visibility: array<u32>;
/** Four words a cluster: index offset, index count, cluster identifier, mesh. */
@group(0) @binding(3) var<storage, read> clusterMeta: array<u32>;
@group(0) @binding(4) var<storage, read> indices: array<u32>;
/** Four floats a vertex: clip x, clip y, clip w, and one attribute to interpolate. */
@group(0) @binding(5) var<storage, read> vertices: array<f32>;
/** Six floats a pixel: the interpolated attribute, its two gradients, and the three weights. */
@group(0) @binding(6) var<storage, read_write> surface: array<f32>;

fn clipOf(vertex: u32) -> vec4<f32> {
  let at = vertex * 4u;
  return vec4<f32>(vertices[at], vertices[at + 1u], 0.0, vertices[at + 2u]);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  /* Past the end of the bin, which is the ordinary case: a bin is not a multiple of the group
     size, and the spare lanes must do nothing rather than shade the last pixel again. */
  if (id.x >= settings[1]) { return; }
  let pixel = binPixels[settings[0] + id.x];
  let packed = visibility[pixel];
  if (packed == VIS_EMPTY) { return; }

  let cluster = packed >> VIS_TRIANGLE_BITS;
  let triangle = packed & 127u;
  let metaAt = cluster * 4u;
  let indexOffset = clusterMeta[metaAt];

  let i0 = indices[indexOffset + triangle * 3u];
  let i1 = indices[indexOffset + triangle * 3u + 1u];
  let i2 = indices[indexOffset + triangle * 3u + 2u];

  let width = f32(settings[2]);
  let height = f32(settings[3]);
  let s0 = screenOf(clipOf(i0), width, height);
  let s1 = screenOf(clipOf(i1), width, height);
  let s2 = screenOf(clipOf(i2), width, height);

  /* Pixel centres, which is where a rasteriser decided this pixel was covered. */
  let px = f32(pixel % settings[2]) + 0.5;
  let py = f32(pixel / settings[2]) + 0.5;

  let w = surfaceWeights(s0, s1, s2, px, py);
  if (!w.valid) { return; }

  let a = vec3<f32>(
    vertices[i0 * 4u + 3u],
    vertices[i1 * 4u + 3u],
    vertices[i2 * 4u + 3u],
  );

  let out = id.x * 6u;
  surface[out] = dot(a, w.c);
  surface[out + 1u] = dot(a, w.gx);
  surface[out + 2u] = dot(a, w.gy);
  surface[out + 3u] = w.c.x;
  surface[out + 4u] = w.c.y;
  surface[out + 5u] = w.c.z;
}
`;

/**
 * One dispatch a material: every pixel in that material's bin, lit and written to the frame.
 *
 * **This is the assembled half, and it is the one nothing can compare against a reference.** The
 * interpolation it rests on is `SHADE_SURFACE_WGSL` above, which *is* compared — that sharing is
 * the point of the split, because the quotient rule is what drifts and a second copy of it would
 * be the copy nobody watches.
 *
 * **Which material a dispatch is shading arrives in a uniform with a per-material bind group**, not
 * in the shader. There is no builtin for "which dispatch am I", and a shader per material would be
 * a pipeline per material — so one pipeline is bound once and group one moves per dispatch. The
 * bin's own offset and length are read from the buffers `materialBin.wgsl.ts` wrote rather than
 * passed in, so there is one statement of where a bin is.
 *
 * **Eight storage buffers is the budget and this pass spends all of it.**
 * `maxStorageBuffersPerShaderStage` is 8 by default; this adapter offers 16 and most do, and a
 * pipeline that asked for the higher limit would refuse to create a device on the ones that do
 * not. So the vertex attributes are interleaved into one buffer rather than three, and the frame
 * block and the material table are uniforms. Found at pipeline creation with twelve.
 *
 * **What the lighting here is, and what it is not.** Vertex colour times the material's tint, one
 * directional term with its highlight and its shadow, the same hemispheric ambient the forward path
 * uses — `mix(ground, sky, n.y * 0.5 + 0.5)` — and the material's emissive. It is not the forward
 * path's standard material: no image-based term and no texture. Those belong to a pipeline that
 * draws the published scenes, and this one draws drafts. **Stating the gap is the point**;
 * discovering it from a capture is what this repository keeps refusing.
 *
 * **The pixel centre is the flipped row.** WebGPU's framebuffer origin is the top-left, so row zero
 * is where clip y is +1, and `screenOf` maps clip y of +1 to `height`. The flip belongs to the
 * pixel rather than to the shared function, which is checked against a reference and must not
 * learn about a framebuffer; flipping all four points of a barycentric evaluation leaves the
 * weights unchanged, which is why this is the whole of it.
 *
 * **The normal is transformed by the upper three-by-three and renormalised**, which is right for
 * the rigid transforms with uniform scale the draft scenes use and wrong for a non-uniform one —
 * that wants the inverse transpose. A scene that needs it will find this comment rather than a
 * lighting error nobody can place.
 */
/**
 * The lit expression, as text, with no bindings in it.
 *
 * **Its own string for the reason the reconstruction above has one, arrived at the same way.** The
 * shading pass writes a colour into a storage texture, so nothing could compare it to a reference —
 * and for as long as the expression was four lines, the shading pass's header argued that nothing
 * needed to. That argument stops the moment the expression grows a term. `gpudriven/lit.ts` is the
 * twin now, `SHADE_LIGHTING_PARITY_WGSL` below is an entry point that does nothing but call this,
 * and `scripts/gpu-parity.mjs` runs both over generated surfaces.
 *
 * Every term matches `flat/main.ts` at the one configuration this pipeline supports — metalness
 * zero, which collapses the Fresnel blend on the highlight to the surface's own reflectance.
 */
export const SHADE_LIGHTING_WGSL = `
/* The normalised GGX distribution, transcribed from flat/lobes.ts. See lit.ts about its peak. */
/*
 * **Two floors, and only one of them can be seen in the output.** The denominator's is what keeps
 * a near-mirror's peak finite, and deleting it is worth 256 times the highlight at roughness 0.05 —
 * gpu-parity.mjs catches that, now that a fifth of its corpus sits on the peak. The floor on a
 * cannot be caught, because the denominator's already prevents the division by zero it guards
 * against: at roughness zero the whole term is a ten-thousandth with it and zero without, and both
 * round to nothing beside a lit surface. It is kept because it is what flat/lobes.ts has, and two
 * spellings of one lobe differing by a guard is the drift this pair exists to prevent.
 */
fn specularLobe(ndh: f32, roughness: f32) -> f32 {
  let a = max(roughness * roughness, ${MIN_LOBE_ALPHA});
  let a2 = a * a;
  let d = ndh * ndh * (a2 - 1.0) + 1.0;
  return (a2 * a2) / max(d * d, 1e-8);
}

/* A dielectric's normal-incidence reflectance, which every material in this pipeline is. */
const DIELECTRIC_F0: f32 = 0.04;

/*
 * The split sum's second half, as Karis's analytic fit: dfg.x scales f0 and dfg.y adds on top.
 * gpudriven/ibl.ts is the twin and carries what the tabulated integral would cost instead.
 */
fn envBrdfApprox(ndv: f32, roughness: f32) -> vec2<f32> {
  let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}

/*
 * The same with the multiply-scattered light put back. At f0 of one this returns exactly 1.0 at
 * every roughness, which is the invariant ibl.test.ts asserts across the range: roughness
 * scatters light and does not absorb it, and the bare split sum claims otherwise by up to 44%.
 */
fn envSpecularEnergy(f0: f32, dfg: vec2<f32>) -> f32 {
  let single = f0 * dfg.x + dfg.y;
  let energy = dfg.x + dfg.y;
  let missing = 1.0 - energy;
  let average = f0 + (1.0 - f0) / 21.0;
  let multi = single * average / (1.0 - missing * average);
  return single + multi * missing;
}

/*
 * How much of what the surface sees in the mirror direction reaches the frame.
 *
 * Two expressions and a selector that is exactly 0 or exactly 1: the split sum is the correct
 * share of a prefiltered environment and asserts an integral that was never performed over
 * anything else. See ibl.ts for what ignoring that costs on the other pipeline.
 */
fn surfaceF0(metalness: f32) -> f32 {
  return mix(DIELECTRIC_F0, 1.0, metalness);
}

fn environmentWeight(
  ndv: f32,
  roughness: f32,
  reflectivity: f32,
  prefiltered: f32,
  metalness: f32,
) -> f32 {
  let f0 = surfaceF0(metalness);
  let facing = 1.0 - ndv;
  let fresnel = mix(f0, 1.0, facing * facing * facing * facing * facing);
  /*
   * max(reflectivity * (1 - roughness), metal), and both halves are repairs flat/main.ts records:
   * a metal reflects whether or not the pass asked for reflections, and the one-minus-roughness
   * thinning belongs to the dielectric alone. See ibl.ts.
   */
  let amount = max(reflectivity * (1.0 - roughness), metalness);
  let sweep = clamp(fresnel * amount, 0.0, 1.0);
  let dfg = envBrdfApprox(ndv, roughness);
  let integrated = clamp(envSpecularEnergy(f0, dfg) * max(reflectivity, metalness), 0.0, 1.0);
  return mix(sweep, integrated, prefiltered);
}

struct LitSurface {
  albedo: vec3<f32>,
  normal: vec3<f32>,
  toEye: vec3<f32>,
  roughness: f32,
  specular: f32,
  emissive: f32,
  /*
   * What the glow is coloured by: the albedo times an emissive map, flat/main.ts's
   * emissiveTint * emissiveMapped. The albedo itself where the material binds no map. See lit.ts.
   */
  emissiveColour: vec3<f32>,
  /* How much of the sun reaches here: 0 in full shadow, 1 in full light. See lit.ts. */
  shade: f32,
  reflectivity: f32,
  /* 0 is a dielectric and 1 is a metal. One number a material here, an ORM texel there. */
  metalness: f32,
  /* A crevice's share of everything below, as flat/main.ts applies ormOcclusion. See lit.ts. */
  occlusion: f32,
}

struct LitEnvironment {
  lightDir: vec3<f32>,
  lightColour: vec3<f32>,
  sky: vec3<f32>,
  ground: vec3<f32>,
  irradiance: vec3<f32>,
  radiance: vec3<f32>,
  irradianceAmount: f32,
  /* How much of the mirror-direction gradient the radiance replaces. Zero keeps the gradient. */
  radianceAmount: f32,
  prefiltered: f32,
  /* The frame's emissive gain times its night factor, which scales every glow. See lit.ts. */
  emission: f32,
}

fn litColour(surface: LitSurface, env: LitEnvironment) -> vec3<f32> {
  let n = surface.normal;
  let albedo = surface.albedo;
  let lightColour = env.lightColour;
  let roughness = surface.roughness;
  let shade = surface.shade;
  let ndl = max(dot(n, env.lightDir), 0.0);
  /*
   * The forward path's own hemispheric term — flat/main.ts, mix(ground, sky, n.y * 0.5 + 0.5) —
   * replaced by the room's irradiance where a caller supplies one rather than lifted toward it.
   */
  let hemispheric = mix(env.ground, env.sky, n.y * 0.5 + 0.5);
  let ambient = mix(hemispheric, env.irradiance, env.irradianceAmount);

  /*
   * The half vector between the light and the eye, and the highlight at its peak. Computed whether
   * or not the surface is shiny and multiplied by zero where it is not: a branch on a value read
   * from the material table is not provably uniform control flow, which is the rule this pass and
   * the forward one both keep.
   */
  let halfway = env.lightDir + surface.toEye;
  let length2 = dot(halfway, halfway);
  var ndh = 0.0;
  if (length2 > 0.0) {
    ndh = max(dot(n, halfway * inverseSqrt(length2)), 0.0);
  }
  let lobe = specularLobe(ndh, roughness);
  let metal = surface.metalness;
  /*
   * A metal's highlight takes its own colour and goes white at the edge; a dielectric's takes the
   * light's and does neither. mix(specular, albedo, 0) is specular exactly, and the Schlick term is
   * scaled by metalness, so at metalness 0 both lines are the expression that shipped before them.
   */
  let specColour = mix(vec3<f32>(surface.specular), albedo, metal);
  let voh = select(0.0, max(dot(surface.toEye, halfway * inverseSqrt(length2)), 0.0), length2 > 0.0);
  let facing = 1.0 - voh;
  let sunSpec = mix(specColour, vec3<f32>(1.0), facing * facing * facing * facing * facing * metal);
  let highlight = lightColour * lobe * sunSpec * shade;

  /*
   * Shade multiplies the two direct terms and not the ambient, which is where flat/main.ts puts
   * its own sunShade and what its comment says the wider version costs. A metal keeps its ambient
   * and loses its direct diffuse; the honest two terms cancel into this one.
   */
  let base = albedo * (ambient + lightColour * ndl * shade * (1.0 - metal)) + highlight * (1.0 - metal);
  /*
   * **The dielectric's highlight goes underneath the blend and the metal's goes on top**, which is
   * flat/main.ts's two lines with the mix between them. Underneath, the blend dims it by the
   * surface's own reflectance — taking it out puts a lobe that was correctly dimmed back at full
   * strength, which on a near-black glass lens carrying specular 1 is a white blob where there was
   * none. On top, it survives a weight of one, which is what a metal always has.
   */
  let nv = dot(n, surface.toEye);
  let ndv = max(nv, 0.0);
  /*
   * What the surface sees along the mirror direction, and with no probe it is the same two-colour
   * gradient the ambient comes from — which is what flat/main.ts reflects where a scene has no
   * environment. Unclamped nv, because reflect takes the facing term as it is: clamping folds the
   * direction back on a silhouette and reflects the sky where the ground belongs.
   */
  let mirrored = 2.0 * nv * n - surface.toEye;
  let gradient = mix(env.ground, env.sky, mirrored.y * 0.5 + 0.5);
  let seen = mix(gradient, env.radiance, env.radianceAmount);
  let weight = environmentWeight(ndv, roughness, surface.reflectivity, env.prefiltered, metal);
  /* A metal reflects the room through itself; mix(1, albedo, 0) is exactly 1 for a dielectric. */
  let reflected = seen * mix(vec3<f32>(1.0), albedo, metal);
  /* Scaled by the frame and dimmed by a share of the sun's shadow, as flat/main.ts's glow is. */
  let glow = surface.emissive * env.emission
    * mix(1.0, surface.shade, ${EMISSIVE_SHADOW_SHARE});
  return (mix(base, reflected, weight) + highlight * metal + surface.emissiveColour * glow)
    * surface.occlusion;
}
`;

export const SHADE_MATERIAL_WGSL = `${SHADE_SURFACE_WGSL}${SHADE_LIGHTING_WGSL}
const VIS_TRIANGLE_BITS: u32 = 7u;
const VIS_EMPTY: u32 = 0xffffffffu;
/** Floats a vertex: position, normal, colour, uv, glow. One buffer, for the storage budget. */
const VERTEX_FLOATS: u32 = ${GPU_DRIVEN_VERTEX_FLOATS}u;

${FRAME_BLOCK_WGSL}


${MATERIAL_TABLE_WGSL}
struct Job {
  material: u32,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> visibility: array<u32>;
@group(0) @binding(2) var<storage, read> binPixels: array<u32>;
@group(0) @binding(3) var<storage, read> binOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> binCounts: array<u32>;
/** Four words a cluster: index offset, index count, cluster identifier, mesh. */
@group(0) @binding(5) var<storage, read> clusterMeta: array<u32>;
@group(0) @binding(6) var<storage, read> indices: array<u32>;
@group(0) @binding(7) var<storage, read> vertices: array<f32>;
/** Sixteen floats a mesh. */
@group(0) @binding(8) var<storage, read> transforms: array<f32>;
@group(0) @binding(9) var<uniform> materials: array<Material, ${MATERIAL_SLOTS}>;
@group(0) @binding(10) var frameColour: texture_storage_2d<rgba16float, write>;
/*
 * **This pipeline's own map, not the frame's.** A contributed pass is handed a device and a format
 * and no attachments at all, so there is nothing of the forward path's to sample even when one
 * exists — see PassDevice. gpuDrivenPass.ts renders this one from the same clusters, before the
 * frame's own render pass opens.
 */
@group(0) @binding(11) var shadowMap: texture_depth_2d;
/*
 * **The frame's own probe, which is the one thing here the pass could not render for itself.**
 * PrepareContext.environment is the seam and carries why it is offered per frame rather than at
 * registration: a scene bakes when it likes, and a value captured once would be null for the life
 * of a pass that registered first. A stand-in one texel across is bound where there is none, so
 * the layout is the same either way and frame.environment.w is what says which.
 */
@group(0) @binding(12) var environmentMap: texture_2d_array<f32>;
@group(0) @binding(13) var environmentSampler: sampler;
${decodeResourcesWgsl({ group: 0, latents: 14, clampSampler: 15, repeatSampler: 16, nodes: 17, weights: 18 })}

fn decodeLatentSize() -> f32 {
  return frame.size.w;
}

${DECODE_WGSL}

@group(1) @binding(0) var<uniform> job: Job;

/*
 * Nearest, by integer coordinate, which is what the lookup's arithmetic assumes: the fetched depth
 * belongs to the centre of the containing texel and the plane compensation is measured to it. A
 * filtered read would blend four depths into a number no surface is at, which is not a softer
 * shadow — it is a comparison against a depth that does not exist.
 */
/*
 * **Layer 0, which is this pipeline reading one probe of a grid.** environment.wgsl.ts carries the
 * argument: a grid is what a large world wants and a single probe pops as a surface crosses a
 * cell, and what this pipeline owns is a fixed cluster set a few metres across.
 */
fn environmentSample(uv: vec2<f32>, level: f32) -> vec3<f32> {
  return textureSampleLevel(environmentMap, environmentSampler, uv, 0, level).rgb;
}

fn shadowDepthAt(u: f32, v: f32) -> f32 {
  let size = frame.shadow.y;
  let x = i32(clamp(floor(u * size), 0.0, size - 1.0));
  let y = i32(clamp(floor(v * size), 0.0, size - 1.0));
  return textureLoad(shadowMap, vec2<i32>(x, y), 0);
}
${SHADE_SHADOW_WGSL}
${ENVIRONMENT_WGSL}
${FOG_WGSL}

fn positionOf(vertex: u32) -> vec3<f32> {
  let at = vertex * VERTEX_FLOATS;
  return vec3<f32>(vertices[at], vertices[at + 1u], vertices[at + 2u]);
}

fn normalOf(vertex: u32) -> vec3<f32> {
  let at = vertex * VERTEX_FLOATS + 3u;
  return vec3<f32>(vertices[at], vertices[at + 1u], vertices[at + 2u]);
}

fn colourOf(vertex: u32) -> vec3<f32> {
  let at = vertex * VERTEX_FLOATS + 6u;
  return vec3<f32>(vertices[at], vertices[at + 1u], vertices[at + 2u]);
}

fn uvOf(vertex: u32) -> vec2<f32> {
  let at = vertex * VERTEX_FLOATS + 9u;
  return vec2<f32>(vertices[at], vertices[at + 1u]);
}

/* The vertex's own glow, added to the material's. Zero wherever a mesh carried none. */
fn emissiveOf(vertex: u32) -> f32 {
  return vertices[vertex * VERTEX_FLOATS + 11u];
}

${MESH_TRANSFORM_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let material = job.material;
  /* Past the end of this material's bin, which is the ordinary case: a bin is not a multiple of
     the group size, and a spare lane must do nothing rather than shade the last pixel again. */
  if (id.x >= binCounts[material]) { return; }
  let pixel = binPixels[binOffsets[material] + id.x];
  let packed = visibility[pixel];
  if (packed == VIS_EMPTY) { return; }

  let cluster = packed >> VIS_TRIANGLE_BITS;
  let triangle = packed & 127u;
  let metaAt = cluster * 4u;
  let indexOffset = clusterMeta[metaAt];
  let mesh = clusterMeta[metaAt + 3u];

  let i0 = indices[indexOffset + triangle * 3u];
  let i1 = indices[indexOffset + triangle * 3u + 1u];
  let i2 = indices[indexOffset + triangle * 3u + 2u];

  /* The row the buffer stores, which finds the pixel; the corners are placed by the width. */
  let row = u32(frame.pitch.x);
  let w0 = worldOf(mesh, positionOf(i0));
  let w1 = worldOf(mesh, positionOf(i1));
  let w2 = worldOf(mesh, positionOf(i2));

  let s0 = screenOf(frame.viewProj * vec4<f32>(w0, 1.0), frame.size.x, frame.size.y);
  let s1 = screenOf(frame.viewProj * vec4<f32>(w1, 1.0), frame.size.x, frame.size.y);
  let s2 = screenOf(frame.viewProj * vec4<f32>(w2, 1.0), frame.size.x, frame.size.y);

  let x = pixel % row;
  let y = pixel / row;
  /* Pixel centres, with the row flipped: see the header. */
  let weights = surfaceWeights(s0, s1, s2, f32(x) + 0.5, frame.size.y - f32(y) - 0.5);
  if (!weights.valid) { return; }

  let n0 = rotatedOf(mesh, normalOf(i0));
  let n1 = rotatedOf(mesh, normalOf(i1));
  let n2 = rotatedOf(mesh, normalOf(i2));
  let n = normalize(n0 * weights.c.x + n1 * weights.c.y + n2 * weights.c.z);
  let entry = materials[material];

  /*
   * **The texture coordinate, how fast it moves across this pixel, and the level that asks for.**
   * All three from the weights and gradients the shadow's receiver plane already uses, because a
   * compute invocation has no neighbours to difference against. The scale is applied first, as the
   * forward path's vUv already carries it.
   */
  let uvScale = entry.maps.xy;
  let uv0 = uvOf(i0) * uvScale;
  let uv1 = uvOf(i1) * uvScale;
  let uv2 = uvOf(i2) * uvScale;
  let uv = uv0 * weights.c.x + uv1 * weights.c.y + uv2 * weights.c.z;
  let duvdx = uv0 * weights.gx.x + uv1 * weights.gx.y + uv2 * weights.gx.z;
  let duvdy = uv0 * weights.gy.x + uv1 * weights.gy.y + uv2 * weights.gy.z;
  let textureLod = surfaceLod(duvdx, duvdy, frame.size.w);
  let time = frame.size.z;

  /*
   * **The normal map first, and everything after it reads the turned normal**, which is the order
   * flat/main.ts uses: its ndl, its shadow fade, its irradiance and its reflection all take the
   * mapped n. The material table is a uniform, and textureSampleLevel takes no implicit
   * derivative, so the branch is legal whichever way it goes.
   */
  var shadingNormal = n;
  if (entry.programs.y != NO_PROGRAM && entry.maps.z > 0.0) {
    let mapped = decodeProgram(entry.programs.y, uv, textureLod, time).xyz * 2.0 - 1.0;
    let dp1 = w0 * weights.gx.x + w1 * weights.gx.y + w2 * weights.gx.z;
    let dp2 = w0 * weights.gy.x + w1 * weights.gy.y + w2 * weights.gy.z;
    let tangents = derivedTangentFrame(n, dp1, dp2, duvdx, duvdy);
    let turned = normalize(tangents.t * mapped.x + tangents.b * mapped.y + n * mapped.z);
    shadingNormal = normalize(mix(n, turned, entry.maps.z));
  }

  let vertexColour =
    colourOf(i0) * weights.c.x + colourOf(i1) * weights.c.y + colourOf(i2) * weights.c.z;
  var baseColour = vec3<f32>(1.0);
  if (entry.programs.x != NO_PROGRAM) {
    baseColour = decodeProgram(entry.programs.x, uv, textureLod, time).xyz;
  }
  let albedo = vertexColour * entry.tint.xyz * baseColour;
  /*
   * **Where the surface glows**: the albedo times the emissive map, or the albedo where there is
   * none, so an unmapped surface glows exactly as it did. The map modulates the glow and creates
   * none — a material whose emissive is zero stays dark however bright its map — which is glTF's
   * rule and flat/main.ts's.
   */
  var emissiveMapped = vec3<f32>(1.0);
  if (entry.programs.w != NO_PROGRAM) {
    emissiveMapped = decodeProgram(entry.programs.w, uv, textureLod, time).xyz;
  }

  /* The ORM map replaces roughness and metal, and occlusion is a mix from one: SurfaceMaterial's rules. */
  var roughness = entry.surface.x;
  var metalness = entry.surface.w;
  var occlusion = 1.0;
  if (entry.programs.z != NO_PROGRAM) {
    let orm = decodeProgram(entry.programs.z, uv, textureLod, time);
    occlusion = mix(1.0, orm.x, entry.maps.w);
    roughness = clamp(orm.y * entry.orm.x, 0.0, 1.0);
    metalness = clamp(orm.z * entry.orm.y, 0.0, 1.0);
  }
  /*
   * **A mapped normal wanders, so the roughness grows with it**, as flat/main.ts's surfaceRoughness
   * does and for its reason: a normal that varies fast cannot hold a highlight narrower than the
   * variation. The strength is zero for a material with no normal program, so the sum is the
   * material's own roughness there, and the clamp is the forward path's too.
   */
  let surfaceRoughness = clamp(roughness + entry.maps.z * ${RELIEF_ROUGHNESS}, 0.0, 1.0);

  /* The surface's world position, for the eye vector the highlight needs. */
  let world = w0 * weights.c.x + w1 * weights.c.y + w2 * weights.c.z;
  let toEyeRaw = frame.eye.xyz - world;
  let toEyeLen2 = dot(toEyeRaw, toEyeRaw);
  let toEye = select(vec3<f32>(0.0, 0.0, 1.0), toEyeRaw * inverseSqrt(toEyeLen2), toEyeLen2 > 0.0);

  /*
   * **The receiver in the light's clip space, interpolated from the three corners.** Exact rather
   * than approximate: a directional light's projection is orthographic, so w is one and the
   * light-space position is linear in the world position — which is also what lets the plane below
   * come from the barycentric gradients instead of from derivatives this stage cannot take.
   */
  let l0 = (frame.lightViewProj * vec4<f32>(w0, 1.0)).xyz;
  let l1 = (frame.lightViewProj * vec4<f32>(w1, 1.0)).xyz;
  let l2 = (frame.lightViewProj * vec4<f32>(w2, 1.0)).xyz;
  let lightPos = l0 * weights.c.x + l1 * weights.c.y + l2 * weights.c.z;

  var settings: ShadowSettings;
  settings.strength = frame.shadow.x;
  settings.mapSize = frame.shadow.y;
  settings.depthSpan = frame.shadow.z;
  settings.maxDistance = frame.shadow.w;
  settings.maxSlope = frame.shadowLimits.x;
  settings.taps = frame.shadowLimits.y;
  settings.lightDir = frame.lightDir;
  /* The same cosine litColour computes, because the lookup fades the shadow through the
     terminator band where that cosine is already collapsing. flat/main.ts shares it too. */
  let ndl = max(dot(shadingNormal, frame.lightDir.xyz), 0.0);
  let shade = shadowFactor(
    vec4<f32>(lightPos, 1.0),
    receiverPlaneFromWeights(l0, l1, l2, weights.gx, weights.gy),
    ndl,
    settings,
  );

  var litSurface: LitSurface;
  litSurface.albedo = albedo;
  litSurface.normal = shadingNormal;
  litSurface.toEye = toEye;
  litSurface.roughness = surfaceRoughness;
  litSurface.specular = entry.surface.y;
  /* Interpolated as the colour is, and added: the sandbox's block light is a glow a vertex. */
  let glow = emissiveOf(i0) * weights.c.x + emissiveOf(i1) * weights.c.y + emissiveOf(i2) * weights.c.z;
  litSurface.emissive = entry.tint.w + glow;
  litSurface.emissiveColour = albedo * emissiveMapped;
  litSurface.shade = shade;
  litSurface.reflectivity = entry.surface.z;
  litSurface.metalness = metalness;
  litSurface.occlusion = occlusion;

  var room: LitEnvironment;
  room.lightDir = frame.lightDir.xyz;
  room.lightColour = frame.lightColour.xyz;
  room.sky = frame.sky.xyz;
  room.ground = frame.ground.xyz;
  /*
   * **The mirror direction and the gradient behind it moved into litColour on 2026-09-17**, so the
   * default cannot be forgotten: a metal's environment weight is exactly 1, and a metal handed no
   * radiance renders black. radianceAmount is what says whether a probe was bound, the same shape
   * irradianceAmount already had.
   */
  let probeBound = frame.environment.w;
  let edge = frame.environment.x;
  let maxLod = frame.environment.y;
  /*
   * **Roughness alone picks the level, and the footprint term is missing rather than folded in.**
   * The forward path widens the level where the mirror direction swings fast across a pixel —
   * fwidth(mirrored), which a compute invocation cannot take — and what its absence costs is
   * sparkle on creases and shut lines at grazing angles, worst on dark surfaces. The derivative is
   * recoverable from the barycentric gradients the same way the shadow's receiver plane is, and
   * that is a term with its own reference rather than one to guess at here.
   */
  let lod = clamp(surfaceRoughness * maxLod, 0.0, maxLod);
  room.radiance = probeRadianceAt(reflect(-toEye, shadingNormal), edge, lod, maxLod);
  room.radianceAmount = probeBound;
  room.irradiance = probeIrradianceAt(shadingNormal, edge, frame.environment.z);
  room.irradianceAmount = frame.environmentMix.x;
  /* The split sum is the correct share of a prefiltered chain and of nothing else. See ibl.ts. */
  room.prefiltered = probeBound;
  room.emission = frame.environmentMix.y;

  let lit = litColour(litSurface, room);
  /*
   * **The haze, last, over everything the surface returned.** flat/main.ts applies it at the same
   * point and for the same reason: fog is the air in front of the picture rather than a property
   * of the surface, so it is the last thing between a shaded colour and the frame.
   */
  let hazed = mix(lit, mediumColour(), mediumFog(distance(world, frame.eye.xyz), world.y));

  textureStore(frameColour, vec2<u32>(x, y), vec4<f32>(hazed, 1.0));
}
`;

/**
 * An entry point that does nothing but light a surface, so `gpu-parity.mjs` can compare the
 * expression above with `gpudriven/lit.ts` directly rather than through a shading pass that writes
 * to a texture and reads eleven buffers.
 *
 * `LIT_SURFACE_FLOATS` a surface: albedo, normal, the direction to the eye, then roughness,
 * specular, emissive, shade, reflectivity, metalness, occlusion and the emitted colour; and
 * `LIT_ENVIRONMENT_FLOATS` a room. The prose said fourteen and twenty for two waves after both had
 * grown, which is why it names the constants now rather than counting them.
 */
/**
 * Floats a surface of the lighting check. Matches `LitSurface`: occlusion at fifteen, then the
 * emitted colour, which a surface with no emissive map sets to its albedo.
 */
export const LIT_SURFACE_FLOATS = 19;

/**
 * Floats an environment of the lighting check. Matches `LitEnvironment`.
 *
 * **One block a surface rather than one for the corpus**, which it was until the image-based term
 * arrived: the room, the chain and the two selectors are per-pixel quantities in the shading pass,
 * and a check that held them constant would run the split sum at exactly one configuration.
 */
export const LIT_ENVIRONMENT_FLOATS = 22;

export const SHADE_LIGHTING_PARITY_WGSL = `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> environment: array<f32>;
@group(0) @binding(2) var<storage, read> surfaces: array<f32>;
@group(0) @binding(3) var<storage, read_write> colours: array<f32>;

${SHADE_LIGHTING_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let count = u32(params[0]);
  if (id.x >= count) {
    return;
  }
  let at = id.x * ${LIT_SURFACE_FLOATS}u;
  let env = id.x * ${LIT_ENVIRONMENT_FLOATS}u;
  var surface: LitSurface;
  surface.albedo = vec3<f32>(surfaces[at], surfaces[at + 1u], surfaces[at + 2u]);
  surface.normal = vec3<f32>(surfaces[at + 3u], surfaces[at + 4u], surfaces[at + 5u]);
  surface.toEye = vec3<f32>(surfaces[at + 6u], surfaces[at + 7u], surfaces[at + 8u]);
  surface.roughness = surfaces[at + 9u];
  surface.specular = surfaces[at + 10u];
  surface.emissive = surfaces[at + 11u];
  surface.shade = surfaces[at + 12u];
  surface.reflectivity = surfaces[at + 13u];
  surface.metalness = surfaces[at + 14u];
  surface.occlusion = surfaces[at + 15u];
  surface.emissiveColour = vec3<f32>(surfaces[at + 16u], surfaces[at + 17u], surfaces[at + 18u]);

  var room: LitEnvironment;
  room.lightDir = vec3<f32>(environment[env], environment[env + 1u], environment[env + 2u]);
  room.lightColour = vec3<f32>(environment[env + 3u], environment[env + 4u], environment[env + 5u]);
  room.sky = vec3<f32>(environment[env + 6u], environment[env + 7u], environment[env + 8u]);
  room.ground = vec3<f32>(environment[env + 9u], environment[env + 10u], environment[env + 11u]);
  room.irradiance =
    vec3<f32>(environment[env + 12u], environment[env + 13u], environment[env + 14u]);
  room.radiance = vec3<f32>(environment[env + 15u], environment[env + 16u], environment[env + 17u]);
  room.irradianceAmount = environment[env + 18u];
  room.radianceAmount = environment[env + 19u];
  room.prefiltered = environment[env + 20u];
  room.emission = environment[env + 21u];

  let colour = litColour(surface, room);
  colours[id.x * 3u] = colour.x;
  colours[id.x * 3u + 1u] = colour.y;
  colours[id.x * 3u + 2u] = colour.z;
}
`;

/** Floats a case of the surface-frame check: n, dp1, dp2, duv1, duv2, size. */
export const SURFACE_FRAME_CASE_FLOATS = 14;

export const SURFACE_FRAME_PARITY_WGSL = /* wgsl */ `${SHADE_SURFACE_WGSL}
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> cases: array<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(params[0])) {
    return;
  }
  let at = id.x * ${SURFACE_FRAME_CASE_FLOATS}u;
  let n = vec3<f32>(cases[at], cases[at + 1u], cases[at + 2u]);
  let dp1 = vec3<f32>(cases[at + 3u], cases[at + 4u], cases[at + 5u]);
  let dp2 = vec3<f32>(cases[at + 6u], cases[at + 7u], cases[at + 8u]);
  let duv1 = vec2<f32>(cases[at + 9u], cases[at + 10u]);
  let duv2 = vec2<f32>(cases[at + 11u], cases[at + 12u]);
  let frame = derivedTangentFrame(n, dp1, dp2, duv1, duv2);
  let dst = id.x * 7u;
  results[dst] = surfaceLod(duv1, duv2, cases[at + 13u]);
  results[dst + 1u] = frame.t.x;
  results[dst + 2u] = frame.t.y;
  results[dst + 3u] = frame.t.z;
  results[dst + 4u] = frame.b.x;
  results[dst + 5u] = frame.b.y;
  results[dst + 6u] = frame.b.z;
}
`;
