/**
 * A capture to open when nobody has one: a room, segmented, as the bytes of a `.drft`.
 *
 * **The same reason `demoScene.ts` exists, one stage along.** An editor that opens empty cannot be
 * looked at, photographed or handed to somebody as a thing to try — and a `.drft` is not something
 * this repository can commit, because a captured room is tens of megabytes and is not the engine's
 * to redistribute. So the file is *made*: four quads, segmented into regions and proposed as
 * entities by the capture package itself, written by its own writer.
 *
 * It is not a fixture for a test. What it is for is `?capture=demo`, so the product opens with
 * something in the viewport.
 */
import { captureFile, proposeEntities, segmentGeometry } from '@driftengine/capture';
import type { MeshData } from '@driftengine/drft';

/** A floor and three walls, each quad carrying its own corners as a flat-shaded mesh does. */
function room(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const quad = (
    corners: readonly (readonly [number, number, number])[],
    normal: readonly [number, number, number],
  ): void => {
    const base = positions.length / 3;
    for (const [x, y, z] of corners) {
      positions.push(x, y, z);
      normals.push(normal[0] as number, normal[1] as number, normal[2] as number);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  quad(
    [
      [-3, 0, -3],
      [-3, 0, 3],
      [3, 0, 3],
      [3, 0, -3],
    ],
    [0, 1, 0],
  );
  quad(
    [
      [-3, 0, -3],
      [3, 0, -3],
      [3, 2.6, -3],
      [-3, 2.6, -3],
    ],
    [0, 0, 1],
  );
  quad(
    [
      [-3, 0, -3],
      [-3, 2.6, -3],
      [-3, 2.6, 3],
      [-3, 0, 3],
    ],
    [1, 0, 0],
  );
  /* A crate on the floor: small enough that the capture offers it as something to move. */
  quad(
    [
      [0.6, 0.8, 0.6],
      [0.6, 0.8, 1.4],
      [1.4, 0.8, 1.4],
      [1.4, 0.8, 0.6],
    ],
    [0, 1, 0],
  );

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: new Float32Array(positions.length).fill(0.8),
    emissive: new Float32Array(positions.length / 3),
    indices: Uint32Array.from(indices),
  };
}

export function demoCaptureBytes(): ArrayBuffer {
  const mesh = room();
  const proposals = proposeEntities(segmentGeometry(mesh)).map((proposal) => {
    /*
     * The crate is the one small enough to name, which is what makes the list worth reading — and
     * it is measured on the *longest* side. A wall is a metre of nothing in x and six metres of
     * wall in z, so anything asking only about x calls it a crate.
     */
    const b = proposal.bounds;
    const span = Math.max(
      (b[3] as number) - (b[0] as number),
      (b[4] as number) - (b[1] as number),
      (b[5] as number) - (b[2] as number),
    );
    return span > 2 ? proposal : { ...proposal, label: 'crate' };
  });
  return captureFile({ mesh, proposals });
}
