import { expect, test } from 'vitest';
import { deliveryVerdict } from './frameDelivery.ts';

/**
 * What a decoded probe colour means, which is the whole decision the round trip makes.
 *
 * Every number here was read off a real decode. Magenta survives a round trip as roughly
 * `255, 0, 254` through 4:2:0 and a colour space conversion; an empty frame decodes to
 * `0, 77, 0` under BT.709 and `0, 135, 0` under BT.601, and both were produced on this machine
 * by turning on `chrome://flags#enable-vulkan` under Wayland and encoding the same canvas.
 */

test('both channels the probe painted came back', () => {
  /* Measured, Chrome 149 on an RX 9070 XT with the flag off. */
  expect(deliveryVerdict([255, 0, 254])).toBe('carries');
  /* Generous on purpose: the trip is lossy and a threshold tight enough to fail on chroma
     subsampling would refuse exports on a machine where nothing is wrong. */
  expect(deliveryVerdict([235, 0, 246])).toBe('carries');
  expect(deliveryVerdict([200, 40, 200])).toBe('carries');
});

test('an all-zero frame is green in either colour space, and neither is magenta', () => {
  /* Measured with the flag on, same page, same canvas: the encode reported success and the
     decode returned this. */
  expect(deliveryVerdict([0, 77, 0])).toBe('empty');
  /* The same zeroes read as BT.601, which a decoder may choose instead. */
  expect(deliveryVerdict([0, 135, 0])).toBe('empty');
});

test('anything else lets the export through', () => {
  /* Only a positive reading of an empty frame refuses anything. A probe that could not run
     costs nobody a clip; a probe that guesses wrong costs somebody every clip they were going
     to make on a machine that was working. */
  expect(deliveryVerdict(null)).toBe('unknown');
  expect(deliveryVerdict([100, 100, 100])).toBe('unknown');
  expect(deliveryVerdict([40, 90, 40])).toBe('unknown');
  /* Red without blue is not this fault, whatever else it is. */
  expect(deliveryVerdict([255, 0, 0])).toBe('unknown');
});
