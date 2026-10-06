/**
 * A draw's surface overlay in the lit stage: the rim, the dissolve and the wrinkles
 * `surfaceOverlay.ts` packs into `uOverlay`. Called from `main` at three places — the dissolve's cut
 * before anything is shaded, the wrinkles after the normal map, and the glow beside emission.
 *
 * **A lit switch, `SURFACE_OVERLAY`**, off until a draw first sets an overlay and then on for good,
 * as `litSwitchesGlsl`'s are; declared after the models so every switch before it keeps its id.
 * Compiled out, the three calls are stubs and the fifteen vectors are not declared at all, which is
 * what lets WebGL2 build a lit program without them on a device that has no room.
 *
 * **Images come from the atlas bound where the frame's refraction copy goes**, which an opaque draw
 * never reads; a draw that refracts or is glass reads that copy there, so its overlay reads no image
 * (`overlayImagesBound`). Each image is read by `textureLod` at level 0: several are reached under a
 * branch on a per-pixel value, and the atlas carries no chain anyway.
 */
export function overlayGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool SURFACE_OVERLAY = false;  // wgsl:override
bool overlayCuts(vec2 uv) { return false; }
vec3 overlayWrinkle(vec3 mapped, vec3 unmapped, vec2 uv) { return mapped; }
vec3 overlayGlow(vec2 uv, vec3 n) { return vec3(0.0); }
`;
  }
  return /* glsl */ `
/* Whether this program carries a draw's overlay. Off but where one has been set: overlay.ts. */
const bool SURFACE_OVERLAY = true;  // wgsl:override
/* The overlay's fifteen vectors; packSurfaceOverlay in surfaceOverlay.ts says what each holds. */
uniform vec4 uOverlay[15];

/* Whether the atlas is what the refraction slot holds: not where this draw refracts or is glass. */
bool overlayImagesBound() {
  return uSeeThrough.x <= 0.0 && uSeeThrough.z <= 0.0;
}

/* One image of the atlas at uv, repeated within its region; zero where the region has no size. */
vec4 overlayImage(vec4 region, vec2 uv) {
  if (region.x <= 0.0) return vec4(0.0);
  return textureLod(uRefractScene, region.zw + fract(uv) * region.xy, 0.0);
}

/* The dissolve's noise at uv, and whether the draw dissolves at all: -1 where it does not. */
float overlayDissolveNoise(vec2 uv) {
  if (uOverlay[6].x <= 0.0 || uOverlay[7].z <= 0.0) return -1.0;
  if (!overlayImagesBound()) return -1.0;
  return overlayImage(uOverlay[6], uv * uOverlay[7].xy).r;
}

/* Whether the dissolve cuts this fragment away: where its noise is under the threshold, or all of
   it at a threshold of 1. */
bool overlayCuts(vec2 uv) {
  float noise = overlayDissolveNoise(uv);
  if (noise < 0.0) return false;
  return noise < uOverlay[7].z || uOverlay[7].z >= 1.0;
}

/*
 * The wrinkle normal blended into the mapped one by the two masks' channels times the six weights,
 * in the frame the normal map is read in. **Under uniform control flow up to the frame**, which
 * takes derivatives: every branch before it is on the overlay's numbers alone, and the weight a
 * pixel takes is a mix rather than a branch.
 */
vec3 overlayWrinkle(vec3 mapped, vec3 unmapped, vec2 uv) {
  if (uOverlay[10].x <= 0.0 || !overlayImagesBound()) return mapped;
  mat3 tbn = tangentFrame(unmapped, vWorldPos, vUv.xy, vTangent, vHasTangents);
  vec3 a = overlayImage(uOverlay[11], uv).rgb;
  vec3 b = overlayImage(uOverlay[12], uv).rgb;
  float weight = clamp(
    dot(a, uOverlay[13].xyz) + dot(b, vec3(uOverlay[13].w, uOverlay[14].xy)), 0.0, 1.0);
  vec3 wrinkle = overlayImage(uOverlay[10], uv).xyz * 2.0 - 1.0;
  /* z rebuilt where none is stored, as normalMapped does: see normalMap.ts. */
  wrinkle.z = wrinkle.z > 0.0 ? wrinkle.z : sqrt(max(0.0, 1.0 - dot(wrinkle.xy, wrinkle.xy)));
  return normalize(mix(mapped, normalize(tbn * wrinkle), weight));
}

/*
 * The rim's place on the screen, 0 to 1 up its height and its width in the same units: from view
 * space and the projection's tangent, not from gl_FragCoord, whose y runs up on one backend and
 * down on the other (the 2026-08-17 rule), and whose scale is a render target's, not the screen's.
 */
vec2 overlayScreen() {
  vec4 eye = uView * vec4(vWorldPos, 1.0);
  float depth = max(-eye.z, 1e-4) * uClusterFrustum.z;
  return vec2(eye.x / depth + uClusterFrustum.w, eye.y / depth + 1.0) * 0.5;
}

/* What the overlay adds to the light the surface gives off: the dissolve's band, the colour laid
   over through its noise, and the rim. Zero where the draw sets none of them. */
vec3 overlayGlow(vec2 uv, vec3 n) {
  vec3 glow = vec3(0.0);
  float noise = overlayDissolveNoise(uv);
  if (noise >= 0.0) {
    float band = 1.0 - clamp((noise - uOverlay[7].z) / uOverlay[7].w, 0.0, 1.0);
    glow += uOverlay[8].rgb * uOverlay[8].w * band + uOverlay[9].rgb * uOverlay[9].w * noise;
  }
  float strength = uOverlay[0].w;
  if (strength > 0.0) {
    vec3 toEye = normalize(uCameraPos - vWorldPos);
    float edge = pow(1.0 - clamp(dot(n, toEye), 0.0, 1.0), max(uOverlay[1].x, 1e-4));
    float up = pow(clamp(n.y * 0.5 + 0.5, 0.0, 1.0), max(uOverlay[1].y, 1e-4));
    float rim = pow(edge * up, max(uOverlay[1].z, 1e-4));
    float time = uSurfaceScene.x;
    if (uOverlay[2].x > 0.0 && overlayImagesBound()) {
      vec2 at = overlayScreen() * uOverlay[3].z + uOverlay[3].xy * time;
      rim *= overlayImage(uOverlay[2], at).r;
    }
    rim = min(rim, 1.0);
    rim *= mix(uOverlay[4].x, uOverlay[4].y, 0.5 + 0.5 * sin(uOverlay[3].w * time));
    if (uOverlay[5].x > 0.0 && overlayImagesBound()) {
      rim *= 1.0 - uOverlay[1].w * overlayImage(uOverlay[5], uv).r;
    }
    glow += uOverlay[0].rgb * strength * rim;
  }
  return glow;
}
`;
}
