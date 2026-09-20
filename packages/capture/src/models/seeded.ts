/**
 * A miniature checkpoint's values, drawn from a seed and a tensor's name, so each tensor depends on
 * its name and never on the order the tensors were made in.
 */
import { mulberry32 } from '@driftengine/core';

/* FNV-1a over a name, so each tensor's values depend on its name and not on the order made. */
export function nameSeed(name: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < name.length; i += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The spread a tensor's values are drawn with, by what the name says it is: a norm's scale near
 * one, a layer scale near a half, a bias small, and a weight at 1.7/√fan-in. At 1/√fan-in the
 * head's twenty convolutions shrank the signal until the depth was its biases — 1.08 to 1.11
 * everywhere, and a slip in a norm's ε moved nothing a test could see; at He's √(6/fan-in) the
 * fusion's residual sums compounded it to depths of 10^33. At 1.7 the depth spans 0.96 to 11.7.
 *
 * **A one-dimensional weight is a norm's scale** in every checkpoint here, whatever its name — a
 * channel norm is often a bare index in a sequence — and is drawn near one.
 *
 * **A batch norm's statistics are drawn as statistics**: a running variance between a half and one
 * and a half, so the scale folded from it stays near one, and a running mean small. Drawn as any
 * other vector, a variance near zero would fold into a scale of hundreds.
 */
export function draw(name: string, shape: readonly number[], seed: number): Float32Array {
  const next = mulberry32(nameSeed(name, seed));
  const count = shape.reduce((total, d) => total * d, 1);
  const fanIn = shape.slice(1).reduce((total, d) => total * d, 1);
  const norm = (/norm|\.bn\./.test(name) || shape.length === 1) && name.endsWith('.weight');
  const gamma = name.endsWith('.gamma') || name.endsWith('.lambda1');
  const variance = name.endsWith('.running_var');
  const centre = norm || variance ? 1 : gamma ? 0.5 : 0;
  const spread = norm
    ? 0.1
    : gamma
      ? 0.2
      : variance
        ? 0.5
        : name.endsWith('.bias') || name.endsWith('.running_mean')
          ? 0.1
          : shape.length >= 2 && name.endsWith('.weight')
            ? 1.7 / Math.sqrt(fanIn)
            : 0.5;
  return Float32Array.from({ length: count }, () => centre + (next() * 2 - 1) * spread);
}
