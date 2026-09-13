import { expect, test } from 'vitest';
import { vec4 } from 'gl-matrix';
import { Camera } from '../render/camera.ts';
import {
  clipBitrate,
  clipFpsFor,
  exportAspect,
  exportSizeExact,
  exportSizeFor,
  isDuplicateFrame,
} from './exportTarget.ts';

/** Portrait first: it is the primary preset, and 16:9 is the alternative. */
const PORTRAIT = { width: 1080, height: 1920 } as const;
const LANDSCAPE = { width: 1920, height: 1080 } as const;

test('a healthy renderer exports exactly the preset it was given', () => {
  /*
   * The defect this guards is a clip that comes out at the window's size — which
   * is what happens when an exporter records the live canvas. The preset is the
   * whole promise: 1080x1920 on a laptop in a 900-pixel-tall window, and the
   * same on a phone held sideways.
   */
  for (const fps of [60, 45, 34.6]) {
    const size = exportSizeFor(PORTRAIT.width, PORTRAIT.height, fps, 30);
    expect(size).toEqual({ width: 1080, height: 1920, reduced: false });
  }
  // No measurement yet (the first export of a session) is not evidence of a
  // slow device, and must not silently halve the quality of every clip.
  expect(exportSizeFor(1920, 1080, 0, 30)).toEqual({
    width: 1920,
    height: 1080,
    reduced: false,
  });
});

test('a renderer that cannot hold the rate exports smaller, at the same shape', () => {
  /*
   * The alternative is a clip at full size that judders, which is worse than a
   * slightly softer one that does not — nobody watching a phone video has ever
   * complained about 720 lines, and everybody notices a stutter.
   *
   * The aspect has to survive the reduction exactly, or the fallback quietly
   * becomes the crop bug it was built to avoid.
   */
  const size = exportSizeFor(PORTRAIT.width, PORTRAIT.height, 24, 30);
  expect(size).toEqual({ width: 720, height: 1280, reduced: true });
  expect(exportAspect(size.width, size.height)).toBeCloseTo(
    exportAspect(PORTRAIT.width, PORTRAIT.height),
    12,
  );

  // Even on both sides: an odd dimension is rejected or silently padded by the
  // H.264 encoders in the share path.
  const odd = exportSizeFor(1081, 1921, 10, 30);
  expect(odd.width % 2).toBe(0);
  expect(odd.height % 2).toBe(0);
});

test('no phone can earn the full frame from the real-time gate', () => {
  /*
   * The measurement that sent every mobile clip to 720x1280, expressed as the
   * arithmetic rather than as a story. The gate compares a *scaled* estimate —
   * `measuredFps × windowPixels / exportPixels` — against `targetFps × 1.15`, so
   * at the 60 fps a phone's vsync caps it to, clearing the bar needs a drawing
   * buffer of 2.38 Mpx. A phone's is about 1.5.
   *
   * This test does not argue that the gate is wrong. It is right for the recorder,
   * which is racing a wall clock. It exists so that nobody re-reads the branch and
   * concludes the reduction was a slow-device path rather than the *only* path a
   * handheld device has ever taken.
   */
  const PHONE_PIXELS = 824 * 1830; // ~412x915 CSS at the DPR-2 cap: 1.51 Mpx.
  const phone = exportSizeFor(PORTRAIT.width, PORTRAIT.height, 60, 60, PHONE_PIXELS);
  expect(phone).toEqual({ width: 720, height: 1280, reduced: true });

  // And a desktop window big enough to clear it, so the comparison is a real one
  // and not an assertion that the gate rejects everything.
  const DESKTOP_PIXELS = 2560 * 1440;
  const desktop = exportSizeFor(PORTRAIT.width, PORTRAIT.height, 60, 60, DESKTOP_PIXELS);
  expect(desktop.reduced).toBe(false);
});

test('an offline encode takes the size it asked for, whatever the device', () => {
  /*
   * The offline path has no clock to lose to: frames are stamped by index, so a
   * slow device buys a longer wait and never a worse file. `exportSizeExact` is
   * how it says so — and the phone measurement above is exactly the input that
   * must *not* change the answer here.
   */
  const PHONE_PIXELS = 824 * 1830;
  expect(exportSizeExact(PORTRAIT.width, PORTRAIT.height)).toEqual({
    width: 1080,
    height: 1920,
    reduced: false,
  });
  // The same inputs that reduce under the real-time gate, side by side, because
  // the two functions differing on them is the entire point of there being two.
  expect(exportSizeFor(PORTRAIT.width, PORTRAIT.height, 60, 60, PHONE_PIXELS).reduced).toBe(true);

  // Still even, for the same encoders.
  const odd = exportSizeExact(1081, 1921);
  expect(odd.width % 2).toBe(0);
  expect(odd.height % 2).toBe(0);
});

test('bitrate follows the pixel count instead of being a constant', () => {
  /*
   * 8 Mbit/s was the original figure and it is two different mistakes at once:
   * generous at 720p, thin at 1080x1920. Thin bitrate on high-motion footage
   * reads as stutter rather than as softness, which is why this sits in the
   * judder fix rather than in a quality setting.
   */
  const small = clipBitrate(720, 1280, 30);
  const large = clipBitrate(1080, 1920, 30);
  expect(large).toBeGreaterThan(small);
  // 1080x1920 at 30 has 2.25x the pixels of 720x1280, so the bitrate follows.
  expect(large / small).toBeCloseTo(2.25, 2);
  // Doubling the frame rate doubles the throughput needed.
  expect(clipBitrate(1080, 1920, 60)).toBeCloseTo(large * 2, 0);
  // Bounded, so a tiny frame still gets a usable file and a huge one does not
  // produce an upload nobody waits for.
  expect(clipBitrate(64, 64, 30)).toBe(2_500_000);
  expect(clipBitrate(3840, 2160, 60)).toBe(24_000_000);
});

test('a subject the director centres is in frame in both presets', () => {
  /*
   * The crop bug wearing a different hat. Vertical FOV is what a camera holds
   * fixed, so changing the aspect changes the *horizontal* field: a shot framed
   * on a 16:9 screen has 3.2x the lateral room of the same shot at 9:16. A
   * director tuned against the wide preset can therefore compose a shot that
   * puts the character outside a vertical frame entirely, and nothing about the
   * code that placed the camera would look wrong.
   *
   * The offset here is generous on purpose: 1.5 m is a character sliding sideways
   * across a chase shot, which is exactly the moment worth watching.
   */
  const LATERAL = 1.5;
  const DISTANCE = 6;
  const point = vec4.create();

  for (const preset of [PORTRAIT, LANDSCAPE]) {
    const camera = new Camera();
    camera.fovYDeg = 70;
    camera.position[0] = 0;
    camera.position[1] = 0;
    camera.position[2] = 0;
    camera.yaw = 0;
    camera.pitch = 0;
    camera.updateMatrices(exportAspect(preset.width, preset.height));

    vec4.set(point, LATERAL, 0, -DISTANCE, 1);
    vec4.transformMat4(point, point, camera.viewProjection);
    const ndcX = (point[0] ?? 0) / (point[3] ?? 1);

    /*
     * Hand-derived: at 70° vertical FOV the half-height at 6 m is
     * 6·tan(35°) = 4.20 m, so the half-width at 9:16 is 4.20 × 0.5625 = 2.36 m
     * and 1.5 m of offset is 0.63 of the way to the edge. Inside 0.8 leaves a
     * tenth of the frame as margin on each side, which is what stops a mark or a
     * platform UI element from covering the subject.
     */
    expect(Math.abs(ndcX), `${preset.width}x${preset.height}`).toBeLessThan(0.8);
  }
});

test('the clip rate climbs the ladder only as far as the display allows', () => {
  /*
   * The pacer takes every n-th animation frame, so a clip can never be faster than
   * the game is drawn. A 60 Hz panel asked for 120 would write a file claiming a rate
   * it does not hold, which is the exact lie the frame schedule exists to prevent.
   */
  const pixels = 1080 * 1920;
  // A 120 Hz machine with room to spare records at its own rate, not at a tidier one.
  expect(clipFpsFor(1080, 1920, 120, pixels * 3)).toBe(120);
  // The same headroom on a 60 Hz panel cannot buy 120, however fast the machine is.
  expect(clipFpsFor(1080, 1920, 60, pixels * 3)).toBe(60);
  // And an unusual panel takes its own rung rather than being rounded down to 120.
  expect(clipFpsFor(1080, 1920, 165, pixels * 3), '165 Hz records 165').toBe(165);
});

test('the rate falls a rung at a time rather than to the floor', () => {
  // 120 if it can, else 60, else 30 — one rung at a time. A machine that clears 60
  // keeps 60.
  const pixels = 1080 * 1920;
  // 120 Hz with no headroom at export size drops one rung, not to the floor.
  expect(clipFpsFor(1080, 1920, 120, pixels), 'one rung down from 120').toBe(90);
  expect(clipFpsFor(1080, 1920, 40, pixels * 1.2), 'clears 30 and not 60').toBe(30);
});

test('a device with no measurement takes the lowest rung, not the highest', () => {
  // An export that guesses high on an unmeasured device drops frames on the one
  // machine least able to spare them.
  expect(clipFpsFor(1080, 1920, 0)).toBe(30);
  expect(clipFpsFor(1080, 1920, Number.NaN)).toBe(30);
});

test('a frame is a duplicate only once something has actually repeated', () => {
  /*
   * The defect this exists to catch, stated as the two ways it could go wrong. `ExportTarget`
   * itself needs a `<canvas>` and this suite runs in `node` (see `vitest.config.ts`), so this is
   * `compose()`'s comparison held to account on its own — `isDuplicateFrame` is the whole of
   * what decides `ExportTarget.duplicateFrame`, with nothing else between it and a renderer's
   * `presentedFrames`.
   */

  // The renderer's own count starts at 0 and nothing has been composed yet: a bare `0 === 0`
  // check would call the very first frame a repeat of a frame that never happened.
  expect(isDuplicateFrame(null, 0)).toBe(false);

  // Two composes back to back with no frame presented in between: this is the export bug a
  // consumer reported verbatim, and it is what a `false` here would fail to catch.
  expect(isDuplicateFrame(3, 3)).toBe(true);

  // The count moved, so a new picture landed on the canvas since the last compose.
  expect(isDuplicateFrame(3, 4)).toBe(false);
});

test('the export size is what the rate is judged against, not the window', () => {
  /*
   * The same failure `exportSizeFor` documents: a machine holding a comfortable rate
   * in a small window is not holding it at 1080x1920, which is three times the pixels.
   */
  const measuredAt = 1200 * 700;
  // 240 in a small window: plenty of headroom until the frame is three times larger.
  const trusting = clipFpsFor(1080, 1920, 240, 0);
  const scaled = clipFpsFor(1080, 1920, 240, measuredAt);
  expect(trusting, 'trusting the raw number is optimistic').toBeGreaterThan(120);
  expect(scaled, 'scaled to the export size').toBeLessThan(trusting);
});
