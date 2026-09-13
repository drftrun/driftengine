/**
 * Turn an imported asset into the engine's frame. One responsibility: orientation.
 *
 * **This lives on the intermediate, not in a reader, and that placement is the point.** Every
 * format arrives here eventually — glTF, OBJ, STL, FBX, and whatever is added next — and each
 * one has its own idea of which way is up: glTF specifies Y-up and means it, STL specifies
 * nothing at all, FBX records a convention per file and its exporters disagree about how to
 * honour it. If each reader carried its own correction, the engine would slowly acquire one
 * format's habits as its defaults, and the next reader would be written to match the last
 * one's quirks rather than its own specification. So a reader's job is to report what its
 * file says, faithfully and with no opinion, and the single opinionated step happens once,
 * here, where it is written down and testable.
 *
 * **Why an override exists at all.** A file can be internally consistent and still disagree
 * with itself: an asset whose `GlobalSettings` declare Y-up while every node in it was
 * exported a half turn away is not malformed, and no amount of reading it more carefully
 * reveals which of the two statements the author meant. That is not a defect a reader can
 * repair, because the information is genuinely absent from the file — so it is supplied from
 * outside, by somebody who has looked at the model, and the baker prints what it was told.
 *
 * Every turn here is a **rotation**, never a mirror. A reflection would flip the handedness
 * of the geometry, which turns every triangle inside out and shades the model dark where it
 * should be lit, and it is not obvious in a bounding box — the numbers look right and the
 * render does not. Each entry in `TURNS` has determinant +1, so the winding a reader produced
 * is still the winding the rasteriser wants, and the index buffers are passed through
 * untouched.
 */

import type { DrftNode, MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';

/** Which way is up in the asset, as a signed axis of the engine's own frame. */
export type UpAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export const UP_AXES: readonly UpAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/**
 * The rotation that carries each axis onto the engine's `+y`, row-major 3x3.
 *
 * `-y` is the one genuinely ambiguous case: a half turn about X and a half turn about Z both
 * stand the asset up, and they differ by a half turn of yaw, which no amount of measurement
 * on the model can decide. X is the choice, because for an asset whose parts were exported
 * with a quarter turn already baked into them it reduces those to exactly the conventional
 * Z-up conversion rather than to that conversion plus an unexplained yaw.
 */
const TURNS: Readonly<Record<UpAxis, { readonly m: readonly number[]; readonly says: string }>> = {
  '+y': { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], says: 'already the engine frame, so nothing is turned' },
  '-y': { m: [1, 0, 0, 0, -1, 0, 0, 0, -1], says: 'a half turn about X' },
  '+z': {
    m: [1, 0, 0, 0, 0, 1, 0, -1, 0],
    says: 'a quarter turn about X, the conventional Z-up conversion',
  },
  '-z': { m: [1, 0, 0, 0, 0, -1, 0, 1, 0], says: 'a quarter turn about X, the other way' },
  '+x': { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], says: 'a quarter turn about Z' },
  '-x': { m: [0, 1, 0, -1, 0, 0, 0, 0, 1], says: 'a quarter turn about Z, the other way' },
};

/** Read an axis a person typed. `z` and `+z` mean the same thing; anything else is refused. */
export function parseUpAxis(text: string): UpAxis {
  const cleaned = text.trim().toLowerCase();
  const signed = cleaned.startsWith('+') || cleaned.startsWith('-') ? cleaned : `+${cleaned}`;
  const found = UP_AXES.find((axis) => axis === signed);
  if (found === undefined) {
    throw new DrftError(`"${text}" is not an axis. Use one of: ${UP_AXES.join(', ')}.`);
  }
  return found;
}

/** What the turn does, in words, for the line the baker prints. */
export function describeUpAxis(up: UpAxis): string {
  return (TURNS[up] as { says: string }).says;
}

function turnTriples(source: Float32Array, m: readonly number[]): Float32Array {
  const out = new Float32Array(source.length);
  const m0 = m[0] as number;
  const m1 = m[1] as number;
  const m2 = m[2] as number;
  const m3 = m[3] as number;
  const m4 = m[4] as number;
  const m5 = m[5] as number;
  const m6 = m[6] as number;
  const m7 = m[7] as number;
  const m8 = m[8] as number;
  for (let i = 0; i + 2 < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;
    out[i] = m0 * x + m1 * y + m2 * z;
    out[i + 1] = m3 * x + m4 * y + m5 * z;
    out[i + 2] = m6 * x + m7 * y + m8 * z;
  }
  return out;
}

/**
 * Stand an asset up, given which of its axes points at the sky.
 *
 * Normals take the same matrix as positions rather than an inverse transpose, and that is
 * exact rather than an approximation: for a rotation the two are the same matrix. There is
 * no scale here by construction, which is the other half of why.
 */
export function orientMeshes(meshes: readonly MeshData[], assetUp: UpAxis): MeshData[] {
  const { m } = TURNS[assetUp];
  return meshes.map((mesh) => ({
    ...mesh,
    positions: turnTriples(mesh.positions, m),
    normals: turnTriples(mesh.normals, m),
  }));
}

/**
 * Which way round a format's coordinate system is.
 *
 * **Every format read here is right-handed**, including the one that was declared left-handed for
 * two releases on the strength of the graphics API its authoring tool targets, and whose frame is
 * measured in the reader that reports it. The pair below is what a genuinely left-handed format
 * gets.
 */
export type Handedness = 'right' | 'left';

/**
 * Mirror an asset into the engine's right-handed frame, in place.
 *
 * **This is the one thing the `TURNS` table above deliberately cannot do**, and the paragraph at
 * the top of this file explaining why is still correct: an up-axis correction must be a rotation,
 * or it flips geometry that was already the right way round. A *handedness* conversion is the
 * opposite case — the geometry is genuinely mirrored, and refusing to mirror it is what would
 * leave it wrong. Keeping the two apart is what lets each stay honest about what it does.
 *
 * **Three changes, and all three or none.** Negating X alone turns every triangle inside out;
 * reversing the winding without flipping the bitangent sign lights every normal-mapped surface
 * backwards. Doing them together, here, is why this is a function and not three lines inside a
 * reader — the next left-handed format gets the same conversion and the same tests.
 *
 * UVs are untouched. A mirror moves the surface, not its parameterisation.
 */
export function convertHandedness(meshes: readonly MeshData[]): void {
  for (const mesh of meshes) {
    for (let at = 0; at < mesh.positions.length; at += 3) {
      mesh.positions[at] = -(mesh.positions[at] as number);
    }
    for (let at = 0; at < mesh.normals.length; at += 3) {
      mesh.normals[at] = -(mesh.normals[at] as number);
    }
    const tangents = mesh.tangents;
    if (tangents !== undefined) {
      for (let at = 0; at < tangents.length; at += 4) {
        tangents[at] = -(tangents[at] as number);
        tangents[at + 3] = -(tangents[at + 3] as number);
      }
    }
    for (let at = 0; at + 2 < mesh.indices.length; at += 3) {
      const middle = mesh.indices[at + 1] as number;
      mesh.indices[at + 1] = mesh.indices[at + 2] as number;
      mesh.indices[at + 2] = middle;
    }
  }
}

/**
 * Mirror an asset's hierarchy by the same reflection `convertHandedness` mirrors its geometry by.
 *
 * **The pair to `convertHandedness`, exactly as `orientNodes` is the pair to `orientMeshes`**, and
 * it did not exist: the one caller that mirrored a graph negated each node's translation X inline
 * and left the rotations alone. A hierarchy with rotations then places its parts where the
 * geometry is not — measured on a real car at **1.385 m apart and on the other side of the
 * model** — while both halves stay individually well formed, which is the worst shape this can
 * take and the reason the two functions now sit together.
 *
 * **The rotation is conjugated, not negated.** Reflecting a rotation `R` by a mirror `M` gives
 * `M R M`, which is a rotation about the mirrored axis in the opposite sense; as a quaternion that
 * is `(x, −y, −z, w)` for a reflection about the YZ plane. A scale is untouched, because `M S M`
 * is `S` for any diagonal.
 *
 * **Every node, not only the roots**, which is the one place this differs from `orientNodes`. A
 * rotation applied to a root already carries its descendants, so applying it to a child would
 * apply it twice. A reflection is a conjugation and conjugation distributes over the product —
 * `M (A B) M = (M A M)(M B M)` — so leaving a child alone drops the mirror out of the composition
 * rather than avoiding a double application.
 */
export function mirrorNodes(nodes: readonly DrftNode[]): DrftNode[] {
  return nodes.map((node) => ({
    ...node,
    translation: [-node.translation[0], node.translation[1], node.translation[2]],
    rotation: [node.rotation[0], -node.rotation[1], -node.rotation[2], node.rotation[3]],
  }));
}

/**
 * Turn an asset's hierarchy by the same rotation `orientMeshes` turns its geometry by.
 *
 * **Without this, `--up` silently desynchronises the two.** The meshes rotate and the graph does
 * not, so every node then claims a part is somewhere it no longer is — and nothing downstream can
 * detect it, because both halves are individually well formed. That is the worst shape a bug can
 * take in a bake, so the two turns happen together or the hierarchy is wrong.
 *
 * **Only roots are turned**, and that is not an optimisation: a child's transform is relative to
 * its parent, so rotating the parent already carries every descendant with it. Turning a child too
 * would apply the rotation twice.
 */
export function orientNodes(nodes: readonly DrftNode[], assetUp: UpAxis): DrftNode[] {
  const { m } = TURNS[assetUp];
  if (assetUp === '+y') return [...nodes];
  const turn = (v: readonly [number, number, number]): [number, number, number] => [
    (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
    (m[3] as number) * v[0] + (m[4] as number) * v[1] + (m[5] as number) * v[2],
    (m[6] as number) * v[0] + (m[7] as number) * v[1] + (m[8] as number) * v[2],
  ];

  /* The turn as a quaternion, so a root's own rotation composes with it. */
  const trace = (m[0] as number) + (m[4] as number) + (m[8] as number);
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [
      ((m[7] as number) - (m[5] as number)) / s,
      ((m[2] as number) - (m[6] as number)) / s,
      ((m[3] as number) - (m[1] as number)) / s,
      s / 4,
    ];
  } else if ((m[0] as number) > (m[4] as number) && (m[0] as number) > (m[8] as number)) {
    const s = Math.sqrt(1 + (m[0] as number) - (m[4] as number) - (m[8] as number)) * 2;
    q = [
      s / 4,
      ((m[1] as number) + (m[3] as number)) / s,
      ((m[2] as number) + (m[6] as number)) / s,
      ((m[7] as number) - (m[5] as number)) / s,
    ];
  } else if ((m[4] as number) > (m[8] as number)) {
    const s = Math.sqrt(1 + (m[4] as number) - (m[0] as number) - (m[8] as number)) * 2;
    q = [
      ((m[1] as number) + (m[3] as number)) / s,
      s / 4,
      ((m[5] as number) + (m[7] as number)) / s,
      ((m[2] as number) - (m[6] as number)) / s,
    ];
  } else {
    const s = Math.sqrt(1 + (m[8] as number) - (m[0] as number) - (m[4] as number)) * 2;
    q = [
      ((m[2] as number) + (m[6] as number)) / s,
      ((m[5] as number) + (m[7] as number)) / s,
      s / 4,
      ((m[3] as number) - (m[1] as number)) / s,
    ];
  }

  return nodes.map((node) => {
    if (node.parent >= 0) return node;
    const [bx, by, bz, bw] = node.rotation;
    return {
      ...node,
      translation: turn(node.translation),
      rotation: [
        q[3] * bx + q[0] * bw + q[1] * bz - q[2] * by,
        q[3] * by - q[0] * bz + q[1] * bw + q[2] * bx,
        q[3] * bz + q[0] * by - q[1] * bx + q[2] * bw,
        q[3] * bw - q[0] * bx - q[1] * by - q[2] * bz,
      ],
    };
  });
}
