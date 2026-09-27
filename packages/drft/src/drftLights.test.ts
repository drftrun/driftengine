import { expect, test } from 'vitest';
import { buildLights, readLights } from './drftLights.ts';
import type { DrftLight } from './drftLights.ts';

/**
 * `LITE`: lights authored in the scene, in glTF's own terms, read back as they went in.
 *
 * The byte offsets below are the layout's, read from the payload directly rather than through
 * `readLights`, because a reader and a writer that share a mistake agree with each other.
 */

const lamp: DrftLight = {
  kind: 'point',
  name: 'lamp',
  position: [1, 2, 3],
  direction: [0, 0, -1],
  color: [1, 0.5, 0.25],
  intensity: 40,
  range: 0,
  innerConeRad: 0,
  outerConeRad: Math.PI / 4,
};

test('A LIGHT IS WRITTEN AT THE OFFSETS THE LAYOUT STATES', () => {
  const bytes = buildLights([lamp]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true), 'one light').toBe(1);
  expect(view.getUint32(4, true), 'one name').toBe(1);
  /* "lamp": a u32 length and four bytes, already on a four-byte boundary. */
  expect(view.getUint32(8, true)).toBe(4);
  expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe('lamp');
  const at = 16;
  expect(view.getUint32(at, true), 'kind: point is 0').toBe(0);
  expect(view.getUint32(at + 4, true), 'name index').toBe(0);
  expect([8, 12, 16].map((o) => view.getFloat32(at + o, true))).toEqual([1, 2, 3]);
  expect([20, 24, 28].map((o) => view.getFloat32(at + o, true))).toEqual([0, 0, -1]);
  expect([32, 36, 40].map((o) => view.getFloat32(at + o, true))).toEqual([1, 0.5, 0.25]);
  expect(view.getFloat32(at + 44, true)).toBe(40);
  expect(view.getFloat32(at + 48, true), 'range 0 is unbounded').toBe(0);
  expect(view.getFloat32(at + 56, true)).toBeCloseTo(Math.PI / 4, 6);
  expect(bytes.byteLength, 'a light is 64 bytes').toBe(at + 64);
});

test('TEN THOUSAND LIGHTS SHARING ONE NAME STORE IT ONCE, and come back in order', () => {
  const lights: DrftLight[] = [];
  for (let i = 0; i < 10_000; i++) {
    lights.push({ ...lamp, name: 'Instance', position: [i, 0, 0] });
  }
  lights.push({ ...lamp, kind: 'spot', name: 'door' });
  lights.push({ ...lamp, kind: 'directional', name: 'sun' });
  const bytes = buildLights(lights);
  /* Three names; a name per light would be 120 KB of "Instance". */
  expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)).toBe(3);
  const back = readLights(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(back).toHaveLength(10_002);
  expect(back[9_999]?.position[0]).toBe(9_999);
  expect(back[9_999]?.name).toBe('Instance');
  expect(back.slice(-2).map((l) => [l.kind, l.name])).toEqual([
    ['spot', 'door'],
    ['directional', 'sun'],
  ]);
});

test('a payload that ends inside a light is refused by name', () => {
  const bytes = buildLights([lamp]);
  expect(() => readLights(bytes.buffer, bytes.byteOffset, bytes.byteLength - 4)).toThrow(/LITE/);
});

test('A FILE CARRIES ITS LIGHTS IN AN OPTIONAL LITE CHUNK, AND BOTH READERS RETURN THEM', async () => {
  const { writeDrft } = await import('./drftWrite.ts');
  const { readDrft } = await import('./drftRead.ts');
  const { streamDrft } = await import('./drftStream.ts');
  const mesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(1),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  const file = writeDrft({ meshes: [mesh], lights: [lamp] });
  const view = new DataView(file);
  let flags = -1;
  for (let i = 0; i < view.getUint32(12, true); i++) {
    const entry = 32 + i * 16;
    if (String.fromCharCode(...new Uint8Array(file, entry, 4)) === 'LITE') {
      flags = view.getUint16(entry + 12, true);
    }
  }
  expect(flags, 'a LITE chunk, not required').toBe(0);
  expect(readDrft(file).lights).toEqual([
    { ...lamp, outerConeRad: expect.closeTo(Math.PI / 4, 6) },
  ]);
  let streamed: readonly DrftLight[] = [];
  await streamDrft(new Response(file), { onLights: (lights) => (streamed = lights) });
  expect(streamed.map((l) => l.name)).toEqual(['lamp']);
  expect(readDrft(writeDrft({ meshes: [mesh] })).lights, 'a file with none reads empty').toEqual(
    [],
  );
});
