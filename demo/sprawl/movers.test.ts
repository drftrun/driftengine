import { describe, expect, it } from 'vitest';

import type { MeshData, MeshInstances, RendererApi } from '../../packages/core/src/index';
import type { MoverKindData } from './data/life';
import { MoverBatches, createTints, pose } from './movers';

/** A renderer that keeps what each batch was last asked to draw. */
function recorder(): { renderer: RendererApi; drawn: MeshInstances[] } {
  const drawn: MeshInstances[] = [];
  const renderer = {
    createMesh: () => ({}),
    createInstanced: () => ({}),
    uploadInstanced: () => {},
    drawInstanced: (_batch: unknown, data: MeshInstances) => drawn.push(data),
  } as unknown as RendererApi;
  return { renderer, drawn };
}

/* A walker whose body is mesh 0 and whose leg, mesh 1, hangs from a hip 0.9 m up and 0.1 m out. */
const WALKER: MoverKindData = {
  name: 'Walker',
  role: 'person',
  meshes: [
    { mesh: 0, tint: 'cloth', limb: -1 },
    { mesh: 1, tint: 'cloth2', limb: 0 },
  ],
  limbs: [{ pivot: [0.1, 0.9, 0], phase: 0, swing: Math.PI / 2, lift: 0 }],
};
const MESHES = new Map<number, MeshData>([
  [0, {} as MeshData],
  [1, {} as MeshData],
]);

/** Where column-major `m` at `at` takes the point (x, y, z). */
function apply(m: Float32Array, at: number, x: number, y: number, z: number): number[] {
  return [0, 1, 2].map(
    (r) =>
      Math.round(
        ((m[at + r] as number) * x +
          (m[at + 4 + r] as number) * y +
          (m[at + 8 + r] as number) * z +
          (m[at + 12 + r] as number)) *
          1000,
      ) /
        1000 +
      0,
  );
}

describe("the movers' batches", () => {
  it('A LIMB TURNS ABOUT ITS PIVOT BY ITS SWING, AND GOES WHERE ITS BODY GOES', () => {
    const { renderer, drawn } = recorder();
    const batches = new MoverBatches(renderer, [WALKER], MESHES, () => 4);
    const tints = createTints();
    tints.cloth2.set([0.2, 0.3, 0.4]);
    /* The body 10 m along x and 5 along z, facing +z. */
    const body = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 5, 1]);
    batches.begin();
    /* A quarter of the way round the stride: sin = 1, so the full swing of a right angle. */
    batches.add(0, body, tints, Math.PI / 2);
    batches.draw(renderer);
    const [torso, leg] = drawn;
    expect(apply(torso?.models as Float32Array, 0, 0, 1.2, 0)).toEqual([10, 1.2, 5]);
    /* The foot, 0.9 m down the leg, swings a right angle about x: from below the hip to behind it. */
    expect(apply(leg?.models as Float32Array, 0, 0, -0.9, 0)).toEqual([10.1, 0.9, 4.1]);
    expect(Array.from(leg?.tints.subarray(0, 3) ?? []).map((c) => Math.round(c * 10) / 10)).toEqual(
      [0.2, 0.3, 0.4],
    );
  });

  it('A KIND WHOSE MESHES HAVE NOT ALL ARRIVED DRAWS NOTHING, AND A FULL BATCH TAKES NO MORE', () => {
    const { renderer, drawn } = recorder();
    const partial = new MoverBatches(renderer, [WALKER], new Map([[0, {} as MeshData]]), () => 4);
    const body = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    partial.begin();
    partial.add(0, body, createTints(), 0);
    expect(partial.draw(renderer)).toBe(0);
    const small = new MoverBatches(renderer, [WALKER], MESHES, () => 2);
    small.begin();
    for (let i = 0; i < 5; i++) small.add(0, body, createTints(), 0);
    small.draw(renderer);
    expect(drawn.map((d) => d.count)).toEqual([2, 2]);
  });

  it('A POSE TURNS, PITCHES AND ROLLS ABOUT THE BODY’S OWN AXES, IN THAT ORDER', () => {
    const m = new Float32Array(16);
    /* A quarter turn to face +x, nose down a quarter, no roll: the nose points straight down. */
    pose(m, 5, 6, 7, Math.PI / 2, Math.PI / 2, 0, 1);
    expect(apply(m, 0, 0, 0, 1)).toEqual([5, 5, 7]);
    /* Facing +z, rolled a quarter: the body's +x wing goes up. */
    pose(m, 0, 0, 0, 0, 0, Math.PI / 2, 2);
    expect(apply(m, 0, 1, 0, 0)).toEqual([0, 2, 0]);
    /* Facing +x and rolled a quarter: the wing that was its +x, now pointing −z, goes up. */
    pose(m, 0, 0, 0, Math.PI / 2, 0, Math.PI / 2, 1);
    expect(apply(m, 0, 1, 0, 0)).toEqual([0, 1, 0]);
    /* And its up now points the way its wing did: +z. */
    expect(apply(m, 0, 0, 1, 0)).toEqual([0, 0, 1]);
  });
});
