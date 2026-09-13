/**
 * Every attachment a frame can read or write, as a fixed table.
 *
 * Fixed rather than allocated, because this frame's composition is fixed: the same shadow
 * cascades, the same scene target, the same bloom chain, every frame. The transient allocator
 * and resource aliasing a frame graph is famous for would be machinery with no case here to
 * serve.
 *
 * A mask is a `number` and not a bitset object. Thirty-one bits is more than the table needs,
 * a number compares and combines in one instruction, and the scheduler does this per node.
 */
export const FRAME_RESOURCES = [
  'sceneColor',
  'sceneDepth',
  'canvas',
  'cascade0',
  'cascade1',
  'cascade2',
  /*
   * The twelve point-shadow cubes are one bit, not twelve. They are baked together and
   * sampled together, and nothing in the frame reads one without the others, so twelve bits
   * would be twelve ways to express one fact — and twelve chances for a node to declare a
   * subset that does not correspond to anything the renderer can actually do.
   */
  'pointShadows',
  'probeCube',
  'mirrorColor',
  'mirrorDepth',
  'bloomChain',
  'aoTarget',
  'depthSnapshot',
  'inset',
] as const;

export type FrameResource = (typeof FRAME_RESOURCES)[number];

export const RESOURCE_COUNT = FRAME_RESOURCES.length;

const BITS = new Map<string, number>(FRAME_RESOURCES.map((name, i) => [name, 1 << i]));

/** The single bit that stands for one resource. */
export function resourceBit(name: FrameResource): number {
  return BITS.get(name) ?? 0;
}

/** A mask of the named resources, for declaring what a node reads or writes. */
export function maskOf(...names: FrameResource[]): number {
  let mask = 0;
  for (const name of names) mask |= resourceBit(name);
  return mask;
}

/**
 * The resources a mask names.
 *
 * For diagnostics and tests rather than for the frame: it allocates an array, so nothing on
 * the per-frame path may call it.
 */
export function namesIn(mask: number): FrameResource[] {
  return FRAME_RESOURCES.filter((_, i) => (mask & (1 << i)) !== 0);
}
