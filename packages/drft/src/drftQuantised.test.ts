import { expect, test } from 'vitest';
import { decodeQuantisedMesh, encodeQuantisedMesh } from './drftQuantised.ts';
import type { MeshData } from './meshData.ts';

/**
 * `MSHQ`: a mesh in the bytes its data needs, decoded back to the `MeshData` every reader takes.
 *
 * Every bound below is derived from the encoding by hand. A value quantised to 16 bits over its own
 * range [lo, hi] lands within half a step, (hi − lo) / 65535 / 2, of where it was. The octahedral
 * bound is measured, and the test that holds it says so.
 */

function roundTrip(mesh: MeshData): MeshData {
  const bytes = encodeQuantisedMesh(mesh);
  return decodeQuantisedMesh(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A strip of `n` vertices along x from 0 to `length` metres, with varied normals and UVs. */
function strip(n: number, length: number): MeshData {
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    positions.set([t * length, Math.sin(t * 7), Math.cos(t * 3) * 2], i * 3);
    const a = t * 5;
    const b = t * 3 - 1.5;
    normals.set([Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)], i * 3);
    uvs.set([t * 8, 1 - t], i * 2);
  }
  const indices = new Uint32Array((n - 2) * 3);
  for (let i = 0; i + 2 < n; i++) indices.set([i, i + 1, i + 2], i * 3);
  return {
    positions,
    normals,
    colors: new Float32Array(n * 3).fill(0.8),
    emissive: new Float32Array(n),
    uvs,
    indices,
  };
}

test('A POSITION COMES BACK WITHIN HALF A 16-BIT STEP OF ITS OWN RANGE', () => {
  const mesh = strip(500, 36);
  const back = roundTrip(mesh);
  /* x spans 36 m: half a step is 36 / 65535 / 2 = 0.275 mm. y spans 2, z spans 4 at most. */
  const bound = [36 / 65535 / 2, 2 / 65535 / 2, 4 / 65535 / 2];
  for (let i = 0; i < mesh.positions.length; i++) {
    expect(
      Math.abs((back.positions[i] as number) - (mesh.positions[i] as number)),
    ).toBeLessThanOrEqual((bound[i % 3] as number) * 1.01 + 1e-7);
  }
  /* And a UV spanning 8 comes back within 8 / 65535 / 2. */
  for (let i = 0; i < 1000; i += 2) {
    expect(Math.abs((back.uvs?.[i] as number) - (mesh.uvs?.[i] as number))).toBeLessThanOrEqual(
      (8 / 65535 / 2) * 1.01 + 1e-7,
    );
  }
});

/*
 * **The angle is measured as atan2(|a × b|, a · b), never acos(a · b).** Near 1, acos is so badly
 * conditioned that a float32 dot product's own rounding reads as 3.5e-4 rad, and a first version of
 * this test measured that floor instead of the encoding. The bound is 5e-5 rad, 0.003°: the worst of
 * 200,000 directions over the sphere came back at 4.3e-5, and an 8-bit normal map resolves 0.45°.
 */
test('A UNIT NORMAL COMES BACK UNIT, within 5e-5 of a radian', () => {
  const mesh = strip(500, 1);
  const back = roundTrip(mesh);
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const ax = mesh.normals[i] as number;
    const ay = mesh.normals[i + 1] as number;
    const az = mesh.normals[i + 2] as number;
    const bx = back.normals[i] as number;
    const by = back.normals[i + 1] as number;
    const bz = back.normals[i + 2] as number;
    expect(Math.hypot(bx, by, bz)).toBeCloseTo(1, 5);
    const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    expect(Math.atan2(cross, ax * bx + ay * by + az * bz)).toBeLessThan(5e-5);
  }
});

test('A CONSTANT ATTRIBUTE COSTS NO BYTES A VERTEX, and comes back exact', () => {
  const small = strip(10, 1);
  const large = strip(1000, 1);
  const perVertex =
    (encodeQuantisedMesh(large).byteLength - encodeQuantisedMesh(small).byteLength) / 990;
  /*
   * Positions 6, normals 4, UVs 4, and colour and emissive nothing: 14 bytes a vertex, plus about
   * 6 of 16-bit indices. Against 12 + 12 + 12 + 4 + 8 = 48 of floats and 12 of 32-bit indices.
   */
  expect(perVertex).toBeLessThan(21);
  const back = roundTrip(large);
  expect(back.colors.every((c) => c === 0.8 || Math.abs(c - 0.8) < 1e-7)).toBe(true);
  expect([...back.emissive].every((e) => e === 0)).toBe(true);
});

test('indices are exact at either width, and sixteen bits are used only where they reach', () => {
  const mesh = strip(100, 1);
  expect([...roundTrip(mesh).indices]).toEqual([...mesh.indices]);
  /* 70,000 vertices is past 65,536: the widths must not wrap an index. */
  const big = strip(70_000, 1);
  const back = roundTrip(big);
  expect(back.indices[back.indices.length - 1]).toBe(69_999);
});

test('JOINTS ARE CARRIED EXACTLY, and a direction that is not unit length is not bent into one', () => {
  const mesh = strip(8, 1);
  mesh.joints = new Float32Array(32).map((_, i) => i % 5);
  mesh.weights = new Float32Array(32).fill(0.25);
  mesh.tangents = new Float32Array(32).map((_, i) =>
    i % 4 === 3 ? (i % 8 === 3 ? 1 : -1) : i % 4 === 0 ? 1 : 0,
  );
  /* A zero normal is not a direction, and an octahedral code would turn it into +z. */
  mesh.normals[0] = 0;
  mesh.normals[1] = 0;
  mesh.normals[2] = 0;
  const back = roundTrip(mesh);
  expect([...(back.joints ?? [])]).toEqual([...mesh.joints]);
  expect([back.normals[0], back.normals[1], back.normals[2]]).toEqual([0, 0, 0]);
  /* The tangent's handedness survives exactly. */
  for (let i = 3; i < 32; i += 4) expect(back.tangents?.[i]).toBe(mesh.tangents[i]);
});

test('A QUANTISED FILE CARRIES MSHQ IN PLACE OF MESH, REQUIRED, AND BOTH READERS DECODE IT', async () => {
  const { writeDrft } = await import('./drftWrite.ts');
  const { readDrft } = await import('./drftRead.ts');
  const { streamDrft } = await import('./drftStream.ts');
  const mesh = strip(64, 5);
  const file = writeDrft({ meshes: [mesh, strip(10, 1)], quantise: true });
  const view = new DataView(file);
  const codes: string[] = [];
  let required = 0;
  for (let i = 0; i < view.getUint32(12, true); i++) {
    const entry = 32 + i * 16;
    const code = String.fromCharCode(...new Uint8Array(file, entry, 4));
    codes.push(code);
    if (code === 'MSHQ') required += view.getUint16(entry + 12, true) & 1;
  }
  expect(codes.filter((c) => c === 'MSHQ')).toHaveLength(2);
  expect(codes.includes('MESH')).toBe(false);
  expect(required, 'every MSHQ is required').toBe(2);

  const whole = readDrft(file);
  expect(whole.meshes).toHaveLength(2);
  expect(whole.meshes[0]?.positions[3 * 63]).toBeCloseTo(5, 3);

  const streamed: number[] = [];
  await streamDrft(new Response(file), {
    onMesh: (m, ordinal) => streamed.push(ordinal * 1000 + m.positions.length / 3),
  });
  expect(streamed).toEqual([64, 1010]);
});

test('TEXTURE-ARRAY LAYERS ARE CARRIED EXACTLY, because a layer rounded to its neighbour is another picture', () => {
  const mesh = strip(8, 1);
  mesh.layers = new Float32Array([0, 1, 2, 3, 250, 251, 252, 4095]);
  expect([...(roundTrip(mesh).layers ?? [])]).toEqual([0, 1, 2, 3, 250, 251, 252, 4095]);
});
