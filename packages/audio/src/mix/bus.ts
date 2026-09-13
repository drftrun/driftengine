import type { ScheduleClock } from '../ambientLoop.ts';
import { clamp01 } from '../filters.ts';

/**
 * One bus: everything that reaches it, through whatever it inserts, at whatever level it is set to.
 *
 * Three nodes rather than one, and each earns its place:
 *
 * ```
 *   input ─ [inserts] ─ tap ─ [post-send inserts] ─ output ─→ parent.input
 *                        └─ send gain ─→ a return bus
 * ```
 *
 * **`input` is the fader**, and it is at the *top* of the chain rather than the bottom. That is not
 * a preference: it is what makes a send post-fader, and it is what the mix this replaces already
 * did — the level sat ahead of the lift, and the sends hung off the lift. A fader at the bottom
 * would leave every insert and every send working on unattenuated signal, so turning a bus down
 * would leave its reverb at full strength.
 *
 * **`tap` is where sends listen from**, and it exists as a real node so that rewiring the chain
 * cannot silently move what the sends hear. Inserts added normally land above it and are heard by
 * the sends; an insert added `postSend` lands below it and is not. The slam is the reason that flag
 * exists: `graph.ts` says the sends hang off the stage before it "so the reverb tail never hears
 * the slam", because a six-second convolution of a clipped bass hit is a mess still arriving three
 * gates later.
 *
 * **`output` is a unity sum**, for the reason `AudioGraph.out` gives: what a parent hears has to be
 * a node and not an implicit sum at somebody else's input, or nothing can ever be inserted between
 * a bus and its parent.
 *
 * Cost: two multiplications by unity per bus that a hand-wired graph would not have. Both are exact
 * in floating point, so they cannot move a mix — measured, by the gate in `scripts/audio-baseline.mjs`,
 * which is bit-exact and passes across this change. What would make this wrong is a tree deep
 * enough for the node count itself to matter, which at the depth a game mixes at — a master, a few
 * groups, their children — it is not.
 */

/**
 * Smoothing for parameter moves, seconds.
 *
 * The same 0.08 the mix has always used, and it lives here now because a bus is where every level
 * move goes. Long enough to never click; short enough that a fader feels immediate.
 */
export const RAMP = 0.08;

/** A stage a bus can put in its own signal path. Internally it may be anything, including parallel. */
export interface MixInsert {
  readonly input: AudioNode;
  readonly output: AudioNode;
}

export interface InsertOptions {
  /**
   * Place this insert *below* the send tap, so the sends do not hear it.
   *
   * Cost: an insert down here cannot be heard in a reverb tail even when a caller wants it to be.
   * What would make this wrong is an insert that is a colour rather than an event — a bus-wide EQ
   * belongs above the tap, because a reverb of an unequalised signal is a reverb of a different
   * instrument.
   */
  readonly postSend?: boolean;
}

export interface BusOptions {
  /**
   * Where this bus sends its output. Omitted, the console parents it to `master`.
   *
   * **`null` means nowhere**, and the caller wires the output itself. That is not a hole in the
   * model: a return bus joins the mix *downstream* of the master filter, so parenting one to master
   * would put every reverb tail through a filter the dry signal has already been through. The mix
   * this replaces has always done it that way, and `mixOutput.test.ts` exists because getting it
   * wrong once meant every exported clip carried the dry track and nothing wet.
   */
  readonly parent?: MixBus | null;
  /**
   * Where the fader starts. Unity when omitted.
   *
   * Assigned rather than ramped, for the reason `AudioGraphOptions.levels` gives: a level that does
   * not change for the whole of a render is not a move, it is where the parameter starts, and
   * ramping it would open every rendered clip with a glide down from unity.
   */
  readonly level?: number;
}

export class MixBus {
  /** The fader. Sources and child buses connect here. */
  readonly input: GainNode;
  /** Where sends listen from. Unity, always. */
  readonly tap: GainNode;
  /** What the parent hears. Unity, always. */
  readonly output: GainNode;
  readonly parent: MixBus | null;

  private readonly kids: MixBus[] = [];
  private readonly inserts: { insert: MixInsert; postSend: boolean }[] = [];
  /**
   * Nodes fed from this bus's pre-insert signal, restored whenever the chain is rewired.
   *
   * For a stage that needs the bus as it arrives rather than as its own position in the chain would
   * give it. The slam is the case: its wet path is tapped upstream of the lift's high-pass, because
   * a low-cut ahead of the tap would make the effect vanish exactly when the player is in the air,
   * which is where half of it is used. Registered rather than connected once, because `rebuild`
   * disconnects `input` and would otherwise silently drop it the next time an insert is added.
   */
  private readonly inputTaps: AudioNode[] = [];
  private readonly sends = new Map<MixBus, GainNode>();
  /**
   * What each send was last asked for.
   *
   * Mirrored rather than read back off the parameter, for the reason `AudioGraph.mixLevels` gives:
   * a send is ramped, and mid-ramp `gain.value` is somewhere between where it was and where it is
   * going. A snapshot capturing sends would otherwise record whatever instant it happened to ask on.
   */
  private readonly sendAmounts = new Map<MixBus, number>();
  private levelValue: number;
  private mutedValue = false;
  private soloedValue = false;
  /**
   * What solo has decided about this bus, from the console that can see the whole tree.
   *
   * A separate factor rather than a second write to the level, because a bus silenced by somebody
   * else's solo must come back to the level its own fader is at, and a single value cannot remember
   * two decisions.
   */
  private soloGateValue = 1;
  /**
   * A temporary move over the top of the fader, without disturbing it.
   *
   * The distinction `AudioGraph.fadeMusic` and `AudioGraph.levels` spent two paragraphs on: a fade
   * is part of an *edit* and has to end by returning to whatever the player chose, so it cannot be
   * allowed to overwrite that choice. Here the choice stays in `levelValue` and the edit is a
   * factor beside it, which means the value to come back to is `1` rather than something the caller
   * has to have remembered.
   */
  private duckFactor = 1;

  constructor(
    readonly name: string,
    private readonly context: BaseAudioContext,
    private readonly scheduleAt: ScheduleClock,
    options: BusOptions = {},
  ) {
    this.levelValue = options.level === undefined ? 1 : clamp01(options.level);
    this.parent = options.parent ?? null;

    this.input = context.createGain();
    this.input.gain.value = this.levelValue;
    this.tap = context.createGain();
    this.output = context.createGain();

    this.rebuild();
    if (this.parent !== null) {
      this.output.connect(this.parent.input);
      this.parent.kids.push(this);
    }
  }

  get children(): readonly MixBus[] {
    return this.kids;
  }
  get level(): number {
    return this.levelValue;
  }
  get muted(): boolean {
    return this.mutedValue;
  }
  get soloed(): boolean {
    return this.soloedValue;
  }

  /** Feed a node from this bus's signal as it arrives, before any insert. See `inputTaps`. */
  feedFromInput(node: AudioNode): void {
    this.inputTaps.push(node);
    this.input.connect(node);
  }

  /** Append a stage to this bus's own signal path. See `InsertOptions.postSend`. */
  insert(insert: MixInsert, options: InsertOptions = {}): void {
    this.inserts.push({ insert, postSend: options.postSend === true });
    this.rebuild();
  }

  /**
   * Feed a return bus from this one, at `amount`.
   *
   * Idempotent per target: asking twice moves the existing send rather than building a second one,
   * because this is called from per-frame code in every consumer that has ever used it and a send
   * node per frame is a graph that grows until the page stops.
   */
  send(returnBus: MixBus, amount: number): void {
    let gain = this.sends.get(returnBus);
    if (gain === undefined) {
      gain = this.context.createGain();
      // At zero, then ramped: a send that springs into existence at full level is a click.
      gain.gain.value = 0;
      this.tap.connect(gain);
      gain.connect(returnBus.input);
      this.sends.set(returnBus, gain);
    }
    /*
     * Floored at zero and not ceilinged at one. A send above unity is ordinary on a console — it is
     * how a return is driven harder than the source feeding it — and the mix this replaces has
     * always allowed it: `setReverbSend` floors at zero and stops there. Clamping to unity here
     * would quietly change what every existing caller is allowed to ask for.
     */
    const floored = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    this.sendAmounts.set(returnBus, floored);
    this.ramp(gain.gain, floored);
  }

  /** What this bus was last asked to send to that return, or 0 if it has never sent to it. */
  sendAmount(returnBus: MixBus): number {
    return this.sendAmounts.get(returnBus) ?? 0;
  }

  /** Every return this bus feeds, for a snapshot to capture. */
  get sendTargets(): readonly MixBus[] {
    return [...this.sends.keys()];
  }

  setLevel(level: number): void {
    this.levelValue = clamp01(level);
    this.applyGain();
  }

  /**
   * Move to a level over an explicit time, rather than at the fader's own smoothing.
   *
   * A fader is a control and wants to feel immediate; a snapshot recall is an edit and takes as
   * long as it was asked to take. Both write the same mirrored level, so the mix knows where it is
   * either way — which `AudioGraph.fadeMusic` deliberately does *not* do, because a fade there is
   * part of an edit that has to return to the player's setting when it is over.
   */
  fadeLevel(level: number, seconds: number): void {
    this.levelValue = clamp01(level);
    const at = this.scheduleAt();
    const target = this.mutedValue ? 0 : this.levelValue * this.soloGateValue * this.duckFactor;
    this.input.gain.cancelScheduledValues(at);
    // A third of the span as the time constant: `setTargetAtTime` is asymptotic, and three time
    // constants is where it is within five per cent of the target, which is where a listener
    // stops hearing it move.
    this.input.gain.setTargetAtTime(target, at, Math.max(seconds, 1e-3) / 3);
  }

  /**
   * Move over the top of the fader and back, without moving the fader.
   *
   * `duck(0, 0.4)` takes this bus away over four tenths of a second; `duck(1, 0.4)` brings it back
   * to exactly whatever the fader is set to, including a setting the player changed in between.
   * Cost: this is a second thing multiplying into one parameter, so a caller that ducks and forgets
   * to release leaves a bus quiet with a fader that says otherwise — which is why `duckedTo` is
   * readable rather than private.
   */
  duck(factor: number, seconds: number): void {
    this.duckFactor = clamp01(factor);
    const at = this.scheduleAt();
    const target = this.mutedValue ? 0 : this.levelValue * this.soloGateValue * this.duckFactor;
    this.input.gain.cancelScheduledValues(at);
    if (seconds <= 0) {
      this.input.gain.setTargetAtTime(target, at, RAMP);
      return;
    }
    /*
     * Linear, because a linear ramp actually *reaches* its target where `setTargetAtTime` only ever
     * approaches it — and a score still faintly audible under the next scene is the bug this is
     * for. From wherever the parameter actually is rather than from where it was last set, because
     * cancelling a ramp mid-flight leaves the value between the two and a fade that starts by
     * jumping back is an audible click.
     */
    this.input.gain.setValueAtTime(this.input.gain.value, at);
    this.input.gain.linearRampToValueAtTime(target, at + Math.max(seconds, 0.001));
  }

  /** What this bus is ducked to, 1 when it is not. See `duck`. */
  get duckedTo(): number {
    return this.duckFactor;
  }

  setMute(muted: boolean): void {
    this.mutedValue = muted;
    this.applyGain();
  }

  setSolo(soloed: boolean): void {
    this.soloedValue = soloed;
    this.onSoloChanged?.();
  }

  /** Set by the console when it adopts this bus, so a solo anywhere re-resolves the whole tree. */
  onSoloChanged: (() => void) | null = null;

  /** Written by the console alone. 1 is audible, 0 is silenced by somebody else's solo. */
  setSoloGate(gate: number): void {
    if (gate === this.soloGateValue) return;
    this.soloGateValue = gate;
    this.applyGain();
  }

  /**
   * Level, mute and the solo gate are one number, written once.
   *
   * Three writers to one parameter race, and the loser is whichever ran first — which is heard as a
   * fader that sometimes does not take, and is nearly impossible to reproduce deliberately.
   */
  private applyGain(): void {
    this.ramp(
      this.input.gain,
      this.mutedValue ? 0 : this.levelValue * this.soloGateValue * this.duckFactor,
    );
  }

  /**
   * Rewire the series path.
   *
   * Only `input`, the insert outputs and `tap` are disconnected — never `output`, which carries this
   * bus's connection to its parent and would take the whole subtree with it. The sends are
   * reconnected here because `tap` was just disconnected, and a send silently dropped by a later
   * insert is exactly the kind of fault that reads as "the reverb stopped working" days afterwards.
   */
  private rebuild(): void {
    this.input.disconnect();
    for (const { insert } of this.inserts) insert.output.disconnect();
    this.tap.disconnect();
    for (const node of this.inputTaps) this.input.connect(node);

    let node: AudioNode = this.input;
    for (const { insert, postSend } of this.inserts) {
      if (postSend) continue;
      node.connect(insert.input);
      node = insert.output;
    }
    node.connect(this.tap);

    node = this.tap;
    for (const { insert, postSend } of this.inserts) {
      if (!postSend) continue;
      node.connect(insert.input);
      node = insert.output;
    }
    node.connect(this.output);

    for (const gain of this.sends.values()) this.tap.connect(gain);
  }

  /**
   * Every parameter move is ramped and every one lands on the console's instant.
   *
   * `scheduleAt`, never `currentTime`: offline there is no now, and a move left to the clock lands
   * on instant zero along with every other move a render ever makes.
   */
  private ramp(param: AudioParam, value: number): void {
    const at = this.scheduleAt();
    param.cancelScheduledValues(at);
    param.setTargetAtTime(value, at, RAMP);
  }
}
