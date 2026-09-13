/**
 * A `.sog` capture read end to end, with the browser's own WebP decoder in the loop.
 *
 * **The one part `scripts/sog-reader.test.mjs` cannot reach.** That test supplies texels a
 * different decoder produced, because Node has none and this engine will not vendor one — so
 * `browserWebpDecoder` itself, which is what every consumer actually calls, is untested code there.
 * This page is what runs it, and `scripts/sog-check.mjs` is what reads the answer off.
 *
 * The bundle is the committed fixture: sixty-four Gaussians this repository chose, encoded by
 * `@playcanvas/splat-transform`. So the numbers below are the round trip through somebody else's
 * encoder and this browser's decoder, against the values that went in.
 *
 * Nothing here is engine API and nothing under `src/` may import it.
 */

import cloudUrl from '../../packages/splats/src/fixtures/cloud.sog?url';
import reference from '../../packages/splats/src/fixtures/cloud.texels.json';
import truth from '../../packages/splats/src/fixtures/cloud.truth.json';
import { browserWebpDecoder, readSogSource, unbundleSog } from '../../packages/splats/src/index';

interface Truth {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: readonly number[];
  readonly opacity: number;
  readonly rotWxyz: readonly number[];
  readonly colour: readonly number[];
}

async function main(): Promise<void> {
  const out = document.getElementById('out') as HTMLElement;
  const bundle = await (await fetch(cloudUrl as string)).arrayBuffer();
  const files = await unbundleSog(bundle);
  const decode = browserWebpDecoder();

  /*
   * **The decoder against a reference decode of the same bytes, before anything is made of them.**
   *
   * This is the measurement that found what a 2d canvas does to these images, and it is the one
   * worth keeping: everything below reads texels through a dequantiser, so a decode that is a few
   * indices out arrives as a slightly wrong colour and looks like a codebook problem. Compared
   * texel for texel against what Pillow produced, it is a decoder problem and says so.
   */
  const texels = reference as Record<string, { width: number; height: number; rgba: string }>;
  let worstTexel = 0;
  let worstTexelIn = '';
  for (const [name, expected] of Object.entries(texels)) {
    const bytes = files.get(name);
    if (bytes === undefined) continue;
    const got = await decode(bytes);
    const want = Uint8Array.from(atob(expected.rgba), (c) => c.charCodeAt(0));
    let worst = 0;
    for (let i = 0; i < want.length; i++)
      worst = Math.max(worst, Math.abs((got.rgba[i] ?? 0) - (want[i] ?? 0)));
    if (worst > worstTexel) {
      worstTexel = worst;
      worstTexelIn = name;
    }
  }

  const source = await readSogSource(files, decode);
  const cloud = truth as unknown as Truth[];

  const worst = { position: 0, scale: 0, colour: 0, opacity: 0, rotation: 0 };
  const matched = new Set<number>();
  for (let i = 0; i < source.count; i++) {
    const p = [
      source.positions[i * 3] ?? 0,
      source.positions[i * 3 + 1] ?? 0,
      source.positions[i * 3 + 2] ?? 0,
    ];
    /* Nearest position, because the container is Spatially Ordered Gaussians and the encoder is
       free to reorder — index i of the bundle is not index i of the `.ply`. */
    let best = -1;
    let bestDistance = Infinity;
    cloud.forEach((t, j) => {
      const d = Math.hypot(p[0] - t.x, p[1] - t.y, p[2] - t.z);
      if (d < bestDistance) {
        bestDistance = d;
        best = j;
      }
    });
    const t = cloud[best] as Truth;
    matched.add(best);
    worst.position = Math.max(worst.position, bestDistance);
    for (let k = 0; k < 3; k++) {
      worst.scale = Math.max(
        worst.scale,
        Math.abs((source.scales[i * 3 + k] ?? 0) - (t.scale[k] ?? 0)) / (t.scale[k] ?? 1),
      );
      worst.colour = Math.max(
        worst.colour,
        Math.abs((source.colors[i * 3 + k] ?? 0) - (t.colour[k] ?? 0)),
      );
    }
    worst.opacity = Math.max(worst.opacity, Math.abs((source.opacities[i] ?? 0) - t.opacity));
    const q = [
      source.rotations[i * 4] ?? 0,
      source.rotations[i * 4 + 1] ?? 0,
      source.rotations[i * 4 + 2] ?? 0,
      source.rotations[i * 4 + 3] ?? 0,
    ];
    const w = [t.rotWxyz[1] ?? 0, t.rotWxyz[2] ?? 0, t.rotWxyz[3] ?? 0, t.rotWxyz[0] ?? 0];
    const dot = q[0] * w[0] + q[1] * w[1] + q[2] * w[2] + q[3] * w[3];
    worst.rotation = Math.max(worst.rotation, 1 - Math.abs(dot));
  }

  const result = {
    entries: [...files.keys()].sort(),
    count: source.count,
    expected: cloud.length,
    matched: matched.size,
    sh1: source.sh1 !== undefined,
    worstTexel,
    worstTexelIn,
    worst,
  };
  (globalThis as unknown as { __sogCheck?: unknown }).__sogCheck = result;

  out.innerHTML =
    `<table>` +
    `<tr><td>bundle entries</td><td>${result.entries.join(', ')}</td></tr>` +
    `<tr><td>worst texel</td><td>${worstTexel} of 255${worstTexelIn === '' ? '' : `, in ${worstTexelIn}`}</td></tr>` +
    `<tr><td>Gaussians</td><td>${result.count} of ${result.expected}, ${result.matched} matched one to one</td></tr>` +
    `<tr><td>worst position</td><td>${worst.position.toExponential(2)} m</td></tr>` +
    `<tr><td>worst scale</td><td>${(worst.scale * 100).toFixed(3)} % relative</td></tr>` +
    `<tr><td>worst colour</td><td>${worst.colour.toExponential(2)} linear</td></tr>` +
    `<tr><td>worst opacity</td><td>${worst.opacity.toExponential(2)}</td></tr>` +
    `<tr><td>worst rotation</td><td>${worst.rotation.toExponential(2)} (1 − |dot|)</td></tr>` +
    `</table>`;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
});
