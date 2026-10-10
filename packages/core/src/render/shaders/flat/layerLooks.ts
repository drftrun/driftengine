/**
 * Which layer of the shared arrays each of a layered material's layers reads, and how each looks:
 * `uLayerLooks`, packed by `surfaceLayerLooks.ts`, read by `layered.ts`.
 *
 * **Every helper is the identity where the switch is off**, written as a branch on `LAYER_LOOKS`
 * itself because the generated WGSL carries one string for both values of an override: layer `i`
 * reads layer `i`, the maps beyond the layers start at the layer count, a tint is white, a range is
 * 0 to 1, a normal is as stored, a specular is the surface's own, a repeat down is the repeat
 * across, and nothing is occluded — exactly what `layered.ts` did before this existed, which is what
 * a layered material that asks for none of it has to keep drawing.
 *
 * **A lit switch, `LAYER_LOOKS`**, off until a material first asks and declared after `LAYERED`, so
 * every switch before it keeps its id. It is only ever compiled beside `LAYERED`, whose `uLayers`
 * it reads.
 */
export function layerLooksGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool LAYER_LOOKS = false;  // wgsl:override
float layerArray(int i) { return float(i); }
float layerExtras() { return uLayers[1].y; }
vec3 layerTint(int i) { return vec3(1.0); }
vec2 layerRanges(int i, vec2 roughMetal) { return roughMetal; }
vec3 layerStrengthen(int i, vec3 texel) { return texel; }
float layerNamedSpecular(int i) { return -1.0; }
float layerRepeatDown(int i, float across) { return across; }
vec2 layerOcclusionStrengths() { return vec2(0.0); }
vec2 layerOcclusionRange() { return vec2(0.0, 1.0); }
`;
  }
  return /* glsl */ `
/* Whether layers are picked from shared arrays and given looks of their own: layerLooks.ts. */
const bool LAYER_LOOKS = true;  // wgsl:override
/*
 * Fifteen vectors, as surfaceLayerLooks.ts packs them: the array layer each of the five reads, base
 * first (floats 0 to 4); where the maps beyond the layers start (5), the mesh occlusion's strength
 * on the colour, from 0 up (6), and on the ambient light (7); then two vectors a
 * layer, base first: its tint (x y z) and normal strength (w), then its roughness range (x to y)
 * and metalness range (z to w); then each layer's specular, -1 for the surface's own (48 to 52), its
 * repeat down (53 to 57), and the occlusion's range (58 to 59).
 */
uniform vec4 uLayerLooks[15]; // wgsl:material

/* Float k of the fifteen vectors. */
float layerLook(int k) {
  return uLayerLooks[k / 4][k % 4];
}

/* The layer of the albedo, normal and ORM arrays a material's layer i reads. */
float layerArray(int i) {
  if (LAYER_LOOKS) return layerLook(i);
  return float(i);
}

/* Where the maps beyond the layers start in each array. */
float layerExtras() {
  if (LAYER_LOOKS) return uLayerLooks[1].y;
  return uLayers[1].y;
}

vec3 layerTint(int i) {
  if (LAYER_LOOKS) return uLayerLooks[2 + i * 2].xyz;
  return vec3(1.0);
}

/* The ORM's roughness and metalness, each spread over the layer's own range. */
vec2 layerRanges(int i, vec2 roughMetal) {
  if (LAYER_LOOKS) {
    vec4 range = uLayerLooks[3 + i * 2];
    return vec2(mix(range.x, range.y, roughMetal.x), mix(range.z, range.w, roughMetal.y));
  }
  return roughMetal;
}

/*
 * A tangent-space texel bent further or less by the layer's strength: its x and y scaled, its z
 * kept, so 0 lies flat and a strength above 1 steepens every slope the map holds. z is held above
 * zero so a texel lying exactly flat on its surface cannot normalise to nothing at strength 0.
 */
vec3 layerStrengthen(int i, vec3 texel) {
  if (LAYER_LOOKS) return normalize(vec3(texel.xy * uLayerLooks[2 + i * 2].w, max(texel.z, 1e-4)));
  return texel;
}

/* The specular the layer names, or -1 where it names none and the surface's own stands. */
float layerNamedSpecular(int i) {
  if (LAYER_LOOKS) return layerLook(48 + i);
  return -1.0;
}

/* The layer's repeat down, which is its repeat across unless it gave two. */
float layerRepeatDown(int i, float across) {
  if (LAYER_LOOKS) return layerLook(53 + i);
  return across;
}

/* The mesh occlusion's strength on the colour (x), from 0 up, and on the ambient light (y). */
vec2 layerOcclusionStrengths() {
  if (LAYER_LOOKS) return uLayerLooks[1].zw;
  return vec2(0.0);
}

vec2 layerOcclusionRange() {
  if (LAYER_LOOKS) return uLayerLooks[14].zw;
  return vec2(0.0, 1.0);
}
`;
}
