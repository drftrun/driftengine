/**
 * What every device kernel shares: its request, its source, its bindings, and a per-element grid.
 *
 * **Every size is baked into the source as a constant**, because a graph's shapes are fixed when
 * the runner is built: loops with constant bounds are what a compiler unrolls and schedules, and
 * `networkFixedWgsl` measured the difference at nine to fourteen times against bounds read from a
 * uniform. The cost is one pipeline per node, built once.
 *
 * **Inputs bind at 0 to n − 1, read-only, and the output at n, the only buffer written** — the order
 * the runner builds its bind groups in and `scripts/inference-parity.mjs` binds its buffers in.
 *
 * **Half precision is a storage choice here, not an arithmetic one.** A weight stored as `f16` is
 * read and widened, and every sum accumulates in `f32`: half the memory and bandwidth for the
 * weights, and the reference's answer on half-rounded weights to single-precision tolerance. What
 * it gives up is half-precision arithmetic's speed on devices that have it; measuring that against
 * a model's error is the step after this one, not an assumption in it.
 */
import type { DeviceAttribute } from './deviceGraph.ts';

export type ElementType = 'f32' | 'f16';

export interface KernelRequest {
  readonly inputShapes: readonly (readonly number[])[];
  readonly outputShape: readonly number[];
  readonly attributes: Readonly<Record<string, DeviceAttribute>>;
  /** What each input is stored as: `f16` only for a weight kept at half precision. */
  readonly inputTypes: readonly ElementType[];
}

export interface KernelSource {
  readonly code: string;
  readonly workgroups: readonly [number, number, number];
}

export type KernelGenerator = (request: KernelRequest) => KernelSource;

/** Invocations a workgroup of a per-element kernel holds. */
export const GROUP = 64;
/** The most workgroups one dimension of a dispatch may ask for. */
const MAX_GROUPS = 65535;

export function num(
  attributes: Readonly<Record<string, DeviceAttribute>>,
  name: string,
  fallback?: number,
): number {
  const value = attributes[name];
  if (typeof value === 'number') return value;
  if (fallback !== undefined) return fallback;
  throw new RangeError(`attribute "${name}" must be a number`);
}

export function list(
  attributes: Readonly<Record<string, DeviceAttribute>>,
  name: string,
): readonly number[] {
  const value = attributes[name];
  return Array.isArray(value) ? (value as readonly number[]) : [];
}

export function size(shape: readonly number[]): number {
  let total = 1;
  for (const d of shape) total *= d;
  return total;
}

/** A WGSL float literal that is a float whatever the number is. */
export function float(value: number): string {
  const text = value.toPrecision(12);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/** The bindings, and `enable f16;` first when any input is stored at half precision. */
export function header(request: KernelRequest): string {
  const half = request.inputTypes.includes('f16');
  const lines: string[] = half ? ['enable f16;'] : [];
  request.inputTypes.forEach((type, i) => {
    lines.push(`@group(0) @binding(${i}) var<storage, read> input${i}: array<${type}>;`);
  });
  lines.push(
    `@group(0) @binding(${request.inputTypes.length}) var<storage, read_write> output: array<f32>;`,
  );
  return lines.join('\n');
}

/** An expression reading input `i` at `index`, widened to `f32` where it is stored as `f16`. */
export function read(request: KernelRequest, i: number, index: string): string {
  return request.inputTypes[i] === 'f16' ? `f32(input${i}[${index}])` : `input${i}[${index}]`;
}

/**
 * A kernel with one invocation per element of its output, `count` of them, laid over as many
 * dimensions of workgroups as the dispatch limit needs. `body` sees the element's index as `i`.
 */
export function perElement(request: KernelRequest, count: number, body: string): KernelSource {
  const groups = Math.max(1, Math.ceil(count / GROUP));
  const across = Math.min(groups, MAX_GROUPS);
  const down = Math.ceil(groups / across);
  return {
    code: `${header(request)}

@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * ${across * GROUP}u;
  if (i >= ${count}u) { return; }
${body}
}
`,
    workgroups: [across, down, 1],
  };
}

/** A grid of one workgroup per row, `rows` of them, across as many dimensions as it needs. */
export function perRow(rows: number): { workgroups: [number, number, number]; row: string } {
  const across = Math.min(Math.max(1, rows), MAX_GROUPS);
  return {
    workgroups: [across, Math.ceil(Math.max(1, rows) / across), 1],
    row: `group.x + group.y * ${across}u`,
  };
}
