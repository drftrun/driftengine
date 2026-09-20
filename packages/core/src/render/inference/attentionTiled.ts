/**
 * Attention with keys and values staged in workgroup memory: many queries against many keys, at
 * head widths that would spill an invocation's accumulator from its registers.
 *
 * **A workgroup takes one window's head and as many of its queries as 256 threads hold**, each
 * thread one query and 16 of the head's channels — so what a thread keeps is 16 values of its output
 * and as many of its query, where the other two forms keep the whole head; a head of 256 is 16
 * queries a workgroup, and a head of 64 is 64, and every key staged serves each of them. Keys come
 * in tiles of 8: the tile is staged, each thread's share of every query-key dot is written out, a
 * dot's shares are summed, and the same memory then holds the tile's values for the weighted sum. A
 * query's softmax runs key by key with the running maximum, exactly as the other forms run it, so
 * the bound that holds for them holds here.
 *
 * **What it gives up is barriers**: four a tile, so 2,000 for 4,096 keys, which is why it is chosen
 * where the work is large enough to pay for them. The memory is under 16 KB at any width — at a
 * head of 256, all of what a workgroup is promised — and a head wider than that, or one sixteen does
 * not divide, takes one of the other forms.
 */
import {
  type KernelRequest,
  type KernelSource,
  float,
  header,
  num,
  perRow,
  read,
} from './kernelKit.ts';

const THREADS = 256;
const KEYS = 8;

/*
 * The groups a query's channels split into: 8, or 16 above a head of 128, which measured best on an
 * RX 9070 XT — 8 took a head of 64 from 1.37 ms at 16 to 1.0 and a head of 96 from 7.3 to 4.8, and
 * 16 took a head of 256 from 22.4 at 8 to 12.2 (`tools/capture-weights/opbudget.ts`).
 */
export function tiledGroups(d: number): number {
  return d > 128 ? 16 : 8;
}

/** Whether this form can take a head of `d` channels in `groups` groups. */
export function tiledAttentionFits(d: number, groups = tiledGroups(d)): boolean {
  return d % groups === 0 && d <= 256;
}

/**
 * The tiled form, each query's channels in `groups` groups and so `256 / groups` queries a
 * workgroup. `attentionKernel` chooses it; the argument is how `opbudget.ts` measured the choice.
 */
export function tiledAttention(request: KernelRequest, groups?: number): KernelSource {
  const queryShape = request.inputShapes[0] as readonly number[];
  const [queries, channels] = queryShape.slice(-2) as [number, number];
  const keys = (request.inputShapes[1] as readonly number[]).at(-2) as number;
  const batch = queryShape.length === 3 ? (queryShape[0] as number) : 1;
  const heads = num(request.attributes, 'heads', 1);
  const d = channels / heads;
  const GROUPS = groups ?? tiledGroups(d);
  const share = d / GROUPS;
  const QUERIES = THREADS / GROUPS;
  const threads = THREADS;
  const blocks = Math.ceil(queries / QUERIES);
  const grid = perRow(batch * heads * blocks);
  const bias =
    request.inputShapes.length > 3
      ? ` + ${read(request, 3, `(head * ${queries}u + min(query, ${queries - 1}u)) * ${keys}u + key`)}`
      : '';
  const stage = (
    input: number,
  ): string => `  for (var i = local.x; i < ${KEYS * d}u; i = i + ${threads}u) {
    let key = start + i / ${d}u;
    tile[i] = select(0.0, ${read(request, input, `(keyRow + min(key, ${keys - 1}u)) * ${channels}u + first + i % ${d}u`)}, key < ${keys}u);
  }
  workgroupBarrier();`;
  return {
    code: `${header(request)}

var<workgroup> tile: array<f32, ${KEYS * d}>;
var<workgroup> partial: array<f32, ${QUERIES * KEYS * GROUPS}>;

@compute @workgroup_size(${threads})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let block = ${grid.row};
  if (block >= ${batch * heads * blocks}u) { return; }
  let window = block / ${heads * blocks}u;
  let head = (block / ${blocks}u) % ${heads}u;
  let r = local.x / ${GROUPS}u;
  let g = local.x % ${GROUPS}u;
  let query = (block % ${blocks}u) * ${QUERIES}u + r;
  let row = window * ${queries}u + min(query, ${queries - 1}u);
  let keyRow = window * ${keys}u;
  let first = head * ${d}u;
  let own = g * ${share}u;
  var mine: array<f32, ${share}>;
  var gathered: array<f32, ${share}>;
  for (var c = 0u; c < ${share}u; c = c + 1u) { mine[c] = ${read(request, 0, `row * ${channels}u + first + own + c`)}; }
  var largest = -3.4028234e38;
  var total = 0.0;
  for (var start = 0u; start < ${keys}u; start = start + ${KEYS}u) {
${stage(1)}
    for (var k = 0u; k < ${KEYS}u; k = k + 1u) {
      var dot = 0.0;
      for (var c = 0u; c < ${share}u; c = c + 1u) { dot = dot + mine[c] * tile[k * ${d}u + own + c]; }
      partial[(r * ${KEYS}u + k) * ${GROUPS}u + g] = dot;
    }
    workgroupBarrier();
    for (var k = g; k < ${KEYS}u; k = k + ${GROUPS}u) {
      var sum = 0.0;
      for (var j = 0u; j < ${GROUPS}u; j = j + 1u) { sum = sum + partial[(r * ${KEYS}u + k) * ${GROUPS}u + j]; }
      partial[(r * ${KEYS}u + k) * ${GROUPS}u] = sum;
    }
${stage(2)}
    for (var k = 0u; k < ${KEYS}u; k = k + 1u) {
      let key = start + k;
      if (key >= ${keys}u) { break; }
      let score = partial[(r * ${KEYS}u + k) * ${GROUPS}u] * ${float(1 / Math.sqrt(d))}${bias};
      let top = max(largest, score);
      let rescale = exp(largest - top);
      let weight = exp(score - top);
      total = total * rescale + weight;
      for (var c = 0u; c < ${share}u; c = c + 1u) { gathered[c] = gathered[c] * rescale + weight * tile[k * ${d}u + own + c]; }
      largest = top;
    }
    workgroupBarrier();
  }
  if (query < ${queries}u) {
    for (var c = 0u; c < ${share}u; c = c + 1u) { output[row * ${channels}u + first + own + c] = gathered[c] / total; }
  }
}
`,
    workgroups: grid.workgroups,
  };
}
