/**
 * A Web Audio context that answers everything, for tests that need a graph and not a browser.
 *
 * **Not a `.test.ts` file, and that is the point.** Vitest registers a test when the file declaring
 * it is imported, so a test file importing a stub from beside another file's tests would re-run
 * every test in that file too. Split out so importing the harness costs nothing but the harness —
 * the same reasoning, and the same shape, as `rendererHarness.ts` in core.
 *
 * **It exists because there were three of these.** `autoplay.test.ts`, `graph.test.ts` and
 * `mixOutput.test.ts` each carried their own `StubNode` and their own `param()`, and they had
 * already drifted: one recorded what was connected to it and two did not, one had an
 * `fftSize` of 512 and another 2048, one could decode audio and the others could not. `AGENTS.md`'s
 * 2026-08-17 rule is exactly this — two implementations of one decision drift, and they drift
 * invisibly when the constants look identical.
 *
 * **A stub is not a contract and nothing here is tested directly.** What it must do is let the real
 * graph build and let a test read back what the graph did. Where a member exists only so a
 * constructor does not throw, it does nothing and says so.
 */

/** A parameter that remembers every move asked of it, so a test can ask when a fade was scheduled. */
export interface StubParam {
  value: number;
  readonly ramps: { value: number; at: number }[];
  setValueAtTime(value: number, at: number): void;
  linearRampToValueAtTime(value: number, at: number): void;
  cancelScheduledValues(at: number): void;
  setTargetAtTime(value: number, at: number, tc: number): void;
}

export function stubParam(): StubParam {
  const ramps: { value: number; at: number }[] = [];
  return {
    value: 0,
    ramps,
    setValueAtTime: (value, at) => ramps.push({ value, at }),
    linearRampToValueAtTime: (value, at) => ramps.push({ value, at }),
    cancelScheduledValues: () => undefined,
    setTargetAtTime: (value, at) => ramps.push({ value, at }),
  };
}

/**
 * A node that remembers what was connected to it. Enough graph to build against.
 *
 * `inputs` is what makes a topology assertable at all: the browser's own graph is write-only, so a
 * test asking "is the send taken from the output or the input" has nowhere else to look.
 */
export class StubNode {
  readonly inputs: StubNode[] = [];
  /** Instants `stop` was asked for, so a test can see whether a fade preceded one. */
  readonly stops: number[] = [];
  /** Instants `start` was asked for, so a test can see an offline launch has no lead. */
  readonly starts: number[] = [];
  type = '';
  buffer: unknown = null;
  loop = false;
  readonly gain = stubParam();
  readonly frequency = stubParam();
  readonly Q = stubParam();
  readonly delayTime = stubParam();
  readonly playbackRate = stubParam();
  readonly pan = stubParam();
  fftSize = 2048;
  smoothingTimeConstant = 0;
  readonly frequencyBinCount = 1024;

  /** A buffer source answers this; the spatial layer drives it for doppler. */
  readonly detune = stubParam();

  /**
   * The channel plumbing a multi-channel source needs.
   *
   * `channelInterpretation` is the one that matters and is the one a test asserts: the default
   * up-mixes or down-mixes by *meaning*, and W, Y, Z, X are not left, right, centre and low
   * frequency, so a field read that way comes out as a blur that still plays.
   */
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';

  /* What a panner answers. */
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = stubParam();
  readonly positionY = stubParam();
  readonly positionZ = stubParam();

  /**
   * `output` is accepted and ignored, which is enough for what these tests ask.
   *
   * A splitter's outputs go to different nodes, and what a test here checks is *which node* was
   * connected rather than from which output — the coefficient gains are one per (speaker, channel)
   * pair, so the pair is already carried by the node's identity.
   */
  connect(target: StubNode, output?: number): StubNode {
    void output;
    target.inputs.push(this);
    return target;
  }
  disconnect(): void {}
  start(at = 0): void {
    this.starts.push(at);
  }
  stop(at = 0): void {
    this.stops.push(at);
  }
  getByteFrequencyData(): void {}
  getFloatFrequencyData(): void {}
}

/**
 * The listener, in both shapes a browser might offer it.
 *
 * Both are present deliberately, because the code under test picks one and the choice is a feature
 * detection rather than a preference: a test that only had the modern form could not tell whether
 * the legacy branch was ever written. `positions` records the legacy calls so a test can assert
 * which branch ran.
 */
export class StubListener {
  readonly positionX = stubParam();
  readonly positionY = stubParam();
  readonly positionZ = stubParam();
  readonly forwardX = stubParam();
  readonly forwardY = stubParam();
  readonly forwardZ = stubParam();
  readonly upX = stubParam();
  readonly upY = stubParam();
  readonly upZ = stubParam();
  readonly positions: number[][] = [];
  readonly orientations: number[][] = [];
  setPosition(x: number, y: number, z: number): void {
    this.positions.push([x, y, z]);
  }
  setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    this.orientations.push([fx, fy, fz, ux, uy, uz]);
  }
}

export interface StubContextOptions {
  /** `suspended` is a browser that has not been given a gesture yet. */
  readonly state?: string;
  /** A context that refuses to resume, which is what a blocked autoplay policy looks like. */
  readonly refuseResume?: boolean;
  /** Absent on a browser too old for it; `createLoop` falls back rather than skipping the loop. */
  readonly stereoPanner?: boolean;
  /** Absent where the browser has only the deprecated `setPosition`/`setOrientation` pair. */
  readonly listenerParams?: boolean;
}

export class StubContext {
  readonly destination = new StubNode();
  /** Every buffer source built, in order, so a test can inspect the transport. */
  readonly sources: StubNode[] = [];
  readonly listener = new StubListener();
  /** Every panner built, in order, so a test can inspect what was placed in the world. */
  readonly panners: StubNode[] = [];
  /**
   * Every convolver built, in order.
   *
   * Counted because "a second routing rather than a second convolver" is a claim about how many of
   * them exist, and a convolver is the most expensive node in this graph. A test that asserted the
   * send worked would not notice one being built per source.
   */
  readonly convolvers: StubNode[] = [];
  outputLatency = 0;
  readonly tap = { stream: {} as MediaStream, ...new StubNode() } as unknown as StubNode & {
    stream: MediaStream;
  };
  state: string;
  currentTime = 0;
  sampleRate = 48000;
  /** How many times a resume was attempted, for the tests about a context that will not start. */
  resumeCalls = 0;

  constructor(private readonly options: StubContextOptions = {}) {
    this.state = options.state ?? 'running';
    if (options.stereoPanner === false) {
      (this as { createStereoPanner?: unknown }).createStereoPanner = undefined;
    }
    if (options.listenerParams === false) {
      for (const name of ['positionX', 'forwardX', 'upX'] as const) {
        (this.listener as unknown as Record<string, unknown>)[name] = undefined;
      }
    }
  }

  createGain(): StubNode {
    return new StubNode();
  }
  createBiquadFilter(): StubNode {
    // `type` is assigned by the graph right after creation; tests read it back to find the
    // master low-pass without knowing the construction order.
    return new StubNode();
  }
  createConvolver(): StubNode {
    const convolver = new StubNode();
    this.convolvers.push(convolver);
    return convolver;
  }
  createWaveShaper(): StubNode {
    return new StubNode();
  }
  createDelay(): StubNode {
    return new StubNode();
  }
  createAnalyser(): StubNode {
    return new StubNode();
  }
  createPanner(): StubNode {
    const panner = new StubNode();
    this.panners.push(panner);
    return panner;
  }
  createBufferSource(): StubNode {
    const source = new StubNode();
    this.sources.push(source);
    return source;
  }
  createStereoPanner(): StubNode {
    return new StubNode();
  }
  createMediaStreamDestination(): StubNode {
    return this.tap;
  }
  createChannelSplitter(): StubNode {
    return new StubNode();
  }
  createChannelMerger(): StubNode {
    return new StubNode();
  }
  /*
   * `numberOfChannels` is answered because a decoder that refuses a buffer of the wrong shape has
   * to be able to see the shape. It was absent, so every such refusal fired against `undefined` —
   * which happened to be right and for the wrong reason.
   */
  createBuffer(
    channels: number,
    length: number,
  ): { numberOfChannels: number; length: number; getChannelData(): Float32Array } {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, getChannelData: () => data };
  }
  async decodeAudioData(): Promise<AudioBuffer> {
    return {} as AudioBuffer;
  }
  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.options.refuseResume === true) {
      throw new DOMException('play() blocked', 'NotAllowedError');
    }
  }
  async close(): Promise<void> {}
}

/** The context most tests want: running, complete, and recording what was done to it. */
export function stubContext(options?: StubContextOptions): StubContext {
  return new StubContext(options);
}

/**
 * Install a stub as the page's `AudioContext` and hand back the one that gets built.
 *
 * The graph constructs its own context through the global, so a test that wants to look at the
 * nodes has to intercept the construction rather than pass one in. Returns a getter rather than
 * the context, because nothing exists until the code under test asks for it.
 */
export function installStubAudioContext(options?: StubContextOptions): () => StubContext | null {
  let built: StubContext | null = null;
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      built = new StubContext(options);
      return built as unknown as AudioContext;
    }
  };
  return () => built;
}
