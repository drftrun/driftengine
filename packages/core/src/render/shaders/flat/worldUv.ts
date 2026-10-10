/**
 * A material's maps placed by where a point is in the world rather than by the mesh's texture
 * coordinates: `SurfaceMaterial.projection`, packed into `uWorldUv` by `surfaceProjection.ts`.
 *
 * **Planar** takes the two horizontal axes, `x` and `z`, at so many repeats a metre: a floor whose
 * mesh carries no useful coordinates, or one coordinate for the whole of it, shows its texture at
 * the size the material asks. **Triplanar** reads every map three times, on the planes across `x`,
 * `y` and `z`, and blends them by how squarely the surface faces each — the geometric normal raised
 * to a sharpness — so a wall, a cliff and a rock wear it as a floor does. A normal map on three
 * planes is turned into the world by the whiteout blend, each plane's tangent-space normal added to
 * the surface's own swizzled into that plane, which keeps the detail of each without a tangent
 * frame per plane.
 *
 * **A lit switch, `WORLD_UVS`**, off until a material first asks and then on for good, declared
 * last so every switch before it keeps its id. Compiled out, its vector is not declared and its
 * calls are constants, so a scene that never asks pays nothing.
 *
 * **What it gives up**: a projection is the world's, so a mesh that moves slides under its own
 * texture, which is right for ground and wrong for a crate; triplanar reads each map three times;
 * and a map that is an array reads one layer for the whole surface, the one the face names.
 */
export function worldUvGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool WORLD_UVS = false;  // wgsl:override
bool projected() { return false; }
bool triplanar() { return false; }
vec2 planarAt() { return vec2(0.0); }
vec4 triplanarAlbedo(float layer) { return vec4(0.0); }
vec3 triplanarOrm(float layer) { return vec3(0.0); }
vec3 triplanarEmissive(float layer) { return vec3(0.0); }
vec3 triplanarNormal(vec3 n, float layer) { return n; }
`;
  }
  return /* glsl */ `
/* Whether this program places maps by the world. Off but where a material has asked: worldUv.ts. */
const bool WORLD_UVS = true;  // wgsl:override
/* x: 0 the mesh's coordinates, 1 planar, 2 triplanar; y: repeats a metre; z: the blend's sharpness. */
uniform vec4 uWorldUv; // wgsl:material

bool projected() {
  return uWorldUv.x > 0.5;
}

bool triplanar() {
  return uWorldUv.x > 1.5;
}

/* The horizontal axes, scaled: u along +x, v along +z. */
vec2 planarAt() {
  return vWorldPos.xz * uWorldUv.y;
}

/* How much each plane counts: the geometric normal's components, sharpened, summing to one. */
vec3 triplanarWeights() {
  vec3 w = pow(abs(normalize(vNormal)), vec3(uWorldUv.z));
  return w / max(w.x + w.y + w.z, 1e-5);
}

/*
 * Each map read on the three planes and blended: a function a map rather than one taking the
 * sampler, whose precision differs between them. Under a branch on a uniform, as every map read
 * is, so the implicit level each read takes is legal: AGENTS.md 2026-08-07.
 */
vec4 triplanarAlbedo(float layer) {
  vec3 w = triplanarWeights();
  vec3 p = vWorldPos * uWorldUv.y;
  return texture(uAlbedo, vec3(p.zy, layer)) * w.x + texture(uAlbedo, vec3(p.xz, layer)) * w.y +
    texture(uAlbedo, vec3(p.xy, layer)) * w.z;
}

vec3 triplanarOrm(float layer) {
  vec3 w = triplanarWeights();
  vec3 p = vWorldPos * uWorldUv.y;
  return texture(uOrmMap, vec3(p.zy, layer)).rgb * w.x +
    texture(uOrmMap, vec3(p.xz, layer)).rgb * w.y + texture(uOrmMap, vec3(p.xy, layer)).rgb * w.z;
}

vec3 triplanarEmissive(float layer) {
  vec3 w = triplanarWeights();
  vec3 p = vWorldPos * uWorldUv.y;
  return texture(uEmissiveMap, vec3(p.zy, layer)).rgb * w.x +
    texture(uEmissiveMap, vec3(p.xz, layer)).rgb * w.y +
    texture(uEmissiveMap, vec3(p.xy, layer)).rgb * w.z;
}

/* A tangent-space normal off the map, its z rebuilt where a two-channel map stored none. */
vec3 triplanarTexel(vec2 at, float layer) {
  vec3 t = texture(uNormalMap, vec3(at, layer)).xyz * 2.0 - 1.0;
  t.z = t.z > 0.0 ? t.z : sqrt(max(0.0, 1.0 - dot(t.xy, t.xy)));
  return t;
}

/*
 * The normal map on three planes, by the whiteout blend: each plane's texel added to the surface
 * normal swizzled into that plane, its z scaled by the normal's own, and swizzled back. Each plane's
 * coordinates run along the same world axes from both sides, so a texel's axes are the world's and
 * nothing is flipped; what that gives up is a texture mirrored on a plane's negative side.
 */
vec3 triplanarNormal(vec3 n, float layer) {
  vec3 w = triplanarWeights();
  vec3 p = vWorldPos * uWorldUv.y;
  vec3 tx = triplanarTexel(p.zy, layer);
  vec3 ty = triplanarTexel(p.xz, layer);
  vec3 tz = triplanarTexel(p.xy, layer);
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  vec3 blended = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
  return normalize(mix(n, blended, uNormalStrength));
}
`;
}
