import { expect, test } from 'vitest';
import { ColliderSet } from '@driftengine/physics';
import { aabbFromCenter } from '@driftengine/physics';
import { CinematicCamera } from './cinematicCamera.ts';
import type { ShotParams } from './cinematicCamera.ts';

const EMPTY = new ColliderSet([]);

function shot(over: Partial<ShotParams> = {}): ShotParams {
  return { kind: 'chase', distance: 6, height: 2, fovDeg: 70, ...over };
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  );
}

test('a cut is instant, and everything between cuts is smooth', () => {
  /*
   * Both halves matter and they pull against each other. A cut that eases is
   * not a cut, it is a swoop, and it destroys the sync with the beat the whole
   * edit is built on. But motion *within* a shot must never step, or the
   * footage judders at exactly the moment somebody is watching it frame by
   * frame.
   */
  const cam = new CinematicCamera(EMPTY);
  cam.cut(shot(), 0);
  cam.update(1 / 60, 0, 0, 0, 0);
  const opening = [...cam.camera.position];

  cam.cut(shot({ kind: 'overhead', distance: 14, height: 12, fovDeg: 55 }), 1);
  cam.update(1 / 60, 0, 0, 0, 0);
  expect(distance(opening, [...cam.camera.position]), 'a cut jumps').toBeGreaterThan(5);

  const settled = [...cam.camera.position];
  cam.update(1 / 60, 0.12, 0, 0, 0);
  expect(distance(settled, [...cam.camera.position]), 'within a shot it glides').toBeLessThan(0.6);
});

test('every shot keeps the subject in frame', () => {
  /*
   * The one thing a director camera cannot do is lose the character. Each shot
   * places the camera differently, and it is easy to get a sign wrong in one of
   * them and end up filming the sky — which looks like an engine bug rather
   * than a framing mistake, and only in that one shot.
   *
   * Stated as: the subject is inside the horizontal field of view.
   */
  const kinds = ['chase', 'lowWide', 'orbit', 'flyby', 'overhead'] as const;
  for (const kind of kinds) {
    const cam = new CinematicCamera(EMPTY);
    cam.cut(shot({ kind, anchor: [30, 4, 6] }), 0);
    for (let i = 0; i < 120; i++) cam.update(1 / 60, 22 + i * 0.05, 3, 4, 0.4);

    const pos = cam.camera.position;
    const toSubject = [22 + 119 * 0.05 - (pos[0] ?? 0), 3 - (pos[1] ?? 0), 4 - (pos[2] ?? 0)];
    const length = Math.hypot(...toSubject) || 1;

    const cosPitch = Math.cos(cam.camera.pitch);
    const forward = [
      Math.sin(cam.camera.yaw) * cosPitch,
      Math.sin(cam.camera.pitch),
      -Math.cos(cam.camera.yaw) * cosPitch,
    ];
    const alignment =
      ((toSubject[0] ?? 0) * (forward[0] ?? 0) +
        (toSubject[1] ?? 0) * (forward[1] ?? 0) +
        (toSubject[2] ?? 0) * (forward[2] ?? 0)) /
      length;

    // cos(35°): comfortably inside a 70° vertical FOV even at 16:9.
    expect(alignment, `${kind} is looking at the character`).toBeGreaterThan(0.82);
  }
});

test('a shot never puts the camera inside the world', () => {
  /*
   * A replay camera clipping through an island is the single artefact that
   * reads as broken immediately — not as a bad angle, as a bug. The boom
   * shortens against real geometry, the same way the gameplay camera does.
   */
  const wall = new ColliderSet([aabbFromCenter(0, 3, 6, 20, 6, 1)]);
  const cam = new CinematicCamera(wall);
  // Behind the character is straight into the wall.
  cam.cut(shot({ distance: 12 }), 0);
  for (let i = 0; i < 60; i++) cam.update(1 / 60, 0, 1, 0, 0);

  const pos = cam.camera.position;
  expect(pos[2] ?? 0, 'pulled in short of the wall').toBeLessThan(5.6);
});

test('geometry crossing the boom retracts it without teleporting the camera', () => {
  /*
   * The bug behind *"it shutters and its jumpy"*, measured: 196 single-frame
   * camera jumps over half a metre in a 40 s clip, the worst of them 8.3 m — and
   * not one of them on a cut. The boom fraction came straight from `segmentHit`
   * and was applied after the smoothing, so a lamp post drifting through the line
   * between camera and character moved the camera 8 m and back within three frames.
   *
   * A post is the honest case rather than a wall: it blocks the boom for a
   * moment and then stops, which is what the route is full of.
   */
  const post = new ColliderSet([aabbFromCenter(0, 3, 6, 0.4, 6, 0.4)]);
  const cam = new CinematicCamera(post);
  cam.cut(shot({ distance: 12 }), 0);

  // Settle with the boom clear of the post, off to one side.
  for (let i = 0; i < 60; i++) cam.update(1 / 60, 4, 1, 0, 0);

  let worst = 0;
  let previous = [...cam.camera.position];
  // Walk the character sideways so the post sweeps across the boom and off again.
  for (let i = 0; i < 120; i++) {
    cam.update(1 / 60, 4 - i * 0.07, 1, 0, 0);
    const now = [...cam.camera.position];
    worst = Math.max(worst, distance(previous, now));
    previous = now;
  }

  expect(worst, 'worst single-frame move while the post crosses the boom').toBeLessThan(0.35);
});

test('a subject that teleports gets a new shot, not a 124-metre pan', () => {
  /*
   * A character who dies is put back on a checkpoint, and the camera used to *fly*
   * there: measured at 124 m of travel inside one shot, taking about a second, at
   * 12.95 s into a clip whose character had died. From the viewer's side the camera
   * left the run and went sightseeing.
   *
   * `snap` is the answer rather than a distance threshold inside the camera,
   * because only the caller can tell a teleport from a fast frame — a clip
   * catching up after a freeze legitimately advances several ticks at once. The
   * shot is kept: what is dropped is the smoothing history that was pulling the
   * rig back to where the character used to be.
   */
  const cam = new CinematicCamera(EMPTY);
  cam.cut(shot({ distance: 8 }), 0);
  for (let i = 0; i < 60; i++) cam.update(1 / 60, 0, 1, 0, 0);

  cam.snap();
  cam.update(1 / 60, 120, 1, 40, 0);
  const toCharacter = (): number =>
    Math.hypot(
      120 - (cam.camera.position[0] ?? 0),
      1 - (cam.camera.position[1] ?? 0),
      40 - (cam.camera.position[2] ?? 0),
    );
  // Framed from the shot's own distance, immediately — not somewhere between the
  // two positions.
  expect(toCharacter(), 'framed the character where they now are').toBeLessThan(9);

  /*
   * And it stays framed. This is the half that separates a snap from a cut: the
   * rig rides along at the speed its target is travelling, and across a teleport
   * that speed is a fiction — 126 m in one frame. A rig that inherited it would
   * hold the first frame and then coast off after the character's ghost, which is
   * the same 124 m of sightseeing arriving one frame later.
   */
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    cam.update(1 / 60, 120, 1, 40, 0);
    worst = Math.max(worst, toCharacter());
  }
  // The worst frame, not the last one: an inherited velocity coasts out and comes
  // back, so a check at the end of the second would find it already settled.
  expect(worst, 'and it stays framed for the whole second after').toBeLessThan(9);
});

test('an orbit goes round, and a flyby stays put', () => {
  // The two shots whose whole character is their motion. An orbit that does not
  // move is a bad chase cam; a flyby that follows is just a chase cam.
  const orbit = new CinematicCamera(EMPTY);
  orbit.cut(shot({ kind: 'orbit', orbitRate: 1.2 }), 0);
  orbit.update(1 / 60, 0, 1, 0, 0);
  const orbitStart = [...orbit.camera.position];
  for (let i = 0; i < 60; i++) orbit.update(1 / 60, 0, 1, 0, 0);
  expect(distance(orbitStart, [...orbit.camera.position])).toBeGreaterThan(2);

  const flyby = new CinematicCamera(EMPTY);
  flyby.cut(shot({ kind: 'flyby' }), 0);
  flyby.update(1 / 60, 0, 1, 0, 0);
  const station = [...flyby.camera.position];
  for (let i = 0; i < 60; i++) flyby.update(1 / 60, i * 0.2, 1, 0, 0);
  expect(distance(station, [...flyby.camera.position]), 'the station holds').toBeLessThan(0.5);
});

test('a lookAt shot leans toward its anchor without losing the character', () => {
  /*
   * How the grapple shot works: the camera holds on the ring while the character flies at it.
   * Pointing flatly at the character instead loses the thing the shot exists to show, so it
   * must tilt toward a high anchor.
   *
   * It used to aim at the anchor *exactly*, however far away it was, and this test asserted
   * that with a fixture 19 m over the subject's head — a pitch steep enough that the character
   * was nowhere near frame. Real rings hang about 5.9 m above the deck, so the exaggeration
   * hid the cost rather than measuring it: past the ring, the character was simply out of shot.
   * It was reported as a replay losing the subject's framing entirely — the character
   * effectively invisible for that stretch of the shot.
   *
   * The pull toward an anchor is now bounded by the shot's own camera distance
   * (`LOOK_AT_ANCHOR_PULL`), so the assertion is the shape of the behaviour rather than a
   * number that only an unreal anchor can reach: it tilts up, and the character stays framed.
   */
  const cam = new CinematicCamera(EMPTY);
  cam.cut(shot({ kind: 'lookAt', anchor: [0, 20, 0] }), 0);
  for (let i = 0; i < 120; i++) cam.update(1 / 60, 0, 1, 0, 0);
  expect(cam.camera.pitch, 'did not tilt toward a high anchor').toBeGreaterThan(0.1);

  /*
   * And the character is inside the frame the shot asked for — half of 70°, with margin.
   *
   * Forward is built from yaw and pitch rather than read off `camera.forward`, which only
   * `updateMatrices` writes and nothing here calls: reading it gives the zero vector and an
   * off-axis angle of exactly 90° for every input, which passes for a real measurement.
   */
  const cx = cam.camera.position[0] ?? 0;
  const cy = cam.camera.position[1] ?? 0;
  const cz = cam.camera.position[2] ?? 0;
  const toCharacter = [0 - cx, 1 - cy, 0 - cz];
  const cosPitch = Math.cos(cam.camera.pitch);
  const fwd = [
    Math.sin(cam.camera.yaw) * cosPitch,
    Math.sin(cam.camera.pitch),
    -Math.cos(cam.camera.yaw) * cosPitch,
  ];
  const alignment =
    ((toCharacter[0] ?? 0) * (fwd[0] ?? 0) +
      (toCharacter[1] ?? 0) * (fwd[1] ?? 0) +
      (toCharacter[2] ?? 0) * (fwd[2] ?? 0)) /
    (Math.hypot(...toCharacter) || 1);
  const offAxisDeg = (Math.acos(Math.min(Math.max(alignment, -1), 1)) * 180) / Math.PI;
  expect(offAxisDeg, 'the character is out of shot').toBeLessThan(30);
});

test('a shot holds its framing while the character is at speed, and a cut starts no slide', () => {
  /*
   * The bug behind *"the transitions between them that it's like straight"*,
   * measured.
   *
   * A first-order lag can only produce a correction proportional to the error it
   * has already accumulated, so to travel at the subject's speed it must first
   * *build* an error of `speed / lambda` metres and then hold it. At 14 m/s and
   * `FOLLOW_LAMBDA = 6` that is 2.33 m: a shot asking for a 7 m boom was measured
   * sitting at **9.219 m**, every shot framed a third further out than it asked.
   *
   * A cut snaps the rig onto the placement it asked for — correctly, that is the
   * cut — and from that instant the lag rebuilds the same error: measured
   * 7.000 → 7.731 → 8.317 → 8.887 → 9.213 over the second after the cut, at a
   * drift that peaks on frame 2 at 12.67 m/s and decays monotonically. A straight
   * slide away from the character, on every cut, in every mode.
   *
   * Stated as the thing that must be true whatever the lambdas are retuned to: a
   * rig riding along with a subject at constant speed holds the framing it was
   * given, both in steady state and across the cut that placed it.
   */
  const cam = new CinematicCamera(EMPTY);
  const SPEED = 14;
  let z = 0;
  const step = (): void => {
    z -= SPEED / 60;
    cam.update(1 / 60, 0, 1, z, 0);
  };
  // `chase` at yaw 0 places the camera exactly `distance` behind on +Z.
  const boom = (): number =>
    Math.hypot(0 - (cam.camera.position[0] ?? 0), z - (cam.camera.position[2] ?? 0));

  cam.cut(shot({ distance: 7 }), 0);
  for (let i = 0; i < 240; i++) step();
  expect(boom(), 'a held shot keeps the 7 m it asked for').toBeCloseTo(7, 0);

  // A cut re-places the rig; the second after it must not be a slide. (This is
  // also what a scrub does — `seek` re-applies the shot and snaps.)
  cam.cut(shot({ distance: 7 }), 4);
  let worst = 0;
  for (let f = 0; f < 90; f++) {
    step();
    worst = Math.max(worst, Math.abs(boom() - 7));
  }
  expect(worst, 'worst framing error in the second after a cut').toBeLessThan(0.5);
});

test('an orbit starts from rest and comes to rest, having swept its whole arc', () => {
  /*
   * The other half of the same report, and the only shot with motion of its own:
   * every other kind was measured travelling exactly 0.000 m over two seconds
   * with a still character, while `orbit` travelled 7.067 m.
   *
   * It travelled it at a dead constant speed — 3.820, 3.822, 3.823, 3.824, 3.825,
   * 3.826 m/s across frames 55 to 60 — because the angle is `shotAge x rate`. So
   * it began abruptly, held one speed, and was *still at full speed* at the
   * instant the shot was cut away from. A dolly on rails rather than an operator.
   *
   * The arc it covers is a composition decision and must survive the ease: rate
   * times hold, 0.55 x 4 = 2.2 rad, is still what gets swept.
   */
  const cam = new CinematicCamera(EMPTY);
  const RATE = 0.55;
  const HOLD = 4;
  cam.cut(shot({ kind: 'orbit', distance: 8, orbitRate: RATE, holdSec: HOLD }), 0);

  const bearing = (): number =>
    Math.atan2(cam.camera.position[0] ?? 0, cam.camera.position[2] ?? 0);
  const speeds: number[] = [];
  let previous: readonly number[] | null = null;
  let unwrapped = 0;
  let lastBearing = 0;
  cam.update(1 / 60, 0, 1, 0, 0);
  previous = [...cam.camera.position];
  lastBearing = bearing();

  for (let f = 0; f < HOLD * 60; f++) {
    cam.update(1 / 60, 0, 1, 0, 0);
    const now = [...cam.camera.position];
    speeds.push(distance(previous ?? now, now) * 60);
    previous = now;
    const b = bearing();
    let d = b - lastBearing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    unwrapped += d;
    lastBearing = b;
  }

  const peak = Math.max(...speeds);
  expect(speeds[0] ?? 0, 'the first frame is nearly still').toBeLessThan(peak * 0.25);
  expect(speeds[speeds.length - 1] ?? 0, 'and so is the last').toBeLessThan(peak * 0.25);
  // 0.55 rad/s across a 4 s hold, whatever shape the ease gives it.
  expect(Math.abs(unwrapped), 'the whole arc is still swept').toBeCloseTo(RATE * HOLD, 1);
});

test('the camera survives absurd parameters instead of producing NaN', () => {
  // Shots come from a director working off measured data, and a zero-length run
  // or a degenerate anchor must not put NaN into a view matrix — where it
  // silently blanks the whole frame rather than raising anything.
  const cam = new CinematicCamera(EMPTY);
  for (const bad of [
    shot({ distance: 0, height: 0, fovDeg: 0 }),
    shot({ kind: 'orbit', distance: -5, orbitRate: 1e9 }),
    shot({ kind: 'lookAt', anchor: [0, 0, 0] }),
  ]) {
    cam.cut(bad, 0);
    cam.update(1 / 60, 0, 0, 0, 0);
    for (const v of cam.camera.position) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(cam.camera.yaw)).toBe(true);
    expect(Number.isFinite(cam.camera.pitch)).toBe(true);
    expect(cam.camera.fovYDeg).toBeGreaterThan(0);
  }
});
