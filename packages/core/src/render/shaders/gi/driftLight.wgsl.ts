/**
 * DriftLight's lookup in hand-written WGSL, for the traced probe bake: the summed light arriving on
 * a surface a probe's ray struck, which is how candles past the frame's choice reach the bounce.
 *
 * **A transcription of `flat/driftLight.ts`, line for line**, because a compute shader cannot
 * include the generated WGSL of a fragment stage. Two spellings of one lookup is the hazard the
 * 2026-08-13 rule is about, and `driftLight.test.ts` beside this holds them together by reading
 * both: change one and it names the line of the other.
 *
 * **Integer arithmetic for the brick's corner**, by the 2026-09-20 rule: a device divides a float by
 * multiplying by its reciprocal, and a brick number off by one is a brick from somewhere else.
 *
 * The including module declares `driftIndex: texture_3d<u32>`, `driftAtlas: texture_3d<f32>` and a
 * filtering `driftSampler`; `origin` is the field's first sample and, in `w`, the spacing.
 */
export const DRIFT_LIGHT_WGSL = /* wgsl */ `
fn driftLightIrradiance(world: vec3<f32>, n: vec3<f32>, origin: vec4<f32>) -> vec3<f32> {
  let spacing = origin.w;
  let at = (world + n * (0.5 * spacing) - origin.xyz) / (3.0 * spacing);
  let cell = vec3<i32>(floor(at));
  if (any(cell < vec3<i32>(0)) || any(cell >= vec3<i32>(textureDimensions(driftIndex, 0)))) {
    return vec3<f32>(0.0);
  }
  let id = textureLoad(driftIndex, cell, 0).r;
  if (id == 0u) {
    return vec3<f32>(0.0);
  }
  let size = vec3<i32>(textureDimensions(driftAtlas, 0));
  let brick = i32(id) - 1;
  let across = size.x / 8;
  let down = size.y / 4;
  let corner = vec3<f32>(
    f32((brick % across) * 8),
    f32(((brick / across) % down) * 4),
    f32((brick / (across * down)) * 4)
  );
  let texel = 1.0 / vec3<f32>(size);
  let inside = (at - vec3<f32>(cell)) * 3.0 + 0.5;
  let light = textureSampleLevel(driftAtlas, driftSampler, (corner + inside) * texel, 0.0);
  if (light.a < 1e-3) {
    return vec3<f32>(0.0);
  }
  let toward = textureSampleLevel(driftAtlas, driftSampler, (corner + vec3<f32>(4.0, 0.0, 0.0) + inside) * texel, 0.0);
  let arriving = light.rgb / light.a;
  let towardLight = toward.xyz / light.a;
  let facing = max(dot(n, towardLight), 0.0) + (1.0 - min(length(towardLight), 1.0)) * 0.25;
  return arriving * facing;
}
`;
