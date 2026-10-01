import { INSTANCE_FLOATS } from '../../../instances.ts';

/**
 * The instance cull, in WGSL, hand-authored under the compute exception `AGENTS.md` records
 * (2026-08-24): a compute shader has no WebGL2 twin to generate from, and `npm run wgsl` neither
 * writes nor polices this file.
 *
 * **It keeps exactly what `cullInstances` keeps**, and `gpu-parity.mjs` runs both on a device: an
 * instance's world sphere is the mesh's sphere with its centre through the model matrix and its
 * radius scaled by the largest column, and it is kept unless wholly beyond one of the six planes.
 * The one difference is order — survivors are compacted by `atomicAdd`, so they arrive in whatever
 * order the invocations reached it. That is invisible to an opaque draw and is why a blended draw
 * is never culled here.
 *
 * `args` is a `drawIndexedIndirect` record, `(indexCount, instanceCount, firstIndex, baseVertex,
 * firstInstance)`; the renderer writes it with a zero instance count before each dispatch and this
 * counts the survivors into it.
 */
export const INSTANCE_CULL_WORKGROUP = 64;

export const INSTANCE_CULL_WGSL = /* wgsl */ `
struct Params {
  planes: array<vec4<f32>, 6>,
  sphere: vec4<f32>,
  count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> source: array<f32>;
@group(0) @binding(2) var<storage, read_write> kept: array<f32>;
@group(0) @binding(3) var<storage, read_write> args: array<atomic<u32>, 5>;

const STRIDE: u32 = ${INSTANCE_FLOATS}u;

@compute @workgroup_size(${INSTANCE_CULL_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let at = i * STRIDE;
  let c0 = vec3<f32>(source[at], source[at + 1u], source[at + 2u]);
  let c1 = vec3<f32>(source[at + 4u], source[at + 5u], source[at + 6u]);
  let c2 = vec3<f32>(source[at + 8u], source[at + 9u], source[at + 10u]);
  let t = vec3<f32>(source[at + 12u], source[at + 13u], source[at + 14u]);
  let local = params.sphere;
  let centre = c0 * local.x + c1 * local.y + c2 * local.z + t;
  let scale = sqrt(max(dot(c0, c0), max(dot(c1, c1), dot(c2, c2))));
  let radius = local.w * scale;
  for (var p = 0u; p < 6u; p = p + 1u) {
    let plane = params.planes[p];
    if (dot(plane.xyz, centre) + plane.w < -radius) { return; }
  }
  let slot = atomicAdd(&args[1], 1u);
  let to = slot * STRIDE;
  for (var k = 0u; k < STRIDE; k = k + 1u) {
    kept[to + k] = source[at + k];
  }
}
`;
