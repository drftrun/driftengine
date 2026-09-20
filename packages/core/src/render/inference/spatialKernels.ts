/**
 * The spatial operators on the device: convolution, its transpose, patch embedding, resizing and
 * max pooling.
 *
 * **One invocation per output element, each gathering what it reads**, in the layouts of the
 * references in `@driftengine/texture`'s `spatial.ts` — channel-major images and the upstream's
 * weight layouts. A transposed convolution is written as a gather, not the reference's scatter, so
 * no two invocations write one element; the two agree because each output sums the same products.
 *
 * **Resizing bakes the reference's conventions as constants**: the half-pixel source without aligned
 * corners, clamped below zero for bilinear only, stepping by the node's own step where it gives one;
 * the corner-to-corner scale with them, and zero for an output of one; and the cubic kernel at
 * a = −0.75 with its taps clamped to the border.
 *
 * What it gives up: a gather per output reads its whole window from storage with no reuse between
 * neighbours, which is the cost a tiled convolution removes. Measured against a DPT head's largest,
 * a 3×3 of 32 channels at 518², it is 3.2 ms — 1.5 TFLOP/s where the tiled multiply reaches 4.5 on
 * the same device (an RX 9070 XT) — so the decoder's convolutions are the second thing to tile.
 */
import { type KernelGenerator, float, num, perElement, read, size } from './kernelKit.ts';

/* Grouped, output `o` reads the `perGroup` channels from `first`: its group's run of the input. */
const conv2d: KernelGenerator = (request) => {
  const [, h, w] = request.inputShapes[0] as [number, number, number];
  const [, perGroup, kh, kw] = request.inputShapes[1] as [number, number, number, number];
  const [cout, oh, ow] = request.outputShape as [number, number, number];
  const outPerGroup = cout / num(request.attributes, 'groups', 1);
  const stride = num(request.attributes, 'stride', 1);
  const padding = num(request.attributes, 'padding', 0);
  const bias = request.inputShapes.length > 2 ? read(request, 2, 'o') : '0.0';
  return perElement(
    request,
    size(request.outputShape),
    `  let o = i / ${oh * ow}u;
  let y = i32((i / ${ow}u) % ${oh}u);
  let x = i32(i % ${ow}u);
  let first = (o / ${outPerGroup}u) * ${perGroup}u;
  var sum = ${bias};
  for (var c = 0u; c < ${perGroup}u; c = c + 1u) {
    for (var ky = 0; ky < ${kh}; ky = ky + 1) {
      let sy = y * ${stride} - ${padding} + ky;
      if (sy < 0 || sy >= ${h}) { continue; }
      for (var kx = 0; kx < ${kw}; kx = kx + 1) {
        let sx = x * ${stride} - ${padding} + kx;
        if (sx < 0 || sx >= ${w}) { continue; }
        sum = sum + ${read(request, 0, `((first + c) * ${h}u + u32(sy)) * ${w}u + u32(sx)`)} * ${read(request, 1, `((o * ${perGroup}u + c) * ${kh}u + u32(ky)) * ${kw}u + u32(kx)`)};
      }
    }
  }
  output[i] = sum;`,
  );
};

const convTranspose2d: KernelGenerator = (request) => {
  const [cin, h, w] = request.inputShapes[0] as [number, number, number];
  const [, cout, kh, kw] = request.inputShapes[1] as [number, number, number, number];
  const [, oh, ow] = request.outputShape as [number, number, number];
  const stride = num(request.attributes, 'stride', 1);
  const padding = num(request.attributes, 'padding', 0);
  const bias = request.inputShapes.length > 2 ? read(request, 2, 'o') : '0.0';
  return perElement(
    request,
    size(request.outputShape),
    `  let o = i / ${oh * ow}u;
  let ty = i32((i / ${ow}u) % ${oh}u);
  let tx = i32(i % ${ow}u);
  var sum = ${bias};
  for (var ky = 0; ky < ${kh}; ky = ky + 1) {
    let sy = ty + ${padding} - ky;
    if (sy < 0 || sy % ${stride} != 0 || sy / ${stride} >= ${h}) { continue; }
    for (var kx = 0; kx < ${kw}; kx = kx + 1) {
      let sx = tx + ${padding} - kx;
      if (sx < 0 || sx % ${stride} != 0 || sx / ${stride} >= ${w}) { continue; }
      for (var c = 0u; c < ${cin}u; c = c + 1u) {
        sum = sum + ${read(request, 0, `(c * ${h}u + u32(sy / ${stride})) * ${w}u + u32(sx / ${stride})`)} * ${read(request, 1, `((c * ${cout}u + o) * ${kh}u + u32(ky)) * ${kw}u + u32(kx)`)};
      }
    }
  }
  output[i] = sum;`,
  );
};

const patchEmbed: KernelGenerator = (request) => {
  const [cin, h, w] = request.inputShapes[0] as [number, number, number];
  const dim = (request.inputShapes[1] as readonly number[])[0] as number;
  const patch = num(request.attributes, 'patch');
  const cols = Math.floor(w / patch);
  const bias = request.inputShapes.length > 2 ? read(request, 2, 'o') : '0.0';
  return perElement(
    request,
    size(request.outputShape),
    `  let token = i / ${dim}u;
  let o = i % ${dim}u;
  let top = (token / ${cols}u) * ${patch}u;
  let left = (token % ${cols}u) * ${patch}u;
  var sum = ${bias};
  for (var c = 0u; c < ${cin}u; c = c + 1u) {
    for (var ky = 0u; ky < ${patch}u; ky = ky + 1u) {
      for (var kx = 0u; kx < ${patch}u; kx = kx + 1u) {
        sum = sum + ${read(request, 0, `(c * ${h}u + top + ky) * ${w}u + left + kx`)} * ${read(request, 1, `((o * ${cin}u + c) * ${patch}u + ky) * ${patch}u + kx`)};
      }
    }
  }
  output[i] = sum;`,
  );
};

/*
 * The source coordinate of a destination index, as a WGSL expression, in the reference's
 * convention: `step` source pixels a destination pixel, which is the sizes' ratio unless the node
 * gives its own, as a resize by a scale factor does upstream.
 */
function source(
  index: string,
  input: number,
  output: number,
  align: boolean,
  cubic: boolean,
  step: number | undefined,
): string {
  if (align) return output <= 1 ? '0.0' : `f32(${index}) * ${float((input - 1) / (output - 1))}`;
  const raw = `(f32(${index}) + 0.5) * ${float(step ?? input / output)} - 0.5`;
  return cubic ? raw : `max(${raw}, 0.0)`;
}

/* PyTorch's `nearest`: `⌊i·scale⌋`, the product in single precision as the reference takes it. */
const nearest: KernelGenerator = (request) => {
  const [, h, w] = request.inputShapes[0] as [number, number, number];
  const [, oh, ow] = request.outputShape as [number, number, number];
  const stepped = typeof request.attributes['stepHeight'] === 'number';
  const scaleY = stepped ? num(request.attributes, 'stepHeight') : h / oh;
  const scaleX = stepped ? num(request.attributes, 'stepWidth') : w / ow;
  return perElement(
    request,
    size(request.outputShape),
    `  let plane = (i / ${oh * ow}u) * ${h * w}u;
  let sy = min(u32(floor(f32((i / ${ow}u) % ${oh}u) * ${float(scaleY)})), ${h - 1}u);
  let sx = min(u32(floor(f32(i % ${ow}u) * ${float(scaleX)})), ${w - 1}u);
  output[i] = ${read(request, 0, `plane + sy * ${w}u + sx`)};`,
  );
};

const resize: KernelGenerator = (request) => {
  if (request.attributes['mode'] === 'nearest') return nearest(request);
  const [, h, w] = request.inputShapes[0] as [number, number, number];
  const [, oh, ow] = request.outputShape as [number, number, number];
  const align = request.attributes['alignCorners'] === true;
  const cubic = request.attributes['mode'] === 'bicubic';
  const stepped = typeof request.attributes['stepHeight'] === 'number';
  const stepHeight = stepped ? num(request.attributes, 'stepHeight') : undefined;
  const stepWidth = stepped ? num(request.attributes, 'stepWidth') : undefined;
  const at = (y: string, x: string): string =>
    read(
      request,
      0,
      `plane + u32(clamp(${y}, 0, ${h - 1})) * ${w}u + u32(clamp(${x}, 0, ${w - 1}))`,
    );
  const sample = cubic
    ? `  let a = -0.75;
  let tx = sx - floor(sx);
  let ty = sy - floor(sy);
  let wx = array<f32, 4>(cubicFar(tx + 1.0, a), cubicNear(tx, a), cubicNear(1.0 - tx, a), cubicFar(2.0 - tx, a));
  let wy = array<f32, 4>(cubicFar(ty + 1.0, a), cubicNear(ty, a), cubicNear(1.0 - ty, a), cubicFar(2.0 - ty, a));
  var value = 0.0;
  for (var j = 0; j < 4; j = j + 1) {
    var across = 0.0;
    for (var k = 0; k < 4; k = k + 1) { across = across + wx[k] * ${at('y0 - 1 + j', 'x0 - 1 + k')}; }
    value = value + wy[j] * across;
  }
  output[i] = value;`
    : `  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let top = ${at('y0', 'x0')} * (1.0 - tx) + ${at('y0', 'x0 + 1')} * tx;
  let bottom = ${at('y0 + 1', 'x0')} * (1.0 - tx) + ${at('y0 + 1', 'x0 + 1')} * tx;
  output[i] = top * (1.0 - ty) + bottom * ty;`;
  const kernel = perElement(
    request,
    size(request.outputShape),
    `  let plane = (i / ${oh * ow}u) * ${h * w}u;
  let sy = ${source(`(i / ${ow}u) % ${oh}u`, h, oh, align, cubic, stepHeight)};
  let sx = ${source(`i % ${ow}u`, w, ow, align, cubic, stepWidth)};
  let y0 = i32(floor(sy));
  let x0 = i32(floor(sx));
${sample}`,
  );
  if (!cubic) return kernel;
  const helpers = `fn cubicNear(x: f32, a: f32) -> f32 { return ((a + 2.0) * x - (a + 3.0)) * x * x + 1.0; }
fn cubicFar(x: f32, a: f32) -> f32 { return ((a * x - 5.0 * a) * x + 8.0 * a) * x - 4.0 * a; }`;
  return { ...kernel, code: kernel.code.replace('\n@compute', `\n${helpers}\n\n@compute`) };
};

/* The largest of each window; a window always lies inside the input, since there is no padding. */
const maxPool2d: KernelGenerator = (request) => {
  const [, h, w] = request.inputShapes[0] as [number, number, number];
  const [, oh, ow] = request.outputShape as [number, number, number];
  const kernel = num(request.attributes, 'kernel');
  const stride = num(request.attributes, 'stride', kernel);
  return perElement(
    request,
    size(request.outputShape),
    `  let plane = (i / ${oh * ow}u) * ${h * w}u;
  let top = ((i / ${ow}u) % ${oh}u) * ${stride}u;
  let left = (i % ${ow}u) * ${stride}u;
  var largest = ${read(request, 0, `plane + top * ${w}u + left`)};
  for (var ky = 0u; ky < ${kernel}u; ky = ky + 1u) {
    for (var kx = 0u; kx < ${kernel}u; kx = kx + 1u) {
      largest = max(largest, ${read(request, 0, `plane + (top + ky) * ${w}u + left + kx`)});
    }
  }
  output[i] = largest;`,
  );
};

export const SPATIAL_KERNELS: readonly (readonly [string, KernelGenerator])[] = [
  ['conv2d', conv2d],
  ['convTranspose2d', convTranspose2d],
  ['patchEmbed', patchEmbed],
  ['resize', resize],
  ['maxPool2d', maxPool2d],
];
