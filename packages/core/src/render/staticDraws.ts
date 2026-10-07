/**
 * Draws that do not change between frames, captured once from an enumeration and replayed into any
 * colour pass: what `createStaticDraws` keeps, and the one rule both backends replay it by.
 *
 * **Captured, not referenced.** An enumeration is a closure over the caller's state, written to
 * allocate nothing, so it hands a sink its scratch: the matrix it fills for every entry and the
 * count it rewrites for the next batch. A list kept across frames copies both when it is made, so
 * what it draws is what the enumeration said then. Meshes, batches and materials are held by
 * reference: they are the caller's, and disposing one a list still holds is the caller's error.
 *
 * **Rigid meshes and instanced batches only.** A skinned mesh is posed every frame and a scatter
 * batch bends with every frame's wind, so neither can be kept, and both are refused by name rather
 * than captured in the pose they happened to have. A caller draws them each frame as it always has.
 *
 * What a backend does with the list is its own: WebGL2 replays the entries every frame through
 * the scene-caster path, and WebGPU records them once into a render bundle per view. See
 * `RendererApi.createStaticDraws` for what a caller is promised, which is the same on both.
 */
import type { InstancedHandle, MeshHandle } from './backend/api.ts';
import type { MeshInstances } from './instances.ts';
import type { SceneCasterMaterial, ShadowCasterSink, ShadowCasters } from './shadowCasters.ts';

/** A list from `createStaticDraws`. Opaque but for its size. */
export interface StaticDrawsHandle {
  /** How many entries it holds: meshes and batches, a batch counting once. */
  readonly draws: number;
}

/** One captured entry. */
export type StaticEntry =
  | {
      readonly kind: 'mesh';
      readonly mesh: MeshHandle;
      readonly model: Float32Array;
      readonly material: SceneCasterMaterial;
    }
  | {
      readonly kind: 'instanced';
      readonly batch: InstancedHandle;
      readonly data: MeshInstances;
      readonly material: SceneCasterMaterial;
    };

/** What both backends hold: the entries, and whether the list has been disposed. */
export interface StaticDrawsList extends StaticDrawsHandle {
  readonly entries: readonly StaticEntry[];
  disposed: boolean;
}

/** Enumerate `casters` once into a list. Allocates: it runs when the list is made, not per frame. */
export function captureStaticDraws(casters: ShadowCasters): StaticDrawsList {
  const entries: StaticEntry[] = [];
  const sink: ShadowCasterSink = {
    mesh: (mesh, model, material) => {
      entries.push({
        kind: 'mesh',
        mesh,
        model: new Float32Array(model as Float32Array),
        material: material ?? null,
      });
    },
    instanced: (batch, data, material) => {
      /* The batch's placements are on the device already; the count is the caller's scratch. */
      entries.push({ kind: 'instanced', batch, data: { ...data }, material: material ?? null });
    },
    skinnedMesh: () => {
      throw new Error(
        'createStaticDraws: a skinned mesh is posed every frame, so a list kept across frames ' +
          'cannot hold one. Draw it each frame, with drawMesh or drawSceneCasters.',
      );
    },
    scatter: () => {
      throw new Error(
        'createStaticDraws: a scatter batch bends with every frame’s wind, so a list kept across ' +
          'frames cannot hold one. Draw it each frame with drawScatter.',
      );
    },
  };
  casters(sink);
  return {
    entries,
    get draws() {
      return entries.length;
    },
    disposed: false,
  };
}

/** Hand every entry to `sink`, in the order it was captured. */
export function replayStaticDraws(list: StaticDrawsList, sink: ShadowCasterSink): void {
  for (const entry of list.entries) {
    if (entry.kind === 'mesh') sink.mesh(entry.mesh, entry.model, entry.material);
    else sink.instanced?.(entry.batch, entry.data, entry.material);
  }
}
