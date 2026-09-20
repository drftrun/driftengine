/**
 * The one network evaluator the device has, in single or half precision.
 *
 * **Every network the engine evaluates on a device goes through this text.** A DriftTexture's
 * decode interpreter reads its networks from uniform tables; reconstruction's refinement tier and
 * capture's priors read theirs from storage buffers, in half precision where the device has it.
 * Those are different bindings and the same arithmetic, so the arithmetic is written once and the
 * weights are reached through a function the including module defines — the arrangement
 * `shadow.wgsl.ts` uses for its map. A second evaluator would be a second set of numerical
 * conventions to keep in step, which `@driftengine/texture`'s `inference.ts` names as the thing this
 * engine refuses.
 *
 * **The reference is `evalNetwork`, and in half precision `evalNetworkHalf`**, operation for
 * operation: the weighted inputs summed in index order, then the bias, then the rectifier on hidden
 * layers and nothing on the output. The weights are laid out as `NNET` stores them — each layer's
 * matrix row by row by output, then its biases.
 *
 * **Half precision needs `enable f16;` at the top of the including module** and a device created
 * with `shader-f16`. It is chosen per network by its consumer, and `activationBound` is what that
 * consumer asks first: past 65,504 the format has no finite value.
 *
 * `scripts/gpu-parity.mjs` runs both instantiations against the references, and
 * `scripts/wgsl-handwritten.test.mjs` has `naga` validate them without a device.
 */

export interface NetworkWgslOptions {
  /** The prefix every function this defines carries, so a module can include more than one. */
  readonly name: string;
  /** The scalar the network computes in. `f16` needs `enable f16;` in the including module. */
  readonly scalar: 'f32' | 'f16';
  /** The widest layer, which is the length of the function-scope arrays the layers pass through. */
  readonly width: number;
  /** The most hidden layers a network may have here. */
  readonly hidden: number;
}

/**
 * The evaluator, as text.
 *
 * Defines `fn <name>Eval(first, inputs, hidden, widths, outputs, input) -> array<S, width>`:
 * `first` is where the network's weights start, `widths` its hidden widths, and `input` its first
 * `inputs` values. The including module defines `fn <name>Weight(index: u32) -> S`.
 *
 * **Every count is clamped to what the arrays hold.** A loader refuses a network wider or deeper
 * than this was instantiated for; the clamps are what keep a malformed one from indexing past a
 * function-scope array, which the language would otherwise clamp silently and differently.
 */
export function networkWgsl(options: NetworkWgslOptions): string {
  const { name, scalar: s, width: w, hidden: h } = options;
  return /* wgsl */ `
fn ${name}Eval(
  first: u32,
  inputs: u32,
  hidden: u32,
  widths: array<u32, ${h}>,
  outputs: u32,
  input: array<${s}, ${w}>,
) -> array<${s}, ${w}> {
  var current = input;
  var next: array<${s}, ${w}>;
  var at = first;
  var previous = min(inputs, ${w}u);
  let layers = min(hidden, ${h}u);
  for (var layer = 0u; layer < layers; layer = layer + 1u) {
    let width = min(widths[layer], ${w}u);
    for (var o = 0u; o < width; o = o + 1u) {
      var total = ${s}(0.0);
      for (var i = 0u; i < previous; i = i + 1u) {
        total = total + current[i] * ${name}Weight(at + o * previous + i);
      }
      /* Rectified linear on hidden layers and nothing on the output, as inference.ts insists. */
      next[o] = max(total + ${name}Weight(at + width * previous + o), ${s}(0.0));
    }
    at = at + previous * width + width;
    previous = width;
    current = next;
  }
  var result: array<${s}, ${w}>;
  let count = min(outputs, ${w}u);
  for (var o = 0u; o < count; o = o + 1u) {
    var total = ${s}(0.0);
    for (var i = 0u; i < previous; i = i + 1u) {
      total = total + current[i] * ${name}Weight(at + o * previous + i);
    }
    result[o] = total + ${name}Weight(at + count * previous + o);
  }
  return result;
}
`;
}

/** A network's shape, which the fixed form bakes in. The same shape `evalNetwork` takes. */
export interface FixedNetworkShape {
  readonly inputs: number;
  readonly hidden: readonly number[];
  readonly outputs: number;
}

export interface FixedNetworkWgslOptions {
  /** The prefix every function this defines carries, as for the variable form. */
  readonly name: string;
  readonly scalar: 'f32' | 'f16';
  readonly shape: FixedNetworkShape;
  /** Where the network's weights start in what `<name>Weight` reads. */
  readonly first?: number;
}

/**
 * The same evaluator with its shape fixed when the pipeline is built, for a consumer whose network
 * is known then — reconstruction's refinement tier, capture's priors.
 *
 * **Nine to fourteen times faster, measured**, 2026-09-19 on an RX 9070 XT, once per pixel of a
 * 1280×720 frame: a network of 11-8-3 in 0.031 ms against the variable form's 0.286, and 11-16-16-3
 * in 0.076 against 1.09 (`tools/recon-train/budget.ts`). The variable form indexes function-scope
 * arrays with counts it reads at run time, which a compiler cannot keep in registers; with every
 * count a constant the loops unroll and the arrays are registers. The DriftTexture interpreter keeps
 * the variable form, because its networks change per material and its pipeline does not.
 *
 * **The arithmetic is the variable form's, in the same order** — the weighted inputs summed in index
 * order, then the bias, then the rectifier on hidden layers and nothing on the output, over weights
 * laid out as `NNET` stores them — so `evalNetwork` and `evalNetworkHalf` are its references too,
 * and `gpu-parity.mjs` holds it to them the same way.
 *
 * Defines `fn <name>Eval(input: array<S, inputs>) -> array<S, outputs>`. The including module
 * defines `fn <name>Weight(index: u32) -> S`, as for the variable form.
 */
export function networkFixedWgsl(options: FixedNetworkWgslOptions): string {
  const { name, scalar: s, shape } = options;
  const layers = [shape.inputs, ...shape.hidden, shape.outputs];
  let at = options.first ?? 0;
  let body = '';
  let previous = 'input';
  for (let layer = 1; layer < layers.length; layer += 1) {
    const width = layers[layer] as number;
    const fanIn = layers[layer - 1] as number;
    const output = layer === layers.length - 1;
    const target = output ? 'result' : `layer${layer}`;
    const bias = at + width * fanIn;
    const value = output
      ? `total + ${name}Weight(${bias}u + o)`
      : `max(total + ${name}Weight(${bias}u + o), ${s}(0.0))`;
    body += `
  var ${target}: array<${s}, ${width}>;
  for (var o = 0u; o < ${width}u; o = o + 1u) {
    var total = ${s}(0.0);
    for (var i = 0u; i < ${fanIn}u; i = i + 1u) {
      total = total + ${previous}[i] * ${name}Weight(${at}u + o * ${fanIn}u + i);
    }
    ${target}[o] = ${value};
  }`;
    at = bias + width;
    previous = target;
  }
  return /* wgsl */ `
fn ${name}Eval(input: array<${s}, ${shape.inputs}>) -> array<${s}, ${shape.outputs}> {${body}
  return result;
}
`;
}

/**
 * An entry point that evaluates one fixed-shape network over many inputs, so a harness can hold
 * the fixed form to `evalNetwork` and `evalNetworkHalf` as it holds the variable one. Inputs and
 * outputs cross as `f32`, as the variable form's parity entry point has them.
 */
export function networkFixedParityWgsl(scalar: 'f32' | 'f16', shape: FixedNetworkShape): string {
  return /* wgsl */ `${scalar === 'f16' ? 'enable f16;\n' : ''}
@group(0) @binding(0) var<storage, read> weights: array<${scalar}>;
@group(0) @binding(1) var<storage, read> inputs: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputs: array<f32>;

fn parityWeight(index: u32) -> ${scalar} {
  return weights[index];
}
${networkFixedWgsl({ name: 'parity', scalar, shape })}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let count = arrayLength(&inputs) / ${shape.inputs}u;
  if (id.x >= count) { return; }
  var input: array<${scalar}, ${shape.inputs}>;
  for (var i = 0u; i < ${shape.inputs}u; i = i + 1u) {
    input[i] = ${scalar}(inputs[id.x * ${shape.inputs}u + i]);
  }
  let result = parityEval(input);
  for (var o = 0u; o < ${shape.outputs}u; o = o + 1u) {
    outputs[id.x * ${shape.outputs}u + o] = f32(result[o]);
  }
}
`;
}

/** The widest network the parity entry points evaluate. */
export const NETWORK_PARITY_WIDTH = 16;
/** The deepest. */
export const NETWORK_PARITY_HIDDEN = 4;
/** Unsigned words per case: first, inputs, hidden count, outputs, then the hidden widths. */
export const NETWORK_CASE_WORDS = 4 + NETWORK_PARITY_HIDDEN;

/**
 * An entry point that evaluates one network per invocation from storage buffers, so a harness can
 * compare the device with `evalNetwork` or `evalNetworkHalf`.
 *
 * Inputs and outputs cross as `f32` whatever the network computes in: a half-precision network's
 * inputs are converted on the way in, as `evalNetworkHalf` rounds them, and its outputs widen on
 * the way out, which loses nothing.
 */
export function networkParityWgsl(scalar: 'f32' | 'f16'): string {
  const w = NETWORK_PARITY_WIDTH;
  return /* wgsl */ `${scalar === 'f16' ? 'enable f16;\n' : ''}
@group(0) @binding(0) var<storage, read> cases: array<u32>;
@group(0) @binding(1) var<storage, read> weights: array<${scalar}>;
@group(0) @binding(2) var<storage, read> inputs: array<f32>;
@group(0) @binding(3) var<storage, read_write> outputs: array<f32>;

fn parityWeight(index: u32) -> ${scalar} {
  return weights[index];
}
${networkWgsl({ name: 'parity', scalar, width: w, hidden: NETWORK_PARITY_HIDDEN })}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let count = arrayLength(&cases) / ${NETWORK_CASE_WORDS}u;
  if (id.x >= count) { return; }
  let at = id.x * ${NETWORK_CASE_WORDS}u;
  var widths: array<u32, ${NETWORK_PARITY_HIDDEN}>;
  for (var layer = 0u; layer < ${NETWORK_PARITY_HIDDEN}u; layer = layer + 1u) {
    widths[layer] = cases[at + 4u + layer];
  }
  var input: array<${scalar}, ${w}>;
  for (var i = 0u; i < ${w}u; i = i + 1u) {
    input[i] = ${scalar}(inputs[id.x * ${w}u + i]);
  }
  let result = parityEval(cases[at], cases[at + 1u], cases[at + 2u], widths, cases[at + 3u], input);
  for (var o = 0u; o < ${w}u; o = o + 1u) {
    outputs[id.x * ${w}u + o] = f32(result[o]);
  }
}
`;
}
