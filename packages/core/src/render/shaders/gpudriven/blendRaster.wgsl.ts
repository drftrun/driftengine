import { GPU_DRIVEN_VERTEX_FLOATS } from '../../gpudriven/sceneUpload.ts';
import { DECODE_WGSL, decodeResourcesWgsl } from './decode.wgsl.ts';
import { ENVIRONMENT_WGSL } from './environment.wgsl.ts';
import { FOG_WGSL } from './fog.wgsl.ts';
import { FRAME_BLOCK_WGSL } from './frameBlock.wgsl.ts';
import { MATERIAL_SLOTS, MATERIAL_TABLE_WGSL } from './materialTable.wgsl.ts';
import { MESH_TRANSFORM_WGSL } from './meshTransform.wgsl.ts';
import { SHADE_LIGHTING_WGSL } from './shade.wgsl.ts';

/**
 * The transparent half: one indirect draw, blended, shaded in the fragment stage.
 *
 * **A visibility buffer stores one surface a pixel and therefore cannot hold a blend at all.** That
 * is architecture rather than an omission: the whole saving of the opaque path is that shading
 * happens once per pixel, after the frame knows which triangle won, and a pane of glass has no
 * winner. So the transparent set skips the visibility buffer and is drawn again here, shading where
 * it stands, with the divergence that implies — exactly as every fragment on the forward path does.
 *
 * **What it reuses is the pipeline's front half.** `instanceCull` and the cut answer "which
 * clusters, at which level of detail", and that question is the same for a pane as for a wall, so
 * they run a second time over the other half of the scene rather than being written again. The
 * material's blend flag is what the cut filters on; `cull.wgsl.ts` carries the filter.
 *
 * **It includes `SHADE_LIGHTING_WGSL` rather than restating it**, so the expression a pane of glass
 * is lit by is the expression a wall is lit by, character for character. That is why the lighting
 * was packaged as an includable function in the first place, and `scripts/gpu-parity.mjs` holds
 * both to `gpudriven/lit.ts`.
 *
 * **Two targets and two blend states, both of which commute.** The accumulation sums weighted
 * colour and the revealage multiplies what each layer let through, so the frame stops depending on
 * which surface was submitted first. `orderIndependent.ts` is the arithmetic on the CPU and says
 * what it approximates; `flatPass.ts`'s `oitTarget` is the same pair of blend states on the forward
 * path. The weight is `oitWeight`, which both paths share.
 *
 * **Depth attached read-only.** A pane behind a wall is rejected at the wall, and nothing here
 * writes depth, so two panes do not hide each other and there is something left to blend.
 *
 * **A transparent surface is not shadowed here**, which is the one place it is lit differently from
 * an opaque one. `shadowFactor` wants a receiver plane, the shading pass derives one from
 * barycentric gradients because a compute invocation has no neighbours, and a fragment stage would
 * have to derive it another way — a second expression for a term whose whole point is that there is
 * one. `docs/IMPROVEMENTS.md` carries the row. A pane in shadow therefore reads as a pane in
 * sunlight, which is visible on a bright scene and is stated rather than hidden.
 */
/**
 * The weighted-transparency arithmetic, declared once for the three things that need it.
 *
 * **The blended raster, the resolve and the parity entry point are three readers of one rule**, and
 * the first version of this file gave each of them its own copy. It was caught by the audit the
 * plan asks for rather than by anything failing: perturbing the weight broke the check while the
 * shader that draws the frame went on using the old one, which is the exact shape of a gate that
 * watches a copy of the thing it is guarding.
 *
 * `render/orderIndependent.ts` is the reference all of this is written against — `oitWeight` and
 * `resolveOit`, where both clamps are argued and the algebra is asserted against numbers — and
 * `flat/main.ts` computes the same weight on the forward path.
 */
const OIT_WGSL = /* wgsl */ `
fn oitWeight(viewDepth: f32, alpha: f32) -> f32 {
  let z = max(viewDepth, 0.0) / 200.0;
  let falloff = 0.03 / (1e-5 + z * z * z * z);
  return alpha * clamp(falloff, 1e-2, 3e3);
}

/* Premultiplied and weighted, against a blend of "one, one": the target holds the two sums. */
fn oitAccumulate(colour: vec3<f32>, alpha: f32, weight: f32) -> vec4<f32> {
  return vec4<f32>(colour * alpha * weight, alpha * weight);
}

/*
 * The two targets, as a premultiplied fragment to lay over what is behind them.
 *
 * The weighted sum divided by the weighted alpha is the average colour the layers make, and the
 * revealage says how much of the background still shows. The division is guarded because a pixel no
 * fragment touched has a weighted alpha of zero — and its revealage of one discards whatever this
 * produces anyway.
 */
fn oitResolved(accum: vec4<f32>, reveal: f32) -> vec4<f32> {
  let average = accum.xyz / max(accum.w, 1e-5);
  let covered = 1.0 - reveal;
  return vec4<f32>(average * covered, covered);
}
`;

export const BLEND_RASTER_WGSL = /* wgsl */ `
struct BlendVarying {
  @builtin(position) position: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) colour: vec3<f32>,
  @location(3) uv: vec2<f32>,
  @location(4) @interpolate(flat) material: u32,
  /* The vertex's own glow, added to the material's in the fragment as the shading pass adds it. */
  @location(5) emissive: f32,
}
${MATERIAL_TABLE_WGSL}
${FRAME_BLOCK_WGSL}
@group(0) @binding(0) var<storage, read> viewProj: array<f32, 16>;
/** The compacted list of blended clusters, from the cut's second run. */
@group(0) @binding(1) var<storage, read> blendList: array<u32>;
@group(0) @binding(2) var<storage, read> clusterMeta: array<u32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> vertices: array<f32>;
@group(0) @binding(5) var<storage, read> transforms: array<f32>;
@group(0) @binding(6) var<storage, read> materialOf: array<u32>;
@group(0) @binding(7) var<uniform> materials: array<Material, ${MATERIAL_SLOTS}>;
@group(0) @binding(8) var<uniform> frame: Frame;
@group(0) @binding(9) var environmentMap: texture_2d_array<f32>;
@group(0) @binding(10) var environmentSampler: sampler;
${decodeResourcesWgsl({ group: 0, latents: 11, clampSampler: 12, repeatSampler: 13, nodes: 14, weights: 15 })}
fn decodeLatentSize() -> f32 {
  return frame.size.w;
}

${DECODE_WGSL}
/*
 * **Layer 0, which is this pipeline reading one probe of a grid**, and the same fetch
 * shade.wgsl.ts makes for the same reason: what this pipeline owns is a fixed cluster set a few
 * metres across, where a grid would pop as a surface crossed a cell.
 */
fn environmentSample(uv: vec2<f32>, level: f32) -> vec3<f32> {
  return textureSampleLevel(environmentMap, environmentSampler, uv, 0, level).rgb;
}
${ENVIRONMENT_WGSL}
${MESH_TRANSFORM_WGSL}
${SHADE_LIGHTING_WGSL}
${FOG_WGSL}
${OIT_WGSL}

const NO_PROGRAM_HERE: u32 = ${0xffffffff}u;

/*
 * The same fetch the visibility raster does, keeping the attributes instead of an identifier.
 *
 * **"metaAt", because "meta" is a reserved word in WGSL** — the visibility raster's own comment
 * records that, and this shader indexes the same buffer the same way.
 */
@vertex
fn blendVert(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) slot: u32,
) -> BlendVarying {
  var out: BlendVarying;
  out.world = vec3<f32>(0.0);
  out.normal = vec3<f32>(0.0, 1.0, 0.0);
  out.colour = vec3<f32>(0.0);
  out.uv = vec2<f32>(0.0);
  out.material = 0u;
  out.emissive = 0.0;
  let cluster = blendList[slot];
  let metaAt = cluster * 4u;
  let indexOffset = clusterMeta[metaAt];
  let indexCount = clusterMeta[metaAt + 1u];
  let mesh = clusterMeta[metaAt + 3u];

  let triangle = vertex / 3u;
  /* Past this cluster's triangles: collapse to a point, which covers no pixel. */
  if (triangle * 3u >= indexCount) {
    out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let index = indices[indexOffset + vertex];
  let at = index * ${GPU_DRIVEN_VERTEX_FLOATS}u;
  let local = vec3<f32>(vertices[at], vertices[at + 1u], vertices[at + 2u]);
  let world = worldOf(mesh, local);

  out.world = world;
  out.normal = rotatedOf(mesh, vec3<f32>(vertices[at + 3u], vertices[at + 4u], vertices[at + 5u]));
  out.colour = vec3<f32>(vertices[at + 6u], vertices[at + 7u], vertices[at + 8u]);
  out.uv = vec2<f32>(vertices[at + 9u], vertices[at + 10u]);
  out.emissive = vertices[at + 11u];
  out.material = materialOf[cluster];
  out.position = vec4<f32>(
    viewProj[0] * world.x + viewProj[4] * world.y + viewProj[8] * world.z + viewProj[12],
    viewProj[1] * world.x + viewProj[5] * world.y + viewProj[9] * world.z + viewProj[13],
    viewProj[2] * world.x + viewProj[6] * world.y + viewProj[10] * world.z + viewProj[14],
    viewProj[3] * world.x + viewProj[7] * world.y + viewProj[11] * world.z + viewProj[15],
  );
  return out;
}

struct BlendTargets {
  @location(0) accum: vec4<f32>,
  @location(1) reveal: vec4<f32>,
}

@fragment
fn blendFrag(in: BlendVarying) -> BlendTargets {
  var out: BlendTargets;
  let entry = materials[min(in.material, ${MATERIAL_SLOTS - 1}u)];
  let uv = in.uv * entry.maps.xy;
  let lod = 0.0;

  var baseColour = vec4<f32>(1.0);
  if (entry.programs.x != NO_PROGRAM_HERE) {
    baseColour = decodeProgram(entry.programs.x, uv, lod, frame.size.z);
  }
  /* The material's own opacity times whatever its base-colour map said about this texel. */
  let alpha = clamp(entry.extra.x * baseColour.w, 0.0, 1.0);
  let toEye = normalize(frame.eye.xyz - in.world);

  var surface: LitSurface;
  surface.albedo = in.colour * entry.tint.xyz * baseColour.xyz;
  surface.normal = normalize(in.normal);
  surface.toEye = toEye;
  surface.roughness = entry.surface.x;
  surface.specular = entry.surface.y;
  surface.emissive = entry.tint.w + in.emissive;
  /* Where the pane glows, as the shading pass decides it: the albedo times the emissive map. */
  var emissiveMapped = vec3<f32>(1.0);
  if (entry.programs.w != NO_PROGRAM_HERE) {
    emissiveMapped = decodeProgram(entry.programs.w, uv, lod, frame.size.z).xyz;
  }
  surface.emissiveColour = surface.albedo * emissiveMapped;
  /* Unshadowed, and the header says why and what it costs. */
  surface.shade = 1.0;
  surface.reflectivity = entry.surface.z;
  surface.metalness = entry.surface.w;
  surface.occlusion = 1.0;

  var room: LitEnvironment;
  room.lightDir = frame.lightDir.xyz;
  room.lightColour = frame.lightColour.xyz;
  room.sky = frame.sky.xyz;
  room.ground = frame.ground.xyz;
  let probeBound = frame.environment.w;
  let edge = frame.environment.x;
  let maxLod = frame.environment.y;
  room.radiance = probeRadianceAt(reflect(-toEye, surface.normal), edge, clamp(entry.surface.x * maxLod, 0.0, maxLod), maxLod);
  room.radianceAmount = probeBound;
  room.irradiance = probeIrradianceAt(surface.normal, edge, frame.environment.z);
  room.irradianceAmount = frame.environmentMix.x;
  room.prefiltered = probeBound;
  room.emission = frame.environmentMix.y;

  /*
   * **The haze multiplies the colour and not the alpha.** A pane at the render edge should take the
   * haze's colour, not become more transparent: fogging its alpha would make distant glass vanish
   * where it ought to grey out, and the two read completely differently across a large view
   * distance — which is the whole reason this pipeline gained a fog.
   */
  let toward = distance(in.world, frame.eye.xyz);
  let colour = mix(litColour(surface, room), mediumColour(), mediumFog(toward, in.world.y));

  /*
   * **The distance to the eye, not the clip-space depth**, because that is what oitWeight's falloff
   * is written in metres against — render/orderIndependent.ts divides by 200 and flat/main.ts takes
   * "distance(vWorldPos, uCameraPos)". A weight fed a 0-to-1 depth instead would put every layer of
   * every scene inside the first hundredth of the falloff.
   */
  let weight = oitWeight(toward, alpha);
  out.accum = oitAccumulate(colour, alpha, weight);
  /* One channel, and it multiplies: what this layer let through. See the blend state. */
  out.reveal = vec4<f32>(alpha, 0.0, 0.0, alpha);
  return out;
}
`;

/**
 * The two targets composited over what the opaque half drew.
 *
 * **`resolveOit` in `render/orderIndependent.ts`, transcribed**, and the division's guard is that
 * file's: a pixel no fragment touched has a weighted alpha of zero, and its revealage of one
 * discards whatever this produced anyway.
 *
 * **Premultiplied, where the forward path's composite is a lerp**, and the difference is what the
 * alpha channel means on each side. `renderer.ts` resolves over a scene target whose alpha is not a
 * coverage mask; this pipeline's colour target has one, because the blit reads it to decide whether
 * the pass drew a pixel at all. Writing `average * (1 - reveal)` with `1 - reveal` in alpha and
 * blending `(one, one-minus-src-alpha)` gives both at once: the colour is the same lerp, and the
 * coverage becomes `1 - (1 - covered) * reveal` — so a pane over empty sky marks the pixel as
 * drawn, which a lerp would not have.
 */
export const BLEND_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var accumMap: texture_2d<f32>;
@group(0) @binding(1) var revealMap: texture_2d<f32>;
${OIT_WGSL}

struct Corner {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn resolveVert(@builtin(vertex_index) vertex: u32) -> Corner {
  /* One triangle covering the target, which needs no vertex buffer and no clip correction. */
  var out: Corner;
  let x = f32((vertex << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vertex & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  return out;
}

@fragment
fn resolveFrag(in: Corner) -> @location(0) vec4<f32> {
  let at = vec2<u32>(in.position.xy);
  let accum = textureLoad(accumMap, at, 0);
  let reveal = textureLoad(revealMap, at, 0).x;
  return oitResolved(accum, reveal);
}
`;

/**
 * The weight and the resolve alone, as a dispatch, so both can be checked against the reference.
 *
 * **What a picture cannot show is whether the weight is the forward path's.** Two panes blended by
 * a weight twice as steep still look like two panes; what it changes is how much a far layer keeps,
 * and nothing about the frame says so. So the arithmetic is lifted out and compared against
 * `oitWeight` and `resolveOit` over generated cases.
 */
export const BLEND_OIT_PARITY_WGSL = /* wgsl */ `
/** Six floats a case: depth, alpha, colour, and the background behind it. */
@group(0) @binding(0) var<storage, read> cases: array<f32>;
/** Four out: the weight, and the three resolved channels. */
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
${OIT_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x * 8u + 7u >= arrayLength(&cases)) { return; }
  let at = id.x * 8u;
  let depth = cases[at];
  let alpha = cases[at + 1u];
  let colour = vec3<f32>(cases[at + 2u], cases[at + 3u], cases[at + 4u]);
  let background = vec3<f32>(cases[at + 5u], cases[at + 6u], cases[at + 7u]);

  let weight = oitWeight(depth, alpha);
  /* One fragment folded in, which is the anchor: for a single layer this reduces to "over". */
  let accum = oitAccumulate(colour, alpha, weight);
  let reveal = 1.0 - alpha;
  /*
   * The resolve's own fragment, then the blend state applied by hand: the pipeline lays it over
   * the target with "one, one-minus-src-alpha", so the background keeps the revealage.
   */
  let over = oitResolved(accum, reveal);
  let resolved = over.xyz + background * (1.0 - over.w);

  let out = id.x * 4u;
  results[out] = weight;
  results[out + 1u] = resolved.x;
  results[out + 2u] = resolved.y;
  results[out + 3u] = resolved.z;
}
`;
