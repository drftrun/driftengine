/**
 * A point skin posed on the device, in WGSL, hand-authored under the compute exception `AGENTS.md`
 * records (2026-08-24): a compute shader has no WebGL2 twin to generate from, and `npm run wgsl`
 * neither writes nor polices this file. WebGL2 poses the same skin by transform feedback, in
 * `backend/webgl2/pointSkinFeedback.ts`, by the same arithmetic in the same order.
 *
 * One invocation a vertex: its position the sum of each weighted point moved by its joint, an
 * influence of weight 0 skipped, and its normal the first joint's turn of the normal it was given,
 * made unit length where it has any. Written into the mesh's own position and normal buffers, three
 * floats a vertex, which every pass then draws as it draws any dynamic mesh.
 */
export const POINT_SKIN_WORKGROUP = 64;

export const POINT_SKIN_WGSL = /* wgsl */ `
struct Params {
  count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> joints: array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> named: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> normals: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> posedPositions: array<f32>;
@group(0) @binding(6) var<storage, read_write> posedNormals: array<f32>;

@compute @workgroup_size(${POINT_SKIN_WORKGROUP})
fn posePoints(@builtin(global_invocation_id) id: vec3<u32>) {
  let v = id.x;
  if (v >= params.count) {
    return;
  }
  let j = named[v];
  var p = vec3<f32>(0.0, 0.0, 0.0);
  for (var k = 0u; k < 4u; k = k + 1u) {
    let q = points[v * 4u + k];
    if (q.w != 0.0) {
      p = p + q.w * (joints[j[k]] * vec4<f32>(q.xyz, 1.0)).xyz;
    }
  }
  let m = joints[j.x];
  let raw = mat3x3<f32>(m[0].xyz, m[1].xyz, m[2].xyz) * normals[v].xyz;
  let l = length(raw);
  var n = raw;
  if (l > 0.0) {
    n = raw / l;
  }
  posedPositions[v * 3u] = p.x;
  posedPositions[v * 3u + 1u] = p.y;
  posedPositions[v * 3u + 2u] = p.z;
  posedNormals[v * 3u] = n.x;
  posedNormals[v * 3u + 1u] = n.y;
  posedNormals[v * 3u + 2u] = n.z;
}
`;
