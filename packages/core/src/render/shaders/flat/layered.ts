import { layerLooksGlsl } from './layerLooks.ts';

/**
 * A material blended from layers by a mask: `SurfaceMaterial.layers`, packed into `uLayers` by
 * `surfaceLayers.ts`.
 *
 * **Layer `i` is layer `i` of the material's arrays** — or the layer `layerLooks.ts` picks, with the
 * tint, ranges and normal strength it gives each — each read at its own repeat of where the
 * layers are laid: the mesh's coordinates, or the world's horizontal plane where the material has a
 * projection (`worldUv.ts`). The mask's channels weigh layers 1 to 4 — red, green, blue, alpha — and
 * come from a map read where a shading model's would be, from the ORM array's layer past the layers,
 * or from the vertex colour; an added mask placed as the layers are raises one layer's weight, and
 * one layer may be weighed by how much the surface faces up instead of by its channel.
 *
 * **Two ways to combine them.** Laid over, each layer covers everything before it, so a layer's
 * share is its weight times one less each later weight, and the base keeps what none took. Summed,
 * the base is mixed toward each layer times its weight by the weights' sum held to 1, so each
 * layer's share is its weight times that and the base keeps the rest. The shares are worked out once
 * a pixel, in `layeredBegin`; colour, roughness and occlusion are blended by them, and the normal
 * map's tangent-space texels too, before the frame turns them into the world — around a normal read
 * at the mesh's own coordinates, where the material lays one under the layers.
 *
 * **Every layer present is read, whatever its share.** A read whose level is implicit is legal only
 * in uniform control flow (AGENTS.md 2026-08-07), so the loop is bounded by the layer count, a
 * uniform, and never skips on a share, which is the pixel's own.
 *
 * **A lit switch, `LAYERED`**, off until a material first asks, declared after every switch before
 * it so each keeps its id. Compiled out, its four vectors are not declared and its calls are
 * constants. `looks` compiles `LAYER_LOOKS` in beside it, and means nothing without it.
 */
export function layeredGlsl(on: boolean, looks = false): string {
  if (!on) {
    return /* glsl */ `
const bool LAYERED = false;  // wgsl:override
bool layered() { return false; }
void layeredBegin() {}
vec3 layeredColor(vec3 color) { return color; }
vec4 layeredAlbedo() { return vec4(1.0); }
vec3 layeredOrm() { return vec3(1.0); }
vec3 layeredTexel() { return vec3(0.0, 0.0, 1.0); }
bool layeredMeshNormal() { return false; }
vec3 layeredMeshTexel() { return vec3(0.0, 0.0, 1.0); }
bool layeredGlows() { return false; }
vec3 layeredEmissive() { return vec3(0.0); }
float layeredAmbient() { return 1.0; }
float layeredSpecular(float own) { return own; }
`;
  }
  return /* glsl */ `
/* Whether this program blends a material's layers. Off but where one has asked: layered.ts. */
const bool LAYERED = true;  // wgsl:override
/*
 * Four vectors, as surfaceLayers.ts packs them: the five repeats, base first (x y z w, then x); the
 * count (y), the glowing layer or -1 (z) and where the mask is, 0 a map, 1 the ORM array, 2 the
 * vertex colour (w); the blend, 0 over and 1 summed (x), whether a mesh normal is laid under the
 * layers (y), the added mask's layer or -1 (z) and its repeat (w); its intensity (x), the facing
 * layer or -1 (y), its bias (z) and its sharpness (w).
 */
uniform vec4 uLayers[4]; // wgsl:material
${layerLooksGlsl(looks)}
/* Each layer's share of this point, the base's and layers 1 to 4's: worked out once, in layeredBegin. */
float lShareBase;
vec4 lShare;
/* What an occlusion read at the mesh's coordinates leaves of this point, 1 where none: layeredBegin. */
float lMeshOcclusion;

bool layered() {
  return uLayers[1].y > 0.5;
}

float layerRepeat(int i) {
  return i < 4 ? uLayers[0][i] : uLayers[1].x;
}

/* Where the layers are laid: the world's horizontal plane under a projection, the mesh's otherwise. */
vec2 layerPlace() {
  if (WORLD_UVS && projected()) return planarAt();
  return vUv.xy;
}

vec3 layerAt(int i) {
  float across = layerRepeat(i);
  return vec3(layerPlace() * vec2(across, layerRepeatDown(i, across)), layerArray(i));
}

/* The weights as the material keeps them: the mask's channels, at the mesh's own coordinates. */
vec4 layerWeights() {
  float source = uLayers[1].w;
  if (source > 1.5) return vec4(vColor, 0.0);
  if (source > 0.5) return texture(uOrmMap, vec3(vUv.xy, layerExtras()));
  return texture(uModelMap, vec3(vUv.xy, 0.0));
}

/* Which of layers 1 to 4 a packed layer number names, as a vector of one 1: none for -1. */
vec4 layerPick(float layer) {
  return vec4(equal(vec4(layer), vec4(1.0, 2.0, 3.0, 4.0)));
}

/*
 * The weights, changed where the material asks and zero past the count, and every share from them.
 * Under a branch on uniforms, as its reads are.
 */
void layeredBegin() {
  /*
   * The occlusion at the mesh's coordinates, once: the ORM array's layer past the layers and past
   * any mask and added mask it carries, spread over its range and taken at its strength.
   */
  lMeshOcclusion = 1.0;
  float strength = layerOcclusionStrength();
  if (strength > 0.0) {
    float at = layerExtras() + (abs(uLayers[1].w - 1.0) < 0.5 ? 1.0 : 0.0) + (uLayers[2].z > 0.5 ? 1.0 : 0.0);
    vec2 range = layerOcclusionRange();
    float occlusion = mix(range.x, range.y, texture(uOrmMap, vec3(vUv.xy, at)).r);
    lMeshOcclusion = mix(1.0, occlusion, strength);
  }
  vec4 m = layerWeights();
  if (uLayers[2].z > 0.5) {
    /* The ORM array's layer past the layers, and past the mask where the array carries that too. */
    float at = layerExtras() + (abs(uLayers[1].w - 1.0) < 0.5 ? 1.0 : 0.0);
    float added = texture(uOrmMap, vec3(layerPlace() * uLayers[2].w, at)).r * uLayers[3].x;
    m = mix(m, clamp(m + added, 0.0, 1.0), layerPick(uLayers[2].z));
  }
  if (uLayers[3].y > 0.5) {
    float up = normalize(vNormal).y * 0.5 + 0.5;
    float facing = clamp(uLayers[3].z + uLayers[3].w * up, 0.0, 1.0);
    m = mix(m, vec4(facing), layerPick(uLayers[3].y));
  }
  float n = uLayers[1].y;
  m *= vec4(n > 1.5 ? 1.0 : 0.0, n > 2.5 ? 1.0 : 0.0, n > 3.5 ? 1.0 : 0.0, n > 4.5 ? 1.0 : 0.0);
  if (uLayers[2].x > 0.5) {
    float taken = min(m.x + m.y + m.z + m.w, 1.0);
    lShare = m * taken;
    lShareBase = 1.0 - taken;
    return;
  }
  /* Each over everything before it: a layer keeps its weight of what every later one leaves. */
  float keep = 1.0;
  lShare.w = m.w * keep;
  keep *= 1.0 - m.w;
  lShare.z = m.z * keep;
  keep *= 1.0 - m.z;
  lShare.y = m.y * keep;
  keep *= 1.0 - m.y;
  lShare.x = m.x * keep;
  keep *= 1.0 - m.x;
  lShareBase = keep;
}

float layerShare(int i) {
  if (i == 0) return lShareBase;
  return lShare[i - 1];
}

/* The vertex colour's part in the albedo: none where it is the mask instead. */
vec3 layeredColor(vec3 color) {
  return uLayers[1].w > 1.5 ? vec3(1.0) : color;
}

/*
 * Colour by the shares, each layer's tinted, and the base layer's coverage, which a cutout reads;
 * then darkened by the occlusion at the mesh's coordinates, where it is the colour that takes it.
 */
vec4 layeredAlbedo() {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uLayers[1].y) break;
    vec4 t = texture(uAlbedo, layerAt(i));
    sum.rgb += t.rgb * layerTint(i) * layerShare(i);
    if (i == 0) sum.a = t.a;
  }
  if (!layerOcclusionAmbient()) sum.rgb *= lMeshOcclusion;
  return sum;
}

/* What the ambient light keeps: the occlusion at the mesh's coordinates, where it takes it. */
float layeredAmbient() {
  return layerOcclusionAmbient() ? lMeshOcclusion : 1.0;
}

/*
 * The specular by the shares, each layer's own or the surface's where it names none. The surface's
 * own, untouched, where no material has asked for looks: shares summing to one in floating point
 * are not quite one, and a layered material that names nothing must draw exactly as before.
 */
float layeredSpecular(float own) {
  if (LAYER_LOOKS) {
    float sum = 0.0;
    for (int i = 0; i < 5; i++) {
      if (float(i) >= uLayers[1].y) break;
      sum += layerSpecular(i, own) * layerShare(i);
    }
    return sum;
  }
  return own;
}

/* Occlusion, roughness and metalness by the shares, each layer's spread over its own ranges. */
vec3 layeredOrm() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uLayers[1].y) break;
    vec3 t = texture(uOrmMap, layerAt(i)).rgb;
    t.yz = layerRanges(i, t.yz);
    sum += t * layerShare(i);
  }
  return sum;
}

/* A tangent-space texel off the normal array, its z rebuilt where a two-channel map stored none. */
vec3 layerNormalTexel(vec3 at) {
  vec3 t = texture(uNormalMap, at).xyz * 2.0 - 1.0;
  t.z = t.z > 0.0 ? t.z : sqrt(max(0.0, 1.0 - dot(t.xy, t.xy)));
  return t;
}

/* The tangent-space texels blended by the shares. */
vec3 layeredTexel() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uLayers[1].y) break;
    sum += layerStrengthen(i, layerNormalTexel(layerAt(i))) * layerShare(i);
  }
  float len = length(sum);
  return len > 1e-5 ? sum / len : vec3(0.0, 0.0, 1.0);
}

/* Whether a normal read at the mesh's own coordinates lies under the layers. */
bool layeredMeshNormal() {
  return uLayers[2].y > 0.5;
}

/* That normal's texel: the normal array's layer past the layers, at the mesh's coordinates. */
vec3 layeredMeshTexel() {
  return layerNormalTexel(vec3(vUv.xy, layerExtras()));
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
