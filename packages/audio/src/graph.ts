import { AmbientLoop } from './ambientLoop.ts';
import { KickDetector } from './rhythm/kickDetector.ts';
import type { FetchLike } from './registry.ts';
import { SoundRegistry } from './registry.ts';
import {
  LIFT_FLOOR_HZ,
  SLAM_ATTACK_SEC,
  SLAM_CLIP_KNEE,
  SLAM_CLOSED_HZ,
  SLAM_DECAY_SEC,
  SLAM_DRIVE,
  SLAM_DUCK,
  SLAM_OPEN_HZ,
  SLAM_SHELF_DB,
  SLAM_SHELF_HZ,
  clamp01,
  cutoffForSpeed,
  liftFrequencyHz,
  liftGainFor,
} from './filters.ts';
import { audioContextConstructor, claimPlaybackSession, errorName } from './session.ts';
import { MixConsole } from './mix/console.ts';
import { defaultLayout, type DefaultLayout } from './mix/defaultLayout.ts';

/**
 * The audio graph: layered stems into a master filter, with parallel sends.
 *
 *   stems[] → stemGain[] → musicGain ─┬→ lift(highpass→duck) → dry ─┬→ bus → lowpass → dest
 *                                     └→ slam(shelf→drive→clip) ──┘
 *   one-shots → level ─────→ effectsGain ───────────────────┘   │
 *                                                              │
 *                              lift ─────────────────────────┬──┼→ convolver ────→ dest
 *                                                            ├──┼→ longConvolver → dest
 *                                                            └──┼→ feedbackDelay → dest
 *
 * Music and effects have their own gain stage because players expect to turn them
 * down independently — muting the score while keeping the game audible is the single
 * most-used audio setting there is.
 *
 * **The sends are fed from the music alone.** They hung off the shared bus first, which
 * put reverb and delay on every sound the game made when only the score should carry
 * them. A footstep with a
 * six-second tail on it is not atmosphere, it is a bug, and the effects that carry
 * the world's own sound need to stay dry and immediate to be legible. The master
 * filter still applies to everything, which is deliberate: going under water muffles
 * the world, not only the score.
 *
 * Game code expresses musical intent — "louder, faster, brighter" — and never
 * builds nodes. That boundary is what stops mixing decisions from ending up
 * spread across gameplay code where nobody can find them.
 *
 * Everything here degrades to silence rather than to a crash. A browser that
 * blocks audio, an unsupported node type, a context that never resumes: all of
 * them leave a playable game, because sound is not what the game is for.
 */
export interface AudioGraphOptions {
  /** How many simultaneous music layers to allocate. */
  stemCount: number;
  /**
   * Build on this context instead of creating a live one.
   *
   * For rendering a mix rather than hearing it: hand in an `OfflineAudioContext` and
   * every node below is built on it, so `startRendering` produces the same mix the
   * speakers would have made. Additive — omitting it is exactly the previous
   * behaviour.
   */
  readonly context?: BaseAudioContext;
  /**
   * Where the music and effects stages start. Unity for both when omitted.
   *
   * The reason this exists rather than a `setMusicVolume` call after construction: a
   * graph built to *reproduce* a mix has to be at that mix's levels from its own zero,
   * and every parameter move here is a `setTargetAtTime` — which approaches its target
   * over `RAMP` and so would open a rendered clip with a third of a second of glide
   * down from unity to whatever the player actually chose. A level that does not change
   * for the whole render is not a move; it is where the parameter starts.
   *
   * It also cannot be scheduled on the wrong clock, which the other shape can: offline
   * there is no "now", so a level set imperatively lands wherever the render happens to
   * have got to. See `at`.
   */
  readonly levels?: MixLevels;
  /**
   * Fetch every registered sound goes through, instead of the global `fetch`.
   *
   * A game may need to gate its own asset requests — a signed URL, a token header —
   * without the engine knowing why. Additive — omitting it is exactly the previous
   * behaviour, and `SoundRegistry` already degrades any fetch failure to its `synth`
   * fallback, so a caller's custom fetch can fail as loudly or as quietly as it likes
   * without a new error path opening up here.
   */
  readonly fetchImpl?: FetchLike;
  /**
   * Told why this browser gave no audio at all, when `create` returns null.
   *
   * Null is deliberately coarse — it means "there is nothing to wake", and a caller
   * reporting it learns only that somebody, somewhere, heard nothing. A game with
   * telemetry needs the other half: a missing constructor and a context that threw
   * are different bugs with different fixes, and the field that said neither was
   * `soundtrack_init_null`. Never called when a graph is returned; a suspended
   * context is not unavailable.
   */
  readonly onUnavailable?: (reason: string) => void;
  /**
   * Where randomness comes from, for the noise the reverb impulses are made of.
   *
   * Defaults to `Math.random`, which is what a game wants: a hall built from a fresh sequence every
   * session is a hall, and one built from a fixed one is a hall with a repeating texture in its
   * tail. Supplied only where a render has to be reproducible sample for sample — a check script
   * comparing two mixes cannot do that while every convolver is different.
   *
   * Additive: omitting it is exactly the previous behaviour.
   */
  readonly random?: () => number;
}

/**
 * The two levels a player is given control of: the score, and everything else.
 *
 * Named as a pair because they travel as one — a second graph reproducing this mix
 * needs both or neither, and the failure of carrying one is silent.
 */
export interface MixLevels {
  readonly music: number;
  readonly effects: number;
}

/** Smoothing for parameter moves, seconds. Long enough to never click. */
const RAMP = 0.08;
/**
 * Fade applied before a source is stopped, seconds.
 *
 * Eight milliseconds. `BufferSource.stop()` lands wherever the waveform happens to be,
 * and a step from mid-waveform to zero is a click — heard at the start line on every
 * run, and *recorded at the clip's zero on every export*, because that is where the
 * score is restarted — it was reported as a pop at the very beginning of every clip.
 *
 * Short enough that the transport still reads as stopping rather than fading, long
 * enough that the discontinuity is gone: a click is broadband because it is
 * instantaneous, and eight milliseconds puts its fastest component below where the ear
 * hears a transient.
 */
const FADE_OUT = 0.008;

const LONG_REVERB_SECONDS = 6;
const LONG_REVERB_DECAY = 1.5;
/** Baseline delay feedback: one clear repeat, not a rhythm of its own. */
const DELAY_FEEDBACK = 0.34;

export class AudioGraph {
  readonly context: BaseAudioContext;
  readonly registry: SoundRegistry;

  /**
   * The mix, as a tree of buses rather than as nodes held here.
   *
   * Everything below that used to be a field — the music and effects stages, the master filter, the
   * lift, the slam, the three sends and their returns — is a bus or an insert now, and
   * `defaultLayout` is where the shape they make is written down. What is left in this class is the
   * transport: what is playing, from where, at what rate.
   */
  private readonly mix: MixConsole;
  private readonly layoutNodes: DefaultLayout;
  /**
   * The recording tap, created once.
   *
   * Cached because it used to be built per call and never taken down — the mix accumulated one
   * `MediaStreamAudioDestinationNode` per export, each still pulling audio for the rest of the
   * session. Ten exports while testing is ten of them, on the thread least able to absorb it and
   * the one whose overrun is heard as a click.
   */
  private tap: MediaStreamAudioDestinationNode | null = null;
  /**
   * The player's own two levels, held here because a second graph built to render this mix has to
   * be built at them.
   *
   * Mirrored rather than read back off the buses for the reason the buses themselves mirror: a
   * level is *ramped*, and mid-ramp a parameter is somewhere between where it was and where it is
   * going. A fade asking "back to the player's level" or a render asking "at what level" would both
   * get whatever instant they happened to ask on.
   *
   * Which is also why `fadeMusic` does not write here. A fade is part of an edit, not a setting; it
   * has to return to the setting when it is over.
   */
  private readonly mixLevels: { music: number; effects: number };
  /**
   * A gain per live source, so a stem can be faded out without touching the stem's own level —
   * which the *replacement* source is already connected to.
   */
  private readonly sourceLevels = new Map<AudioBufferSourceNode, GainNode>();
  /** Where scheduled work lands: an explicit instant, or null for "now". See `at`. */
  private atSec: number | null = null;
  private readonly stemGains: GainNode[] = [];
  private readonly stemBuffers: (AudioBuffer | null)[] = [];
  private readonly stemSources: AudioBufferSourceNode[] = [];
  private started = false;
  /**
   * Transport position, integrated rather than derived from elapsed wall time.
   *
   * The playback rate moves with the character, so three seconds of context time at
   * rate 1.1 is 3.3 seconds of tape — and a caller that puts the track's beat zero
   * on a start line needs to know where the tape actually is.
   */
  private positionSec = 0;
  private positionAt = 0;
  private rate = 1;
  private paused = false;

  private constructor(context: BaseAudioContext, options: AudioGraphOptions) {
    this.context = context;
    this.registry = new SoundRegistry(options.fetchImpl);
    this.mixLevels = {
      music: clamp01(options.levels?.music ?? 1),
      effects: clamp01(options.levels?.effects ?? 1),
    };

    /*
     * The console is handed this graph's clock rather than keeping its own, so `at()` moves the
     * whole mix and not only the transport. Two clocks would be two answers to "when", and offline
     * the one that lost would put its moves on instant zero.
     */
    this.mix = new MixConsole(context, {
      scheduleAt: () => this.scheduleAt(),
      random: options.random,
    });
    this.layoutNodes = defaultLayout(this.mix, this.mixLevels);

    for (let i = 0; i < options.stemCount; i++) {
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(this.layoutNodes.music.input);
      this.stemGains.push(gain);
      this.stemBuffers.push(null);
    }
  }

  /** The mix this graph plays into, for a caller that wants a bus of its own. */
  get console(): MixConsole {
    return this.mix;
  }

  /**
   * Build a graph, or return null only if the browser has no audio to give.
   *
   * **Null means "this browser will not do audio at all", never "not yet".** The
   * distinction is the whole of a bug that silenced audio on mobile devices, both
   * Android and iOS: this used to `await context.resume()`
   * inside the try, so a browser that *rejects* that call — which is what a
   * rejection means when autoplay is blocked — threw a perfectly good graph into
   * the `catch` and reported no audio. The caller latches its load so it happens
   * once, so that null was permanent: silence for the session, with a `wake()`
   * that had nothing left to wake.
   *
   * A suspended context is not a failure. Its clock does not advance, so nothing
   * scheduled on it is missed, and `wake()` exists to start it on the first
   * gesture. The resume is still *attempted* here, because when this is called
   * from a gesture — or on a site the browser already trusts — it starts
   * immediately and there is no reason to wait for a tap that already happened.
   * It is just no longer awaited, and no longer fatal.
   *
   * Desktop cannot show you this. Chrome grants autoplay to a site its user keeps
   * visiting, so on the machine this game is built on the context comes up
   * already running. It only breaks on a device that has not earned that trust,
   * which is every phone arriving from a share link.
   */
  static async create(options: AudioGraphOptions): Promise<AudioGraph | null> {
    try {
      // A context handed in is used as it is: an offline one has no `resume` to call
      // and no gesture to wait for, and rendering starts when its owner says so.
      const given = options.context;
      if (given !== undefined) return new AudioGraph(given, options);
      // Before the context exists, so the context is born into the right session.
      claimPlaybackSession();
      const Ctor = audioContextConstructor();
      if (Ctor === undefined) {
        options.onUnavailable?.('no-audio-context');
        return null;
      }
      const context = new Ctor();
      const graph = new AudioGraph(context, options);
      graph.wake();
      return graph;
    } catch (error) {
      options.onUnavailable?.(`context-threw:${errorName(error)}`);
      return null;
    }
  }

  /**
   * Whether the context is actually producing sound.
   *
   * A context built without a user gesture is `suspended`: nodes run, sources are
   * scheduled, and nothing is heard. A caller that has something to say about that — an
   * intro film with a score, say — needs to be able to ask.
   */
  get audible(): boolean {
    return this.live()?.state === 'running';
  }

  /**
   * Ask the browser to start the context, if it will.
   *
   * Safe to call from anywhere and safe to call repeatedly: outside a gesture the promise
   * simply rejects, which is not an error state — it is the policy working. Anything
   * already scheduled begins when it succeeds, because a suspended context's clock does
   * not advance, so nothing is missed in the meantime.
   */
  wake(): void {
    const live = this.live();
    if (live === null || live.state === 'running') return;
    void live.resume().catch(() => {
      // Not allowed yet. The next gesture will try again.
    });
  }

  loadStem(index: number, buffer: AudioBuffer): void {
    this.stemBuffers[index] = buffer;
  }

  /** Whether the stems are running. */
  get playing(): boolean {
    return this.started;
  }

  /**
   * Start every stem at one scheduled instant.
   *
   * Layers must be sample-locked: started independently they drift apart by
   * however long each `start()` call happened to take, and a bassline a few
   * milliseconds off its drums is heard as flamming rather than as one track.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.positionSec = 0;
    this.launch(0);
  }

  /** Whether the transport is stopped mid-track, as opposed to not yet started. */
  get held(): boolean {
    return this.paused;
  }

  /**
   * Stop the stems where they are.
   *
   * The tape stops — this is a *pause*, not a duck, and the distinction is what
   * several rounds of feedback kept correcting toward: the pause itself was right, it
   * only ever needed a longer tail of effects to keep the music in the background.
   * So the source stops
   * and the sends carry what was already in flight. Reverb and delay live downstream
   * of the stems, so cutting the source is exactly what leaves a decaying tail
   * behind, and `setLongReverbSend` is how far that tail reaches.
   *
   * Idempotent: the caller is a per-frame mix that knows a *state*, not an event.
   */
  hold(): void {
    if (!this.started || this.paused) return;
    this.advance();
    this.stopSources();
    this.paused = true;
  }

  /**
   * Start the stems again from where `hold` left them.
   *
   * From where it left them, rather than from where the tape *would* have been: a
   * pause that catches up is a jump cut, and on a long glide it is audible as the
   * track skipping. The cost is that airborne time puts the score behind the route's
   * bar grid — a real trade, taken deliberately, because the hold is felt on every
   * jump and the grid is felt once at the start line.
   */
  release(): void {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.launch(this.positionSec);
  }

  /**
   * Stop the stems and start them again from the top.
   *
   * A `BufferSource` cannot be rewound — the spec makes it one-shot — so starting
   * over means discarding the sources and creating new ones. That is cheap: a
   * source node is a handle onto a buffer that is already decoded and already
   * resident, and nothing about the graph downstream of it is rebuilt.
   *
   * Exists because a caller needs the track's beat zero to coincide with something
   * in its own world. Left running instead, a loop's downbeats land somewhere
   * different on every attempt.
   *
   * **Returns how long until beat zero is actually heard**, in seconds, because
   * `launch` schedules a little ahead of now and a caller lining a picture up
   * against the music needs that number rather than an assumption. Zero when
   * nothing started.
   */
  restart(): number {
    this.stopSources();
    this.started = false;
    this.paused = false;
    this.start();
    return this.startsInSec;
  }

  /**
   * Seconds until the scheduled start of whatever is playing, or 0 if it is
   * already sounding.
   *
   * Reads the instant `launch` scheduled, which is the only authority on when the
   * stems begin: everything else about the transport is a consequence of it.
   */
  get startsInSec(): number {
    if (!this.started || this.paused) return 0;
    return Math.max(0, this.positionAt - this.scheduleAt());
  }

  /**
   * Create one source per stem, all at the same scheduled instant and the same
   * offset into the buffer.
   *
   * Layers must be sample-locked: started independently they drift apart by however
   * long each `start()` call happened to take, and a bassline a few milliseconds off
   * its drums is heard as flamming rather than as one track.
   */
  private launch(offsetSec: number): void {
    const at = this.scheduleAt() + this.startLead();
    for (let i = 0; i < this.stemGains.length; i++) {
      const buffer = this.stemBuffers[i];
      const gain = this.stemGains[i];
      if (buffer === undefined || buffer === null || gain === undefined) continue;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.value = this.rate;
      // Through its own level, which is what `stopSources` fades. Straight into the
      // stem's gain would mean fading the stem — and the source replacing it.
      const level = this.context.createGain();
      level.gain.value = 1;
      source.connect(level);
      level.connect(gain);
      this.sourceLevels.set(source, level);
      // Wrapped, because the stems loop: an offset past the end of the buffer is a
      // silent source, which is a track that never comes back.
      source.start(at, buffer.duration > 0 ? offsetSec % buffer.duration : 0);
      this.stemSources.push(source);
    }
    this.positionSec = offsetSec;
    this.positionAt = at;
  }

  /**
   * Stop every stem, quietly. See `FADE_OUT` for why the fade is not optional.
   *
   * The sources are dropped from `stemSources` immediately but stay connected until
   * their fade has run: disconnecting a node mid-fade is the same discontinuity this
   * exists to remove.
   */
  private stopSources(): void {
    const at = this.scheduleAt();
    for (const source of this.stemSources) {
      const level = this.sourceLevels.get(source);
      this.sourceLevels.delete(source);
      if (level !== undefined) {
        level.gain.cancelScheduledValues(at);
        level.gain.setValueAtTime(level.gain.value, at);
        level.gain.linearRampToValueAtTime(0, at + FADE_OUT);
      }
      try {
        source.stop(at + FADE_OUT);
      } catch {
        // A source that has already ended throws on stop. Nothing to do about a
        // node we were about to discard anyway.
      }
      this.release_(source, level);
    }
    this.stemSources.length = 0;
  }

  /**
   * Let go of a faded-out source once it can no longer be heard.
   *
   * A timer rather than `onended`, because an offline render has no wall clock to fire
   * one on and the nodes it leaves behind are discarded with the context anyway. Live,
   * a handful of nodes for a fifth of a second is cheaper than a listener per source.
   */
  private release_(source: AudioBufferSourceNode, level: GainNode | undefined): void {
    if (typeof setTimeout !== 'function') return;
    setTimeout(
      () => {
        try {
          source.disconnect();
          level?.disconnect();
        } catch {
          // Already gone; the graph was torn down under us.
        }
      },
      (FADE_OUT + 0.2) * 1000,
    );
  }

  /**
   * Schedule everything that follows at `seconds` on this context's timeline, or at
   * "now" when null.
   *
   * An offline render sets it once per frame and gets a mix whose every move lands
   * where the picture is, exactly, with no clock involved. Live callers never touch it.
   */
  at(seconds: number | null): void {
    this.atSec = seconds;
  }

  /**
   * The instant scheduled work lands on.
   *
   * One reader, so "now" exists in one place — and so an offline render can move it.
   */
  private scheduleAt(): number {
    return this.atSec ?? this.context.currentTime;
  }

  /**
   * How far ahead the stems are launched, seconds.
   *
   * Live it is a lead, so the layers start sample-locked however long the calls take.
   * Offline there is nothing to be late for: work scheduled at an exact instant is
   * already sample-locked, and a lead would only push beat zero off the clip's zero.
   */
  private startLead(): number {
    return this.atSec === null ? 0.06 : 0;
  }

  /** The context as a live one, or null when this graph is rendering offline. */
  private live(): AudioContext | null {
    const context = this.context as AudioContext;
    return typeof context.resume === 'function' && typeof context.state === 'string'
      ? context
      : null;
  }

  /** Carry the transport position up to now at the rate it has been running at. */
  private advance(): void {
    const now = this.context.currentTime;
    if (this.started && !this.paused && now > this.positionAt) {
      this.positionSec += (now - this.positionAt) * this.rate;
    }
    this.positionAt = now;
  }

  setStemGain(index: number, gain: number): void {
    this.ramp(this.stemGains[index]?.gain, Math.max(0, gain));
  }

  /**
   * The layout this graph plays into: its buses, its inserts and its returns.
   *
   * **This is where the mix went in 3.0.0.** Every setter this class used to carry — the two
   * volumes, the lift, the slam, the master filter, the three sends and the delay — is a method on
   * a bus or an insert now, and `PORTING.md` maps them one for one. They were removed rather than
   * left forwarding, because a shim that works forever is a second answer to every question the
   * console already answers, and the two would drift the first time one of them grew a clamp.
   */
  get layout(): DefaultLayout {
    return this.layoutNodes;
  }

  /**
   * The two levels a player chose, read from the buses that hold them.
   *
   * Derived rather than mirrored, which it was until 3.0.0. A mirror is a second place the answer
   * is decided, and the reason the old one existed — that a level is ramped, so mid-ramp the
   * *parameter* is between two values — is answered by the bus itself keeping its own fader
   * setting. A duck does not move it, which is the distinction `fadeMusic` needed a paragraph for.
   */
  get levels(): MixLevels {
    return { music: this.layoutNodes.music.level, effects: this.layoutNodes.effects.level };
  }

  setPlaybackRate(rate: number): void {
    const clamped = Math.min(Math.max(rate, 0.05), 2);
    // Position first, then the new rate: the seconds already elapsed were played at
    // the *old* rate, and crediting them at the new one loses the transport's place
    // a little on every change — which is every frame the character accelerates.
    this.advance();
    this.rate = clamped;
    for (const source of this.stemSources) {
      this.ramp(source.playbackRate, clamped);
    }
  }

  /**
   * Start a looping environmental bed, silent until the caller gives it a
   * level. Routed through the effects stage, so the effects slider governs the
   * world's own sound and the music slider governs only the score.
   *
   * Returns null for a missing buffer, so a caller can create loops
   * unconditionally and let an unresolved slot simply be silent.
   */
  createLoop(buffer: AudioBuffer | undefined): AmbientLoop | null {
    if (buffer === undefined) return null;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = this.context.createGain();
    gain.gain.value = 0;

    // Stereo panning is absent in a few older engines. Direction is a nicety;
    // hearing the fire at all is not, so fall back rather than skip the loop.
    let panner: StereoPannerNode | null = null;
    if (typeof this.context.createStereoPanner === 'function') {
      panner = this.context.createStereoPanner();
      source.connect(panner);
      panner.connect(gain);
    } else {
      source.connect(gain);
    }
    gain.connect(this.layoutNodes.effects.input);
    source.start();

    /*
     * The loop schedules against this graph's own instant, not the context's
     * `currentTime`. Offline they are not the same thing: `currentTime` is zero
     * for the whole time a render is being described, so a loop reading it would
     * pile every level change in the clip onto instant zero. One closure per
     * loop, built here at setup and never in a frame.
     */
    return new AmbientLoop(() => this.scheduleAt(), source, gain, panner);
  }

  /**
   * A live kick detector listening to the music.
   *
   * Tapped off the music stage rather than the master bus, so it hears the
   * track and not the game's own sound effects — a splash landing on the beat
   * would otherwise read as a kick and flash the world.
   *
   * The taps are pure observers: nothing is connected onward from them, so
   * inserting a detector cannot change what anyone hears.
   */
  createKickDetector(): KickDetector | null {
    try {
      const wide = this.context.createAnalyser();
      wide.fftSize = 1024;
      wide.smoothingTimeConstant = 0.32;

      const lowpass = this.context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 180;
      lowpass.Q.value = 0.707;

      const bandpass = this.context.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 62;
      bandpass.Q.value = 1.4;

      const kick = this.context.createAnalyser();
      kick.fftSize = 512;
      kick.smoothingTimeConstant = 0.08;

      this.layoutNodes.music.input.connect(wide);
      this.layoutNodes.music.input.connect(lowpass);
      lowpass.connect(bandpass);
      bandpass.connect(kick);

      return new KickDetector({ wide, kick, bandpass, context: this.context });
    } catch {
      // A browser that will not give us an analyser gets a game with steady
      // lights, which is the same game.
      return null;
    }
  }

  /**
   * A stream of everything the player is hearing, for a clip recording.
   *
   * Tapped off the mix rather than replacing the destination, so recording cannot
   * silence the game — a clip that captures perfectly while the player hears
   * nothing is a bug they would report as "the export broke the sound".
   *
   * **Off `out`, which is the whole mix, and not off `master`, which is the dry
   * path.** The send returns rejoin downstream of the master filter, so a tap on
   * `master` hears the track and the speed filter and nothing wet at all. See
   * `out`.
   *
   * **The alignment of this against the video is not ours to fix, and that was
   * measured rather than assumed.** A probe that flashed one frame white while
   * scheduling a click at the same instant, decoded back out of the file, found the
   * audio leading the picture by a mean of 51 ms in one run and 85 ms in the next, with
   * `outputLatency` reporting 0.048 then 0.024. Feeding the tap through a delay does
   * move it — a forced 200 ms landed at +132 ms, near one for one — but there is no
   * constant to use: correcting by an unstable reading made a run worse, from -51 to
   * -85. `MediaRecorder` aligns its tracks by when data reached it, and nothing here can
   * see that. The offline path exists because it never asks this question.
   *
   * The same tap every time. Building one per recording left the last one
   * connected and running.
   */
  captureStream(): MediaStream | null {
    if (this.tap !== null) return this.tap.stream;
    try {
      // Only a live context can hand out a stream; an offline render has no listener
      // to stream to and produces its buffer instead.
      const live = this.live();
      if (live === null || typeof live.createMediaStreamDestination !== 'function') return null;
      const tap = live.createMediaStreamDestination();
      this.mix.out.connect(tap);
      this.tap = tap;
      return tap.stream;
    } catch {
      return null;
    }
  }

  /**
   * Fire a one-shot. Routed so it sits under the same master filter and sends.
   *
   * `pan` places it across the stereo field (-1 to 1); pass the result of
   * `stereoPan`. Omitted, the sound is centred, which is right for anything
   * that happens *to* the player rather than somewhere near them.
   */
  play(buffer: AudioBuffer | undefined, gain = 1, pan = 0): void {
    if (buffer === undefined || gain <= 0) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const level = this.context.createGain();
    level.gain.value = gain;
    source.connect(level);

    if (pan !== 0 && typeof this.context.createStereoPanner === 'function') {
      const panner = this.context.createStereoPanner();
      panner.pan.value = Math.min(Math.max(pan, -1), 1);
      level.connect(panner);
      panner.connect(this.layoutNodes.effects.input);
    } else {
      level.connect(this.layoutNodes.effects.input);
    }
    source.start(this.scheduleAt());
  }

  dispose(): void {
    for (const source of this.stemSources) {
      try {
        source.stop();
      } catch {
        // Already stopped; nothing to undo.
      }
    }
    this.stemSources.length = 0;
    void this.live()?.close();
  }

  /**
   * Every parameter move is ramped. Assigning `.value` directly steps the
   * signal, and a step in a gain or a filter cutoff is an audible click — which
   * at sixty updates a second becomes a buzz rather than a mix.
   */
  private ramp(param: AudioParam | undefined, value: number): void {
    if (param === undefined) return;
    // `scheduleAt`, not `currentTime`: offline this is the frame's own instant, which
    // is what puts the mix on the picture. `RAMP` is unchanged in both modes on
    // purpose — the clip has to sound like the game, and the game sounds like this.
    const at = this.scheduleAt();
    param.cancelScheduledValues(at);
    param.setTargetAtTime(value, at, RAMP);
  }
}

/**
 * A synthesised impulse response: exponentially decaying noise.
 *
 * Not a real hall — a real one is a file, and files are what the registry is
 * for. This exists so reverb works before any asset has been recorded, on the
 * same principle as every other sound here.
 */
/**
 * A soft clipper, transparent until it is driven and saturating hard after.
 *
 * `tanh` rather than a hard corner: a hard clip of a bass note is a square wave, and
 * a square wave's odd harmonics march all the way up the spectrum as buzz. `tanh`
 * rounds the corner, so what comes out is the second and third harmonic — which is
 * what "driven" sounds like as opposed to "broken".
 *
 * Odd-length so there is a sample exactly at zero, which keeps silence silent.
 */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const samples = 2049;
  const curve = new Float32Array(new ArrayBuffer(2049 * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * SLAM_CLIP_KNEE) / Math.tanh(SLAM_CLIP_KNEE);
  }
  return curve;
}

function impulseResponse(context: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
    }
  }
  return buffer;
}
