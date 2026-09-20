/**
 * `NNET` — the weights of the small networks the engine evaluates, in either precision.
 *
 * **One chunk for every network a file carries, each found by its role.** A role is a FourCC the
 * consumer chooses — reconstruction's refinement tier, a capture stage's prior — so a file can carry
 * several and a reader asks for the one it wants rather than counting. Two networks with one role
 * would make that question ambiguous, so the writer and the reader both refuse them.
 *
 * **The shape is carried, and the weight count has to agree with it.** A network whose weights are
 * all present and whose shape says they are laid out differently is the corruption that reads as a
 * working file: every weight lands in some layer, the evaluator runs, and the output is wrong
 * everywhere. The layout is `@driftengine/texture`'s `evalNetwork`: for each layer, the weight
 * matrix row by row by output, then the biases. `nnetWeightCount` is that formula, and
 * `@driftengine/assets` holds it equal to `networkWeightCount` — the two packages cannot import one
 * another, so a test that can import both is what keeps them one convention.
 *
 * **Sixteen or thirty-two bits, per network.** Half precision is what a device with `shader-f16`
 * runs, and the bits are stored as they will be uploaded rather than converted here — `halfWeights`
 * in `@driftengine/texture` is the one place a float becomes half-precision bits.
 *
 * **No per-chunk version field**, matching `SDFV`, `MSHL`, `DTEX` and every other chunk here, and
 * **additive**: a reader that does not know the code skips it by its length and loses only the
 * networks, which it had nothing to evaluate them with anyway.
 *
 * ### Layout
 *
 * ```text
 * u32  count
 * count x NNET_ENTRY_BYTES:
 *   u32  role          a FourCC naming what the network is for
 *   u32  inputs
 *   u32  outputs
 *   u32  hiddenCount   at most NNET_MAX_HIDDEN
 *   u32  hidden[8]     widths; the slots past hiddenCount are zero
 *   u32  precision     16 or 32
 *   u32  weightCount
 * weights               every network's weights back to back, in entry order: four bytes each at
 *                       32 bits, two at 16, each block padded to a four-byte boundary
 * ```
 *
 * **The padding is what lets every block be viewed rather than copied.** An odd number of
 * sixteen-bit weights ends two bytes short of a boundary, and a `Float32Array` cannot be taken at an
 * offset that is not a multiple of four.
 */

import { DrftError, align, fourCC, fourCCName } from './drftFormat.ts';

/** Role, three counts, eight widths, precision and weight count. */
export const NNET_ENTRY_BYTES = 56;

/** Hidden layers the entry table has room for. */
export const NNET_MAX_HIDDEN = 8;

/**
 * The widest layer a network may declare.
 *
 * **A bound on the arithmetic, not on ambition.** A width is a `u32` read out of a file and two of
 * them multiply into a weight count, so a corrupt pair asks for an allocation the size of the
 * address space. 4,096 is far past anything the device evaluates — its widest is sixteen — and
 * keeps every product of two widths comfortably inside the integers a double holds exactly.
 */
export const NNET_MAX_WIDTH = 4096;

export interface DrftNetwork {
  /** Four printable characters naming what the network is for. */
  readonly role: string;
  readonly inputs: number;
  /** Hidden layer widths, input side first. At most `NNET_MAX_HIDDEN`. */
  readonly hidden: readonly number[];
  readonly outputs: number;
  /** Single-precision weights, or half-precision bits as the device uploads them. */
  readonly weights: Float32Array | Uint16Array;
}

export interface DrftNnet {
  readonly networks: readonly DrftNetwork[];
}

/** How many weights and biases a shape needs, in `evalNetwork`'s layout. */
export function nnetWeightCount(
  inputs: number,
  hidden: readonly number[],
  outputs: number,
): number {
  let total = 0;
  let previous = inputs;
  for (const width of hidden) {
    total += previous * width + width;
    previous = width;
  }
  return total + previous * outputs + outputs;
}

function describeShape(inputs: number, hidden: readonly number[], outputs: number): string {
  return [inputs, ...hidden, outputs].join(' → ');
}

/* Four characters from space to tilde, which is what a FourCC a person chose looks like. */
function printableRole(role: string): boolean {
  if (role.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const code = role.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function refuseWidth(label: string, width: number): void {
  if (!(width >= 1 && width <= NNET_MAX_WIDTH)) {
    throw new DrftError(
      `${label} declares a width of ${width}; a layer is between 1 and ${NNET_MAX_WIDTH} wide`,
    );
  }
}

/** Write the chunk. Refuses anything a reader would have to guess about. */
export function buildNnet(nnet: DrftNnet): Uint8Array {
  const roles = new Set<string>();
  let weightBytes = 0;
  for (const [at, network] of nnet.networks.entries()) {
    const label = `NNET network ${at}`;
    if (!printableRole(network.role)) {
      throw new DrftError(
        `${label} has the role ${JSON.stringify(network.role)}; a role is four printable characters`,
      );
    }
    if (roles.has(network.role)) {
      throw new DrftError(
        `${label} repeats the role ${network.role}; a reader finds a network by it`,
      );
    }
    roles.add(network.role);
    if (network.hidden.length > NNET_MAX_HIDDEN) {
      throw new DrftError(
        `${label} has ${network.hidden.length} hidden layers and the table holds ${NNET_MAX_HIDDEN}`,
      );
    }
    for (const width of [network.inputs, ...network.hidden, network.outputs]) {
      refuseWidth(label, width);
    }
    const expected = nnetWeightCount(network.inputs, network.hidden, network.outputs);
    if (network.weights.length !== expected) {
      throw new DrftError(
        `${label} (${network.role}) is ${describeShape(network.inputs, network.hidden, network.outputs)}, ` +
          `which needs ${expected} weights, and carries ${network.weights.length}`,
      );
    }
    weightBytes += align(network.weights.byteLength);
  }

  const table = 4 + nnet.networks.length * NNET_ENTRY_BYTES;
  const bytes = new Uint8Array(table + weightBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, nnet.networks.length, true);

  let at = 4;
  let block = table;
  for (const network of nnet.networks) {
    view.setUint32(at, fourCC(network.role), true);
    view.setUint32(at + 4, network.inputs, true);
    view.setUint32(at + 8, network.outputs, true);
    view.setUint32(at + 12, network.hidden.length, true);
    for (const [layer, width] of network.hidden.entries()) {
      view.setUint32(at + 16 + layer * 4, width, true);
    }
    const half = network.weights instanceof Uint16Array;
    view.setUint32(at + 48, half ? 16 : 32, true);
    view.setUint32(at + 52, network.weights.length, true);
    bytes.set(
      new Uint8Array(
        network.weights.buffer,
        network.weights.byteOffset,
        network.weights.byteLength,
      ),
      block,
    );
    at += NNET_ENTRY_BYTES;
    block += align(network.weights.byteLength);
  }
  return bytes;
}

/** Read the chunk, refusing every shape a reader would otherwise have to trust. */
export function readNnet(buffer: ArrayBuffer, offset: number, byteLength: number): DrftNnet {
  if (byteLength < 4) throw new DrftError('NNET is too short to hold its count');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);

  const table = 4 + count * NNET_ENTRY_BYTES;
  /* The count first, before anything derived from it is trusted — `SDFV` says why. */
  if (table > byteLength) {
    throw new DrftError(
      `NNET declares ${count} networks, which needs ${table} bytes of table, and the chunk has ` +
        `${byteLength}`,
    );
  }

  const networks: DrftNetwork[] = [];
  const roles = new Set<string>();
  let block = table;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * NNET_ENTRY_BYTES;
    const role = fourCCName(view.getUint32(at, true));
    const label = `NNET network ${i} (${role})`;
    if (roles.has(role)) {
      throw new DrftError(`${label} repeats a role; a reader finds a network by it`);
    }
    roles.add(role);
    const inputs = view.getUint32(at + 4, true);
    const outputs = view.getUint32(at + 8, true);
    const hiddenCount = view.getUint32(at + 12, true);
    if (hiddenCount > NNET_MAX_HIDDEN) {
      throw new DrftError(
        `${label} declares ${hiddenCount} hidden layers and the table holds ${NNET_MAX_HIDDEN}`,
      );
    }
    const hidden: number[] = [];
    for (let layer = 0; layer < hiddenCount; layer++) {
      hidden.push(view.getUint32(at + 16 + layer * 4, true));
    }
    for (const width of [inputs, ...hidden, outputs]) refuseWidth(label, width);

    const precision = view.getUint32(at + 48, true);
    if (precision !== 16 && precision !== 32) {
      throw new DrftError(`${label} declares ${precision}-bit weights; the layout holds 16 or 32`);
    }
    const weightCount = view.getUint32(at + 52, true);
    const expected = nnetWeightCount(inputs, hidden, outputs);
    if (weightCount !== expected) {
      throw new DrftError(
        `${label} carries ${weightCount} weights, and its shape ` +
          `${describeShape(inputs, hidden, outputs)} needs ${expected}`,
      );
    }
    const blockBytes = weightCount * (precision / 8);
    if (block + blockBytes > byteLength) {
      throw new DrftError(
        `${label} carries ${blockBytes} bytes of weights, and the chunk has ` +
          `${byteLength - block} left`,
      );
    }
    const weights =
      precision === 32
        ? new Float32Array(buffer, offset + block, weightCount)
        : new Uint16Array(buffer, offset + block, weightCount);
    networks.push({ role, inputs, hidden, outputs, weights });
    block += align(blockBytes);
  }
  return { networks };
}
