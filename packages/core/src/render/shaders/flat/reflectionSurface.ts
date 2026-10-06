/**
 * What the lit stage leaves for a reflection traced in the frame: how much of the environment each
 * pixel shows, and how a reflection found in the frame would land there instead. Read by the
 * reflection pass (`screenSpaceReflection.ts`), which swaps the one for the other where its ray
 * finds something.
 *
 * **The swap is exact because the lit stage's own blend is a mix**: `lit = mix(lit, environment ·
 * tint, weight)` leaves `environment · tint · weight` of the probe in the frame, and a reflection
 * found in the frame belongs there with the same tint and the same weight. So the frame gains
 * `(found · tint − environment · tint) · weight` and nothing else moves: the diffuse the blend
 * already took its share from keeps it. Both are carried the rest of the way the shaded colour
 * goes — the occlusion, the water and the medium in front of the surface — so the swap lands in the
 * frame's own units.
 *
 * **Two outputs beside the colour, written by every lit draw and kept only where a target is
 * bound.** WebGL2 binds them during opaque lit draws alone; WebGPU's frame pass binds none, and a
 * second pass replays the frame's opaque draws into them with `REFLECTION_SURFACE` on, which leaves
 * before the lamps (`main`). What it gives up is a vector of arithmetic on every lit pixel whether
 * or not anything reads it.
 */
export function reflectionSurfaceGlsl(maps: boolean): string {
  return /* glsl */ `
/*
 * Whether this pipeline is the reflection pass's surface half: the frame's opaque draws again,
 * against the depth they wrote, leaving the two outputs below and no light. Off in every other
 * pipeline, and set from the key as skin's halves are. See reflectionSurface.ts.
 */
const bool REFLECTION_SURFACE = false;  // wgsl:override
/*
 * Whether the frame's own draws write the two outputs as well: WebGL2's arrangement, on where the
 * frame's materials' reflections are, and off in every WebGPU pipeline, which replays the draws
 * instead. A lit switch, so a program that does not write them carries nothing live across the
 * lamps for them.
 */
const bool REFLECTION_MAPS = ${maps ? 'true' : 'false'};  // wgsl:override
/* The environment as the frame shows it, and the surface's roughness in w. */
layout(location = 1) out vec4 outReflectedProbe;
/* What a reflection found in the frame is multiplied by to land where the environment did. */
layout(location = 2) out vec4 outReflectedTint;

/* How much of the surface the medium in front of it leaves: the fog block below's own measure. */
float reflectionAir() {
  return uFogEnabled != 0 ? mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y) : 0.0;
}

/*
 * The two outputs, carried through what the shaded colour meets after the blend: its occlusion,
 * the water, and the air, as \`main\` applies them. \`air\` is the fog the caller has already
 * reckoned, so the frame's own draws pay for it once.
 */
void reflectionSurfaceOut(vec3 probe, vec3 tint, float roughness, float occlusion, float air) {
  vec3 keep = vec3(occlusion * (1.0 - air));
  if (uFogEnabled != 0) {
    vec3 waterTransmission = vec3(0.42) + uUnderwaterColor * 2.0;
    keep *= mix(vec3(1.0), waterTransmission, uUnderwaterFactor * 0.55);
  }
  outReflectedProbe = vec4(probe * keep, roughness);
  outReflectedTint = vec4(tint * keep, 1.0);
}
`;
}
