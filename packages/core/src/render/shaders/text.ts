/**
 * Screen-space 3D text.
 *
 * Every lit cell of every glyph is one instanced cube. That sounds extravagant
 * and is not: a fifteen-character message is a few hundred boxes, one draw
 * call, and it buys real geometry — text that catches light, casts its own
 * shading, and can rotate in depth. Drawing it as a textured quad would put a
 * flat sticker over a flat-shaded world, which is exactly the "HTML on top"
 * look this exists to get rid of.
 *
 * The projection is built here rather than taken from the scene camera. Text is
 * laid out in pixels and must land where the UI says it lands, whatever the
 * gameplay camera is doing — but it still wants perspective, or a rotating
 * letter shears instead of turning.
 */
export const TEXT_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aCorner;
layout(location = 1) in vec3 aNormal;
/** Cell position in pixels, relative to the string's origin. */
layout(location = 2) in vec2 aCell;
/** Which character this cell belongs to, for staggered animation. */
layout(location = 3) in float aCharIndex;

uniform vec2 uViewport;
/** Where the string's baseline-left sits, in pixels from the top left. */
uniform vec2 uOrigin;
uniform float uCellSize;
/** Distance from the virtual camera; larger flattens the perspective. */
uniform float uDepth;

/** 0 before a character has arrived, 1 once it has settled. */
uniform float uReveal;
/** How many characters the stagger spans — the whole line, not this piece. */
uniform float uCharCount;
/**
 * Where this piece starts within that line.
 *
 * A line drawn in several pieces — words around a keycap — must stagger as one
 * sentence. Without this each piece restarts at zero, so the second word begins
 * arriving before the first has finished and they sit at different heights
 * through the whole animation.
 */
uniform float uCharOffset;
/** Radians of entry rotation, decaying to zero as a character settles. */
uniform float uSpin;
/** Extra scale at the moment of arrival — the overshoot. */
uniform float uPunch;
/** Vertical bob amplitude in pixels, and its phase. */
uniform float uBob;
uniform float uTime;
/**
 * Clip space, as the backend drawing this defines it. Identity on WebGL2.
 *
 * This draw builds its own clip position from pixels and never multiplies by a camera, so
 * the correction every other draw carries in its view-projection cannot reach it — the same
 * gap that left the sky unprojecting through the wrong space. Two things are wrong without
 * it on WebGPU, and only one of them is visible: the generated vertex shader negates Y, so
 * the message renders upside down; and z here is a narrow slice about zero, which is inside
 * OpenGL's [-1, 1] and *outside* WebGPU's [0, 1], so half of every glyph is clipped away.
 */
uniform mat4 uClipCorrection;

out vec3 vNormal;
out float vDepth;
out float vChar;

/**
 * Spring settle: overshoots once and comes back.
 *
 * A character that eases into place reads as an element appearing; one that
 * overshoots and settles reads as an object arriving. That difference is most
 * of what makes text feel like part of a game rather than part of a page.
 */
float settle(float t) {
  if (t <= 0.0) return 0.0;
  if (t >= 1.0) return 1.0;
  float d = 1.0 - t;
  return 1.0 - d * d * cos(t * 12.0) ;
}

mat2 rot(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

void main() {
  // Stagger: each character starts a fraction of the reveal later than the
  // one before it, so the message assembles left to right.
  float span = max(uCharCount, 1.0);
  float start = ((aCharIndex + uCharOffset) / span) * 0.55;
  float local = clamp((uReveal - start) / max(0.45, 1.0 - start), 0.0, 1.0);
  float eased = settle(local);

  // Arrives spinning about its own horizontal axis and dropping into place.
  float spin = uSpin * (1.0 - eased);
  float rise = (1.0 - eased) * uCellSize * 6.0;
  float punch = 1.0 + uPunch * (1.0 - abs(eased * 2.0 - 1.0));

  vec3 local3 = aCorner * uCellSize * 0.5 * punch;
  local3.yz = rot(spin) * local3.yz;

  vec2 cell = aCell * uCellSize;
  float bob = sin(uTime * 3.1 + aCharIndex * 0.7) * uBob;

  // Pixels, y down from the top-left corner of the viewport.
  vec2 screen = uOrigin + vec2(cell.x, -cell.y) + vec2(0.0, rise - bob);
  vec3 view = vec3(screen + local3.xy, -uDepth + local3.z);

  // A hand-built perspective divide. The near plane is the viewport itself, so
  // a cell at depth uDepth is exactly its pixel size on screen.
  float invDepth = uDepth / max(0.001, -view.z);
  vec2 ndc = ((view.xy * invDepth) / uViewport) * 2.0 - 1.0;
  // Depth from the cube's own extrusion, mapped into a narrow slice of the
  // range so a message sorts against itself without ever reaching the scene.
  float depth = clamp(-local3.z / max(1.0, uCellSize * 2.0), -1.0, 1.0) * 0.4;
  gl_Position = uClipCorrection * vec4(ndc.x, -ndc.y, depth, 1.0);

  vec3 n = aNormal;
  n.yz = rot(spin) * n.yz;
  vNormal = n;
  vDepth = local3.z;
  vChar = eased;
}`;

export const TEXT_FRAG = `#version 300 es
precision highp float;

in vec3 vNormal;
in float vDepth;
in float vChar;

uniform vec3 uColor;
/** Self-illumination on top of the shaded colour. */
uniform float uGlow;
uniform float uAlpha;

out vec4 fragColor;

void main() {
  /*
   * A fixed key light rather than the world's. Text has to stay legible at
   * midnight and at noon, and lighting it with the scene would make a
   * notification unreadable on exactly the night runs where it matters most.
   * The light only exists to give the cubes an edge.
   */
  vec3 key = normalize(vec3(-0.35, 0.7, 0.6));
  float lambert = 0.55 + 0.45 * max(dot(normalize(vNormal), key), 0.0);

  vec3 lit = uColor * lambert;
  // The glow rides the arrival: brightest as a character lands, settling after.
  vec3 emissive = uColor * uGlow * (0.45 + 0.55 * vChar);
  fragColor = vec4(lit + emissive, uAlpha);
}`;
