import { expect, test } from 'vitest';

import { packDecodeTables } from '../packages/core/src/render/gpudriven/decodeTables.ts';
import { collectPrograms } from '../packages/core/src/render/gpudriven/materialTable.ts';

import { cullInstances } from '../packages/core/src/render/gpudriven/instances.ts';
import { Camera, createFrustum, frustumFromViewProjection } from '../packages/core/src/index';

import type { GpuDrivenMaterial, StreamHandle } from '../packages/core/src/index';
import { DECODE_OP } from '@driftengine/texture';

import {
  RIG_YAW,
  streamRoom,
  cycleStreamed,
  streamEntries,
  denseRig,
  materialsRig,
  occlusionRig,
  rigScene,
  spinAsked,
  StreamCycle,
} from './gpuDrivenRig.ts';

/**
 * **What this file is for: one rig stands somewhere, and nothing else in the repository does.**
 *
 * The GPU-driven pipeline multiplies every vertex and every normal by `transforms[mesh]`, and until
 * 2026-09-17 its culling read the bake's untransformed bounds — which drew the right picture for as
 * long as every transform was the identity, and every transform here was. `occlusionRig` now models
 * each box at its own origin and places it with a matrix, so the path is exercised at all.
 *
 * That re-expression is only worth having if it is the *same geometry*, because a capture of this
 * scene against the build before it is what says the transform arithmetic is right. So the
 * assertions below are about where the boxes end up rather than about the entries of any matrix.
 */

/** The axis-aligned box a mesh's vertices occupy once its own transform has been applied. */
function placedExtent(mesh: { positions: Float32Array; transform?: Float32Array }): {
  centre: number[];
  half: number[];
} {
  const m = mesh.transform ?? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.positions.length / 3; v += 1) {
    const x = mesh.positions[v * 3] as number;
    const y = mesh.positions[v * 3 + 1] as number;
    const z = mesh.positions[v * 3 + 2] as number;
    for (let axis = 0; axis < 3; axis += 1) {
      const at =
        (m[axis] as number) * x +
        (m[4 + axis] as number) * y +
        (m[8 + axis] as number) * z +
        (m[12 + axis] as number);
      low[axis] = Math.min(low[axis] as number, at);
      high[axis] = Math.max(high[axis] as number, at);
    }
  }
  return {
    centre: [0, 1, 2].map((a) => ((low[a] as number) + (high[a] as number)) / 2),
    half: [0, 1, 2].map((a) => ((high[a] as number) - (low[a] as number)) / 2),
  };
}

test('THE TURNED WALL IS THE WALL IT REPLACED, which is what makes the capture a control', () => {
  /*
   * The wall was written as a box 28 by 10 by 1.2 standing at (0, 4, 6). It is modelled as a box
   * 1.2 by 10 by 28 at the origin now, and a quarter turn about y is what makes those the same
   * thing. If the turn goes the other way the extents come out the same and the *normals* do not,
   * which is the next assertion.
   */
  const wall = occlusionRig().meshes[0] as {
    positions: Float32Array;
    normals: Float32Array;
    transform?: Float32Array;
  };
  const placed = placedExtent(wall);
  expect(placed.centre.map((v) => Math.round(v * 1e5) / 1e5)).toEqual([0, 4, 6]);
  expect(placed.half.map((v) => Math.round(v * 1e5) / 1e5)).toEqual([14, 5, 0.6]);
});

test('A PLACEMENT NEVER MIRRORS, because the raster has one winding and no say in it', () => {
  /*
   * **A negative determinant turns every face of every mesh inside out.** `box` winds its
   * triangles so that `(P1 - P0) x (P2 - P0)` points the way the face's normal does, and
   * `visbufferRaster.wgsl.ts` takes that convention and a fixed `frontFace`; a reflection in the
   * transform flips the winding and leaves the stored normal alone, so the pipeline culls exactly
   * the faces it should draw and draws the inside of the box. Nothing in the frame says why.
   */
  for (const rig of [occlusionRig(), denseRig(), materialsRig()]) {
    for (const mesh of rig.meshes) {
      const m = mesh.transform;
      if (m === undefined) continue;
      const determinant =
        (m[0] as number) *
          ((m[5] as number) * (m[10] as number) - (m[6] as number) * (m[9] as number)) -
        (m[4] as number) *
          ((m[1] as number) * (m[10] as number) - (m[2] as number) * (m[9] as number)) +
        (m[8] as number) *
          ((m[1] as number) * (m[6] as number) - (m[2] as number) * (m[5] as number));
      expect(determinant).toBeGreaterThan(0);
    }
  }
});

test('and every face still points out of the box it belongs to, once it has been placed', () => {
  /*
   * The claim a determinant does not make: that the normals and the positions went through the
   * *same* matrix. Transform both, and each face's normal has to point away from the placed
   * centre — which is what the shading reads and what the cone test is built out of.
   */
  for (const mesh of occlusionRig().meshes) {
    const m = mesh.transform as Float32Array;
    const placed = placedExtent(mesh);
    for (let v = 0; v < mesh.normals.length / 3; v += 1) {
      let outward = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const n =
          (m[axis] as number) * (mesh.normals[v * 3] as number) +
          (m[4 + axis] as number) * (mesh.normals[v * 3 + 1] as number) +
          (m[8 + axis] as number) * (mesh.normals[v * 3 + 2] as number);
        const p =
          (m[axis] as number) * (mesh.positions[v * 3] as number) +
          (m[4 + axis] as number) * (mesh.positions[v * 3 + 1] as number) +
          (m[8 + axis] as number) * (mesh.positions[v * 3 + 2] as number) +
          (m[12 + axis] as number);
        outward += n * (p - (placed.centre[axis] as number));
      }
      expect(outward).toBeGreaterThan(0);
    }
  }
});

test('EVERY BOX OF THE FIELD LANDS WHERE IT WAS WRITTEN, all 196 of them', () => {
  /*
   * The grid the rig used to write into its vertices, recomputed here from the same two lines. A
   * placement that dropped the translation, or applied it in the wrong order, puts all 196 at the
   * origin — which is exactly what the cull was reading before `clusterWorld.ts`, and the reason
   * this rig is the one that was changed.
   */
  const meshes = occlusionRig().meshes;
  expect(meshes.length).toBe(1 + 14 * 14);
  for (let z = 0; z < 14; z += 1) {
    for (let x = 0; x < 14; x += 1) {
      const height = 0.6 + ((x * 7 + z * 13) % 9) * 0.35;
      const placed = placedExtent(
        meshes[1 + z * 14 + x] as { positions: Float32Array; transform?: Float32Array },
      );
      expect(
        placed.centre.map((v) => Math.round(v * 1e5) / 1e5),
        `box ${x},${z}`,
      ).toEqual([
        Math.round((x - 6.5) * 2 * 1e5) / 1e5,
        Math.round(height * 1e5) / 1e5,
        Math.round((-z * 2.2 - 2) * 1e5) / 1e5,
      ]);
      expect(
        placed.half.map((v) => Math.round(v * 1e5) / 1e5),
        `box ${x},${z}`,
      ).toEqual([0.7, Math.round(height * 1e5) / 1e5, 0.7]);
    }
  }
});

test('the other two rigs say nothing about where they stand, and that is deliberate', () => {
  /*
   * One rig exercising the transform is the point; three would mean no capture in the record was
   * comparable to the one beside it. These two stay at the origin so their frames stay the frames
   * every figure in the record was measured on.
   */
  for (const rig of [denseRig(), materialsRig()]) {
    for (const mesh of rig.meshes) expect(mesh.transform).toBeUndefined();
  }
});

test('A BOX CARRIES UVS IN METRES OF ITS OWN FACES, so a tiling map lands at one scale everywhere', () => {
  /* The wall is 1.2 deep, 10 tall and 28 wide before its turn; its +x face is 28 by 10. */
  const wall = occlusionRig().meshes[0] as { uvs?: Float32Array };
  expect(wall.uvs?.length).toBe(24 * 2);
  const us = Array.from({ length: 4 }, (_, corner) => wall.uvs?.[corner * 2] as number);
  const vs = Array.from({ length: 4 }, (_, corner) => wall.uvs?.[corner * 2 + 1] as number);
  expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(28, 5);
  expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(10, 5);
});

test('THREE OF THE MATERIALS RIG’S SIXTEEN ARE TEXTURED, and the rest are exactly what they were', () => {
  const rig = materialsRig();
  const textured = rig.materials.flatMap((material, m) =>
    material.textures === undefined ? [] : [m],
  );
  /*
   * **Sixteen materials and three more, and only the first sixteen have a forward twin.** The grid
   * is what the forward path draws beside this pipeline for comparison, so `rig.textured` names the
   * three encoded sources that comparison needs; materials 16 to 18 — the cutout, the pane and the
   * picture — have no forward equivalent to compare against and carry their maps as decode programs
   * built here rather than as `EncodedMaterial`s. That is why the two lists differ.
   */
  expect(textured).toEqual([1, 3, 7, 16, 18]);
  expect([...(rig.textured?.keys() ?? [])]).toEqual([1, 3, 7]);
  /* Every textured program tiles, and is a power-of-two square, which the device array requires. */
  for (const source of rig.textured?.values() ?? []) {
    for (const encoded of [source.baseColour, source.normal, source.orm]) {
      if (encoded === undefined) continue;
      expect(encoded.graph.addressMode).toBe(3);
      expect(encoded.latentWidth).toBe(64);
      expect(encoded.latentHeight).toBe(64);
    }
  }
});

test('the textured rig packs into the device tables without refusal', () => {
  const rig = materialsRig();
  expect(() => packDecodeTables(collectPrograms(rig.materials).programs)).not.toThrow();
});

test('a turn is asked in degrees a second, and anything else is the still eye', () => {
  /* The still eye is the one every published capture of these rigs was taken from. */
  expect(spinAsked('')).toBe(0);
  expect(spinAsked('?spin=')).toBe(0);
  expect(spinAsked('?spin=fast')).toBe(0);
  expect(spinAsked('?spin=Infinity')).toBe(0);
  expect(spinAsked('?scene=16&spin=45')).toBe(45);
  expect(spinAsked('?spin=-30')).toBe(-30);
});

test('THE WALL RIG LEAVES MESHES OUT AS IT TURNS, so the instance cull has something to drop', () => {
  /*
   * **A stage that never fires on the scenes it is photographed on proves only that it is
   * harmless**, and at the yaw the rig is photographed from, it never fires: the whole field of 196
   * boxes is in front of the camera. Turned round the target — which is what `?spin=` does, and
   * what `scripts/motion-check.mjs` photographs step by step — the eye passes the far side of the
   * field and boxes fall behind it. Counted with the reference over the very spheres the pass
   * uploads, at the capture's wide frame, over the motion check's forty-eight steps.
   */
  const rig = occlusionRig();
  const { scene, transforms } = rigScene(rig);
  const meshCount = transforms.length / 16;
  /*
   * **Read off the scene rather than recomputed**, since 2026-09-18: a `StreamingScene` computes a
   * mesh's world-space cluster bounds and its instance sphere when the mesh is placed, so asking
   * for them again here would be a second spelling that could disagree with what the pass uploads.
   */
  const spheres = scene.instanceSpheres;
  const pitch = (rig.pitch * Math.PI) / 180;
  const flat = Math.cos(pitch) * rig.distance;
  const camera = new Camera();
  const flags = new Uint32Array(meshCount);
  const hiddenAt = (yaw: number): number => {
    camera.position[0] = rig.target[0] + Math.sin(yaw) * flat;
    camera.position[1] = rig.target[1] + Math.sin(pitch) * rig.distance;
    camera.position[2] = rig.target[2] + Math.cos(yaw) * flat;
    camera.lookAt(rig.target[0], rig.target[1], rig.target[2]);
    camera.updateMatrices(1280 / 628);
    const planes = frustumFromViewProjection(camera.viewProjection, createFrustum());
    return cullInstances(planes, spheres, meshCount, flags);
  };
  expect(meshCount).toBe(197);
  expect(hiddenAt(RIG_YAW), 'the photographed view').toBe(0);
  const counts = Array.from({ length: 48 }, (_, step) => hiddenAt(RIG_YAW + (step * Math.PI) / 24));
  const most = Math.max(...counts);
  expect(most).toBeGreaterThan(20);
  expect(most).toBeLessThan(meshCount);
  expect(counts.filter((count) => count > 0).length).toBeGreaterThan(8);
});

/**
 * **The streamed cycle, which is what puts add, remove and reuse in front of a driver.**
 *
 * The arithmetic is here rather than in the frame loop so that "nothing leaks and nothing is lost"
 * is a test rather than a picture. What a device adds to it is that the buffers are really written
 * and the frame is really drawn, which is `?stream=1` on scene 16.
 */
test('A STREAM CYCLE TAKES OUT ONE GROUP AND PUTS BACK THE LAST', () => {
  const rig = occlusionRig();
  const { transforms } = rigScene(rig);
  const entries = streamEntries(rig, transforms);
  const scene = streamRoom(entries);
  const handles: (StreamHandle | null)[] = entries.map(() => null);
  /* A cycle below zero is "everything in", which is how a streamed rig fills its scene. */
  cycleStreamed(scene, entries, handles, -1);
  expect(handles.every((handle) => handle !== null)).toBe(true);

  cycleStreamed(scene, entries, handles, 0);
  const out = handles.filter((handle) => handle === null).length;
  expect(out, 'a third of the meshes should be out').toBeGreaterThan(0);
  expect(out).toBeLessThan(entries.length);

  /* The same cycle twice changes nothing: it is a state rather than a step. */
  const after = scene.liveClusters;
  cycleStreamed(scene, entries, handles, 0);
  expect(scene.liveClusters).toBe(after);
});

test('THREE CYCLES RETURN EVERY MESH, so nothing leaks and nothing is lost', () => {
  /*
   * **A leak shows as a count that climbs and a double free as one that falls**, and neither shows
   * in a picture until the allocator refuses something. Going round the whole cycle and landing on
   * the count it started with is what says the ranges came back.
   */
  const rig = occlusionRig();
  const { transforms } = rigScene(rig);
  const entries = streamEntries(rig, transforms);
  const scene = streamRoom(entries);
  const handles: (StreamHandle | null)[] = entries.map(() => null);
  cycleStreamed(scene, entries, handles, -1);
  const full = scene.liveClusters;

  for (let cycle = 0; cycle < 12; cycle += 1) cycleStreamed(scene, entries, handles, cycle);
  /* Cycle 11 has one group out; putting it back is cycle 12's job, so ask for a clear one. */
  cycleStreamed(scene, entries, handles, -1);
  expect(scene.liveClusters).toBe(full);
  expect(handles.every((handle) => handle !== null)).toBe(true);
});

test('A STREAM CYCLE COUNTS FRAMES THAT MOVED THE CLOCK, so a held frame holds the cycle too', () => {
  /*
   * **`?hold=` stops the clock and keeps drawing**: the harness calls `frame` about five hundred
   * and seventy times in the two and a half seconds a capture waits after the hold, each with a
   * step of zero. The rig counted those calls, so a capture at `hold=121` photographed frame 690
   * or so — a cycle boundary, which way it fell being a matter of eighteen frames of scheduling —
   * and two captures of one build differed by 119,157 pixels.
   */
  const cycle = new StreamCycle();
  const steps: number[] = [];
  for (let frame = 0; frame < 61; frame += 1) steps.push(cycle.step(1 / 60));
  /* Thirty frames a cycle, and the frame that is drawn is counted after it. */
  expect(steps.slice(0, 30).every((at) => at === 0)).toBe(true);
  expect(steps.slice(30, 60).every((at) => at === 1)).toBe(true);
  expect(steps[60]).toBe(2);
  /* A held clock: however many frames are drawn, the cycle stays where the hold left it. */
  for (let frame = 0; frame < 600; frame += 1) expect(cycle.step(0)).toBe(2);
});

test('A PASS HOLDING THE ROOM REFUSES NOTHING, cycle after cycle, one frame at a time', () => {
  /*
   * **The streamed rig's room is exactly as large as its meshes**, so it is where the wait on a
   * freed range (§3.4 of the streaming-scene design) would bite first: while a pass holds the scene,
   * a group taken out cannot be refilled in the frame it left. The group put back left a cycle
   * earlier, and its ranges came back at that frame's upload, so every cycle should leave out exactly
   * what a room with no pass leaves out — which is the claim, made against the room's own answer
   * rather than a count written down here.
   */
  const rig = occlusionRig();
  const { transforms } = rigScene(rig);
  const entries = streamEntries(rig, transforms);
  const held = streamRoom(entries);
  const free = streamRoom(entries);
  const heldHandles: (StreamHandle | null)[] = entries.map(() => null);
  const freeHandles: (StreamHandle | null)[] = entries.map(() => null);
  cycleStreamed(held, entries, heldHandles, -1);
  cycleStreamed(free, entries, freeHandles, -1);
  held.attach({ writeVertices: () => undefined, writeIndices: () => undefined });
  const missing = (handles: (StreamHandle | null)[]) =>
    handles.flatMap((handle, at) => (handle === null ? [at] : []));
  for (let cycle = 0; cycle < 12; cycle += 1) {
    cycleStreamed(held, entries, heldHandles, cycle);
    cycleStreamed(free, entries, freeHandles, cycle);
    expect(missing(heldHandles), `cycle ${cycle}`).toEqual(missing(freeHandles));
    /* The frame's upload, which is what gives a waiting range back. */
    held.takeDirty();
  }
});

test('THE MATERIALS RIG CARRIES A CUTOUT, A PANE AND A PICTURE, each visible against something', () => {
  /*
   * **The three capabilities this wave added, in the only place a reader can see them.** Each is
   * only legible against something else, which is why the panels stand between the grid and the
   * camera rather than among it — and the pane has a glowing box directly behind it, because
   * transparency that draws nothing looks exactly like transparency that works when there is
   * nothing behind it.
   */
  const rig = materialsRig();
  const cutout = rig.materials[16] as GpuDrivenMaterial;
  const pane = rig.materials[17] as GpuDrivenMaterial;
  const picture = rig.materials[18] as GpuDrivenMaterial;

  expect(cutout.alphaCutoff).toBe(0.5);
  expect(pane.blend).toBe(true);
  expect(pane.opacity).toBe(0.45);
  /* A picture is one instruction: SAMPLE_BLOCK, and the picture is the operand. */
  const program = picture.textures?.baseColour;
  expect(program?.graph.count).toBe(1);
  expect(program?.graph.nodes[0]).toBe(DECODE_OP.SAMPLE_BLOCK);
  expect(program?.blocks?.[0]?.components).toBe(4);
  /* Every level down to one texel, or a surface at distance reads black. */
  expect(program?.blocks?.[0]?.levels.length).toBe(7);

  /* And the cutout's alpha genuinely has both sides, or this is a test about a solid panel. */
  const alphas = new Set(
    Array.from(cutout.textures?.baseColour?.blocks?.[0]?.levels[0] ?? [])
      .filter((_, i) => i % 4 === 3)
      .map((value) => (value > 127 ? 'kept' : 'cut')),
  );
  expect([...alphas].sort()).toEqual(['cut', 'kept']);

  const span = (mesh: (typeof rig.meshes)[number], axis: number) => {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const value = mesh.positions[v + axis] as number;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    return [low, high] as const;
  };
  const pane17 = rig.meshes.filter((mesh) => mesh.material === 17);
  expect(pane17).toHaveLength(1);
  const [paneLeft, paneRight] = span(pane17[0] as (typeof rig.meshes)[number], 0);
  const [, paneNear] = span(pane17[0] as (typeof rig.meshes)[number], 2);

  /*
   * **Behind it and across from it**, and "behind" is measured rather than asserted: this rig's
   * still eye stands at positive x and positive z, so nearer the camera is larger z. The first
   * placement put the glowing box at a larger z than the pane — in front of it rather than behind
   * — which is a blend with nothing to blend with and looks exactly like one that does not work.
   *
   * The x overlap is not decoration either: every material-0 box in the grid stands at x -8.4,
   * well to the side of a pane spanning -3.6 to 1.6, so an assertion that only asked about depth
   * stayed green with the glowing box moved in front.
   */
  const behind = rig.meshes.filter((mesh) => {
    if (mesh.material !== 0) return false;
    const [left, right] = span(mesh, 0);
    const [, near] = span(mesh, 2);
    return near < paneNear && right > paneLeft && left < paneRight;
  });
  expect(behind).toHaveLength(1);
});
