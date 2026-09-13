import { expect, test } from 'vitest';
import { stubContext, type StubNode } from '../audioHarness.ts';
import { MixBus } from './bus.ts';

/*
 * Three contracts, and only three. The rest of this class is getters and forwarding, which
 * `AGENTS.md` names explicitly as what not to test — and the mix's real behaviour is settled by the
 * sample-identity gate in `scripts/audio-baseline.mjs`, which tests every one of those forwards at
 * once with real signal rather than one at a time with none.
 *
 * What is here is the topology a test *can* judge, because the browser's own graph is write-only:
 * where an insert lands, where a send listens from, and whether mute can lose the level it will
 * return to.
 */

const context = () => stubContext() as unknown as BaseAudioContext;
const asStub = (node: AudioNode) => node as unknown as StubNode;
const insert = (ctx: BaseAudioContext) => ({ input: ctx.createGain(), output: ctx.createGain() });

test('inserts land between the fader and the output, in the order they were added', () => {
  const ctx = context();
  const bus = new MixBus('music', ctx, () => 0);
  const first = insert(ctx);
  const second = insert(ctx);
  bus.insert(first);
  bus.insert(second);

  // Read backwards from the output: `inputs` is what each stub node remembers being fed by.
  expect(asStub(bus.output).inputs).toContain(asStub(bus.tap));
  expect(asStub(bus.tap).inputs).toContain(asStub(second.output));
  expect(asStub(second.input).inputs).toContain(asStub(first.output));
  expect(asStub(first.input).inputs).toContain(asStub(bus.input));
});

test('a send listens after the fader, so turning a bus down turns down what it sends', () => {
  /*
   * The failure this catches is silent and is heard only as "the reverb did not follow the fader":
   * a send taken ahead of the level keeps feeding the return at full strength while a listener
   * watches a fader they believe is closed.
   */
  const ctx = context();
  const bus = new MixBus('music', ctx, () => 0);
  const verb = new MixBus('reverb', ctx, () => 0);
  bus.send(verb, 0.4);

  const sendGain = asStub(verb.input).inputs.at(-1);
  expect(sendGain?.inputs, 'the send hangs off the tap').toContain(asStub(bus.tap));
  // And the tap is downstream of the fader, which is what makes the send post-fader.
  expect(asStub(bus.tap).inputs).toContain(asStub(bus.input));
});

test('an insert added after the send tap is not heard by the sends', () => {
  /*
   * This is why the flag exists rather than every insert simply being in series. The slam is a
   * band of driven, clipped low end; `graph.ts` says in words that the sends hang off the stage
   * before it "so the reverb tail never hears the slam", because a six-second convolution of a
   * clipped bass hit is a mess that is still arriving three gates later.
   */
  const ctx = context();
  const bus = new MixBus('music', ctx, () => 0);
  const verb = new MixBus('reverb', ctx, () => 0);
  const late = insert(ctx);
  bus.insert(late, { postSend: true });
  bus.send(verb, 0.4);

  const sendGain = asStub(verb.input).inputs.at(-1);
  expect(sendGain?.inputs).toContain(asStub(bus.tap));
  expect(sendGain?.inputs, 'the post-send insert is not in what the send hears').not.toContain(
    asStub(late.output),
  );
  expect(asStub(late.input).inputs, 'but it is still in series, after the tap').toContain(
    asStub(bus.tap),
  );
});

test('mute silences without discarding the level it will return to', () => {
  const ctx = context();
  const bus = new MixBus('music', ctx, () => 0);
  bus.setLevel(0.7);
  bus.setMute(true);
  expect(asStub(bus.input).gain.ramps.at(-1)?.value).toBe(0);
  bus.setMute(false);
  expect(asStub(bus.input).gain.ramps.at(-1)?.value).toBeCloseTo(0.7, 6);
  expect(bus.level).toBeCloseTo(0.7, 6);
});
