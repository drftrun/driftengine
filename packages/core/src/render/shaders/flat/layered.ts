/**
 * A material blended from layers by a mask: `SurfaceMaterial.layers`, packed into `uLayers` by
 * `surfaceLayers.ts`.
 *
 * **Layer `i` is layer `i` of the material's arrays**, each read at the mesh's coordinates times its
 * own repeat; the mask is layer 0 of the map a shading model would read, at the mesh's coordinates.
 * Each channel lays a layer over everything before it — red layer 1, green 2, blue 3, alpha 4 — so a
 * layer's share is its channel times one less each later channel, and the base keeps what none of
 * them took. Colour, roughness and occlusion are blended by those shares, and the normal map's
 * tangent-space texels too, before the frame turns them into the world.
 *
 * **Every layer present is read, whatever its share.** A read whose level is implicit is legal only
 * in uniform control flow (AGENTS.md 2026-08-07), so the loop is bounded by the layer count, a
 * uniform, and never skips on a share, which is the pixel's own.
 *
 * **A lit switch, `LAYERED`**, off until a material first asks, declared last so every switch before
 * it keeps its id. Compiled out, its two vectors are not declared and its calls are constants.
 */
export function layeredGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool LAYERED = false;  // wgsl:override
bool layered() { return false; }
void layeredBegin() {}
vec4 layeredAlbedo() { return vec4(1.0); }
vec3 layeredOrm() { return vec3(1.0); }
vec3 layeredTexel() { return vec3(0.0, 0.0, 1.0); }
bool layeredGlows() { return false; }
vec3 layeredEmissive() { return vec3(0.0); }
`;
  }
  return /* glsl */ `
/* Whether this program blends a material's layers. Off but where one has asked: layered.ts. */
const bool LAYERED = true;  // wgsl:override
/* The five repeats, base first (x y z w, then x), the count (y) and the glowing layer, or -1 (z). */
uniform vec4 uLayers[2]; // wgsl:material

/* The mask's channels that lay a layer, zero past the count: read once, in layeredBegin. */
vec4 lMask;

bool layered() {
  return uLayers[1].y > 0.5;
}

/* The mask, at the mesh's coordinates, where a model's map is. Under a branch on uniforms. */
void layeredBegin() {
  vec4 m = texture(uModelMap, vec3(vUv.xy, 0.0));
  float n = uLayers[1].y;
  lMask = vec4(n > 1.5 ? m.r : 0.0, n > 2.5 ? m.g : 0.0, n > 3.5 ? m.b : 0.0, n > 4.5 ? m.a : 0.0);
}

/* Layer i's share of this point: its channel, less every later layer's. */
float layerShare(int i) {
  float keep = 1.0;
  for (int j = 3; j >= 0; j--) {
    if (j + 1 == i) return lMask[j] * keep;
    keep *= 1.0 - lMask[j];
  }
  return keep;
}

float layerRepeat(int i) {
  return i < 4 ? uLayers[0][i] : uLayers[1].x;
}

vec3 layerAt(int i) {
  return vec3(vUv.xy * layerRepeat(i), float(i));
}

/* Colour by the shares, and the base layer's coverage, which a cutout reads. */
vec4 layeredAlbedo() {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uLayers[1].y) break;
    vec4 t = texture(uAlbedo, layerAt(i));
    sum.rgb += t.rgb * layerShare(i);
    if (i == 0) sum.a = t.a;
  }
  return sum;
}

vec3 layeredOrm() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uLayers[1].y) break;
    sum += texture(uOrmMap, layerAt(i)).rgb * layerShare(i);
  }
  return sum;
}

/* The tangent-space texels blended, each with its z rebuilt where a two-channel map stored none. */
vec3 layeredTexel() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uLayers[1].y) break;
    vec3 t = texture(uNormalMap, layerAt(i)).xyz * 2.0 - 1.0;
    t.z = t.z > 0.0 ? t.z : sqrt(max(0.0, 1.0 - dot(t.xy, t.xy)));
    sum += t * layerShare(i);
  }
  float len = length(sum);
  return len > 1e-5 ? sum / len : vec3(0.0, 0.0, 1.0);
}

/* Whether the emissive map belongs to one layer rather than to the whole surface. */
bool layeredGlows() {
  return uLayers[1].z > -0.5;
}

/* The emissive map at its layer's place, glowing by that layer's share. */
vec3 layeredEmissive() {
  int glow = int(uLayers[1].z + 0.5);
  return texture(uEmissiveMap, layerAt(glow)).rgb * layerShare(glow);
}
`;
}
