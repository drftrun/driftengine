import { expect, test } from 'vitest';
import { buildLightVolume } from './drftLightVolume.ts';
import type { DrftLightVolume } from './drftLightVolume.ts';
import { readDrft } from './drftRead.ts';
import { streamDrft } from './drftStream.ts';
import { writeDrft } from './drftWrite.ts';

/**
 * A world's summed lights travel as runs: dark air, solid, and literal samples carrying eight half
 * floats. Twelve samples here — three dark, two inside a wall, three lit, four dark — so the payload
 * is the 28-byte header, four run words and three literal samples of sixteen bytes: 92 bytes.
 */
function volume(): DrftLightVolume {
  const count = 12;
  const light = new Float32Array(count * 4);
  const direction = new Float32Array(count * 4);
  for (let s = 0; s < count; s++) light[s * 4 + 3] = s === 3 || s === 4 ? 0 : 1;
  /* Values a half holds exactly, so the round trip is equality. */
  light.set([1.5, 0.25, 3, 1], 5 * 4);
  light.set([0.5, 0.5, 0.5, 1], 6 * 4);
  light.set([2, 0, 0.125, 1], 7 * 4);
  direction.set([0.5, -0.5, 0, 0], 5 * 4);
  direction.set([0, 1, 0, 0], 6 * 4);
  direction.set([-0.25, 0, 0.75, 0], 7 * 4);
  return { origin: [-12, 0, 40], spacing: 8, dims: [3, 2, 2], light, direction };
}

const triangle = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  emissive: new Float32Array([0, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

test('A LIGHT VOLUME TRAVELS AS RUNS and comes back sample for sample, walls and dark air included', async () => {
  const source = volume();
  expect(buildLightVolume(source).length).toBe(92);

  const bytes = writeDrft({ meshes: [triangle], lightVolume: source });
  const read = readDrft(bytes).lightVolume;
  expect(read?.origin).toEqual([-12, 0, 40]);
  expect([read?.spacing, read?.dims]).toEqual([8, [3, 2, 2]]);
  expect(Array.from(read?.light ?? [])).toEqual(Array.from(source.light));
  expect(Array.from(read?.direction ?? [])).toEqual(Array.from(source.direction));

  let streamed: DrftLightVolume | null = null;
  await streamDrft(new Response(bytes), { onLightVolume: (v) => (streamed = v) });
  expect(Array.from((streamed as DrftLightVolume | null)?.light ?? [])).toEqual(
    Array.from(source.light),
  );
  expect(
    readDrft(writeDrft({ meshes: [triangle] })).lightVolume,
    'none written, none read',
  ).toBeNull();
});
