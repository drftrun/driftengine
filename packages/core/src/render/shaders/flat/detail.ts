/**
 * A material's tiled detail over whatever its maps made: `SurfaceMaterial.detail`, packed into
 * `uDetail` by `surfaceDetail.ts`.
 *
 * **Each texel wears its own region's detail alone.** The region is read exactly from the ORM
 * array's layer the material names, at the base coordinates, so an index is never blended with its
 * neighbour's at a region's edge; then that region's normal map is read at its repeat and offset,
 * turned through a frame built on the normal the base maps made — the construction a layered
 * material lays its layers over a mesh normal with — and its occlusion multiplied into the
 * surface's. A strength scales the detail's slopes as a layer's look does.
 *
 * **Read with explicit gradients**, the base coordinates' times the region's repeat, because the
 * region is the pixel's own: a read whose level is implicit is legal only in uniform control flow
 * (AGENTS.md 2026-08-07), and across a region's edge the repeated coordinates jump, which would
 * read a level as coarse as the jump. The frame and the gradients are taken first, under the
 * uniform branch that calls this.
 *
 * **A lit switch, `SURFACE_DETAIL`**, off until a material first asks, declared after `LAYERED` and
 * `LAYER_LOOKS` so each keeps its id. Compiled out, its thirty-three vectors are not declared.
 */
export function detailGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool SURFACE_DETAIL = false;  // wgsl:override
bool detailed() { return false; }
void surfaceDetail(inout vec3 n, inout float occlusion, vec2 uv) {}
`;
  }
  return /* glsl */ `
/* Whether this program lays a material's detail. Off but where one has asked: detail.ts. */
const bool SURFACE_DETAIL = true;  // wgsl:override
/*
 * Thirty-three vectors, as surfaceDetail.ts packs them: the region count (x) and the ORM array's
 * layer holding the region map, or -1 for none (y); then two a region, the normal map's layer (x),
 * the occlusion's or -1 (y), the normal strength (z) and the occlusion strength (w); its repeats
 * across and down (x y) and its offset (z w).
 */
uniform vec4 uDetail[33]; // wgsl:material

bool detailed() { return uDetail[0].x > 0.0; }

/* The region a texel of the base maps is in, read exactly, held to the regions there are. */
int detailRegion(vec2 uv) {
  int last = int(uDetail[0].x) - 1;
  if (uDetail[0].y < 0.0) return 0;
  ivec2 size = textureSize(uOrmMap, 0).xy;
  ivec2 texel = clamp(ivec2(floor(fract(uv) * vec2(size))), ivec2(0), size - 1);
  int region = int(texelFetch(uOrmMap, ivec3(texel, int(uDetail[0].y)), 0).r * 255.0 + 0.5);
  return clamp(region, 0, last);
}

void surfaceDetail(inout vec3 n, inout float occlusion, vec2 uv) {
  /* In uniform control flow, before anything that depends on the pixel's region. */
  mat3 frame = tangentFrame(n, vWorldPos, uv, vTangent, vHasTangents);
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  int region = detailRegion(uv);
  vec4 picks = uDetail[1 + region * 2];
  vec4 place = uDetail[2 + region * 2];
  vec2 at = uv * place.xy + place.zw;
  vec2 gx = dx * place.xy;
  vec2 gy = dy * place.xy;
  vec3 d = textureGrad(uModelMap, vec3(at, picks.x), gx, gy).xyz * 2.0 - 1.0;
  /* z rebuilt where none is stored, as the base map's is: normalMap.ts. */
  d.z = d.z > 0.0 ? d.z : sqrt(max(0.0, 1.0 - dot(d.xy, d.xy)));
  d = normalize(vec3(d.xy * picks.z, max(d.z, 1e-4)));
  n = normalize(frame * d);
  if (picks.y >= 0.0) {
    float held = textureGrad(uModelMap, vec3(at, picks.y), gx, gy).r;
    occlusion *= mix(1.0, held, picks.w);
  }
}
`;
}
