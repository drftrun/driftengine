/**
 * The little matrix arithmetic a `.blend` scene needs, in the conventions Blender stores it in.
 *
 * Column-major 4x4 as plain number arrays, which is both how Blender lays out `float[4][4]` in a
 * file and how glTF writes `matrix`, so a matrix read from one is written to the other without a
 * transpose. Doubles throughout: these run once per object at import, and a parent chain composes
 * enough of them that single precision drifts visibly on a deep rig.
 *
 * **Every rotation here is Blender's definition, not a generic one**, because a rotation mode is a
 * claim about order: Blender's `XYZ` turns about X first, so its matrix is `Rz · Ry · Rx`. The
 * fixtures under `scripts/fixtures/blend` hold an object in each of the eight modes and Blender's
 * own export of where they ended up.
 */

export type Mat4 = number[];
export type Mat3 = number[];

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[k * 3 + r] as number) * (b[c * 3 + k] as number);
      out[c * 3 + r] = sum;
    }
  }
  return out;
}

export function invert(m: Mat4): Mat4 {
  const a = m;
  const inv = new Array<number>(16);
  const g = (i: number): number => a[i] as number;
  inv[0] =
    g(5) * g(10) * g(15) -
    g(5) * g(11) * g(14) -
    g(9) * g(6) * g(15) +
    g(9) * g(7) * g(14) +
    g(13) * g(6) * g(11) -
    g(13) * g(7) * g(10);
  inv[4] =
    -g(4) * g(10) * g(15) +
    g(4) * g(11) * g(14) +
    g(8) * g(6) * g(15) -
    g(8) * g(7) * g(14) -
    g(12) * g(6) * g(11) +
    g(12) * g(7) * g(10);
  inv[8] =
    g(4) * g(9) * g(15) -
    g(4) * g(11) * g(13) -
    g(8) * g(5) * g(15) +
    g(8) * g(7) * g(13) +
    g(12) * g(5) * g(11) -
    g(12) * g(7) * g(9);
  inv[12] =
    -g(4) * g(9) * g(14) +
    g(4) * g(10) * g(13) +
    g(8) * g(5) * g(14) -
    g(8) * g(6) * g(13) -
    g(12) * g(5) * g(10) +
    g(12) * g(6) * g(9);
  inv[1] =
    -g(1) * g(10) * g(15) +
    g(1) * g(11) * g(14) +
    g(9) * g(2) * g(15) -
    g(9) * g(3) * g(14) -
    g(13) * g(2) * g(11) +
    g(13) * g(3) * g(10);
  inv[5] =
    g(0) * g(10) * g(15) -
    g(0) * g(11) * g(14) -
    g(8) * g(2) * g(15) +
    g(8) * g(3) * g(14) +
    g(12) * g(2) * g(11) -
    g(12) * g(3) * g(10);
  inv[9] =
    -g(0) * g(9) * g(15) +
    g(0) * g(11) * g(13) +
    g(8) * g(1) * g(15) -
    g(8) * g(3) * g(13) -
    g(12) * g(1) * g(11) +
    g(12) * g(3) * g(9);
  inv[13] =
    g(0) * g(9) * g(14) -
    g(0) * g(10) * g(13) -
    g(8) * g(1) * g(14) +
    g(8) * g(2) * g(13) +
    g(12) * g(1) * g(10) -
    g(12) * g(2) * g(9);
  inv[2] =
    g(1) * g(6) * g(15) -
    g(1) * g(7) * g(14) -
    g(5) * g(2) * g(15) +
    g(5) * g(3) * g(14) +
    g(13) * g(2) * g(7) -
    g(13) * g(3) * g(6);
  inv[6] =
    -g(0) * g(6) * g(15) +
    g(0) * g(7) * g(14) +
    g(4) * g(2) * g(15) -
    g(4) * g(3) * g(14) -
    g(12) * g(2) * g(7) +
    g(12) * g(3) * g(6);
  inv[10] =
    g(0) * g(5) * g(15) -
    g(0) * g(7) * g(13) -
    g(4) * g(1) * g(15) +
    g(4) * g(3) * g(13) +
    g(12) * g(1) * g(7) -
    g(12) * g(3) * g(5);
  inv[14] =
    -g(0) * g(5) * g(14) +
    g(0) * g(6) * g(13) +
    g(4) * g(1) * g(14) -
    g(4) * g(2) * g(13) -
    g(12) * g(1) * g(6) +
    g(12) * g(2) * g(5);
  inv[3] =
    -g(1) * g(6) * g(11) +
    g(1) * g(7) * g(10) +
    g(5) * g(2) * g(11) -
    g(5) * g(3) * g(10) -
    g(9) * g(2) * g(7) +
    g(9) * g(3) * g(6);
  inv[7] =
    g(0) * g(6) * g(11) -
    g(0) * g(7) * g(10) -
    g(4) * g(2) * g(11) +
    g(4) * g(3) * g(10) +
    g(8) * g(2) * g(7) -
    g(8) * g(3) * g(6);
  inv[11] =
    -g(0) * g(5) * g(11) +
    g(0) * g(7) * g(9) +
    g(4) * g(1) * g(11) -
    g(4) * g(3) * g(9) -
    g(8) * g(1) * g(7) +
    g(8) * g(3) * g(5);
  inv[15] =
    g(0) * g(5) * g(10) -
    g(0) * g(6) * g(9) -
    g(4) * g(1) * g(10) +
    g(4) * g(2) * g(9) +
    g(8) * g(1) * g(6) -
    g(8) * g(2) * g(5);
  const det =
    g(0) * (inv[0] as number) +
    g(1) * (inv[4] as number) +
    g(2) * (inv[8] as number) +
    g(3) * (inv[12] as number);
  /* Blender's `invert_m4` leaves a singular matrix as it found it, and so does this. */
  if (Math.abs(det) < 1e-30) return [...m];
  return inv.map((v) => v / det);
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Rotation and scale in a 3x3, translation beside it: `T · R · S`. */
export function compose(
  location: readonly number[],
  rotation: Mat3,
  scale: readonly number[],
): Mat4 {
  const out = identity();
  for (let c = 0; c < 3; c++) {
    const s = scale[c] as number;
    for (let r = 0; r < 3; r++) out[c * 4 + r] = (rotation[c * 3 + r] as number) * s;
  }
  out[12] = location[0] as number;
  out[13] = location[1] as number;
  out[14] = location[2] as number;
  return out;
}

function axis(index: 0 | 1 | 2, angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (index === 0) return [1, 0, 0, 0, c, s, 0, -s, c];
  if (index === 1) return [c, 0, -s, 0, 1, 0, s, 0, c];
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/**
 * Blender's Euler rotation modes, by the value `Object.rotmode` stores: 1 `XYZ` to 6 `ZYX`.
 * Each names the axes in the order they are turned about.
 */
const ORDERS: Record<number, readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]> = {
  1: [0, 1, 2],
  2: [0, 2, 1],
  3: [1, 0, 2],
  4: [1, 2, 0],
  5: [2, 0, 1],
  6: [2, 1, 0],
};

export function eulerMatrix(e: readonly number[], mode: number): Mat3 {
  const order = ORDERS[mode] ?? ORDERS[1];
  const [first, second, third] = order as readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  const turn = (i: 0 | 1 | 2): Mat3 => axis(i, e[i] as number);
  return multiply3(turn(third), multiply3(turn(second), turn(first)));
}

/** A quaternion as Blender stores it, `w` first, normalised before use as Blender does. */
export function quaternionMatrix(q: readonly number[]): Mat3 {
  let [w, x, y, z] = q as [number, number, number, number];
  const length = Math.hypot(w, x, y, z);
  if (length < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  w /= length;
  x /= length;
  y /= length;
  z /= length;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ];
}

export function axisAngleMatrix(direction: readonly number[], angle: number): Mat3 {
  const [x, y, z] = direction as [number, number, number];
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = Math.sin(angle / 2) / length;
  return quaternionMatrix([Math.cos(angle / 2), x * s, y * s, z * s]);
}

/** Transform a point by a column-major 4x4. */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const g = (i: number): number => m[i] as number;
  return [
    g(0) * x + g(4) * y + g(8) * z + g(12),
    g(1) * x + g(5) * y + g(9) * z + g(13),
    g(2) * x + g(6) * y + g(10) * z + g(14),
  ];
}
