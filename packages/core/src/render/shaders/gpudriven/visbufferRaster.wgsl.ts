import { GPU_DRIVEN_VERTEX_FLOATS } from '../../gpudriven/sceneUpload.ts';
import { DECODE_WGSL, decodeResourcesWgsl } from './decode.wgsl.ts';
import { MATERIAL_SLOTS, MATERIAL_TABLE_WGSL } from './materialTable.wgsl.ts';
import { MESH_TRANSFORM_WGSL } from './meshTransform.wgsl.ts';

/**
 * The hardware path: one indirect draw that fills the visibility buffer for the whole frame.
 *
 * **Hand-written WGSL, for the reason `cull.wgsl.ts` gives at length**: WebGL2 has no compute
 * stage and no indirect draw, so there is no GLSL original to generate this from and nothing it
 * can break by being wrong. What keeps it honest is `scripts/gpu-parity.mjs`, which runs the
 * packing below against `gpudriven/visbuffer.ts` on a real device.
 *
 * **Every surviving cluster is an instance of a fixed 128-triangle draw.** `indirect.ts` carries
 * the argument layout and the reason: one block for the frame rather than thousands, and a cluster
 * with fewer triangles emitting degenerate ones for the remainder. The degenerate case is a real
 * branch here rather than a clamp — clamping draws a cluster's last triangle once per unused slot,
 * which is a sliver along the edge of every cluster that is not exactly full.
 *
 * **The fragment writes an identifier, not a colour.** Depth is the hardware's; what lands in the
 * target is which triangle of which cluster covered the pixel, and the shading reads it later —
 * which is the whole point of a visibility buffer. `VIS_EMPTY` is what a caller clears the target
 * to, because zero is a legal identifier.
 *
 * **It binds a material anyway, and only for the alpha test.** That is the one decision a pixel
 * cannot defer: a cutout leaf that is discarded in the shading pass has already written its
 * identifier here, so what stood behind it was never rastered and there is nothing left to shade.
 * So this stage carries the material table and the whole decode machinery to answer one question —
 * is this texel solid enough to own the pixel — and **a material whose cutoff is zero asks none of
 * it**, which is what keeps an opaque scene paying nothing. A cluster carries one material, so the
 * branch is coherent across every fragment of a draw rather than divergent within one.
 *
 * **The shadow pass shares this module's vertex stage and has no fragment stage at all**, so a
 * cutout surface casts the shadow of its whole quad. That is a real limitation rather than an
 * oversight: giving the depth-only pass a fragment stage would give it the material table and the
 * decode tables too, and the map is drawn every frame over the whole scene. `docs/IMPROVEMENTS.md`
 * carries the row.
 */

/**
 * The cutout rule, which is `gpudriven/alphaTest.ts`'s `alphaKept` and must stay it.
 *
 * **`>=` rather than `>`** is the boundary every alpha test gets wrong, and getting it wrong shows
 * as a one-texel seam around every leaf rather than as anything failing. **The guard is a separate
 * return rather than arithmetic** because a NaN alpha must be discarded when a test was asked for
 * and kept when it was not, and **it is a negated `>` rather than a `<=`** because a device may
 * assume NaN never arrives and this is where the reference had to move to meet it. The reference's
 * header carries both, and `scripts/gpu-parity.mjs` holds the two to each other on a device.
 */
const ALPHA_TEST_WGSL = /* wgsl */ `
fn alphaKept(alpha: f32, cutoff: f32) -> bool {
  if (!(cutoff > 0.0)) { return true; }
  return alpha >= cutoff;
}
`;

/**
 * The footprint-to-level expression, which is `shade.wgsl.ts`'s `surfaceLod` and must stay it.
 *
 * **Two stages choose a mip level for one texel now**, and they choose it from different evidence:
 * this one differences its neighbours, and the shading pass differences barycentric gradients
 * because a compute invocation has no neighbours. What they must not differ about is what a
 * footprint means once measured, which is this.
 */
const SURFACE_LOD_WGSL = /* wgsl */ `
fn surfaceLod(gradX: vec2<f32>, gradY: vec2<f32>, size: f32) -> f32 {
  let footprint = max(length(gradX), length(gradY)) * size;
  return max(log2(max(footprint, 1e-30)), 0.0);
}
`;

/**
 * The raster pass.
 *
 * `clusterList` is the compacted output of the cull, `clusterMeta` is four words a cluster — index
 * offset, index count, cluster identifier, mesh — and `transforms` is sixteen floats a mesh. A
 * cluster reaches its transform through its mesh rather than carrying one, because a mesh drawn
 * twice is two instances of one cluster set and a transform per cluster would store it twice.
 */
export const VISBUFFER_RASTER_WGSL = /* wgsl */ `
struct Varying {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) visibility: u32,
  /** The cluster's material and this vertex's texture coordinate, for the alpha test. */
  @location(1) @interpolate(flat) material: u32,
  @location(2) uv: vec2<f32>,
}

/** The two numbers the decode machinery needs that nothing else here carries. */
struct RasterParams {
  /** x is the simulation time, y the latent layer's edge in texels, and two spare. */
  values: vec4<f32>,
}

${MATERIAL_TABLE_WGSL}
@group(0) @binding(0) var<storage, read> viewProj: array<f32, 16>;
@group(0) @binding(1) var<storage, read> clusterList: array<u32>;
@group(0) @binding(2) var<storage, read> clusterMeta: array<u32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
/** Eleven floats a vertex: position, normal, colour, uv. One buffer, for the shading pass's
    storage budget — see shade.wgsl.ts. This stage reads the position and the uv. */
@group(0) @binding(4) var<storage, read> vertices: array<f32>;
@group(0) @binding(5) var<storage, read> transforms: array<f32>;
/** One material a cluster, read in the vertex stage and carried flat. */
@group(0) @binding(6) var<storage, read> materialOf: array<u32>;
@group(0) @binding(7) var<uniform> materials: array<Material, ${MATERIAL_SLOTS}>;
@group(0) @binding(8) var<uniform> rasterParams: RasterParams;
${decodeResourcesWgsl({ group: 0, latents: 9, clampSampler: 10, repeatSampler: 11, nodes: 12, weights: 13 })}
fn decodeLatentSize() -> f32 {
  return rasterParams.values.y;
}

${DECODE_WGSL}
${SURFACE_LOD_WGSL}
${ALPHA_TEST_WGSL}

const VIS_TRIANGLE_BITS: u32 = 7u;
const VIS_MAX_TRIANGLES: u32 = 128u;

/* The same expression as packVisibility in gpudriven/visbuffer.ts, checked against it on the
   device by scripts/gpu-parity.mjs. Seven bits of triangle, twenty-five of cluster. */
fn packVisibility(cluster: u32, triangle: u32) -> u32 {
  return (cluster << VIS_TRIANGLE_BITS) | (triangle & (VIS_MAX_TRIANGLES - 1u));
}

${MESH_TRANSFORM_WGSL}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) slot: u32,
) -> Varying {
  var out: Varying;
  let cluster = clusterList[slot];
  /* metaAt, because meta is a reserved word in WGSL. A backtick cannot appear in this comment
     either: it would close the template literal the shader is written in. This shader was
     committed and read by a generator check for a day before anything compiled it. */
  let metaAt = cluster * 4u;
  let indexOffset = clusterMeta[metaAt];
  let indexCount = clusterMeta[metaAt + 1u];
  let clusterId = clusterMeta[metaAt + 2u];
  let mesh = clusterMeta[metaAt + 3u];

  let triangle = vertex / 3u;
  /* Past this cluster's own triangles: collapse to a point, which covers no pixel. See the
     header for why this is not a clamp onto the last real triangle. */
  if (triangle * 3u >= indexCount) {
    out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.visibility = 0u;
    out.material = 0u;
    out.uv = vec2<f32>(0.0);
    return out;
  }

  let index = indices[indexOffset + vertex];
  let at = index * ${GPU_DRIVEN_VERTEX_FLOATS}u;
  let local = vec3<f32>(vertices[at], vertices[at + 1u], vertices[at + 2u]);
  let world = worldOf(mesh, local);

  out.position = vec4<f32>(
    viewProj[0] * world.x + viewProj[4] * world.y + viewProj[8] * world.z + viewProj[12],
    viewProj[1] * world.x + viewProj[5] * world.y + viewProj[9] * world.z + viewProj[13],
    viewProj[2] * world.x + viewProj[6] * world.y + viewProj[10] * world.z + viewProj[14],
    viewProj[3] * world.x + viewProj[7] * world.y + viewProj[11] * world.z + viewProj[15],
  );
  out.visibility = packVisibility(clusterId, triangle);
  /* By the cluster's own record rather than the mesh's, which is where materialOf is indexed. */
  out.material = materialOf[cluster];
  out.uv = vec2<f32>(vertices[at + 9u], vertices[at + 10u]);
  return out;
}

@fragment
fn fragmentMain(in: Varying) -> @location(0) u32 {
  let entry = materials[min(in.material, ${MATERIAL_SLOTS - 1}u)];
  let cutoff = entry.orm.z;
  /*
   * **A cutoff of zero skips the fetch outright**, and with it the whole decode interpreter. That
   * branch is on a value read from a uniform by a flat-interpolated index that is constant across
   * the draw, so it is coherent — every fragment of a cluster takes the same side of it.
   *
   * **The derivatives are taken before the branch**, because a texture level derived inside
   * non-uniform control flow is what the language forbids and a discard below makes the rest of
   * this function non-uniform anyway. shade.wgsl.ts computes the same footprint from barycentric
   * gradients instead, having no neighbouring invocations to difference against.
   */
  let uv = in.uv * entry.maps.xy;
  let lod = surfaceLod(dpdx(uv), dpdy(uv), rasterParams.values.y);
  /*
   * **This branch duplicates alphaKept's own guard and is not redundant**: alphaKept answers what
   * the picture is and this decides what the frame pays. A material with no cutout skips the
   * decode interpreter entirely, which is the whole of why the raster can carry it at all.
   */
  if (cutoff > 0.0 && entry.programs.x != NO_PROGRAM) {
    let alpha = decodeProgram(entry.programs.x, uv, lod, rasterParams.values.x).w;
    if (!alphaKept(alpha, cutoff)) { discard; }
  }
  return in.visibility;
}
`;

/**
 * The packing alone, as a dispatch, so the layout above can be checked against the reference.
 *
 * **A raster pass cannot be compared to a processor-side model and a bit layout can.** What goes
 * wrong in a visibility buffer is almost never the rasterisation — the hardware does that — it is
 * one field overflowing into the next, silently, on the one asset whose clusters are full. So the
 * expression is lifted out and run over generated pairs until it agrees with `packVisibility` and
 * `unpackVisibility` for every one of them.
 */
export const VISBUFFER_PACK_WGSL = `
@group(0) @binding(0) var<storage, read> clusters: array<u32>;
@group(0) @binding(1) var<storage, read> triangles: array<u32>;
@group(0) @binding(2) var<storage, read_write> packed: array<u32>;
@group(0) @binding(3) var<storage, read_write> roundTrip: array<u32>;

const VIS_TRIANGLE_BITS: u32 = 7u;
const VIS_MAX_TRIANGLES: u32 = 128u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&clusters)) { return; }
  let value = (clusters[id.x] << VIS_TRIANGLE_BITS) | (triangles[id.x] & (VIS_MAX_TRIANGLES - 1u));
  packed[id.x] = value;
  /* Unpacked and re-packed, so a layout that packs consistently and unpacks wrongly is caught
     as well as one that packs wrongly at all. */
  let cluster = value >> VIS_TRIANGLE_BITS;
  let triangle = value & (VIS_MAX_TRIANGLES - 1u);
  roundTrip[id.x] = select(0u, 1u, cluster == clusters[id.x] && triangle == triangles[id.x]);
}
`;

/**
 * The cutout rule alone, as a dispatch, so it can be checked against `gpudriven/alphaTest.ts`.
 *
 * **The same function the raster calls, included rather than copied.** A second spelling of a
 * four-line comparison is exactly the kind of thing that stays right for a year and then does not,
 * and the failure it produces — a seam one texel wide around every cutout surface — reads as a
 * mipmap problem. This shares the declaration, so breaking the rule breaks the check.
 */
export const VISBUFFER_ALPHA_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> alphas: array<f32>;
@group(0) @binding(1) var<storage, read> cutoffs: array<f32>;
@group(0) @binding(2) var<storage, read_write> kept: array<f32>;
${ALPHA_TEST_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&alphas)) { return; }
  kept[id.x] = select(0.0, 1.0, alphaKept(alphas[id.x], cutoffs[id.x]));
}
`;
