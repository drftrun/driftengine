/**
 * The anisotropic model in GLSL: GGX stretched along a direction in the surface, after glTF's
 * `KHR_materials_anisotropy` — `anisotropicLobe.ts` is the same arithmetic, and its tests hold it to
 * the standard lobe at strength 0 and to the widths' ratio at its half maximum.
 *
 * **The direction** is the tangent frame's, turned by the material's rotation, and by the model
 * map's red and green where one is bound (a direction encoded −1 to 1, glTF's packing), its blue
 * scaling the strength. **The environment** is reflected about a normal bent toward the stretch, as
 * Filament and three.js do: a streak of sky across a brushed disc rather than a round spot, at the
 * cost of a reflection that is not the exact anisotropic integral.
 *
 * Lamps widen both of the lobe's widths by the source's angle, as `sphereLobe` widens the standard
 * lobe, with the energy kept; at strength 0 that is `sphereLobe` exactly.
 */
export const ANISOTROPIC_GLSL = /* glsl */ `
/* The stretch's frame and strength, gathered once with the surface. */
vec3 aAlong;
vec3 aAcross;
float aStrength;

void anisotropicSurface() {
  vec2 direction = vec2(1.0, 0.0);
  float strength = uModelParams[0].x;
  if (uModelParams[1].w > 0.0) {
    vec2 mapped = mMap.rg * 2.0 - 1.0;
    direction = dot(mapped, mapped) > 1e-8 ? normalize(mapped) : direction;
    strength *= mMap.b;
  }
  vec2 turned = vec2(
    direction.x * uModelParams[0].y - direction.y * uModelParams[0].z,
    direction.x * uModelParams[0].z + direction.y * uModelParams[0].y
  );
  aAlong = normalize(mTangent * turned.x + mBitangent * turned.y);
  aAcross = cross(mNormal, aAlong);
  aStrength = strength;
}

/** The stretched lobe at a half vector, 1 at the mirror direction: anisotropicLobe.ts. */
float anisotropicLobe(vec3 h, float sourceRadius, float dist) {
  float alpha = max(mRoughness * mRoughness, MIN_LOBE_ALPHA);
  float alongWidth = alpha + (1.0 - alpha) * aStrength * aStrength;
  float grow = sourceRadius / max(2.0 * dist, 1e-3);
  float alongWide = clamp(alongWidth + grow, alongWidth, 1.0);
  float acrossWide = clamp(alpha + grow, alpha, 1.0);
  float energy = (alongWidth / alongWide) * (alpha / acrossWide);
  float x = dot(aAlong, h) / alongWide;
  float y = dot(aAcross, h) / acrossWide;
  float z = dot(mNormal, h);
  float d = x * x + y * y + z * z;
  return energy / max(d * d, 1e-8);
}

void anisotropicLight(vec3 l, float sourceRadius, float dist) {
  float ndl = max(dot(mNormal, l), 0.0);
  vec3 h = normalize(l + mToEye);
  vec3 tint = mix(mSpecColor, vec3(1.0), pow(1.0 - max(dot(mToEye, h), 0.0), 5.0) * mMetal);
  mDiffuse = mAlbedo * ndl * (1.0 - mMetal);
  mSpecular = ndl > 0.0 ? tint * anisotropicLobe(h, sourceRadius, dist) : vec3(0.0);
}

/* The environment's normal, bent toward the stretch by its strength and the surface's roughness. */
vec3 anisotropicReflectNormal(vec3 n) {
  vec3 across = cross(aAcross, mToEye);
  vec3 bent = cross(across, aAcross);
  float bend = aStrength * clamp(5.0 * mRoughness, 0.0, 1.0);
  return normalize(mix(n, bent, bend));
}
`;
