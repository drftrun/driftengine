/**
 * A static list on this backend: its draws recorded once, through the renderer's own draw path,
 * into slots the list owns, and replayed as one render bundle per view.
 *
 * **What a recording holds is the frame's draws as the renderer would have recorded them**, taken
 * from a pool of the list's instead of the frame graph's: a pipeline, a bind group, vertex buffers
 * and four dynamic offsets each. Three of the four never change once recorded — the draw's own
 * slot in `entries`, written once, and its material's slot in the store, pinned. The other two are
 * the view's: the pass block and the view block, which differ between the frame, a mirror and a
 * capture of the same frame. So each view a frame draws the list into takes a *copy* — a slot of
 * `passes` and one of `views`, written for that view — and a bundle is encoded per copy from the
 * same commands with that copy's two offsets. A frame that draws a list twice uploads two blocks
 * and executes two bundles, and records nothing.
 *
 * **Its own buffers, and bind groups over them.** A bundle bakes the buffers its groups bind, and
 * the frame's rings are reset every frame, so a list binds rings of its own: the renderer swaps
 * them in while it records the list's draws, and the groups that recording builds go into the
 * list's cache rather than the frame's.
 *
 * **Recorded again when what it baked has moved**: the renderer's groups (a texture forgotten, a
 * frame texture rebound, a ring grown), the pipeline cache's lit set, the store's slots, or the
 * list's own rings. Each is a number compared at replay, so a stale recording is never replayed.
 *
 * What it gives up: culling, since a bundle draws everything recorded into it; and memory, a pass
 * block a view a list, which is a few kilobytes.
 */
import type { StaticDrawsList, StaticEntry } from '../../staticDraws.ts';
import type { CommandPool, DrawCommand } from './drawCommand.ts';
import { createCommandPool, resetPool, takeCommand } from './drawCommand.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { UniformRing } from './uniformRing.ts';

const USAGE_UNIFORM_DST = 0x0040 | 0x0008;
/** Views a list starts with room for: the frame's and one capture's. Doubles when a frame asks more. */
const FIRST_COPIES = 2;
/** Recordings a list keeps before letting the oldest go: a target and a starting state each. */
const MOST_RECORDINGS = 4;

/** What one recording was made against, and what it recorded. */
export interface StaticRecording {
  readonly cache: PipelineCache;
  /** The material block's words the list started from: the pass's state, which entries patch. */
  readonly start: Int32Array;
  readonly startHash: number;
  readonly cutout: string;
  readonly surfaceKept: boolean;
  /** Stamps compared at replay; any that moved makes the recording stale. */
  cacheVersion: number;
  groupEpoch: number;
  storeEpoch: number;
  ringEpoch: number;
  /** The frame pass's commands, and the reflection pass's surface halves, with the record's offsets. */
  readonly frame: CommandPool;
  readonly surface: CommandPool;
  /** Material slots pinned for these commands, and the material changes recording them asked for. */
  readonly pins: number[];
  materialAsks: number;
  /** Under the screen-space skin blur a skin entry splits into halves no bundle replays. */
  immediate: boolean;
  /** Per copy, the bundles `executeBundles` takes; null until a copy is first replayed. */
  readonly frameBundles: (readonly GPURenderBundle[] | null)[];
  readonly surfaceBundles: (readonly GPURenderBundle[] | null)[];
  /** The frame it was last replayed in, which picks the one to let go. */
  usedIn: number;
}

export class GpuStaticDraws implements StaticDrawsList {
  disposed = false;
  /** The draws' own slots, one a draw, written by the recording. */
  readonly drawRing: UniformRing;
  /** A pass block and a view block a copy. */
  passes: UniformRing;
  views: UniformRing;
  /** Bumped whenever the three rings are made again, which invalidates every recording. */
  ringEpoch = 0;
  /** The list's own lit groups and blank group, built over its rings by the renderer. */
  groups: Map<unknown, unknown> = new Map();
  blank: GPUBindGroup | null = null;
  /** The group epoch the cache above was built in. */
  groupEpoch = -1;
  /** The store epoch the list's pins were taken in: pins from before a forgetting are let go of. */
  pinEpoch = -1;
  readonly recordings: StaticRecording[] = [];
  private copies = 0;
  private copyFrame = -1;

  constructor(
    private readonly device: GPUDevice,
    readonly list: StaticDrawsList,
    private readonly passSize: number,
    private readonly viewSize: number,
    drawSize: number,
  ) {
    this.drawRing = new UniformRing(
      device,
      drawSize,
      Math.max(1, list.draws),
      USAGE_UNIFORM_DST,
      'static.draws',
    );
    this.passes = new UniformRing(
      device,
      passSize,
      FIRST_COPIES,
      USAGE_UNIFORM_DST,
      'static.passes',
    );
    this.views = new UniformRing(device, viewSize, FIRST_COPIES, USAGE_UNIFORM_DST, 'static.views');
    this.claimCopies();
  }

  /** The captured entries, which the renderer replays to record them. */
  get entries(): readonly StaticEntry[] {
    return this.list.entries;
  }

  get draws(): number {
    return this.list.draws;
  }

  /**
   * The next view's copy in frame `frame`, growing the copies when a frame asks for more than there
   * are — which makes every recording stale, since the groups bound the old rings.
   */
  takeCopy(frame: number): number {
    if (frame !== this.copyFrame) {
      this.copyFrame = frame;
      this.copies = 0;
    }
    const copy = this.copies;
    this.copies += 1;
    if (copy >= this.passes.slots) this.growCopies(this.passes.slots * 2);
    return copy;
  }

  /** The two offsets copy `copy` binds. */
  passOffset(copy: number): number {
    return copy * this.passes.slotSize;
  }

  viewOffset(copy: number): number {
    return copy * this.views.slotSize;
  }

  /** Copy `copy`'s pass block, written whole. Uploaded by `uploadCopy`. */
  writePass(copy: number, block: Int32Array): void {
    this.passes.writeBlock(this.passOffset(copy), block);
  }

  /** Copy `copy`'s two blocks to the device, and no other copy's: each view writes only its own. */
  uploadCopy(copy: number): void {
    this.passes.uploadSlot(this.passOffset(copy));
    this.views.uploadSlot(this.viewOffset(copy));
  }

  /** The draws' own slots, after a recording wrote them. */
  uploadDraws(): void {
    this.drawRing.flush();
  }

  /** A recording that matches, if one does: the same target, starting state and side passes. */
  find(
    cache: PipelineCache,
    start: Int32Array,
    startHash: number,
    cutout: string,
    surfaceKept: boolean,
  ): StaticRecording | null {
    for (const recording of this.recordings) {
      if (
        recording.cache === cache &&
        recording.startHash === startHash &&
        recording.cutout === cutout &&
        recording.surfaceKept === surfaceKept &&
        sameWords(recording.start, start)
      ) {
        return recording;
      }
    }
    return null;
  }

  /** A new, empty recording, letting the least recently used go past the most kept. */
  open(
    cache: PipelineCache,
    start: Int32Array,
    startHash: number,
    cutout: string,
    surfaceKept: boolean,
    unpin: (offset: number) => void,
  ): StaticRecording {
    if (this.recordings.length >= MOST_RECORDINGS) {
      let oldest = 0;
      for (let i = 1; i < this.recordings.length; i++) {
        if (
          (this.recordings[i] as StaticRecording).usedIn <
          (this.recordings[oldest] as StaticRecording).usedIn
        )
          oldest = i;
      }
      const [gone] = this.recordings.splice(oldest, 1);
      if (gone !== undefined) release(gone, unpin);
    }
    const recording: StaticRecording = {
      cache,
      start: new Int32Array(start),
      startHash,
      cutout,
      surfaceKept,
      cacheVersion: -1,
      groupEpoch: -1,
      storeEpoch: -1,
      ringEpoch: -1,
      frame: createCommandPool(this.list.draws),
      surface: createCommandPool(0),
      pins: [],
      materialAsks: 0,
      immediate: false,
      frameBundles: [],
      surfaceBundles: [],
      usedIn: -1,
    };
    this.recordings.push(recording);
    return recording;
  }

  /** Empty a recording to record it again: its pins let go, its commands and bundles dropped. */
  clear(recording: StaticRecording, unpin: (offset: number) => void): void {
    release(recording, unpin);
    resetPool(recording.frame);
    resetPool(recording.surface);
    recording.frameBundles.length = 0;
    recording.surfaceBundles.length = 0;
    recording.immediate = false;
    recording.materialAsks = 0;
  }

  /** Every recording, let go; what disposal and a forgetting store both do. */
  forget(unpin: ((offset: number) => void) | null): void {
    for (const recording of this.recordings) release(recording, unpin);
    this.recordings.length = 0;
  }

  dispose(unpin: ((offset: number) => void) | null): void {
    this.disposed = true;
    this.forget(unpin);
    this.drawRing.dispose();
    this.passes.dispose();
    this.views.dispose();
  }

  private growCopies(copies: number): void {
    this.passes.dispose();
    this.views.dispose();
    this.passes = new UniformRing(
      this.device,
      this.passSize,
      copies,
      USAGE_UNIFORM_DST,
      'static.passes',
    );
    this.views = new UniformRing(
      this.device,
      this.viewSize,
      copies,
      USAGE_UNIFORM_DST,
      'static.views',
    );
    this.claimCopies();
    this.ringEpoch += 1;
    this.groups = new Map();
    this.blank = null;
  }

  /** Every copy's slot, taken once: a copy is a fixed offset, never handed out again. */
  private claimCopies(): void {
    for (let copy = 0; copy < this.passes.slots; copy++) {
      this.passes.allocate();
      this.views.allocate();
    }
  }
}

/** A command the recording takes in place of the frame graph's. */
export function takeRecorded(pool: CommandPool): DrawCommand {
  const command = pool.commands[takeCommand(pool)] as DrawCommand;
  command.offsetCount = 0;
  command.vertexCount = 0;
  command.indexBuffer = null;
  command.indexFormat = 'uint32';
  command.indexed = false;
  command.instances = 1;
  command.indirect = null;
  return command;
}

/** What a render bundle must agree with: the pass it is executed in. */
export interface BundleTarget {
  readonly colorFormats: (GPUTextureFormat | null)[];
  readonly depthStencilFormat: GPUTextureFormat;
  readonly sampleCount: number;
  readonly depthReadOnly: boolean;
}

/**
 * One copy's bundle of a pool's commands: each lit command as recorded but for the pass and view
 * offsets, which are the copy's. Allocates, and runs once a copy a recording, never per frame.
 */
export function encodeBundle(
  device: GPUDevice,
  target: BundleTarget,
  pool: CommandPool,
  passOffset: number,
  viewOffset: number,
  label: string,
): readonly GPURenderBundle[] {
  const encoder = device.createRenderBundleEncoder({
    label,
    colorFormats: target.colorFormats,
    depthStencilFormat: target.depthStencilFormat,
    sampleCount: target.sampleCount,
    depthReadOnly: target.depthReadOnly,
    stencilReadOnly: target.depthReadOnly,
  });
  for (let i = 0; i < pool.taken; i++) {
    const command = pool.commands[i] as DrawCommand;
    if (command.pipeline === null || command.bindGroup === null) continue;
    if (command.offsetCount !== 4) {
      throw new Error(
        `static draws: a recorded command bound ${command.offsetCount} offsets, not a lit draw's four`,
      );
    }
    encoder.setPipeline(command.pipeline);
    encoder.setBindGroup(0, command.bindGroup, [
      command.offsetA,
      passOffset,
      command.offsetC,
      viewOffset,
    ]);
    for (let slot = 0; slot < command.vertexCount; slot++) {
      const buffer = command.vertexBuffers[slot];
      if (buffer != null) encoder.setVertexBuffer(slot, buffer);
    }
    if (command.indexed && command.indexBuffer !== null) {
      encoder.setIndexBuffer(command.indexBuffer, command.indexFormat);
      if (command.indirect !== null) encoder.drawIndexedIndirect(command.indirect, 0);
      else encoder.drawIndexed(command.count, command.instances);
    } else {
      encoder.draw(command.count, command.instances);
    }
  }
  return [encoder.finish({ label })];
}

function release(recording: StaticRecording, unpin: ((offset: number) => void) | null): void {
  if (unpin !== null) for (const offset of recording.pins) unpin(offset);
  recording.pins.length = 0;
}

function sameWords(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
