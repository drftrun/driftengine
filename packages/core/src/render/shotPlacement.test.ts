import { expect, test } from 'vitest';
import { createShotPlacement, placeShot } from './shotPlacement.ts';
import type { ShotParams, SubjectPose } from './shotPlacement.ts';

const STATION: readonly number[] = [0, 0, 0];

/**
 * Half-angle between the camera's aim and the subject, degrees.
 *
 * The honest test of "is the subject in shot": build the view direction the placement
 * asks for, and measure the subject against it. Comparing positions cannot answer it,
 * because a shot is a *look* as much as a place.
 */
function offAxisDeg(shot: ShotParams, pose: SubjectPose, ageSec = 0): number {
  const out = createShotPlacement();
  placeShot(shot, pose, ageSec, STATION, out);
  const ax = out.lookX - out.wantX;
  const ay = out.lookY - out.wantY;
  const az = out.lookZ - out.wantZ;
  const bx = pose.x - out.wantX;
  const by = pose.y - out.wantY;
  const bz = pose.z - out.wantZ;
  const la = Math.hypot(ax, ay, az) || 1;
  const lb = Math.hypot(bx, by, bz) || 1;
  const cos = (ax * bx + ay * by + az * bz) / (la * lb);
  return (Math.acos(Math.min(Math.max(cos, -1), 1)) * 180) / Math.PI;
}

test('a lookAt shot keeps its subject in frame all the way past the anchor', () => {
  /*
   * The bug this exists for: a `lookAt` aimed at its anchor and nothing else. An anchor is
   * a place the subject arrives at and then *leaves* — a grapple ring — so for the second
   * half of every such shot the subject was outside the frame entirely, for as long as the
   * cut lasted. Reported from a replay: the framing loses the subject entirely, who
   * becomes effectively invisible because the camera stops following them in that phase.
   *
   * Swept along the whole flight rather than sampled at one pose, because the failure was
   * phase-dependent: approach framed correctly and only the departure was broken.
   */
  const shot: ShotParams = {
    kind: 'lookAt',
    distance: 6,
    height: 2,
    fovDeg: 70,
    anchor: [0, 5, 0],
  };
  /*
   * Flying *along the subject's own heading*, which at yaw 0 is toward -Z (this engine's
   * convention), through the ring at the origin: well before it, through it, and well past.
   * Getting that backwards was the first version of this test, and it failed for a reason
   * that had nothing to do with the shot.
   */
  for (let z = 30; z >= -30; z -= 1) {
    const pose: SubjectPose = { x: 0, y: 4, z, yaw: 0 };
    // Inside the half-angle of a 70° frame, with margin for the vertical axis being
    // narrower than the horizontal one on any real aspect ratio.
    expect(offAxisDeg(shot, pose), `subject at z=${z} is out of shot`).toBeLessThan(28);
  }
});

test('a lookAt shot still frames its anchor while the subject is arriving', () => {
  // The other half of the contract. Handing the frame to the subject must not cost the
  // anchor the shot exists to show — on approach it is the anchor that owns the frame.
  const shot: ShotParams = {
    kind: 'lookAt',
    distance: 6,
    height: 2,
    fovDeg: 70,
    anchor: [0, 5, 0],
  };
  const out = createShotPlacement();
  const pose: SubjectPose = { x: 0, y: 4, z: 4, yaw: 0 };
  placeShot(shot, pose, 0, STATION, out);

  // The aim stays nearer the ring than the character while the character is still short of it.
  const toAnchor = Math.hypot(out.lookX - 0, out.lookY - 5, out.lookZ - 0);
  const toSubject = Math.hypot(out.lookX - pose.x, out.lookY - pose.y, out.lookZ - pose.z);
  expect(toAnchor).toBeLessThan(toSubject);
});

test('a lookAt shot with no anchor simply frames its subject', () => {
  // A caller that gives no anchor must not get an aim at the world origin.
  const shot: ShotParams = { kind: 'lookAt', distance: 6, height: 2, fovDeg: 70 };
  const pose: SubjectPose = { x: 12, y: 30, z: -40, yaw: 1 };
  const out = createShotPlacement();
  placeShot(shot, pose, 0, STATION, out);
  expect(out.lookX).toBe(pose.x);
  expect(out.lookY).toBe(pose.y);
  expect(out.lookZ).toBe(pose.z);
});
