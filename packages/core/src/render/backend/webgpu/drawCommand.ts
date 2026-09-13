/**
 * One recorded draw, in the only shape this backend ever issues.
 *
 * Sampled across three unrelated verbs — panels, particles, wind streaks — the sequence is the
 * same every time: a pipeline, a bind group with up to two dynamic offsets, some vertex
 * buffers, perhaps an index buffer, then a draw. Nothing in it is specific to what is being
 * drawn except the values.
 *
 * So the frame graph does not need to know what a plume is. It records these fields and
 * replays them, which is what turns migrating twenty-three verbs into twenty-three call-site
 * edits rather than twenty-three implementations.
 */

/** The most vertex buffers any verb on this backend binds is three. Four leaves a margin. */
const VERTEX_BUFFER_SLOTS = 4;

export interface DrawCommand {
  pipeline: GPURenderPipeline | null;
  bindGroup: GPUBindGroup | null;
  /** Dynamic offsets, held as two numbers rather than an array so a reset stays free. */
  offsetA: number;
  offsetB: number;
  offsetCount: number;
  /** Fixed length; `vertexCount` says how many slots are live. */
  readonly vertexBuffers: (GPUBuffer | null)[];
  vertexCount: number;
  indexBuffer: GPUBuffer | null;
  indexed: boolean;
  count: number;
  instances: number;
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
    offsetCount: 0,
    vertexBuffers: new Array<GPUBuffer | null>(VERTEX_BUFFER_SLOTS).fill(null),
    vertexCount: 0,
    indexBuffer: null,
    indexed: false,
    count: 0,
    instances: 1,
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
 * The entry is **not cleared**. Every caller fills every field it uses, and clearing here would
 * be a write per field per draw for no reader — the same reasoning the node arena uses.
 */
export function takeCommand(pool: CommandPool): number {
  const at = pool.taken;
  while (at >= pool.commands.length) pool.commands.push(emptyCommand());
  pool.taken = at + 1;
  if (pool.taken > pool.highWater) pool.highWater = pool.taken;
  return at;
}

/** Empty the pool for a new frame. Keeps every entry; that is the whole point. */
export function resetPool(pool: CommandPool): void {
  pool.taken = 0;
}
