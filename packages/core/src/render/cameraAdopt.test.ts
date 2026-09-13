import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Camera } from './camera.ts';

/**
 * A view this class did not compute, adopted rather than configured.
 *
 * **The case that matters is the one `updateMatrices` cannot produce.** A headset's eye projection
 * is off-axis: the pupil is not at the centre of the display, so the frustum is sheared, and
 * `camera.ts`'s own note says `perspective` cannot make one. Every test here that used a symmetric
 * projection would pass against a camera that quietly ignored its argument and derived its own, so
 * the asymmetric ones are the file's subject and the symmetric one is only a control.
 */

/** An off-axis frustum, the shape a headset actually hands over. */
function eyeProjection(left: number, right: number, bottom: number, top: number): mat4 {
  const out = mat4.create();
  mat4.frustum(out, left, right, bottom, top, 0.1, 100);
  return out;
}

/** A view matrix from a pose, which is the inverse of the camera's world transform. */
function viewFrom(position: vec3, yawRad: number, rollRad: number): mat4 {
  const world = mat4.create();
  mat4.translate(world, world, position);
  mat4.rotateY(world, world, yawRad);
  mat4.rotateZ(world, world, rollRad);
  return mat4.invert(mat4.create(), world) as mat4;
}

describe('a camera given matrices it did not compute', () => {
  /**
   * **The whole reason this method exists.** `mat4.perspective` cannot express this projection, so
   * a camera that derived its own instead of adopting this one would differ here and nowhere else.
   */
  it('keeps an off-axis projection exactly, which perspective cannot produce', () => {
    const camera = new Camera();
    const asymmetric = eyeProjection(-0.09, 0.11, -0.08, 0.08);
    camera.adoptView(mat4.create(), asymmetric);

    expect([...camera.projection]).toEqual([...asymmetric]);

    /* And it really is off-axis, or the assertion above is about a symmetric matrix. */
    const symmetric = mat4.perspective(mat4.create(), 1.2, 1.25, 0.1, 100);
    expect([...camera.projection]).not.toEqual([...symmetric]);
    expect(camera.projection[8]).not.toBe(0);
  });

  it('keeps the supplied view exactly', () => {
    const camera = new Camera();
    const view = viewFrom([3, 1.6, -4], 0.7, 0);
    camera.adoptView(view, mat4.create());
    expect([...camera.view]).toEqual([...view]);
  });

  /**
   * **`position` is decomposed back out, and a stale one is an audio bug wearing a camera's
   * clothes.** A consumer placing a listener reads `camera.position`; if adopting a view left it
   * holding the last non-XR frame's value, sound would come from where the player used to be.
   */
  it('recovers the eye position from the view matrix', () => {
    const camera = new Camera();
    vec3.set(camera.position, 999, 999, 999);
    camera.adoptView(viewFrom([3, 1.6, -4], 0.7, 0), mat4.create());

    expect(camera.position[0]).toBeCloseTo(3, 5);
    expect(camera.position[1]).toBeCloseTo(1.6, 5);
    expect(camera.position[2]).toBeCloseTo(-4, 5);
  });

  it('recovers the view direction from the view matrix', () => {
    const camera = new Camera();
    /* Yawed a quarter turn: the camera looks down +X once its -Z has swung round. */
    camera.adoptView(viewFrom([0, 0, 0], Math.PI / 2, 0), mat4.create());

    expect(camera.forward[0]).toBeCloseTo(-1, 5);
    expect(camera.forward[1]).toBeCloseTo(0, 5);
    expect(camera.forward[2]).toBeCloseTo(0, 5);
    expect(vec3.length(camera.forward)).toBeCloseTo(1, 6);
  });

  /**
   * **A rolled pose, which is the one no Euler pair this class holds can describe.** `forward` must
   * still come out right, because it is read from the matrix rather than rebuilt from angles.
   */
  it('recovers a direction from a pose carrying roll', () => {
    const camera = new Camera();
    camera.adoptView(viewFrom([1, 2, 3], 0.4, 0.9), mat4.create());

    const expected = vec3.create();
    const world = mat4.create();
    mat4.translate(world, world, [1, 2, 3]);
    mat4.rotateY(world, world, 0.4);
    mat4.rotateZ(world, world, 0.9);
    vec3.transformMat4(expected, [0, 0, -1], world);
    vec3.subtract(expected, expected, [1, 2, 3]);

    expect(camera.forward[0]).toBeCloseTo(expected[0], 5);
    expect(camera.forward[1]).toBeCloseTo(expected[1], 5);
    expect(camera.forward[2]).toBeCloseTo(expected[2], 5);
  });

  /**
   * The angles are left alone on purpose, and this asserts the decision rather than the absence.
   * A supplied rotation may be one no Euler triple describes without a convention this class does
   * not own, so `forward` is the answer to where the camera looks and `yaw` is the last thing
   * somebody set.
   */
  it('leaves yaw, pitch and roll untouched', () => {
    const camera = new Camera();
    camera.yaw = 0.25;
    camera.pitch = -0.5;
    camera.roll = 0.125;
    camera.adoptView(viewFrom([0, 0, 0], Math.PI / 2, 0), mat4.create());

    expect(camera.yaw).toBe(0.25);
    expect(camera.pitch).toBe(-0.5);
    expect(camera.roll).toBe(0.125);
  });

  /** Culling, picking and the sky all read these, so adopting has to leave them consistent. */
  it('derives the combined and inverse matrices from what it was given', () => {
    const camera = new Camera();
    const view = viewFrom([2, 1, 5], 0.3, 0);
    const projection = eyeProjection(-0.09, 0.11, -0.08, 0.08);
    camera.adoptView(view, projection);

    const expected = mat4.multiply(mat4.create(), projection, view);
    for (let i = 0; i < 16; i++) {
      expect(camera.viewProjection[i]).toBeCloseTo(expected[i] as number, 6);
    }

    const round = mat4.multiply(mat4.create(), camera.viewProjection, camera.invViewProjection);
    const identity = mat4.create();
    for (let i = 0; i < 16; i++) expect(round[i]).toBeCloseTo(identity[i] as number, 4);
  });

  /**
   * **The control.** Nothing above should have taught the camera to stop computing its own
   * matrices, so a plain `updateMatrices` after an adopt has to behave exactly as it always did.
   *
   * The two cameras are given the same *position* as well as the same angles, and the first draft
   * of this test did not: adopting a view moves the eye, which is the whole point of decomposing it
   * back out, so a control still standing at the origin was comparing two different cameras and
   * calling the difference a defect. `updateMatrices` derives from the camera's current state, and
   * after an adopt that state includes where the adopted view put it.
   */
  it('goes back to deriving its own matrices when asked to', () => {
    const adopted = new Camera();
    adopted.yaw = 0.4;
    adopted.pitch = 0.2;
    adopted.adoptView(viewFrom([9, 9, 9], 1.1, 0.3), eyeProjection(-0.09, 0.11, -0.08, 0.08));
    adopted.updateMatrices(1.5);

    const derived = new Camera();
    derived.yaw = 0.4;
    derived.pitch = 0.2;
    vec3.copy(derived.position, adopted.position);
    derived.updateMatrices(1.5);

    expect([...adopted.view]).toEqual([...derived.view]);
    expect([...adopted.projection]).toEqual([...derived.projection]);
    /* And the projection really did stop being the off-axis one it adopted. */
    expect(adopted.projection[8]).toBe(0);
  });

  it('allocates nothing, because it runs once per eye per frame', () => {
    const camera = new Camera();
    const view = viewFrom([1, 1, 1], 0.2, 0);
    const projection = eyeProjection(-0.09, 0.11, -0.08, 0.08);
    const position = camera.position;
    const forward = camera.forward;
    const combined = camera.viewProjection;

    for (let i = 0; i < 100; i++) camera.adoptView(view, projection);

    /* The same objects, still: a method handing back new arrays would break every consumer
       holding a reference to these across a frame. */
    expect(camera.position).toBe(position);
    expect(camera.forward).toBe(forward);
    expect(camera.viewProjection).toBe(combined);
  });
});
