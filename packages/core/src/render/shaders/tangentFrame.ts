/**
 * Which way is along the texture, at a fragment.
 *
 * Two sources and a selection. The attribute frame is what `geometry/tangents.ts` generated,
 * interpolated across the triangle and re-orthogonalised here; the derived frame is the standard
 * cotangent construction from screen-space derivatives, for a mesh that never went through the
 * generator — which is every mesh `meshBuilder` makes procedurally.
 *
 * **Both are computed and one is chosen, rather than one being computed under a branch.** The
 * derivatives below are legal only under uniform control flow, and `hasTangents` arrives as a
 * varying — flat, but a compiler cannot prove a varying uniform. The caller puts this inside its
 * branch on `uNormalStrength`, which is a real uniform, and the selection here is a ternary rather
 * than a branch. `main.ts` carries the same arrangement for `fwidth(vWorldPos)` and the long
 * reason beside it; `AGENTS.md` 2026-08-07 is the rule, and WGSL refuses the module outright
 * rather than leaving a derivative in non-uniform control flow undefined.
 */
export const TANGENT_FRAME_GLSL = `mat3 tangentFrame(vec3 n, vec3 worldPos, vec2 uv, vec4 tangent, int hasTangents) {
  /*
   * The derived frame: solve for the axis along u from how position and uv change together over
   * the pixel. Exact where the surface is locally planar, approximate where it curves, which is
   * the trade for working at all on geometry that carries no frame.
   */
  vec3 dp1 = dFdx(worldPos);
  vec3 dp2 = dFdy(worldPos);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n);
  vec3 dp1perp = cross(n, dp1);
  vec3 dt = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 db = dp2perp * duv1.y + dp1perp * duv2.y;
  /*
   * **The determinant's sign, which magnitude-normalising throws away — and it is the difference
   * between the two backends.**
   *
   * dFdy measures along *upward* window y in GLSL and along *downward* framebuffer y in WGSL, so
   * dp2 and duv2 both arrive negated on WebGPU. The system this solves is invariant under that —
   * both sides of its second equation flip — but the closed form above is not: dt and db each come
   * out negated, and dividing by their *length* keeps the negation instead of cancelling it. The
   * frame then points the other way on one backend, which reads as a surface lit from the wrong
   * side and nothing else.
   *
   * The UV determinant flips with them, so folding its sign back in restores the invariance the
   * solve always had. Measured before and after on demo/dev/normal.html: the derived panel stood
   * 86 of 255 rms from the attribute panel on WebGPU and 8.8 on WebGL2; with this they agree.
   */
  float det = duv1.x * duv2.y - duv2.x * duv1.y;
  float handed = det < 0.0 ? -1.0 : 1.0;
  /* One scale for both axes, so a stretched UV layout does not shear the frame it produces. */
  float invmax = inversesqrt(max(max(dot(dt, dt), dot(db, db)), 1e-12)) * handed;
  vec3 derivedT = dt * invmax;
  vec3 derivedB = db * invmax;

  /*
   * The attribute frame, re-orthogonalised. Interpolating a tangent across a triangle leaves it
   * no longer square to the interpolated normal, and Gram-Schmidt is what puts it back —
   * generateTangents does the same per vertex and says why: dropping it is a normal map that
   * shears wherever the geometry curves.
   */
  vec3 attrT = normalize(tangent.xyz - n * dot(n, tangent.xyz));
  /*
   * The bitangent's sign, which is the whole reason w is stored. An artist mapping the left and
   * right of a model onto one patch of texture gives one side a mirrored frame, and a bitangent
   * computed without the sign lights that side inside out.
   */
  vec3 attrB = cross(n, attrT) * tangent.w;

  vec3 t = hasTangents != 0 ? attrT : derivedT;
  vec3 b = hasTangents != 0 ? attrB : derivedB;
  return mat3(t, b, n);
}`;
