import { afterEach, expect, test } from 'vitest';
import { AudioGraph } from './graph.ts';
import { StubContext } from './audioHarness.ts';

/**
 * A phone that has not been tapped yet still gets a mix.
 *
 * The bug behind it: audio absent on mobile devices, both Android and iOS.
 *
 * Every browser refuses to start audio for a page nobody has touched — that is
 * policy, not a fault, and this graph has a `wake()` whose entire job is to start
 * a suspended context on the first gesture. Its comment even states why nothing is
 * lost in the meantime: *"a suspended context's clock does not advance."*
 *
 * `create` did not believe it. It `await`ed `resume()` inside its own try/catch, so
 * a browser that **rejects** that call — which is what a rejection means when
 * autoplay is blocked, and what Safari does — sent the whole graph to the `catch`
 * and returned **null**: the temporary condition "nobody has tapped yet" reported
 * as the permanent one "this browser will not give us audio". And since the caller
 * latches `audioRequested` so the load happens once, null is forever. Silence for
 * the session, with a `wake()` that has nothing to wake.
 *
 * Desktop hid it completely, and that is the part worth remembering: Chrome grants
 * autoplay to a site the user keeps visiting, so on the machine the game is
 * developed on the context comes up already running and `resume()` resolves. The
 * bug is only visible on a device that has *not* earned that trust, which is every
 * phone a stranger arrives on from a share link.
 */

/** Suspended, and refusing to be resumed — a phone with no user gesture yet. */
class BlockedContext extends StubContext {
  constructor() {
    super({ state: 'suspended', refuseResume: true });
  }
}

const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  if (realAudioContext === undefined)
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
  else (globalThis as { AudioContext?: unknown }).AudioContext = realAudioContext;
  delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
  // A stubbed navigator is global state that outlives its test, and the next one
  // reads it as the browser it is running in.
  if (realNavigator !== undefined) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

test('a graph survives a browser that will not start it yet', async () => {
  let built: BlockedContext | null = null;
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      built = new BlockedContext();
      return built as unknown as AudioContext;
    }
  };

  const graph = await AudioGraph.create({ stemCount: 3 });

  expect(graph, 'a suspended context is a graph, not a failure').not.toBeNull();
  expect(graph?.audible, 'and it knows it is not making sound yet').toBe(false);

  /*
   * And the gesture path still works: `wake` is what the first tap calls, and it
   * must survive the same rejection rather than throwing out of an event handler.
   */
  const context = built as unknown as BlockedContext | null;
  const before = context?.resumeCalls ?? 0;
  expect(() => graph?.wake()).not.toThrow();
  await Promise.resolve();
  expect(context?.resumeCalls ?? 0, 'the tap asked the browser again').toBeGreaterThan(before);

  // Once the browser relents, the graph that was kept is the one that plays.
  if (context !== null) context.state = 'running';
  expect(graph?.audible, 'the graph that was kept is the one that plays').toBe(true);
});

/**
 * The iPhone case, which is a different policy wearing the same symptom.
 *
 * Reported on a phone that plays every other site: no audio at all, on iPhone only.
 * Ringer switch on silent, everything else on the web audible.
 *
 * That is not autoplay and not a format. On iOS, Web Audio is put in the *ambient*
 * audio session, and an ambient session is silenced by the hardware switch — while a
 * `<video>` or an `<audio>` element gets the playback session and is not. So a site
 * built out of `AudioContext`, which is this whole engine, is the one kind of site that
 * goes completely quiet in a pocket, and nothing about the graph, the gesture or the
 * files is wrong.
 *
 * The session is the page's to claim: `navigator.audioSession.type = 'playback'` says
 * *this page's audio is the point of it*, and WebKit then treats it as media rather
 * than as decoration. Claimed before the context exists, so the context is born into
 * the right session.
 */
test('a phone with its ringer on silent still gets audio', async () => {
  const session = { type: 'auto' };
  Object.defineProperty(globalThis, 'navigator', {
    value: { audioSession: session },
    configurable: true,
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      return new BlockedContext() as unknown as AudioContext;
    }
  };

  const graph = await AudioGraph.create({ stemCount: 1 });

  expect(graph).not.toBeNull();
  expect(session.type, 'the page claims the playback session').toBe('playback');
});

test('a browser with no audio session at all is left alone', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      return new BlockedContext() as unknown as AudioContext;
    }
  };

  // Every browser but Safari: the property does not exist and asking for audio
  // must not become an error path of its own.
  await expect(AudioGraph.create({ stemCount: 1 })).resolves.not.toBeNull();
});

/**
 * And when there is genuinely no audio, the caller is told *what* was missing.
 *
 * `game_error` in the Worker's logs said only `soundtrack_init_null`, which covers a
 * browser with no `AudioContext`, a context that threw, and every future reason as
 * well — so the one event that reports silence could not be acted on. A reason costs
 * a string.
 */
test('a browser with no audio at all says so, by name', async () => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
  const reasons: string[] = [];

  const graph = await AudioGraph.create({ stemCount: 1, onUnavailable: (r) => reasons.push(r) });

  expect(graph).toBeNull();
  expect(reasons).toEqual(['no-audio-context']);
});

/** An older WebKit exposes the prefixed constructor and nothing else. */
test('a browser that only has the prefixed constructor still gets a graph', async () => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext = class {
    constructor() {
      return new BlockedContext() as unknown as AudioContext;
    }
  };

  const graph = await AudioGraph.create({ stemCount: 1 });

  expect(graph, 'the prefixed constructor is still an audio context').not.toBeNull();
  delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
});
