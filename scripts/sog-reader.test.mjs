import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  SOG_VERSION,
  readSogMeta,
  readSogSource,
  unbundleSog,
} from '../packages/splats/src/splatSog.ts';

/**
 * The `.sog` reader, against a bundle PlayCanvas's own tool wrote from Gaussians this file chose.
 *
 * **Under `node --test` in `scripts/` rather than under vitest in the package**, because it reads
 * three files off disk and the engine's `tsconfig.json` sets `"types": []` — nothing under
 * a package's own `src` may name `node:fs`, which is the rule that keeps the shipped source free of
 * host assumptions. `test:scripts` picks this up; the reader itself is imported as TypeScript and
 * stripped, which works because it declares no enum and no parameter property.
 *
 * **There is no circle in this loop, and that is the whole design of the fixture.** `fixtures/`
 * carries the argument in full: the encoder is `@playcanvas/splat-transform`, the WebP decoder is
 * Pillow, and the expected values are the `.ply` those sixty-four Gaussians were written into. A
 * `.sog` invented here would agree with this reader by construction, which is what Track O refused
 * when it withdrew its mock capability providers.
 *
 * What is *not* checked here is WebP decoding, deliberately: `readSogSource` takes the decoder as a
 * parameter because Node has none and this engine will not vendor one, so the texels below come out
 * of the fixture and the browser's own decoder is exercised by `scripts/sog-check.mjs`.
 */
const FIXTURES = path.join(import.meta.dirname, '..', 'packages', 'splats', 'src', 'fixtures');

function bundle() {
  const file = readFileSync(path.join(FIXTURES, 'cloud.sog'));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

const truth = JSON.parse(readFileSync(path.join(FIXTURES, 'cloud.truth.json'), 'utf8'));

/** The five images as Pillow decoded them, keyed by the names the manifest uses. */
function texels() {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'cloud.texels.json'), 'utf8'));
  const out = new Map();
  for (const [name, image] of Object.entries(raw)) {
    out.set(name, {
      width: image.width,
      height: image.height,
      rgba: Uint8Array.from(Buffer.from(image.rgba, 'base64')),
    });
  }
  return out;
}

/** A decoder that answers from the fixture, keyed by the bytes `unbundleSog` handed it. */
function fixtureDecoder(files) {
  const images = texels();
  const names = new Map();
  for (const [name, bytes] of files) names.set(bytes, name);
  return async (bytes) => {
    const name = names.get(bytes);
    const image = name === undefined ? undefined : images.get(name);
    if (image === undefined) throw new Error(`no fixture texels for ${String(name)}`);
    return image;
  };
}

/* the bundle */
test('unpacks through the central directory, which is the only place the sizes are', async () => {
  /*
   * **The detail a reader gets wrong first.** `splat-transform` writes its entries streaming, so
   * bit 3 of the general-purpose flags is set: every local header carries a compressed size of
   * zero and the real sizes follow the payload in a data descriptor. A reader that trusted the
   * local header extracts nothing from every file that tool has ever produced, and this fixture
   * is one of them — measured flags `0x808`, sizes zero locally and correct in the directory.
   */
  const files = await unbundleSog(bundle());
  assert.deepEqual([...files.keys()].sort(), [
    'means_l.webp',
    'means_u.webp',
    'meta.json',
    'quats.webp',
    'scales.webp',
    'sh0.webp',
  ]);
  for (const [name, bytes] of files) {
    assert.ok(bytes.byteLength > 0, `${name} came back empty`);
  }
});

test('refuses something that is not a ZIP, rather than reading zero entries out of it', async () => {
  await assert.rejects(unbundleSog(new Uint8Array(64).buffer), /not a bundled/);
});

/* the manifest */
test('is version 2 and declares what the fixture holds', async () => {
  const files = await unbundleSog(bundle());
  const meta = readSogMeta(files.get('meta.json'));
  assert.equal(meta.version, SOG_VERSION);
  assert.equal(meta.count, truth.length);
  /* Both codebooks are 256 entries, which is what an 8-bit index into one can address. */
  assert.equal(meta.scales.codebook.length, 256);
  assert.equal(meta.sh0.codebook.length, 256);
  /* And the position bounds are in the **log domain**, not in metres: the fixture spans four
       metres in x and the manifest says 1.0986, which is log(1 + 2). Reading these as metres is a
       cloud squashed toward its own centre, which does not look like an error. */
  assert.ok(Math.abs(meta.means.maxs[0] - Math.log(1 + 2)) < 1e-6);
});

test('refuses a version it does not implement rather than guessing the encodings', () => {
  assert.throws(() => readSogMeta(JSON.stringify({ version: 3, count: 1 })), /version 3/);
});

/* every Gaussian survives the round trip */
test('recovers all sixty-four, one to one, within the quantiser', async () => {
  const files = await unbundleSog(bundle());
  const source = await readSogSource(files, fixtureDecoder(files));
  assert.equal(source.count, truth.length);

  /*
   * **Matched by nearest position rather than by index**, because the container is Spatially
   * Ordered Gaussians and its encoder is free to reorder: index `i` of the bundle is not index
   * `i` of the `.ply`, and asserting that it is would be asserting a property the format does
   * not have.
   */
  const matched = new Set();
  let worstPosition = 0;
  let worstScale = 0;
  let worstColour = 0;
  let worstOpacity = 0;
  let worstRotation = 0;

  for (let i = 0; i < source.count; i++) {
    const p = [
      source.positions[i * 3] ?? 0,
      source.positions[i * 3 + 1] ?? 0,
      source.positions[i * 3 + 2] ?? 0,
    ];
    let best = -1;
    let bestDistance = Infinity;
    truth.forEach((t, j) => {
      const d = Math.hypot(p[0] - t.x, p[1] - t.y, p[2] - t.z);
      if (d < bestDistance) {
        bestDistance = d;
        best = j;
      }
    });
    const t = truth[best];
    matched.add(best);
    worstPosition = Math.max(worstPosition, bestDistance);
    for (let k = 0; k < 3; k++) {
      worstScale = Math.max(
        worstScale,
        Math.abs((source.scales[i * 3 + k] ?? 0) - (t.scale[k] ?? 0)) / (t.scale[k] ?? 1),
      );
      worstColour = Math.max(
        worstColour,
        Math.abs((source.colors[i * 3 + k] ?? 0) - (t.colour[k] ?? 0)),
      );
    }
    worstOpacity = Math.max(worstOpacity, Math.abs((source.opacities[i] ?? 0) - t.opacity));
    /* xyzw out, wxyz in, and a quaternion is the same rotation as its negation — so the
         comparison is the angle between them rather than the components. */
    const q = [
      source.rotations[i * 4] ?? 0,
      source.rotations[i * 4 + 1] ?? 0,
      source.rotations[i * 4 + 2] ?? 0,
      source.rotations[i * 4 + 3] ?? 0,
    ];
    const w = [t.rotWxyz[1] ?? 0, t.rotWxyz[2] ?? 0, t.rotWxyz[3] ?? 0, t.rotWxyz[0] ?? 0];
    const dot = q[0] * w[0] + q[1] * w[1] + q[2] * w[2] + q[3] * w[3];
    worstRotation = Math.max(worstRotation, 1 - Math.abs(dot));
  }

  /* One to one: sixty-four distinct Gaussians, not one matched sixty-four times, which is what a
       reader that decoded a constant would produce and would otherwise pass every bound below. */
  assert.equal(matched.size, truth.length);

  /*
   * Every bound is the quantiser's own resolution rather than a number chosen to pass. Positions
   * are sixteen bits over a four-metre span in a log domain; scale and colour are 256-entry
   * codebooks; opacity is eight bits, so 1/255 is exactly one step and nothing can do better.
   */
  assert.ok(worstPosition < 1e-3, String(worstPosition));
  assert.ok(worstScale < 0.01, String(worstScale));
  assert.ok(worstColour < 0.005, String(worstColour));
  assert.ok(worstOpacity <= 1 / 255 + 1e-6, String(worstOpacity));
  assert.ok(worstRotation < 1e-3, String(worstRotation));
});

test('reads no spherical harmonics where the capture carries none', async () => {
  const files = await unbundleSog(bundle());
  const source = await readSogSource(files, fixtureDecoder(files));
  /* The fixture's `.ply` has no `f_rest_*`, so the encoder wrote no `shN` and the reader must
       not invent one — an empty band would be nine zero coefficients per splat and a silently
       larger upload. */
  assert.equal(source.sh1, undefined);
});

test('says which file is missing rather than decoding whatever is there', async () => {
  const files = await unbundleSog(bundle());
  const short = new Map(files);
  short.delete('quats.webp');
  await assert.rejects(readSogSource(short, fixtureDecoder(files)), /quats\.webp/);
});
