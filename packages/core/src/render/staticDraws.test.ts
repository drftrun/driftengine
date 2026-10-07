import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';

import { createMeshInstances } from './instances.ts';
import type { SceneCasterMaterial, ShadowCasterSink } from './shadowCasters.ts';
import { captureStaticDraws, replayStaticDraws } from './staticDraws.ts';
import type { InstancedHandle, MeshHandle } from './backend/api.ts';

const meshA = { bounds: {} } as unknown as MeshHandle;
const meshB = { bounds: {} } as unknown as MeshHandle;
const batch = {} as unknown as InstancedHandle;
const stone = { uScale: 2 } as SceneCasterMaterial;
const glass = { glass: { transmission: 1 } } as SceneCasterMaterial;

/** What a sink was handed, in order. */
function recorder() {
  const seen: unknown[][] = [];
  const sink: ShadowCasterSink = {
    mesh: (mesh, model, material) => seen.push(['mesh', mesh, Array.from(model), material]),
    skinnedMesh: () => seen.push(['skinned']),
    instanced: (b, data, material) => seen.push(['instanced', b, data.count, material]),
    scatter: () => seen.push(['scatter']),
  };
  return { seen, sink };
}

describe('static draws', () => {
  it('REPLAYS WHAT WAS ENUMERATED, IN ORDER, WITH EACH ENTRY’S MATERIAL', () => {
    const placed = createMeshInstances(8);
    placed.count = 5;
    const draws = captureStaticDraws((sink) => {
      sink.mesh(meshA, mat4.fromTranslation(mat4.create(), [1, 2, 3]), stone);
      sink.instanced?.(batch, placed, glass);
      sink.mesh(meshB, mat4.create());
    });
    const { seen, sink } = recorder();
    replayStaticDraws(draws, sink);
    expect(seen.map((entry) => entry[0])).toEqual(['mesh', 'instanced', 'mesh']);
    expect(seen[0]?.[1]).toBe(meshA);
    expect((seen[0]?.[2] as number[] | undefined)?.slice(12, 15)).toEqual([1, 2, 3]);
    expect(seen[0]?.[3]).toBe(stone);
    expect(seen[1]?.[2]).toBe(5);
    expect(seen[1]?.[3]).toBe(glass);
    expect(seen[2]?.[3]).toBeNull();
    expect(draws.draws).toBe(3);
  });

  /*
   * Recorded once, so what it holds is what the enumeration said then: a caller reusing its scratch
   * matrix or its instance count for the next thing it draws must not move what was recorded.
   */
  it('KEEPS THE MATRICES AND COUNTS IT WAS GIVEN, NOT THE CALLER’S SCRATCH', () => {
    const scratch = mat4.fromTranslation(mat4.create(), [4, 0, 0]);
    const placed = createMeshInstances(8);
    placed.count = 3;
    const draws = captureStaticDraws((sink) => {
      sink.mesh(meshA, scratch, null);
      sink.instanced?.(batch, placed, null);
    });
    mat4.fromTranslation(scratch, [9, 9, 9]);
    placed.count = 7;
    const { seen, sink } = recorder();
    replayStaticDraws(draws, sink);
    const model = seen[0]?.[2] as number[] | undefined;
    expect(model?.[12]).toBe(4);
    expect(seen[1]?.[2]).toBe(3);
  });

  /* A skinned mesh and a scatter batch change every frame; a list kept across frames cannot hold them. */
  it('REFUSES A SKINNED MESH AND A SCATTER BATCH BY NAME', () => {
    expect(() =>
      captureStaticDraws((sink) => sink.skinnedMesh(meshA, mat4.create(), new Float32Array(16))),
    ).toThrow(/skinned mesh/);
    expect(() =>
      captureStaticDraws((sink) => sink.scatter({} as never, {} as never, 0, 0, 0, 0)),
    ).toThrow(/scatter/);
  });
});
