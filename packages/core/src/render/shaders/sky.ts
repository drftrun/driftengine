import { glslFarDepth } from '../depthConvention.ts';
/**
 * Procedural gradient sky drawn as a single attribute-less fullscreen triangle.
 * Ray direction is reconstructed per-fragment from the inverse view-projection,
 * so the sky is correct under any camera. Drawn last at the far plane, so early-z wins —
 * and the far plane is 0 under reversed depth and 1 otherwise, which is why the value is
 * interpolated rather than written. A sky that says 1.0 in a reversed engine is drawn at the
 * *near* plane and covers the world; measured, that was 743,669 changed pixels of 921,600.
 */
export const SKY_VERT = `#version 300 es
const vec2 POS[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));

out vec2 vNdc;

void main() {
  vNdc = POS[gl_VertexID];
  /* The far plane, whichever way depth runs: see glslFarDepth. */
  gl_Position = vec4(vNdc, ${glslFarDepth()}, 1.0);
}
`;

export const SKY_FRAG = `#version 300 es
precision highp float;

in vec2 vNdc;

uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uTopColor;
uniform vec3 uHorizonColor;
uniform vec3 uDeepColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunDiscExponent;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonAngularRadius;
uniform float uMoonPhase;
uniform float uNightFactor;
uniform vec2 uCloudOffset;
uniform vec3 uUnderwaterColor;
uniform float uUnderwaterFactor;

out vec4 outColor;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Three octaves is the ceiling — drop to two before cutting anything else. */
float fbm(vec2 p) {
  float v = valueNoise(p) * 0.5;
  v += valueNoise(p * 2.03) * 0.3;
  v += valueNoise(p * 4.01) * 0.2;
  return v;
}

void main() {
  vec4 world = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(world.xyz / world.w - uCameraPos);

  float t = dir.y;
  vec3 col = t >= 0.0
    ? mix(uHorizonColor, uTopColor, pow(min(t, 1.0), 0.55))
    : mix(uHorizonColor, uDeepColor, min(-t * 1.8, 1.0));

  // Celestial bodies belong to the sky, not to the void underneath. Seeing the
  // sun below the horizon made the world read as unbounded in every direction;
  // fading them out at the horizon leaves the deep reading as depth instead.
  float aboveHorizon = smoothstep(-0.04, 0.06, dir.y);

  /*
   * Sunset.
   *
   * Low sunlight crosses far more atmosphere than high sunlight, and that path
   * scatters the blue out of it — which is why the sun reddens as it drops and
   * why the glow around it spreads into a band rather than staying a disc. Both
   * effects peak right at the horizon and are gone within a few degrees of it,
   * so they are driven by the sun's own elevation rather than by the clock.
   *
   * TWO EDGES, BECAUSE A SUNSET ENDS. This shipped with only the upper one, so every
   * sun below the horizon read as maximum sunset and stayed there all the way to
   * straight down — and a sun direction of (0, -1, 0) is what a night world writes to
   * mean "there is no sun in this sky". A consumer measured the result on a black
   * sun: 87% more red in the sky than the same frame with the sun pointing up, a warm
   * band over a third of the picture in an arctic snowfield, and the world's own
   * blue-grey horizon arriving with its channel order reversed. Four night worlds were
   * not started over it, and this repository's own storm sea shipped it. The lower
   * edge is where astronomical twilight ends, near -0.31, so the term now fades out
   * over the same range the sky it models does.
   *
   * What it gives up: the glow is a function of the sun's elevation and nothing else,
   * so a caller cannot place one where its own sun is not. That is deliberate — a knob
   * here would let a world disagree with itself — but it is also what makes this wrong
   * for a body that is not our sun in our atmosphere. A world lit by something that
   * scatters differently needs its own term, not a wider edge here.
   *
   * Written ascending-and-inverted rather than as a descending smoothstep, whose
   * result GLSL ES leaves undefined when edge0 >= edge1. Every implementation seen so
   * far computes the ramp anybody would expect, which is why the descending form
   * survived this long, but the spec does not owe us that.
   */
  float sunset = (1.0 - smoothstep(-0.03, 0.30, uSunDir.y)) *
    smoothstep(-0.35, -0.05, uSunDir.y);
  vec3 ember = vec3(1.0, 0.36, 0.13);

  float s = max(dot(dir, uSunDir), 0.0);
  // The disc itself reddens; the last sliver above the horizon is nearly blood
  // orange, which is the moment the whole effect is remembered for.
  vec3 discColor = mix(uSunColor, uSunColor * ember, sunset * 0.85);
  col += discColor * (
    pow(s, uSunDiscExponent) * 1.2 +
    pow(s, max(uSunDiscExponent / 75.0, 1.0)) * 0.12
  ) * aboveHorizon;

  /*
   * The band. Brightest toward the sun's bearing and hugging the horizon,
   * falling off both with angle around the compass and with height — a sunset
   * is a direction, not a uniform warm wash, and washing the whole dome is what
   * makes a fake one look like a colour filter.
   */
  vec2 sunBearing = normalize(uSunDir.xz + vec2(1e-5));
  vec2 viewBearing = normalize(dir.xz + vec2(1e-5));
  float toward = max(dot(viewBearing, sunBearing), 0.0);
  /*
   * Measured from the horizon, and falling three times faster below it than above.
   *
   * This was abs(dir.y), which is symmetric, so the band was mirrored twenty-seven
   * degrees down into the deep — visible in any world whose ground does not cover
   * the lower half of the frame, and captured in the -Y face of every environment
   * probe, where it tinted reflections warm. Nothing in the sky mirrors a sunset
   * below the horizon; what is down there is ground, and the ground is drawn by
   * somebody else.
   *
   * Not gated by aboveHorizon like the sun disc and the moon are: that factor is
   * only 0.4 at a dir.y of zero, which is exactly where this term is brightest, so
   * multiplying by it would cut the band's core to a third and change every sunset
   * to fix a night. Falling faster below instead leaves everything at or above the
   * horizon bit-for-bit as it was, and the horizon line itself unbroken. What it
   * gives up: a camera under the world, or above a planet seen from outside its
   * atmosphere, sees the glow end sooner than the geometry does.
   */
  float fromHorizon = dir.y >= 0.0 ? dir.y : -dir.y * 3.0;
  float band = pow(1.0 - min(fromHorizon * 2.2, 1.0), 2.6);
  col += ember * sunset * band * (0.18 + 0.75 * pow(toward, 2.2));

  /*
   * Belt of Venus: the sky opposite a setting sun takes a cool pink-violet from
   * light already reddened on its way past. Subtle, but its absence is why an
   * artificial sunset feels like it is only happening on one side.
   */
  float away = max(-dot(viewBearing, sunBearing), 0.0);
  col += vec3(0.42, 0.28, 0.45) * sunset * band * away * 0.22;

  /*
   * Moon: a shaded procedural sphere-disc, not one dot subtracted from another.
   * The local sphere normal gives a curved terminator and limb; lunar phase
   * supplies the light direction around that sphere. Low-frequency noise adds
   * maria without a texture file, while a faint earthshine keeps the dark limb
   * just legible instead of cutting a mathematically black hole in the sky.
   */
  vec3 moonReference = abs(uMoonDir.y) < 0.98
    ? vec3(0.0, 1.0, 0.0)
    : vec3(1.0, 0.0, 0.0);
  vec3 moonRight = normalize(cross(moonReference, uMoonDir));
  vec3 moonUp = cross(uMoonDir, moonRight);
  float moonRadius = clamp(uMoonAngularRadius, 0.001, 0.5);
  vec2 moonUv = vec2(dot(dir, moonRight), dot(dir, moonUp)) / moonRadius;
  float moonRadiusSq = dot(moonUv, moonUv);
  float moonFacing = step(0.0, dot(dir, uMoonDir));
  float moonDisc = (1.0 - smoothstep(0.90, 1.0, moonRadiusSq)) * moonFacing;
  if (moonDisc > 0.0) {
    float sphereZ = sqrt(max(1.0 - moonRadiusSq, 0.0));
    vec3 surfaceNormal = normalize(vec3(moonUv, sphereZ));
    float phaseAngle = uMoonPhase * 6.28318530718;
    vec3 phaseLight = vec3(sin(phaseAngle), 0.0, -cos(phaseAngle));
    float phaseShade = max(dot(surfaceNormal, phaseLight), 0.0);
    float maria = valueNoise(moonUv * 3.2 + vec2(4.7, 9.1)) * 0.68 +
      valueNoise(moonUv * 9.3 - vec2(7.4, 2.6)) * 0.32;
    float albedo = mix(0.56, 1.02, maria);
    float limb = mix(0.72, 1.0, sphereZ);
    float earthshine = 0.035;
    float lunarLight = earthshine + (1.0 - earthshine) * phaseShade;
    col += uMoonColor * albedo * limb * lunarLight * moonDisc *
      1.35 * uNightFactor * aboveHorizon;
  }
  float phaseIllumination = 0.5 - cos(uMoonPhase * 6.28318530718) * 0.5;
  float moonHalo = (1.0 - smoothstep(1.0, 3.0, length(moonUv))) * moonFacing;
  col += uMoonColor * moonHalo * 0.08 * phaseIllumination *
    uNightFactor * aboveHorizon;

  if (dir.y > 0.0) {
    // Stars. Stereographic projection: unlike dir.xz/dir.y it stays finite and
    // near-uniform all the way to the horizon, so stars don't smear into grain.
    // Each cell holds one jittered *point* — lighting the whole cell would draw
    // square blocks, which is what "random pixels" looks like.
    if (uNightFactor > 0.0) {
      vec2 p = dir.xz / (1.0 + dir.y) * 26.0;
      vec2 cell = floor(p);
      float h = hash21(cell);
      if (h > 0.93) {
        vec2 jitter = vec2(hash21(cell + 17.3), hash21(cell + 41.7));
        float d = length(fract(p) - jitter);
        float star = smoothstep(0.10, 0.0, d) * (0.4 + h * 0.6);
        // Fade out near the horizon, where haze would swallow them anyway.
        col += vec3(0.86, 0.91, 1.0) * star * uNightFactor * smoothstep(0.03, 0.3, dir.y);
      }
    }

    // Clouds: banded value noise on a layer above the camera, carried by the
    // world's wind — the same signal the smoke and the grass answer to, so the
    // largest moving thing in frame agrees with the smallest.
    // The floor on dir.y bounds the perspective stretch near the horizon.
    if (dir.y > 0.02) {
      vec2 uv = dir.xz / max(dir.y, 0.16) * 0.09 + uCloudOffset * 0.012;
      float band = smoothstep(0.46, 0.60, fbm(uv));
      float fade = smoothstep(0.02, 0.30, dir.y);
      vec3 cloudCol = mix(uHorizonColor, vec3(1.0), 0.45) * mix(1.0, 0.32, uNightFactor);
      col = mix(col, cloudCol, band * fade * 0.8);
    }
  }

  // There is no outdoor sky inside a water column. Retain a little vertical
  // gradient so the surface remains legible above and depth reads darker
  // below, while celestial bodies and clouds disappear with the same smooth
  // surface transition used by the geometry passes.
  float waterLight = mix(0.62, 1.08, clamp(dir.y * 0.5 + 0.5, 0.0, 1.0));
  col = mix(col, uUnderwaterColor * waterLight, uUnderwaterFactor);

  outColor = vec4(col, 1.0);
}
`;
