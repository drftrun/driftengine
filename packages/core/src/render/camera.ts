import { mat4, vec3 } from 'gl-matrix';
import type { ReadonlyMat4 } from 'gl-matrix';
import { DEG_TO_RAD } from '../math/scalar.ts';

/** Reused by `project`; a per-call vec4 would allocate on every pointer move. */
const projected = new Float32Array(4);

/** Reused by `rayThrough`; this runs on every pointer move. */
const nearPoint = new Float32Array(4);
const farPoint = new Float32Array(4);

/** One NDC point back through the inverse view-projection, with the perspective divide. */
function unproject(out: Float32Array, inv: ReadonlyMat4, x: number, y: number, z: number): void {
  const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  const scale = w === 0 ? 1 : 1 / w;
  out[0] = (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) * scale;
  out[1] = (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) * scale;
  out[2] = (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) * scale;
}

/**
 * Perspective camera. Yaw/pitch convention: yaw 0 looks toward -Z, positive
 * yaw turns right (+X); positive pitch looks up.
 */
export class Camera {
  readonly position = vec3.create();
  yaw = 0;
  pitch = 0;
  fovYDeg = 70;
  /**
   * Near plane, metres — and the single biggest control this engine has over
   * z-fighting.
   *
   * A conventional depth buffer spends its precision hyperbolically: the smallest
   * separation it can resolve at distance `z` is about `z² / (near · 2^bits)`. At
   * the old 0.1 that is a quarter of a millimetre at twenty metres, **1.5 mm at
   * fifty, and 6 mm at a hundred** — so any two surfaces closer together than that
   * are decided by float rounding, and which one a pixel shows changes as the
   * camera moves — shown most clearly by a matched pair of screenshots of one seam
   * from two angles, right in one and wrong in the other.
   *
   * Precision scales linearly with this number, so four times the near plane is
   * four times the resolution at every distance, and it costs nothing. Safe at 0.4
   * because a third-person boom never brings the eye closer than `BOOM_MIN` (0.9 m)
   * to the character and keeps its own radius clear of surfaces — there is nothing
   * legitimately within 40 cm of this camera to clip.
   *
   * It is a mitigation and not the cure. A 0.2 mm seam, which the daily generator
   * does produce where two decks meet, still fights past about forty metres. The
   * cure is a reversed-Z float depth buffer; see `docs/bugs/`.
   */
  near = 0.4;
  far = 500;

  readonly forward = vec3.create();
  readonly view = mat4.create();
  readonly projection = mat4.create();
  readonly viewProjection = mat4.create();
  readonly invViewProjection = mat4.create();

  /**
   * Roll about the view direction, radians. Positive drops the right side.
   * Render-only: nothing about the camera reaches the simulation.
   */
  roll = 0;

  /**
   * Point the camera at a world position from wherever it currently stands.
   *
   * Added because three callers had each derived this by hand and one of them got it
   * wrong: a preview rig placed itself on a circle around its subject and computed a yaw
   * that was exactly π out, so it rendered the inside of an empty box and the figure it was
   * built to show was behind it. The trig is four lines and the sign conventions are this
   * class's own — `yaw 0` looks toward −Z, positive yaw turns toward +X — so leaving every
   * caller to rediscover them is leaving them a trap.
   *
   * Sets `yaw` and `pitch` only. Roll is a separate decision (it is a lean, not an aim),
   * and `updateMatrices` still has to be called afterwards.
   */
  lookAt(x: number, y: number, z: number): void {
    const dx = x - (this.position[0] ?? 0);
    const dy = y - (this.position[1] ?? 0);
    const dz = z - (this.position[2] ?? 0);
    const flat = Math.hypot(dx, dz);
    // Straight up or down leaves yaw meaningless, so it is left as it was rather than
    // snapped to zero — which would spin the view on the way past vertical.
    if (flat > 1e-6) this.yaw = Math.atan2(dx, -dz);
    this.pitch = Math.atan2(dy, flat);
  }

  updateMatrices(aspect: number): void {
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);
    vec3.set(this.forward, sinYaw * cosPitch, sinPitch, -cosYaw * cosPitch);

    /*
     * The view basis is derived from the angles, and **not** by aiming a look-at at
     * `position + forward`, which is what this did for as long as it existed.
     *
     * A look-at builds its right axis by crossing the view direction with world up, so it has
     * nothing to work with when the two are parallel — and at a pitch of ±π/2 they are. What
     * hid that for so long is that `cos(π/2)` is 6.1e-17 rather than 0, so the horizontal part
     * of the direction survives *if it survives the addition*, and in a `Float32Array` that
     * depends on where the camera is standing: at the origin the epsilon is kept and the basis
     * is fine, and past about half a metre on the axis in question it is rounded away, the
     * cross product collapses to zero, and the view matrix is singular.
     *
     * A singular view does not draw a wrong picture, it draws none: every vertex lands on one
     * point, so the frame keeps its clear colour, and `invert` below fails and silently leaves
     * whatever the previous aim put in `invViewProjection` — which the sky pass then reads as
     * though it were this one's. **Measured on a reflection probe**, whose up and down faces are
     * the only two in the engine that ever aim straight at a pole: both came back holding one
     * stale copy of a sideways face, in every world whose subject does not stand at the origin.
     *
     * Right is `(cos yaw, 0, sin yaw)` and does not depend on pitch at all, so it is unit length
     * at every aim including both poles, and up follows from it and the direction. The result
     * matches what the look-at produced everywhere the look-at was well defined, including the
     * mirrored frame it gave past vertical, which `lean` keeps.
     *
     * What it gives up: a camera tilted past vertical still mirrors rather than rolling over the
     * top, because that is the behaviour that shipped and nothing here aims there — every
     * consumer clamps pitch well inside a quarter turn. A camera meant to loop, in a cockpit or
     * a free-flight view, wants `lean` dropped and the basis carried continuously instead.
     */
    const lean = cosPitch < 0 ? -1 : 1;
    let rightX = lean * cosYaw;
    /* Level until something rolls it: right is horizontal at every pitch. */
    let rightY = 0;
    let rightZ = lean * sinYaw;
    let upX = -lean * sinYaw * sinPitch;
    let upY = lean * cosPitch;
    let upZ = lean * cosYaw * sinPitch;

    /*
     * Up is rolled about the view direction rather than fixed to world up.
     *
     * A camera that stays level while the surface under the subject banks makes
     * the *world* look like it is tilting, which is exactly backwards: the
     * player is the thing that tilted. Rolling with them is what makes a banked
     * corner read as leaning into it.
     *
     * Both axes turn together, which is the same rotation the previous construction reached by
     * rolling world up and letting the look-at re-derive right from it — and unlike that one it
     * still turns something when the camera is aimed at a pole.
     *
     * **The sign is the shipped one and it is the opposite of a positive rotation about the view
     * direction**, which is worth stating because the construction this replaced carried a
     * comment naming the positive form while its code computed the negative one. Following the
     * comment turned every rolled frame the wrong way by twice the angle: measured as 384,242
     * pixels of 921,600 on the one demo scene that rolls, against a floor of 47.
     */
    if (this.roll !== 0) {
      const cosRoll = Math.cos(this.roll);
      const sinRoll = Math.sin(this.roll);
      const turnedRightX = rightX * cosRoll + upX * sinRoll;
      const turnedRightY = upY * sinRoll;
      const turnedRightZ = rightZ * cosRoll + upZ * sinRoll;
      upX = upX * cosRoll - rightX * sinRoll;
      upY = upY * cosRoll;
      upZ = upZ * cosRoll - rightZ * sinRoll;
      rightX = turnedRightX;
      rightY = turnedRightY;
      rightZ = turnedRightZ;
    }

    const eyeX = this.position[0] ?? 0;
    const eyeY = this.position[1] ?? 0;
    const eyeZ = this.position[2] ?? 0;
    const forwardX = this.forward[0] ?? 0;
    const forwardY = this.forward[1] ?? 0;
    const forwardZ = this.forward[2] ?? 0;
    /* Column major, and the third row is the direction negated: a view looks down -Z. */
    const view = this.view;
    view[0] = rightX;
    view[1] = upX;
    view[2] = -forwardX;
    view[3] = 0;
    view[4] = rightY;
    view[5] = upY;
    view[6] = -forwardY;
    view[7] = 0;
    view[8] = rightZ;
    view[9] = upZ;
    view[10] = -forwardZ;
    view[11] = 0;
    view[12] = -(rightX * eyeX + rightY * eyeY + rightZ * eyeZ);
    view[13] = -(upX * eyeX + upY * eyeY + upZ * eyeZ);
    view[14] = forwardX * eyeX + forwardY * eyeY + forwardZ * eyeZ;
    view[15] = 1;
    /*
     * A **vertical** field of view, which is a promise worth stating because a consumer built an
     * interface on it.
     *
     * Because the vertical extent is what is held, a projection keeps its top and bottom when the
     * aspect changes and trades only horizontal. So a tall export is exactly what a centred
     * rectangle of a wider preview sees, and a frame drawn over that preview is arithmetic rather
     * than an approximation: no second render, no two paths to compare.
     *
     * The corollary belongs beside it. Only a *centred* crop of a symmetric frustum is itself a
     * symmetric frustum; an off-centre one is sheared, which `perspective` cannot produce. A
     * consumer wanting an off-axis preview needs `mat4.frustum`, which gl-matrix already exports
     * and this engine does not wrap. Panning the camera instead is a real pan and lands in an
     * export as one.
     */
    mat4.perspective(this.projection, this.fovYDeg * DEG_TO_RAD, aspect, this.near, this.far);
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.invert(this.invViewProjection, this.viewProjection);
  }

  /**
   * Take a view and a projection that were computed somewhere else.
   *
   * **Because an XR eye cannot be described by this class, and this file already says why.**
   * `updateMatrices` derives the view from yaw and pitch and the projection from
   * `mat4.perspective`, and the note above it records the corollary: *only a centred crop of a
   * symmetric frustum is itself a symmetric frustum; an off-centre one is sheared, which
   * `perspective` cannot produce.* A headset's eye projection is exactly that shear, off-axis by
   * the distance from the pupil to the display's centre, and its view comes from a pose no pair of
   * Euler angles was ever asked to describe.
   *
   * So a supplied view is adopted rather than configured. Everything downstream reads `view`,
   * `projection`, `viewProjection` and `invViewProjection`, so frustum culling, picking, the sky
   * and every pass that samples the inverse keep working with nothing changed.
   *
   * **`position` and `forward` are decomposed back out**, and that is not a convenience. A view
   * matrix is the inverse of the camera's world transform, so the eye is `-Rᵀt` and the direction
   * is the third row negated. A consumer reading `camera.position` to place a listener or to score
   * a level of detail would otherwise get whatever the last non-XR frame left there, which is a
   * defect that looks like an audio bug rather than a camera one.
   *
   * **`yaw`, `pitch` and `roll` are deliberately left alone**, and reading them after this is
   * reading the last angles somebody set. A supplied rotation may be one no Euler triple
   * describes without a convention this class does not own, and inventing one here would put a
   * second answer to "where is the camera looking" beside `forward`, which is derived from the
   * matrix and is always right.
   *
   * `near` and `far` are not read and not written: the supplied projection carries its own depth
   * range, which the runtime chose.
   */
  adoptView(view: ReadonlyMat4, projection: ReadonlyMat4): void {
    mat4.copy(this.view, view);
    mat4.copy(this.projection, projection);
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.invert(this.invViewProjection, this.viewProjection);

    /*
     * The rotation is the upper-left 3x3 and it is orthonormal, so its inverse is its transpose
     * and the eye falls out without a general inverse. Reading the matrix rather than inverting it
     * also keeps this allocation-free, which matters because it runs once per eye per frame.
     */
    const v = this.view;
    const rx = v[0] as number,
      ry = v[4] as number,
      rz = v[8] as number;
    const ux = v[1] as number,
      uy = v[5] as number,
      uz = v[9] as number;
    const bx = v[2] as number,
      by = v[6] as number,
      bz = v[10] as number;
    const tx = v[12] as number,
      ty = v[13] as number,
      tz = v[14] as number;

    vec3.set(
      this.position,
      -(rx * tx + ux * ty + bx * tz),
      -(ry * tx + uy * ty + by * tz),
      -(rz * tx + uz * ty + bz * tz),
    );
    /* The third row of the rotation is the camera's backward axis, so forward is its negation. */
    vec3.set(this.forward, -bx, -by, -bz);
  }

  /**
   * Where a world point lands on the canvas, in CSS pixels, or false if it is behind.
   *
   * For attaching DOM to a place in the world: a focus ring on a card, a label on a
   * marker. The caller passes the CSS box rather than the drawing buffer, because the
   * answer is for the document and the document does not know the device pixel ratio.
   *
   * **False rather than a coordinate when w <= 1e-6.** The perspective divide by a negative
   * w mirrors the point through the origin, so a thing behind the viewer reports a
   * perfectly plausible position on the opposite side of the screen. A caller that
   * placed an affordance there would be putting it on the wrong object, which is worse
   * than putting it nowhere.
   */
  project(
    out: Float32Array | number[],
    x: number,
    y: number,
    z: number,
    cssWidth: number,
    cssHeight: number,
  ): boolean {
    const m = this.viewProjection;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1e-6) return false;
    projected[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    projected[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[0] = (projected[0] * 0.5 + 0.5) * cssWidth;
    out[1] = (0.5 - projected[1] * 0.5) * cssHeight;
    return true;
  }

  /**
   * The ray a pixel looks along, in world space.
   *
   * Two points are unprojected rather than one, because a direction cannot be recovered
   * from a single unprojected point without knowing where the eye is in the same space —
   * and for an orthographic camera there is no single eye at all. Unprojecting both ends
   * of the depth range and subtracting is correct for either projection, which is why it
   * is written this way for a camera that is currently only perspective.
   *
   * `cssX`/`cssY` are in the canvas's CSS box, so a caller hands over
   * `event.clientX - rect.left` and nothing has to know the device pixel ratio.
   */
  rayThrough(
    origin: Float32Array,
    direction: Float32Array,
    cssX: number,
    cssY: number,
    cssWidth: number,
    cssHeight: number,
  ): void {
    const ndcX = (cssX / cssWidth) * 2 - 1;
    const ndcY = 1 - (cssY / cssHeight) * 2;
    unproject(nearPoint, this.invViewProjection, ndcX, ndcY, -1);
    unproject(farPoint, this.invViewProjection, ndcX, ndcY, 1);

    origin[0] = nearPoint[0];
    origin[1] = nearPoint[1];
    origin[2] = nearPoint[2];

    let dx = farPoint[0] - nearPoint[0];
    let dy = farPoint[1] - nearPoint[1];
    let dz = farPoint[2] - nearPoint[2];
    const length = Math.hypot(dx, dy, dz) || 1;
    dx /= length;
    dy /= length;
    dz /= length;
    direction[0] = dx;
    direction[1] = dy;
    direction[2] = dz;
  }
}
