import { afterEach, expect, test } from 'vitest';
import { AudioGraph } from './graph.ts';
import { StubContext, type StubNode } from './audioHarness.ts';

/**
 * Does everything the player hears also reach a recording?
 *
 * `graph.test.ts` says topology is not something a test can judge, and for how the
 * mix *sounds* that is right. This is the one topological fact that is not a matter
 * of taste: a clip has to carry the same signal as the speakers. It did not.
 *
 * The send returns — short reverb, the long reverb that is the airborne wash, and
 * the delay — were each wired straight to `context.destination`, joining the mix
 * downstream of the `master` filter that the recording tap hung off. So **every clip
 * ever exported held the dry track and the speed filter and nothing wet**: no glide
 * reverb, no wall-run delay, and no airborne hold, which is the effect five rounds
 * of work went into. The symptom was an exported clip whose music did not match what
 * the same run sounded like live.
 *
 * Measured in Chrome with the long send wide open, RMS of the reverb tail arriving
 * at the tap after the source stops: **0.00000 before, 0.03876 after.** Not reduced
 * — absent.
 *
 * Stated as "one output" rather than as a list of nodes, because the failure is
 * always the same shape: something new is wired to the destination, and the
 * destination is not the thing anybody listens to.
 */

const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

afterEach(() => {
  if (realAudioContext === undefined)
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
  else (globalThis as { AudioContext?: unknown }).AudioContext = realAudioContext;
});

async function buildGraph(): Promise<{ graph: AudioGraph; context: StubContext }> {
  let built: StubContext | null = null;
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      built = new StubContext();
      return built as unknown as AudioContext;
    }
  };
  const graph = await AudioGraph.create({ stemCount: 3 });
  if (graph === null || built === null) throw new Error('the stub context did not build a graph');
  return { graph, context: built };
}

test('one node reaches the speakers, and a recording taps that node', async () => {
  const { graph, context } = await buildGraph();

  /*
   * The invariant. Every send return, every effect and every stem has to arrive at
   * the same place, because that place is what a recording listens to. Anything
   * wired to the destination directly is audible and unrecordable at the same time,
   * which is the least detectable bug in the whole mix: it sounds perfect while you
   * work and is missing from the artefact you ship.
   */
  expect(
    context.destination.inputs.length,
    `${context.destination.inputs.length} nodes reach the speakers; exactly one may`,
  ).toBe(1);

  const stream = graph.captureStream();
  expect(stream, 'a recording tap').not.toBeNull();
  const out = context.destination.inputs[0];
  expect(context.tap.inputs, 'the tap hears the same node the speakers do').toEqual([out]);
});

test('the transport fades before it stops, so a restart is not a click', async () => {
  /*
   * `BufferSource.stop()` lands wherever the waveform happens to be, and a step from
   * mid-waveform to zero is a click. It fires at the start line on every run and, since
   * the export restarts the score at the clip's zero, was recorded at the head of every
   * clip, where it was reported as a pop from the very first frame.
   *
   * Asserted as an ordering — the level reaches zero no later than the stop — rather
   * than as a fade length, because the length is a tuning constant and the ordering is
   * the contract.
   */
  const { graph, context } = await buildGraph();
  const buffer = { duration: 1, length: 128 } as unknown as AudioBuffer;
  graph.loadStem(0, buffer);
  graph.start();
  expect(context.sources.length, 'a stem source was created').toBeGreaterThan(0);

  context.currentTime = 5;
  graph.restart();

  const source = context.sources[0];
  const stopAt = source?.stops[0] ?? -1;
  expect(stopAt, 'the stop is scheduled ahead of now, not at it').toBeGreaterThan(5);

  // The source's own level node is the one thing between it and the stem's gain.
  const level = source?.inputs === undefined ? undefined : findLevelFedBy(context, source);
  const silenced = level?.gain.ramps.find((r) => r.value === 0);
  expect(silenced, 'the level was ramped to zero').toBeDefined();
  expect(
    silenced?.at ?? Infinity,
    'and it reaches zero no later than the stop',
  ).toBeLessThanOrEqual(stopAt);
});

/** The gain node a source was connected through. */
/** The first node upstream of `from` that matches, breadth first. The graph is small. */
function findUpstream(from: StubNode, matches: (node: StubNode) => boolean): StubNode | undefined {
  const seen = new Set<StubNode>([from]);
  const queue: StubNode[] = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) continue;
    if (node !== from && matches(node)) return node;
    for (const input of node.inputs) {
      if (seen.has(input)) continue;
      seen.add(input);
      queue.push(input);
    }
  }
  return undefined;
}

function findLevelFedBy(context: StubContext, source: StubNode): StubNode | undefined {
  const seen: StubNode[] = [context.destination];
  for (let i = 0; i < seen.length; i++) {
    const node = seen[i];
    if (node === undefined) continue;
    for (const input of node.inputs) {
      if (input === source) return node;
      if (!seen.includes(input)) seen.push(input);
    }
  }
  return undefined;
}

test('an injected context is used, and automation lands where it was scheduled', async () => {
  /*
   * The two additions an offline render needs. A context it can hand in, so the mix is
   * built on the thing that will render it; and a clock it can move, so every parameter
   * move lands at the frame it belongs to instead of at "now" — which offline is
   * wherever the render has got to.
   *
   * Both additive: with no context and no `at`, this is the behaviour the live game has.
   */
  const context = new StubContext();
  const graph = await AudioGraph.create({
    stemCount: 3,
    context: context as unknown as BaseAudioContext,
  });
  expect(graph, 'built on the context it was given').not.toBeNull();
  // Nothing was created behind our back: the stub is the only context in play.
  expect(context.destination.inputs.length, 'the mix reached this context').toBe(1);

  /*
   * The master filter, found by walking upstream rather than by looking one level down. It sits
   * inside the master bus now — between that bus's input and its output — so its exact depth is a
   * property of the layout and not of what this test is about, which is where automation lands.
   */
  const out = context.destination.inputs[0];
  const master =
    out === undefined ? undefined : findUpstream(out, (node) => node.type === 'lowpass');
  expect(master, 'the master filter').toBeDefined();

  graph?.at(4.5);
  graph?.layout.masterFilter.setCutoff(9000);
  expect(master?.frequency.ramps.at(-1)?.at, 'scheduled where it was asked for').toBe(4.5);

  graph?.at(null);
  context.currentTime = 2;
  graph?.layout.masterFilter.setCutoff(5000);
  expect(master?.frequency.ramps.at(-1)?.at, 'and back to now when released').toBe(2);
});

/**
 * **A mix nobody has asked to muffle is not muffled.** The master low-pass started at
 * `cutoffForSpeed(0, 1)` — 320 Hz — so every graph was a mix heard through a wall until its
 * caller drove the speed curve, which is one game's feel standing in as everybody's default.
 * Reported by the maintainer on 2026-09-19, while comparing the native host's render with Chrome's.
 * It starts open, at the top of `setCutoff`'s own range, and muffling is what a caller asks for.
 */
test('the master filter starts open, so a mix nobody muffled is heard whole', async () => {
  const context = new StubContext();
  const graph = await AudioGraph.create({
    stemCount: 1,
    context: context as unknown as BaseAudioContext,
  });
  expect(graph?.layout.masterFilter.filter.frequency.value).toBe(20000);
});

/**
 * **The slam's alignment heads the music bus**, ahead of the lift and so of the tap the sends hang
 * off, and it is fed from the node the wet arm is. The wet arm is late by its shaper's latency and
 * sums at the output with the dry arm *and* with the reverb and delay returns; an alignment on the
 * dry arm alone would leave the returns arriving before the note they are the room of.
 */
test('the slam’s alignment heads the music bus, so everything the wet arm meets is as late', async () => {
  const graph = await AudioGraph.create({
    stemCount: 1,
    context: new StubContext() as unknown as BaseAudioContext,
  });
  if (graph === null) throw new Error('the graph did not build');
  const { slam, lift } = graph.layout;
  const inputsOf = (node: AudioNode): StubNode[] => (node as unknown as StubNode).inputs;
  expect(inputsOf(lift.input), 'the lift follows the alignment').toContain(slam.align.output);
  const busInput = inputsOf(slam.wetInput)[0];
  expect(busInput, 'the wet arm is fed').toBeDefined();
  expect(inputsOf(slam.align.input), 'from where the wet arm is').toContain(busInput);
});

test('an offline graph launches its stems with no lead', async () => {
  /*
   * Live, the stems are launched slightly ahead so the layers start sample-locked
   * however long the calls take. Offline there is nothing to be late for — work
   * scheduled at an instant is already sample-locked — and a lead would push beat zero
   * off the clip's zero, which is the alignment the whole offline path exists to get
   * exactly right.
   */
  const context = new StubContext();
  const graph = await AudioGraph.create({
    stemCount: 1,
    context: context as unknown as BaseAudioContext,
  });
  graph?.loadStem(0, { duration: 1, length: 128 } as unknown as AudioBuffer);
  graph?.at(0);
  graph?.start();
  expect(context.sources[0]?.starts[0], 'beat zero is the clip zero').toBe(0);
});
