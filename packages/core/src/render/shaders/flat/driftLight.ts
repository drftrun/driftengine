/**
 * DriftLight in the lit shader: how much of a pixel the summed light stands in for, and the summed
 * light itself, read from the field's sparse volume.
 *
 * **The split is per pixel.** Inside the frame's completeness radius (`uDriftLight.y`, measured from
 * the eye) every light that reaches the pixel was chosen, so it is shaded exactly; past it the
 * volume stands in, and across the band before the radius the two crossfade. The choice was made
 * about some centre, which need not be the eye; `uniforms.ts` takes the distance between the two
 * off the radius, so a pixel inside it is inside the choice's radius too. A field light's
 * exact contribution is scaled by the share left over (`main.ts`, where its weight's sign is read),
 * so a light is counted once however the pixel is split.
 *
 * **One index fetch and two filtered ones.** The index finds the brick; the brick's four samples a
 * side share their faces with the next brick's, so the hardware's trilinear lookup inside one is
 * seamless across the join. The light texel carries in its fourth channel whether each sample is a
 * sample at all, and dividing by the filtered value drops the samples buried in walls rather than
 * blending their darkness into the surface. The lookup is nudged half a spacing along the normal,
 * which keeps a surface reading the air in front of it rather than the wall it is part of.
 *
 * **Two vectors of uniforms, and the sizes read off the textures.** The lit stage sits two vectors
 * under the 256 a reported part offers at eight lights, and the first cut of this, at five, took that
 * part down a rung to four. So the grid's extent and the atlas's are what `textureSize` answers, and
 * the radius is measured from `uCameraPos`, which the stage already has, rather than from a centre
 * of its own. What it gives up is two integer queries a pixel past the radius.
 *
 * `textureLod` throughout, by the 2026-08-07 rule: this is reached through branches no compiler can
 * prove uniform. Both samplers are declared `highp` because GLSL ES gives 3D samplers no default.
 */
export const DRIFT_LIGHT_GLSL = /* glsl */ `
/** x how much of the summed light is in the frame (0 off), y the radius, z the band, w the scale. */
uniform vec4 uDriftLight;
/** xyz the first sample; w metres between samples — a third of a brick, or negated for a dense volume. */
uniform vec4 uDriftLightOrigin;
uniform highp usampler3D uDriftLightIndex;  // wgsl:share shadow
uniform highp sampler3D uDriftLightAtlas;

/** The share of this pixel's field light the volume stands in for: 0 inside the radius, 1 past it. */
float driftLightShare(vec3 world) {
  if (uDriftLight.x <= 0.0) return 0.0;
  float away = distance(world, uCameraPos);
  return smoothstep(uDriftLight.y - uDriftLight.z, uDriftLight.y, away) * uDriftLight.x;
}

/**
 * A sample's light and direction turned into the light on a surface facing \`n\`: Lambert for a
 * single light, a quarter for light arriving from everywhere (see \`bake.ts\`). One statement for
 * both kinds of volume.
 */
vec3 driftLightFacing(vec4 light, vec4 toward, vec3 n) {
  vec3 arriving = light.rgb / light.a;
  vec3 from = toward.xyz / light.a;
  float facing = max(dot(n, from), 0.0) + (1.0 - min(length(from), 1.0)) * 0.25;
  return arriving * facing;
}

/**
 * The same from a dense volume: one sample a texel, the light in the lower half of y and its
 * direction in the upper. A lookup kept inside the samples never filters across the halves.
 */
vec3 driftLightDense(vec3 world, vec3 n, float spacing) {
  ivec3 size = textureSize(uDriftLightAtlas, 0);
  vec3 dims = vec3(float(size.x), float(size.y / 2), float(size.z));
  vec3 at = (world + n * (0.5 * spacing) - uDriftLightOrigin.xyz) / spacing;
  if (any(lessThan(at, vec3(0.0))) || any(greaterThan(at, dims - 1.0))) return vec3(0.0);
  vec3 uvw = (at + 0.5) / vec3(dims.x, dims.y * 2.0, dims.z);
  vec4 light = textureLod(uDriftLightAtlas, uvw, 0.0);
  if (light.a < 1e-3) return vec3(0.0);
  vec4 toward = textureLod(uDriftLightAtlas, uvw + vec3(0.0, 0.5, 0.0), 0.0);
  return driftLightFacing(light, toward, n);
}

/** The summed light arriving on a surface at \`world\` facing \`n\`. A negative spacing is dense. */
vec3 driftLightIrradiance(vec3 world, vec3 n) {
  float spacing = uDriftLightOrigin.w;
  if (spacing < 0.0) return driftLightDense(world, n, -spacing);
  vec3 at = (world + n * (0.5 * spacing) - uDriftLightOrigin.xyz) / (3.0 * spacing);
  ivec3 cell = ivec3(floor(at));
  if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, textureSize(uDriftLightIndex, 0)))) {
    return vec3(0.0);
  }
  uint id = texelFetch(uDriftLightIndex, cell, 0).r;
  if (id == 0u) return vec3(0.0);
  /* A brick is eight texels across (its light block, then its direction block) and four up and deep. */
  ivec3 size = textureSize(uDriftLightAtlas, 0);
  int brick = int(id) - 1;
  int across = size.x / 8;
  int down = size.y / 4;
  vec3 corner = vec3(
    float((brick % across) * 8),
    float(((brick / across) % down) * 4),
    float((brick / (across * down)) * 4)
  );
  vec3 texel = 1.0 / vec3(size);
  vec3 inside = (at - vec3(cell)) * 3.0 + 0.5;
  vec4 light = textureLod(uDriftLightAtlas, (corner + inside) * texel, 0.0);
  if (light.a < 1e-3) return vec3(0.0);
  vec4 toward = textureLod(uDriftLightAtlas, (corner + vec3(4.0, 0.0, 0.0) + inside) * texel, 0.0);
  return driftLightFacing(light, toward, n);
}
`;
