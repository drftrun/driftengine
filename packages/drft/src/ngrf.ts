/**
 * `NGRF` — a network as a graph of operators, and its tensors, in either precision.
 *
 * **`NNET` describes a perceptron and cannot describe anything else**: its entry table has room for
 * inputs, eight hidden widths and outputs, and a transformer is attention, normalisation,
 * convolution and resampling between named values. So a graph is its own chunk, beside `NNET`
 * rather than in place of it — `NNET` stays the compact form for the small networks the texture
 * decode and reconstruction carry.
 *
 * **The chunk carries no semantics.** This package has no dependencies and knows nothing of what
 * `linear` or `attention` compute; the structure is plain data that `@driftengine/texture`'s graph
 * satisfies, and texture validates a graph it is handed, naming any operator it lacks — the
 * arrangement `DTEX` already has.
 *
 * **The structure is UTF-8 JSON and the tensors are bytes.** A graph's structure is small and read
 * once; JSON keeps it legible and lets an attribute be added without a layout change. It is checked
 * field by field on the way in, and every tensor's offset against the payload before one is viewed.
 * The tensors are stored as a device uploads them — `Float32Array` values or half-precision bits —
 * each block aligned to four bytes so it can be viewed rather than copied.
 *
 * ### Layout
 *
 * ```text
 * u32  count
 * count x:
 *   u32  role              a FourCC naming what the graph is for; unique in the chunk
 *   u32  structureBytes
 *   u32  payloadBytes
 *   structure             UTF-8 JSON: inputs, outputs, nodes, and a tensor directory of name,
 *                         shape, precision (16 or 32) and byte offset into the payload;
 *                         padded to four bytes
 *   payload               the tensors, each aligned to four bytes
 * ```
 *
 * **No per-chunk version and additive**, as every chunk here: a reader that does not know the code
 * skips it by its length and loses only the graphs. Added at 1.15.
 */
import { DrftError, align, fourCC, fourCCName } from './drftFormat.ts';

export type DrftAttribute = number | string | boolean | readonly number[];

export interface DrftGraphValue {
  readonly name: string;
  readonly shape: readonly number[];
}

export interface DrftGraphNode {
  readonly op: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly attributes: Readonly<Record<string, DrftAttribute>>;
}

export interface DrftGraphTensor {
  readonly name: string;
  readonly shape: readonly number[];
  /** Single-precision values, or half-precision bits as a device uploads them. */
  readonly data: Float32Array | Uint16Array;
}

export interface DrftGraph {
  /** Four printable characters naming what the graph is for. */
  readonly role: string;
  readonly inputs: readonly DrftGraphValue[];
  readonly outputs: readonly string[];
  readonly nodes: readonly DrftGraphNode[];
  readonly tensors: readonly DrftGraphTensor[];
}

interface DirectoryEntry {
  readonly name: string;
  readonly shape: readonly number[];
  readonly precision: 16 | 32;
  readonly offset: number;
}

/** A dimension past this is a corrupt file rather than a model: a product of four of them is 2^64. */
const MAX_DIMENSION = 1 << 24;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const count = (shape: readonly number[]): number => shape.reduce((total, d) => total * d, 1);

function printableRole(role: string): boolean {
  return (
    role.length === 4 && [...role].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e)
  );
}

/** Write the chunk. Refuses anything a reader would have to guess about. */
export function buildNgrf(graphs: readonly DrftGraph[]): Uint8Array {
  const roles = new Set<string>();
  const parts: { role: number; structure: Uint8Array; payload: Uint8Array }[] = [];
  for (const graph of graphs) {
    if (!printableRole(graph.role)) {
      throw new DrftError(
        `NGRF: the role ${JSON.stringify(graph.role)} is not four printable characters`,
      );
    }
    if (roles.has(graph.role)) {
      throw new DrftError(
        `NGRF: two graphs have the role ${graph.role}; a reader finds a graph by it`,
      );
    }
    roles.add(graph.role);
    const directory: DirectoryEntry[] = [];
    let payloadBytes = 0;
    for (const tensor of graph.tensors) {
      if (tensor.data.length !== count(tensor.shape)) {
        throw new DrftError(
          `NGRF ${graph.role}: tensor "${tensor.name}" holds ${tensor.data.length} values and its ` +
            `shape [${tensor.shape.join(', ')}] needs ${count(tensor.shape)}`,
        );
      }
      const precision = tensor.data instanceof Uint16Array ? 16 : 32;
      directory.push({ name: tensor.name, shape: tensor.shape, precision, offset: payloadBytes });
      payloadBytes += align(tensor.data.byteLength);
    }
    const structure = encoder.encode(
      JSON.stringify({
        inputs: graph.inputs,
        outputs: graph.outputs,
        nodes: graph.nodes,
        tensors: directory,
      }),
    );
    const payload = new Uint8Array(payloadBytes);
    for (const [i, tensor] of graph.tensors.entries()) {
      payload.set(
        new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength),
        (directory[i] as DirectoryEntry).offset,
      );
    }
    parts.push({ role: fourCC(graph.role), structure, payload });
  }
  let total = 4;
  for (const part of parts)
    total += 12 + align(part.structure.byteLength) + part.payload.byteLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, parts.length, true);
  let at = 4;
  for (const part of parts) {
    view.setUint32(at, part.role, true);
    view.setUint32(at + 4, part.structure.byteLength, true);
    view.setUint32(at + 8, part.payload.byteLength, true);
    bytes.set(part.structure, at + 12);
    at += 12 + align(part.structure.byteLength);
    bytes.set(part.payload, at);
    at += part.payload.byteLength;
  }
  return bytes;
}

function isShape(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((d) => Number.isInteger(d) && (d as number) > 0 && (d as number) <= MAX_DIMENSION)
  );
}

function isAttribute(value: unknown): value is DrftAttribute {
  return (
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'number'))
  );
}

/* The structure, checked field by field: JSON from a file is whatever the file says. */
function readStructure(
  label: string,
  text: string,
): {
  inputs: DrftGraphValue[];
  outputs: string[];
  nodes: DrftGraphNode[];
  tensors: DirectoryEntry[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DrftError(`${label}: the structure is not JSON`);
  }
  const s = parsed as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new DrftError(`${label}: ${what}`);
  };
  if (typeof s !== 'object' || s === null) fail('the structure is not an object');
  const inputs = s.inputs;
  const outputs = s.outputs;
  const nodes = s.nodes;
  const tensors = s.tensors;
  if (
    !Array.isArray(inputs) ||
    !inputs.every((i) => typeof i?.name === 'string' && isShape(i?.shape))
  ) {
    fail('inputs must each have a name and a shape');
  }
  if (!Array.isArray(outputs) || !outputs.every((o) => typeof o === 'string'))
    fail('outputs must be names');
  if (
    !Array.isArray(nodes) ||
    !nodes.every(
      (n) =>
        typeof n?.op === 'string' &&
        typeof n?.output === 'string' &&
        Array.isArray(n?.inputs) &&
        (n.inputs as unknown[]).every((i) => typeof i === 'string') &&
        typeof n?.attributes === 'object' &&
        n.attributes !== null &&
        Object.values(n.attributes as object).every(isAttribute),
    )
  ) {
    fail('nodes must each have an operator, input names, an output name and attributes');
  }
  if (
    !Array.isArray(tensors) ||
    !tensors.every(
      (t) =>
        typeof t?.name === 'string' &&
        isShape(t?.shape) &&
        (t?.precision === 16 || t?.precision === 32) &&
        Number.isInteger(t?.offset) &&
        (t.offset as number) >= 0 &&
        (t.offset as number) % 4 === 0,
    )
  ) {
    fail('tensors must each have a name, a shape, a precision of 16 or 32 and an aligned offset');
  }
  return {
    inputs: inputs as DrftGraphValue[],
    outputs: outputs as string[],
    nodes: nodes as DrftGraphNode[],
    tensors: tensors as DirectoryEntry[],
  };
}

/** Read the chunk, refusing every structure and offset a reader would otherwise have to trust. */
export function readNgrf(buffer: ArrayBuffer, offset: number, byteLength: number): DrftGraph[] {
  if (byteLength < 4) throw new DrftError('NGRF is too short to hold its count');
  const view = new DataView(buffer, offset, byteLength);
  const graphCount = view.getUint32(0, true);
  const graphs: DrftGraph[] = [];
  const roles = new Set<string>();
  let at = 4;
  for (let g = 0; g < graphCount; g += 1) {
    if (at + 12 > byteLength) throw new DrftError(`NGRF graph ${g} runs past the chunk`);
    const role = fourCCName(view.getUint32(at, true));
    const label = `NGRF ${role}`;
    if (roles.has(role))
      throw new DrftError(`${label} repeats a role; a reader finds a graph by it`);
    roles.add(role);
    const structureBytes = view.getUint32(at + 4, true);
    const payloadBytes = view.getUint32(at + 8, true);
    const structureAt = at + 12;
    const payloadAt = structureAt + align(structureBytes);
    if (payloadAt + payloadBytes > byteLength) {
      throw new DrftError(`${label}: its structure and payload run past the chunk`);
    }
    const structure = readStructure(
      label,
      decoder.decode(new Uint8Array(buffer, offset + structureAt, structureBytes)),
    );
    const tensors: DrftGraphTensor[] = [];
    for (const entry of structure.tensors) {
      const bytes = count(entry.shape) * (entry.precision / 8);
      if (entry.offset + bytes > payloadBytes) {
        throw new DrftError(
          `${label}: tensor "${entry.name}" needs ${bytes} bytes at ${entry.offset} and the payload has ${payloadBytes}`,
        );
      }
      const absolute = offset + payloadAt + entry.offset;
      const length = count(entry.shape);
      /* Viewed where the file's alignment allows, and copied where it does not. */
      const data =
        entry.precision === 32
          ? absolute % 4 === 0
            ? new Float32Array(buffer, absolute, length)
            : new Float32Array(buffer.slice(absolute, absolute + bytes))
          : absolute % 2 === 0
            ? new Uint16Array(buffer, absolute, length)
            : new Uint16Array(buffer.slice(absolute, absolute + bytes));
      tensors.push({ name: entry.name, shape: entry.shape, data });
    }
    graphs.push({
      role,
      inputs: structure.inputs,
      outputs: structure.outputs,
      nodes: structure.nodes,
      tensors,
    });
    at = payloadAt + payloadBytes;
  }
  return graphs;
}
