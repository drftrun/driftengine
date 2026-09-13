/**
 * The wave field, as one piece of GLSL every program that answers to it shares.
 *
 * A water surface and the light it throws onto whatever covers it are the same
 * phenomenon, so they have to be the same *numbers*. A caustic driven by its own
 * animation drifts out of step with the crests visible five metres away, and
 * once it has, no tuning on either side brings them back — the player never
 * consciously notices why the shot looks fake, they just do not believe it.
 * Sharing this table and this phase makes the two agree by construction instead
 * of by review.
 *
 * `gain` scales *steepness*: how built-up the sea is for the wind blowing (see
 * `seaState.ts`). It changes the shape of the water, not its size — so a calm day
 * throws a soft wide sheen where a built-up one throws sharp lines, from one
 * number, in both programs at once.
 *
 * No backticks anywhere below, including in comments: this is a template literal
 * and a backtick inside one ends it. It has cost this project two debugging
 * sessions in `flat.ts` already.
 */
export const GERSTNER_GLSL = `
const int GERSTNER_COUNT = 4;
/*
 * direction.xy, steepness, wavelength. Amplitude is steepness/k, so these sum to
 * roughly a 1m swell — enough to read as a living surface, low enough that crests
 * never wash over an island whose deck sits ~1.8m above sea level.
 */
const vec4 GERSTNER_WAVES[4] = vec4[4](
  vec4( 1.0,  0.0,  0.115, 34.0),
  vec4( 0.6,  0.8,  0.100, 18.0),
  vec4(-0.7,  0.7,  0.080,  9.0),
  vec4( 0.2, -0.98, 0.060,  5.0)
);

/*
 * Steer each wave toward the wind, but only partway. A real sea is a dominant
 * swell plus cross-chop; rotating all four onto one bearing gives corduroy,
 * which reads as a material rather than as water.
 */
vec2 gerstnerDirection(int i, vec2 windDir) {
  return normalize(mix(normalize(GERSTNER_WAVES[i].xy), windDir, 0.62));
}

float gerstnerWavenumber(int i) {
  return 6.28318530718 / GERSTNER_WAVES[i].w;
}

/** Deep-water phase in radians at a point on the resting plane. */
float gerstnerPhase(float k, vec2 dir, vec2 p, float time) {
  float c = sqrt(9.81 / k);              // deep-water phase speed
  return k * (dot(dir, p) - c * time);
}

struct GerstnerSurface {
  /** Displacement from the resting plane — horizontal as well as vertical. */
  vec3 offset;
  vec3 normal;
  /** Height in units of steepness; positive near a crest. */
  float crest;
};

GerstnerSurface gerstnerSurface(vec2 p, float time, vec2 windDir, float gain) {
  GerstnerSurface s;
  s.offset = vec3(0.0);
  s.normal = vec3(0.0, 1.0, 0.0);
  s.crest = 0.0;
  for (int i = 0; i < GERSTNER_COUNT; i++) {
    vec2 dir = gerstnerDirection(i, windDir);
    float steepness = GERSTNER_WAVES[i].z * gain;
    float k = gerstnerWavenumber(i);
    float f = gerstnerPhase(k, dir, p, time);
    float a = steepness / k;             // amplitude from steepness

    s.offset.x += dir.x * a * cos(f);
    s.offset.y += a * sin(f);
    s.offset.z += dir.y * a * cos(f);

    // Analytic normal: the partial derivatives of the displacement above.
    s.normal.x -= dir.x * steepness * cos(f);
    s.normal.z -= dir.y * steepness * cos(f);
    s.normal.y -= steepness * sin(f);

    s.crest += sin(f) * steepness;
  }
  return s;
}

/**
 * Second derivatives of the height field: (d2h/dx2, d2h/dz2, d2h/dxdz).
 *
 * How the surface *bends*, which is what decides where reflected light
 * converges. Analytic from the same sum, so it cannot disagree with the shape
 * the vertex stage displaced.
 */
vec3 gerstnerCurvature(vec2 p, float time, vec2 windDir, float gain) {
  vec3 h = vec3(0.0);
  for (int i = 0; i < GERSTNER_COUNT; i++) {
    vec2 dir = gerstnerDirection(i, windDir);
    float steepness = GERSTNER_WAVES[i].z * gain;
    float k = gerstnerWavenumber(i);
    float f = gerstnerPhase(k, dir, p, time);
    // Second derivative of (steepness/k)*sin(f) along the wave's own bearing.
    float second = -steepness * k * sin(f);
    h.x += second * dir.x * dir.x;
    h.y += second * dir.y * dir.y;
    h.z += second * dir.x * dir.y;
  }
  return h;
}
`;
