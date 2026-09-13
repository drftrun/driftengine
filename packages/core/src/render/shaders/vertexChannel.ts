/**
 * The per-vertex channel's declaration and its wind displacement, authored once for two programs.
 *
 * **Shared source rather than two copies, for the reason `scatter.ts` gives about its own.** The
 * colour pass and the depth pass have to agree *exactly*: a canopy that bends in one and stands
 * still in the other slides its whole shade off the ground it belongs to, and the drift follows
 * the gust, so it never reads as a constant offset anybody could find by looking. One expression,
 * two callers.
 *
 * The lanes are `MeshData.channel`: `.x` sway, `.y` skyDirect, `.z` alpha, `.w` reserved. Only
 * `.x` is read here; the other two are varyings the fragment stage consumes.
 */

/**
 * The attribute, and the wind the bend below reads.
 *
 * Declared unconditionally in every vertex variant. **No lane is a permutation**: the fragment
 * stage already carries sixteen of those at 282.2 KB gzipped, where the whole vertex stage is
 * 4.1 KB across five, so a `#if` here would buy nothing measurable and cost a variant axis.
 */
export const CHANNEL_ATTRIBUTE = `
layout(location = 13) in vec4 aChannel;

/*
 * The frame's wind, already converted by \`resolveScatterDeform\` — a normalised direction, metres
 * of bend, a gust amplitude and a scaled clock.
 *
 * **The same numbers the scatter batch reads, and that is the rule rather than an economy.** A
 * second conversion here would be a second wind however identical its inputs, and the failure is
 * not localised: it shows up as a scene that does not cohere, a canopy leaning one way while the
 * grass beneath it leans another, with no single element looking wrong. See "One wind, sampled
 * once" in AGENTS.md.
 */
uniform vec2 uWindDirection;
uniform float uWindSpeed;
uniform float uWindGust;
uniform float uWindTime;
/* Spatial frequency of the travelling gust, per metre. */
uniform vec2 uWindSpatialPhase;
`;

/**
 * Where the wind puts a vertex, given how much of it that vertex takes.
 *
 * Phase comes from world position, so neighbouring geometry is never in lockstep and a gust
 * visibly travels across a canopy instead of the whole canopy pulsing at once. That is the scatter
 * shader's reasoning and it transfers without change.
 *
 * **The lane scales the bend once, where `scatter.ts` squares its own falloff.** That file derives
 * its falloff from height, and a linear response there slides a whole plant sideways and reads as
 * the ground moving, so it squares to keep the base planted. Here the falloff is *authored* — 0 on
 * a trunk, 1 at a leaf tip — and squaring it would silently overrule a curve somebody had already
 * shaped. What that costs is that a lane filled linearly up a trunk gives a tree that slides at
 * its base; the fix is the curve the author meant, not a square in the shader.
 *
 * The early return is not an optimisation. Geometry that never said it bends must reach exactly
 * the position it reached before this existed, and `sin` of a phase multiplied by zero is not
 * bit-identical to not moving at all.
 */
export const CHANNEL_BEND = `
vec3 channelBend(vec3 worldPos, float sway) {
  if (sway <= 0.0) return worldPos;
  float phase = dot(worldPos.xz, uWindSpatialPhase) + uWindTime;
  float bend = (uWindSpeed + uWindGust) * sin(phase) * sway;
  return vec3(
    worldPos.x + uWindDirection.x * bend,
    worldPos.y,
    worldPos.z + uWindDirection.y * bend
  );
}
`;
