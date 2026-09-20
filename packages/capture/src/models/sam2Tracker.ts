/**
 * SAM 2.1 tracking objects through a video: the upstream's `Sam2VideoModel` loop on the host, its
 * networks as the engine's graphs, run by whatever the caller gives — the device's runner, or the
 * CPU's evaluator.
 *
 * **A frame is decoded against what the tracker remembers.** A prompted frame, the first time, reads
 * nothing and is given `no_memory_embedding`; every other frame's features are first conditioned by
 * the memory attention on the frames and pointers `sam2Memories.ts` chooses, and `sam2Choice.ts`
 * keeps one of the four masks decoded.
 *
 * **Then each object's frame becomes a memory**, all of a frame's objects together: the mask
 * brought to the frame's size, binarised when any of them was just prompted and taken through a
 * sigmoid otherwise — the upstream decides it once for the batch — encoded with the frame's
 * features, the occlusion embedding added where the object is absent, and rounded to bfloat16.
 *
 * What it gives up: a mask as a prompt, which the upstream downsamples with an antialiased resize
 * the runtime does not yet have, and more prompted frames than all of them — the upstream's default
 * — are the two options not taken.
 */
import type { NetworkGraph, WeightSource } from '@driftengine/texture';
import { graphFromWeights, type Architecture } from '@driftengine/texture';

import type { GraphRun } from '../run.ts';

import {
  memoriesFor,
  memoryTokens,
  pointersFor,
  toBfloat16,
  type Sam2History,
  type Sam2Output,
} from './sam2Memories.ts';
import { chooseMask } from './sam2Choice.ts';
import { sam2SinePositions } from './sam2Positions.ts';
import { sam21Decoder, sam21Encoder, type Sam21Config } from './sam21.ts';
import { sam21MemoryAttention, sam21MemoryEncoder, sam21Upscale } from './sam21Video.ts';
import { SAM2_VIDEO_PROMPT, samPromptTokens, samTokenCount, type SamPrompt } from './samPrompt.ts';

export type { GraphRun } from '../run.ts';

/** The weights each graph reads: a converted file's graphs, or a checkpoint for all four. */
export interface Sam21Weights {
  readonly encoder: WeightSource;
  readonly decoder: WeightSource;
  readonly memoryEncoder: WeightSource;
  readonly memoryAttention: WeightSource;
}

export interface Sam21Video {
  readonly frames: number;
  /** The original frame's size, which prompts are given in. */
  readonly height: number;
  readonly width: number;
  /** A frame prepared as the encoder takes it, `[3, size, size]`. */
  frame(index: number): Float32Array;
}

/** A frame's result: every object's mask logits at a quarter of the encoder's size, and its score. */
export interface Sam21Frame {
  readonly frame: number;
  readonly objects: readonly number[];
  /** `[objects, (size / 4)²]`. */
  readonly masks: Float32Array;
  readonly scores: Float32Array;
}

const NO_WEIGHTS: WeightSource = { get: () => undefined, names: () => [] };

interface Tracked extends Sam2History {
  readonly prompts: Map<number, SamPrompt>;
  readonly seen: Set<number>;
}

export class Sam21Tracker {
  private readonly objects = new Map<number, Tracked>();
  private fresh: number[] = [];
  private readonly graphs = new Map<string, NetworkGraph>();
  private encoded: {
    readonly frame: number;
    readonly values: ReadonlyMap<string, Float32Array>;
  } | null = null;
  private readonly cellPositions: Float32Array;

  constructor(
    private readonly config: Sam21Config,
    private readonly weights: Sam21Weights,
    private readonly run: GraphRun,
    private readonly video: Sam21Video,
  ) {
    const grid = config.size / 16;
    const width = config.memory.dim;
    const sine = sam2SinePositions(width / 2, grid, grid);
    this.cellPositions = new Float32Array(grid * grid * width);
    for (let c = 0; c < width; c += 1) {
      for (let i = 0; i < grid * grid; i += 1)
        this.cellPositions[i * width + c] = sine[c * grid * grid + i] as number;
    }
  }

  /** Prompts on `frame`, replacing each object's earlier ones there; the next step decodes them. */
  prompt(frame: number, prompts: ReadonlyMap<number, SamPrompt>): void {
    for (const [object, prompt] of prompts) {
      let state = this.objects.get(object);
      if (state === undefined) {
        state = { prompts: new Map(), prompted: new Map(), tracked: new Map(), seen: new Set() };
        this.objects.set(object, state);
      }
      state.prompts.set(frame, prompt);
    }
    this.fresh = [...prompts.keys()];
  }

  /** Every object on `frame`, as the upstream's `forward` over its session answers it. */
  async step(frame: number, reverse = false): Promise<Sam21Frame> {
    const objects = [...this.objects.keys()];
    const side = this.config.size / 4;
    const cells = side * side;
    const masks = new Float32Array(objects.length * cells);
    const scores = new Float32Array(objects.length);
    const pending: { readonly output: Sam2Output; readonly fromPrompt: boolean }[] = [];
    let backwards = reverse;
    for (const [i, object] of objects.entries()) {
      const state = this.objects.get(object) as Tracked;
      const isNew = this.fresh.includes(object);
      let output = state.prompted.get(frame);
      let first = true;
      if (isNew || output === undefined) {
        first = false;
        let prompt: SamPrompt | null = null;
        if (isNew) {
          first = !state.seen.has(frame);
          if (first) backwards = false;
          prompt = state.prompts.get(frame) ?? null;
          if (prompt !== null) this.fresh = this.fresh.filter((id) => id !== object);
        }
        output = await this.decode(state, frame, first, prompt, backwards);
        (first ? state.prompted : state.tracked).set(frame, output);
        pending.push({ output, fromPrompt: prompt !== null });
      }
      masks.set(output.lowRes, i * cells);
      scores[i] = output.score;
      if (!first) state.seen.add(frame);
    }
    await this.remember(frame, pending);
    return { frame, objects, masks, scores };
  }

  private graph(key: string, source: WeightSource, build: () => Architecture): NetworkGraph {
    let graph = this.graphs.get(key);
    if (graph === undefined) {
      graph = graphFromWeights(source, build());
      this.graphs.set(key, graph);
    }
    return graph;
  }

  private async features(frame: number): Promise<ReadonlyMap<string, Float32Array>> {
    if (this.encoded?.frame !== frame) {
      const graph = this.graph('encoder', this.weights.encoder, () => sam21Encoder(this.config));
      const out = await this.run(graph, new Map([['image', this.video.frame(frame)]]));
      this.encoded = {
        frame,
        values: new Map([...out].map(([name, values]) => [name, Float32Array.from(values)])),
      };
    }
    return this.encoded.values;
  }

  private async decode(
    state: Tracked,
    frame: number,
    first: boolean,
    prompt: SamPrompt | null,
    reverse: boolean,
  ): Promise<Sam2Output> {
    const { config } = this;
    const { dim } = config.decoder;
    const features = await this.features(frame);
    let embedding = features.get('features') as Float32Array;
    if (!first) embedding = await this.condition(state, frame, embedding, reverse);
    const request = prompt ?? {};
    const tokens = new Float32Array(samTokenCount(request, SAM2_VIDEO_PROMPT) * dim);
    samPromptTokens(
      this.weights.decoder,
      dim,
      config.size,
      request,
      this.video.height,
      this.video.width,
      tokens,
      SAM2_VIDEO_PROMPT,
    );
    const n = tokens.length / dim;
    const decoder = this.graph(`decoder.${n}.${first}`, this.weights.decoder, () =>
      sam21Decoder(config, n, { noMemory: first }),
    );
    const out = await this.run(
      decoder,
      new Map([
        ['embedding', embedding],
        ['high1', features.get('high1') as Float32Array],
        ['high0', features.get('high0') as Float32Array],
        ['prompt', tokens],
      ]),
    );
    const score = (out.get('object') as Float32Array)[0] as number;
    const { lowRes, pointer } = chooseMask(
      out.get('masks') as Float32Array,
      out.get('quality') as Float32Array,
      out.get('pointers') as Float32Array,
      score,
      (prompt?.points?.length ?? 0) + (prompt?.box === undefined ? 0 : 2),
      this.tensor(this.weights.decoder, 'no_object_pointer'),
    );
    return { lowRes, pointer, score, memory: null };
  }

  private async condition(
    state: Tracked,
    frame: number,
    features: Float32Array,
    reverse: boolean,
  ): Promise<Float32Array> {
    const { config } = this;
    const memories = memoriesFor(state, frame, config.memory.frames, reverse);
    const pointers = pointersFor(state, frame, this.video.frames, config.memory.pointers, reverse);
    const { memory, positions, pointerTokens } = memoryTokens(
      this.weights.memoryAttention,
      memories,
      pointers,
      this.cellPositions,
      config.memory.dim,
      config.decoder.dim,
    );
    const graph = this.graph(
      `attention.${memories.length}.${pointerTokens}`,
      this.weights.memoryAttention,
      () => sam21MemoryAttention(config, memories.length, pointerTokens),
    );
    const out = await this.run(
      graph,
      new Map([
        ['features', features],
        ['memory', memory],
        ['positions', positions],
      ]),
    );
    return Float32Array.from(out.get('conditioned') as Float32Array);
  }

  private async remember(
    frame: number,
    pending: readonly { readonly output: Sam2Output; readonly fromPrompt: boolean }[],
  ): Promise<void> {
    if (pending.length === 0) return;
    const { config } = this;
    const binary = pending.some(({ fromPrompt }) => fromPrompt);
    const features = (await this.features(frame)).get('features') as Float32Array;
    const upscale = this.graph('upscale', NO_WEIGHTS, () => sam21Upscale(config, 1));
    const encoder = this.graph(`memory.${binary}`, this.weights.memoryEncoder, () =>
      sam21MemoryEncoder(config, binary),
    );
    const occlusion = this.tensor(
      this.weights.memoryEncoder,
      'occlusion_spatial_embedding_parameter',
    );
    const width = config.memory.dim;
    for (const { output } of pending) {
      const high = Float32Array.from(
        (await this.run(upscale, new Map([['masks', output.lowRes]]))).get('high') as Float32Array,
      );
      if (binary)
        for (let i = 0; i < high.length; i += 1) high[i] = (high[i] as number) > 0 ? 1 : 0;
      const encoded = (
        await this.run(
          encoder,
          new Map([
            ['features', features],
            ['mask', high],
          ]),
        )
      ).get('memory') as Float32Array;
      const cells = encoded.length / width;
      const memory = new Float32Array(encoded.length);
      for (let c = 0; c < width; c += 1) {
        const add = output.score > 0 ? 0 : (occlusion[c] as number);
        for (let i = 0; i < cells; i += 1)
          memory[i * width + c] = Math.fround((encoded[c * cells + i] as number) + add);
      }
      toBfloat16(memory);
      output.memory = memory;
    }
  }

  private tensor(source: WeightSource, name: string): Float32Array {
    const held = source.get(name);
    if (held === undefined) throw new Error(`the tracker's weights have no "${name}"`);
    return held.data;
  }
}
