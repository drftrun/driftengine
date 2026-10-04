/**
 * Surface effects in the lit shader: what a layer does beyond its picture, read from the albedo
 * array's effects table at the layer a vertex carries (`surfaceEffects.ts` has the layout).
 *
 * **Nothing here changes a surface that asks for nothing.** With no table the fetch never runs and
 * every value is zero; each effect is then `mix(x, y, 0)` or a multiply by exactly 1, so a scene
 * that never names an effect draws bit for bit what it drew before. Rain is the one effect that
 * needs no table — it is the scene's (`Environment.wetness`) — and at zero it is the same no-op.
 *
 * **Windows and rooms.** A layer's windows are a grid of cells over one repeat. Each window lights
 * by a hash of its cell against the scene's lit share, quantised to tenths, so a rising share lights
 * more windows rather than brightening the lit ones; a share of them stays lit in the small hours.
 * A room behind a window is **interior mapping from one image**: a one-point perspective picture of
 * a room, back wall in its centre half, is sampled where the view ray meets the room's box. A point
 * on any wall at depth s maps into that picture at `0.5 + (xy - 0.5) / (1 + s)` — the back wall at
 * s = 1 lands in the centre square, and a side wall runs from the picture's edge in to it — so one
 * formula serves every wall and the picture carries its own shading.
 *
 * **Wear** is procedural: dust settling on what faces up, grime rising from the ground and in
 * blotches, streaks running down walls, all fading out with distance where a table says to.
 *
 * Every sample inside these branches is `textureGrad` with gradients taken outside them, or
 * `texelFetch` (the 2026-08-07 rule). Hashes are integer arithmetic (the 2026-09-20 rule).
 *
 * What it gives up: the room picture is one per layer, so every room of a facade is the same room
 * lit or dark; and a room's box assumes a window as wide as it is tall, so a very tall cell
 * stretches its room.
 */
export const SURFACE_EFFECTS_GLSL = /* glsl */ `
/*
 * The layer's six rows, and what every effect reads beside them, filled once at the top of main.
 * Globals rather than arguments, because naga passes every argument through a pointer and a copy,
 * and in sixteen permutations that traffic was most of what the effects cost in bytes.
 */
vec4 fx0;
vec4 fx1;
vec4 fx2;
vec4 fx3;
vec4 fx4;
vec4 fx5;
vec3 fxNormal;
float fxDistance;

/** Every row zero: the layer carries no effect. */
void fxClear() {
  fx0 = vec4(0.0);
  fx1 = vec4(0.0);
  fx2 = vec4(0.0);
  fx3 = vec4(0.0);
  fx4 = vec4(0.0);
  fx5 = vec4(0.0);
}

/** Fill the rows for this layer, or leave them zero where the array carries no table. */
void fxLoad(int layer) {
  ivec2 size = textureSize(uSurfaceEffects, 0);
  if (size.x < 6 || layer < 0 || layer >= size.y) return;
  fx0 = texelFetch(uSurfaceEffects, ivec2(0, layer), 0);
  fx1 = texelFetch(uSurfaceEffects, ivec2(1, layer), 0);
  fx2 = texelFetch(uSurfaceEffects, ivec2(2, layer), 0);
  fx3 = texelFetch(uSurfaceEffects, ivec2(3, layer), 0);
  fx4 = texelFetch(uSurfaceEffects, ivec2(4, layer), 0);
  fx5 = texelFetch(uSurfaceEffects, ivec2(5, layer), 0);
}

/** A cell and a seed to 0..1, the same on every device. */
float fxHash(vec2 cell, float seed) {
  uvec2 q = uvec2(ivec2(cell)) + uvec2(uint(seed) * 7919u, uint(seed) * 104729u);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = (h ^ (h >> 16)) * 2246822519u;
  h ^= h >> 13;
  return float(h & 16777215u) / 16777216.0;
}

float fxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = smoothstep(0.0, 1.0, fract(p));
  return mix(
    mix(fxHash(i, 0.0), fxHash(i + vec2(1.0, 0.0), 0.0), u.x),
    mix(fxHash(i + vec2(0.0, 1.0), 0.0), fxHash(i + vec2(1.0, 1.0), 0.0), u.x),
    u.y);
}

/** Scroll and flipbook, on the caller's clock. \`fract\` keeps a long clock from eating precision. */
vec3 fxAnimate(vec3 at) {
  float time = uSurfaceScene.x;
  at.xy += fract(fx4.xy * time);
  if (fx5.y > 0.0) at.z += mod(floor(time * fx5.z), fx5.y);
  return at;
}

/** Pulse, flicker and fade with distance, as a factor on the emission. */
float fxEmission(float layer) {
  float time = uSurfaceScene.x;
  float e = 1.0 - fx4.w * (0.5 + 0.5 * sin(6.2831853 * fract(fx4.z * time)));
  e *= 1.0 - fx5.x * step(0.7, fxHash(vec2(floor(time * 14.0), layer), 3.0));
  if (fx5.w > 0.0) e *= 1.0 - smoothstep(fx5.w * 0.7, fx5.w, fxDistance);
  return e;
}

/** Dust, grime and streaks, then the scene's rain: the colour in xyz, the roughness in w. */
vec4 fxWeather(vec3 world, vec3 albedo, float roughness) {
  float fade = fx3.w > 0.0 ? 1.0 - smoothstep(fx3.w * 0.5, fx3.w, fxDistance) : 1.0;
  if (fx3.x + fx3.y + fx3.z > 0.0) {
    float blotch = fxNoise(world.xz * 0.35 + world.y * 0.2);
    float dust = fx3.x * smoothstep(0.35, 0.9, fxNormal.y) * (0.5 + 0.5 * blotch) * fade;
    float grime = fx3.y * (0.55 - 0.55 * smoothstep(0.0, 2.5, world.y) + 0.45 * blotch) * fade;
    float streak = fx3.z * (1.0 - abs(fxNormal.y))
      * fxNoise(vec2((world.x + world.z) * 2.5, world.y * 0.15)) * fade;
    albedo = mix(albedo, vec3(0.56, 0.53, 0.48), dust * 0.6) * (1.0 - 0.5 * grime - 0.35 * streak);
    roughness = mix(roughness, 1.0, clamp(0.5 * (dust + grime), 0.0, 1.0));
  }
  float wet = uSurfaceScene.y * (1.0 - fx2.w) * mix(0.35, 1.0, smoothstep(0.2, 0.8, fxNormal.y));
  return vec4(albedo * (1.0 - 0.45 * wet), mix(roughness, 0.08, wet));
}

/**
 * Windows and the rooms behind them: the glow a lit window adds to the emission in xyz, and in w
 * how much of the surface is glass, which the caller mixes toward the room's dim colour. The room
 * itself is returned through \`fxRoom\`. \`mask\` is the albedo's alpha, and a window is a hole in the
 * wall's picture: glass where it is 0. The other way round would lose the wall's colour, which does
 * not survive an upload at alpha 0.
 *
 * **A building's own light, where its vertices name one.** The table is per layer, and every
 * facade of one style shares a layer, so a light that differs from building to building — its
 * colour and its strength — cannot live there. A window layer's vertex emissive is otherwise unused
 * (its windows glow here, not through the emissive term), so the vertex's emissive colour, strength
 * folded in, is that light: the window's colour where there is no room, a tint on the room where
 * there is. An absent colour reads negative and leaves both exactly as the table says.
 */
vec3 fxRoom;
vec4 fxWindows(vec3 at, vec2 dx, vec2 dy, float mask) {
  float glass = fx0.z > 0.0 ? 1.0 - mask : 1.0;
  vec2 g = at.xy * fx0.xy;
  vec2 local = fract(g);
  float share = floor(max(uSurfaceScene.z, uSurfaceScene.w) * 10.0 + 0.5) / 10.0;
  float lit = fxHash(floor(g), fx0.w) < share * (fx1.x > 0.0 ? fx1.z : 1.0) ? 1.0 : 0.0;
  fxRoom = fx2.rgb;
  bool own = vEmissiveColor.r >= 0.0;
  vec3 glow = own ? vEmissiveColor : fx2.rgb;
  float tangentLength = length(vTangent.xyz);
  if (fx1.x > 0.0 && tangentLength > 1e-4) {
    vec3 t = vTangent.xyz / tangentLength;
    vec3 v = normalize(vWorldPos - uCameraPos);
    vec3 d = vec3(dot(v, t), dot(v, cross(fxNormal, t)) * sign(vTangent.w + 0.5),
      min(dot(v, fxNormal), -1e-3) / max(fx1.y, 0.05));
    vec2 across = (step(0.0, d.xy) - local) / (sign(d.xy + 1e-9) * max(abs(d.xy), 1e-5));
    float travel = min(min(across.x, across.y), -1.0 / d.z);
    float depth = min(-d.z * travel, 1.0);
    vec2 picture = 0.5 + (local + d.xy * travel - 0.5) / (1.0 + depth);
    fxRoom = textureGrad(uAlbedo, vec3(picture, fx1.x - 1.0), dx * fx0.xy * 0.5, dy * fx0.xy * 0.5).rgb;
    glow = own ? fxRoom * vEmissiveColor : fxRoom;
  }
  return vec4(glow * (lit * fx1.w * glass), glass);
}
`;
