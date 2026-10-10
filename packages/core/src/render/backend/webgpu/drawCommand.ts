/**
 * One recorded draw, in the only shape this backend ever issues.
 *
 * Sampled across three unrelated verbs — panels, particles, wind streaks — the sequence is the
 * same every time: a pipeline, a bind group with up to four dynamic offsets, some vertex
 * buffers, perhaps an index buffer, then a draw. Nothing in it is specific to what is being
 * drawn except the values.
 *
 * So the frame graph does not need to know what a plume is. It records these fields and
 * replays them, which is what turns migrating twenty-three verbs into twenty-three call-site
 * edits rather than twenty-three implementations.
 */

/**
 * WebGPU's guaranteed `maxVertexBuffers`, so no verb can outgrow it. The most any binds is five — a
 * dynamic mesh's positions, normals, rows and constants, and an instanced batch's placements — and
 * this said three, then four, while text and bolts already bound four.
 */
const VERTEX_BUFFER_SLOTS = 8;

export interface DrawCommand {
  pipeline: GPURenderPipeline | null;
  bindGroup: GPUBindGroup | null;
  /**
   * Dynamic offsets, held as numbers rather than an array so a reset stays free. Four only for a
   * lit mesh: its draw's slot, its pass's, its material's and its view's, in binding order.
   */
  offsetA: number;
  offsetB: number;
  offsetC: number;
  offsetD: number;
  offsetCount: number;
  /** Fixed length; `vertexCount` says how many slots are live. */
  readonly vertexBuffers: (GPUBuffer | null)[];
  vertexCount: number;
  indexBuffer: GPUBuffer | null;
  /** How wide an index of `indexBuffer` is: a mesh's own, thirty-two bits for everything else. */
  indexFormat: GPUIndexFormat;
  indexed: boolean;
  count: number;
  instances: number;
  /**
   * A `drawIndexedIndirect` record to draw from instead of `count` and `instances`: an instance
   * cull's survivors, counted on the device. Null for every other draw.
   */
  indirect: GPUBuffer | null;
  /**
   * Render bundles to execute instead of everything above: a static list recorded once, replayed
   * as one command. Held as the array `executeBundles` takes, kept by the list, so issuing it
   * allocates nothing. Null for every other command, and put back to null by every take.
   */
  bundles: readonly GPURenderBundle[] | null;
}

export interface CommandPool {
  commands: DrawCommand[];
  taken: number;
  /** The most any frame has taken, so growth converges instead of repeating. */
  highWater: number;
}

function emptyCommand(): DrawCommand {
  return {
    pipeline: null,
    bindGroup: null,
    offsetA: 0,
    offsetB: 0,
    offsetC: 0,
    offsetD: 0,
    offsetCount: 0,
    vertexBuffers: new Array<GPUBuffer | null>(VERTEX_BUFFER_SLOTS).fill(null),
    vertexCount: 0,
    indexBuffer: null,
    indexFormat: 'uint32',
    indexed: false,
    count: 0,
    instances: 1,
    indirect: null,
    bundles: null,
  };
}

export function createCommandPool(capacity: number): CommandPool {
  const commands: DrawCommand[] = [];
  for (let i = 0; i < capacity; i += 1) commands.push(emptyCommand());
  return { commands, taken: 0, highWater: 0 };
}

/**
 * Hand out the next command, growing if a frame overruns.
 *
 * The entry is **not cleared**, but for `bundles`. Every caller fills every field it uses, and
 * clearing here would be a write per field per draw for no reader — the same reasoning the node
 * arena uses. `bundles` is the exception because almost no caller knows it exists: a pooled command
 * that once carried a static list's bundles and was then taken for an ordinary draw would replay the
 * list instead, so the one field nobody fills is the one field put back here.
 */
export function takeCommand(pool: CommandPool): number {
  const at = pool.taken;
  while (at >= pool.commands.length) pool.commands.push(emptyCommand());
  pool.taken = at + 1;
  if (pool.taken > pool.highWater) pool.highWater = pool.taken;
  (pool.commands[at] as DrawCommand).bundles = null;
  return at;
}

/** Empty the pool for a new frame. Keeps every entry; that is the whole point. */
export function resetPool(pool: CommandPool): void {
  pool.taken = 0;
}
