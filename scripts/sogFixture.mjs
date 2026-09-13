#!/usr/bin/env node
/**
 * Write the `.ply` that `packages/splats/src/fixtures/cloud.sog` was encoded from.
 *
 * **Run by hand, and the fixture beside it is what is committed.** The point of the chain is that
 * the encoder is somebody else's: this writes a `.ply` with values chosen to be distinguishable,
 * `@playcanvas/splat-transform` turns it into a real bundle, and the reader is checked against the
 * values that went in. See that directory's README for the whole loop and why it has no circle in
 * it.
 *
 *     node scripts/sogFixture.mjs /tmp/cloud.ply /tmp/cloud.truth.json
 *     npx @playcanvas/splat-transform@3.3.3 /tmp/cloud.ply /tmp/cloud.sog
 */
import { writeFileSync } from 'node:fs';

/** Sixty-four: four rows of an eight-by-eight image, which is the smallest bundle worth reading. */
const COUNT = 64;
const SH_C0 = 0.28209479177387814;

const PROPERTIES = [
  'x',
  'y',
  'z',
  'nx',
  'ny',
  'nz',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
];

const ply = process.argv[2] ?? 'cloud.ply';
const truthFile = process.argv[3] ?? 'cloud.truth.json';

const body = new Float32Array(COUNT * PROPERTIES.length);
const truth = [];
for (let i = 0; i < COUNT; i++) {
  const t = i / (COUNT - 1);
  /* A curve rather than a grid: a grid is symmetric, and a reader that transposed an image would
     still recover a grid. */
  const x = -2 + 4 * t;
  const y = Math.sin(t * 6) * 1.5;
  const z = Math.cos(t * 4) * 2;
  /* Anisotropic and spread over an order of magnitude, so a codebook that collapsed would show. */
  const scale = [0.02 + 0.08 * t, 0.03 + 0.05 * t, 0.04 + 0.02 * t];
  const opacity = 0.15 + 0.8 * t;
  /* Turning through three radians about an axis with all three components distinct, so a
     smallest-three encoding drops a different component along the sequence. */
  const angle = t * 3;
  const raw = [
    Math.cos(angle / 2),
    Math.sin(angle / 2) * 0.6,
    Math.sin(angle / 2) * 0.48,
    Math.sin(angle / 2) * 0.64,
  ];
  const length = Math.hypot(...raw);
  const rotWxyz = raw.map((v) => v / length);
  const colour = [0.2 + 0.6 * t, 0.7 - 0.5 * t, 0.45];

  body.set(
    [
      x,
      y,
      z,
      0,
      0,
      1,
      /* Written as DC coefficients, which is what a training run stores and what the file means. */
      ...colour.map((c) => (c - 0.5) / SH_C0),
      /* The logit, and the logarithms: the encodings a `.ply` carries and this fixture must too. */
      Math.log(opacity / (1 - opacity)),
      ...scale.map(Math.log),
      ...rotWxyz,
    ],
    i * PROPERTIES.length,
  );
  truth.push({ x, y, z, scale, opacity, rotWxyz, colour });
}

const header =
  `ply\nformat binary_little_endian 1.0\nelement vertex ${COUNT}\n` +
  `${PROPERTIES.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
writeFileSync(ply, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)]));
writeFileSync(truthFile, JSON.stringify(truth, null, 0));
console.log(`wrote ${COUNT} Gaussians to ${ply} and their values to ${truthFile}`);
