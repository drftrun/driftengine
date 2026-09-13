import type { KeyValueStore } from '../core/storage.ts';
import type { InputSource } from './input.ts';
import type { GamepadButton } from './gamepadMapping.ts';

/**
 * Actions a game asks about, and the bindings that satisfy them.
 *
 * **This is what makes the gamepad worth having.** Without it every site that reads input carries
 * the device branch by hand — `isDown('Space') || pad?.down('faceDown')` — every new device widens
 * it, and a player cannot change either half. A game asks whether *jump* happened and does not ask
 * which device said so.
 *
 * **The action name is the consumer's own string.** A game's verbs are a game's business, and an
 * engine-side enumeration of them would be exactly the "needs to know what something *is*" boundary
 * error `AGENTS.md` forbids.
 */

/** One thing that can satisfy an action. */
export type Binding =
  | { readonly device: 'keyboard'; readonly code: string }
  | { readonly device: 'gamepad'; readonly button: GamepadButton };

/** Jump, fire, pause: a state, bound to keys and buttons. */
export interface DigitalAction {
  readonly keys?: readonly string[];
  readonly buttons?: readonly GamepadButton[];
}

/**
 * Move, look: a direction rather than a state.
 *
 * **The reason this cannot be a button-only design.** A stick is not a key, and a game that treated
 * one as four keys would throw away the magnitude the player is actually controlling.
 *
 * Key directions follow the stick's convention, which is the specification's: **up is negative**.
 * The alternative was to flip one of them, and an engine that silently disagrees with the API it
 * wraps is one a consumer cannot reason about.
 */
export interface AnalogAction {
  readonly stick: 'left' | 'right';
  /**
   * One code or several, per direction.
   *
   * **Several, because `DigitalAction` above takes several and a player does not care which kind
   * of action they are rebinding.** A game binding both `KeyW` and `ArrowUp` to forward — which is
   * the ordinary thing to do — could express that for jump and not for movement, and the asymmetry
   * was the whole of the gap: the alternative was two analog actions merged by hand at the call
   * site, which is the engine handing back a job it already does.
   */
  readonly up?: string | readonly string[];
  readonly down?: string | readonly string[];
  readonly left?: string | readonly string[];
  readonly right?: string | readonly string[];
}

export type ActionDefinition = DigitalAction | AnalogAction;

function isAnalog(definition: ActionDefinition): definition is AnalogAction {
  return 'stick' in definition;
}

/** Scratch, at module scope because `vector` is a per-frame read. */
const stickVector = { x: 0, y: 0 };
const keyVector = { x: 0, y: 0 };

/** What a stored record holds: only what differs from the defaults. See `save`. */
interface StoredBindings {
  readonly [action: string]: readonly Binding[];
}

export class ActionMap {
  private readonly input: InputSource;
  private readonly definitions: Readonly<Record<string, ActionDefinition>>;
  /** The current bindings per digital action, which rebinding and loading replace. */
  private readonly bindings = new Map<string, Binding[]>();
  private readonly defaults = new Map<string, readonly Binding[]>();
  private warnedAboutRecord = false;

  constructor(input: InputSource, definitions: Readonly<Record<string, ActionDefinition>>) {
    this.input = input;
    this.definitions = definitions;
    for (const [name, definition] of Object.entries(definitions)) {
      if (isAnalog(definition)) continue;
      const initial = bindingsOf(definition);
      this.defaults.set(name, initial);
      this.bindings.set(name, [...initial]);
    }
  }

  /** Whether anything bound to this action is held. */
  down(action: string): boolean {
    return this.any(action, (binding) =>
      binding.device === 'keyboard'
        ? this.input.isDown(binding.code)
        : (this.input.pad(0)?.down(binding.button) ?? false),
    );
  }

  /** Whether anything bound to it went down since the last poll. Readable by anything. */
  pressed(action: string): boolean {
    return this.any(action, (binding) =>
      binding.device === 'keyboard'
        ? this.input.keyPressed(binding.code)
        : (this.input.pad(0)?.pressed(binding.button) ?? false),
    );
  }

  /**
   * The same edge, claimed: true for exactly one caller.
   *
   * **Claims through the device rather than keeping its own set**, so a claim made here is also
   * gone from `input.keyPressed` and from the pad's own `pressed`. Two claim registers over one
   * physical press is how a press gets acted on twice.
   */
  consumePress(action: string): boolean {
    const bindings = this.bindings.get(action);
    if (bindings === undefined) return false;
    for (const binding of bindings) {
      if (binding.device === 'keyboard') {
        if (this.input.consumeKeyPress(binding.code)) return true;
      } else if (this.input.pad(0)?.consumePress(binding.button) === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * Fill `out` with an analog action's direction.
   *
   * **The larger of stick and keys, never the sum.** A player holding a key while pushing the
   * stick the same way is asking to go that way, once; adding the contributions would send them at
   * twice the speed, which is the bug a naive merge ships with. What it costs: the two cannot be
   * combined to exceed the rim, which is the intent. What would make it wrong: an action where two
   * devices genuinely should add, and nothing has asked for one.
   *
   * **This is the reader for a direction.** If the two axes are two separate controls — throttle
   * and steering, pitch and roll — read them one at a time with `axis`, which does not normalise
   * them against each other. See its note for what the joint normalisation cost one consumer.
   */
  vector(action: string, out: { x: number; y: number }): void {
    out.x = 0;
    out.y = 0;
    if (!this.sample(action)) return;
    /* Normalised, so a diagonal on the keyboard is not faster than a straight line. This is the
       one line `axis` does not run, and the whole difference between the two readers. */
    const keyLength = Math.hypot(keyVector.x, keyVector.y);
    if (keyLength > 1) {
      keyVector.x /= keyLength;
      keyVector.y /= keyLength;
    }
    const useStick = Math.hypot(stickVector.x, stickVector.y) >= Math.min(keyLength, 1);
    out.x = useStick ? stickVector.x : keyVector.x;
    out.y = useStick ? stickVector.y : keyVector.y;
  }

  /**
   * One axis of an analog action, on its own, **not normalised against the other**.
   *
   * **`vector` is right for a direction and wrong for two controls**, and the difference is not
   * cosmetic. On foot the two axes are one direction, so a keyboard diagonal must be shortened to
   * the rim or the player walks faster askew than straight ahead — that is what `vector` is for and
   * it should stay the default. At a wheel the same two axes are throttle and steering, which are
   * two separate controls that happen to share an action: normalising them together means a driver
   * holding forward and left gets 0.707 of each and **can never reach full lock while accelerating**.
   *
   * A consumer lost two weeks to this. The report was "the car does not turn and it is slow", the
   * whole vehicle model was rewritten looking for it, and it was not in the vehicle model — it was
   * `Math.hypot` three call frames away, doing exactly what it was written to do. They shipped four
   * duplicate digital actions bound to the same keys to get around it.
   *
   * The pad is unchanged either way: a stick already gives its two axes independently, so a caller
   * driving with one reads the same numbers from both methods. The keyboard is where they part.
   */
  axis(action: string, axis: 'x' | 'y'): number {
    if (!this.sample(action)) return 0;
    const useStick =
      Math.hypot(stickVector.x, stickVector.y) >= Math.min(Math.hypot(keyVector.x, keyVector.y), 1);
    const from = useStick ? stickVector : keyVector;
    return axis === 'x' ? from.x : from.y;
  }

  /**
   * Fill the two scratch vectors for an analog action, and say whether there was one.
   *
   * Shared so that `vector` and `axis` cannot disagree about which device is being read or how a
   * key becomes a number — the device choice in particular is subtle enough that two copies of it
   * would drift.
   */
  private sample(action: string): boolean {
    const definition = this.definitions[action];
    if (definition === undefined || !isAnalog(definition)) return false;

    const pad = this.input.pad(0);
    stickVector.x = pad === null ? 0 : pad.axis(definition.stick === 'left' ? 'leftX' : 'rightX');
    stickVector.y = pad === null ? 0 : pad.axis(definition.stick === 'left' ? 'leftY' : 'rightY');

    keyVector.x = 0;
    keyVector.y = 0;
    if (this.anyDown(definition.left)) keyVector.x -= 1;
    if (this.anyDown(definition.right)) keyVector.x += 1;
    if (this.anyDown(definition.up)) keyVector.y -= 1;
    if (this.anyDown(definition.down)) keyVector.y += 1;
    return true;
  }

  /**
   * Whether the pad these actions read has motors this browser can drive.
   *
   * **Pad 0, which is the pad every other member of this class already reads.** An action map is
   * one player's controls, so "the pad the actions come from" is the device a rumble belongs on;
   * a consumer running local multiplayer reaches `InputSource.pad(n).rumble` directly.
   *
   * Grey the control out when this is false. It is re-read rather than cached, because a pad
   * unplugged and plugged back in is a different device behind the same slot.
   */
  get canRumble(): boolean {
    return this.input.pad(0)?.canRumble ?? false;
  }

  /**
   * Rumble that pad for `durationMs`, at two magnitudes in [0, 1]. Answers whether it was taken.
   *
   * `false` where there is no pad, no actuator, or nothing to play. Never throws.
   */
  rumble(durationMs: number, strong: number, weak: number): boolean {
    return this.input.pad(0)?.rumble(durationMs, strong, weak) ?? false;
  }

  /** Stop whatever that pad is playing. Answers whether the platform took it. */
  stopRumble(): boolean {
    return this.input.pad(0)?.stopRumble() ?? false;
  }

  /**
   * Whether any of a direction's codes is held.
   *
   * Allocation-free for both shapes: a single code is compared without wrapping it in an array,
   * and an array is walked by index. `vector` runs once a tick.
   */
  private anyDown(codes: string | readonly string[] | undefined): boolean {
    if (codes === undefined) return false;
    if (typeof codes === 'string') return this.input.isDown(codes);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code !== undefined && this.input.isDown(code)) return true;
    }
    return false;
  }

  /** What currently satisfies an action. */
  bindingsFor(action: string): readonly Binding[] {
    return this.bindings.get(action) ?? [];
  }

  /**
   * Give an action a binding, and say which actions lost it.
   *
   * **Reports rather than decides.** A binding already serving another action is the interesting
   * case in every rebinding screen there has ever been, and what to do about it is a product
   * decision: steal it silently, warn, or refuse. A consumer that wants uniqueness enforced reads
   * the return and rebinds back.
   */
  rebind(action: string, binding: Binding): readonly string[] {
    const displaced: string[] = [];
    for (const [name, list] of this.bindings) {
      if (name === action) continue;
      const at = list.findIndex((held) => sameBinding(held, binding));
      if (at < 0) continue;
      list.splice(at, 1);
      displaced.push(name);
    }
    const own = this.bindings.get(action);
    if (own === undefined) return displaced;
    if (!own.some((held) => sameBinding(held, binding))) own.push(binding);
    return displaced;
  }

  /** Put one action, or every action, back to what the game shipped with. */
  resetToDefaults(action?: string): void {
    for (const [name, initial] of this.defaults) {
      if (action !== undefined && name !== action) continue;
      this.bindings.set(name, [...initial]);
    }
  }

  /**
   * Write the bindings a player has actually changed, and nothing else.
   *
   * **A diff rather than a snapshot, and this is the load-bearing decision.** A snapshot freezes
   * the map at the version that saved it: a game that later adds an action, or changes a default
   * nobody had rebound, finds every returning player still on the old set with no way to tell a
   * deliberate choice from a stale record. A diff means an untouched action always follows the
   * current default and only real choices survive an update.
   *
   * Through `KeyValueStore` because the engine calls no platform API a consumer might want to
   * supply differently — the rule that put saves behind this seam.
   */
  save(store: KeyValueStore, key: string): void {
    const changed: Record<string, readonly Binding[]> = {};
    for (const [name, list] of this.bindings) {
      const initial = this.defaults.get(name) ?? [];
      if (sameList(list, initial)) continue;
      changed[name] = list;
    }
    store.write(key, JSON.stringify(changed));
  }

  /**
   * Apply a stored record over the defaults.
   *
   * **An unreadable record is the defaults, reported once.** A player whose stored bindings cannot
   * be parsed should get a working game rather than a broken one, and should not have that decided
   * silently — the same shape as every other refusal in this engine.
   */
  load(store: KeyValueStore, key: string): void {
    const raw = store.read(key);
    if (raw === null) return;
    let parsed: StoredBindings | null = null;
    try {
      parsed = JSON.parse(raw) as StoredBindings;
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== 'object') {
      if (!this.warnedAboutRecord) {
        this.warnedAboutRecord = true;
        console.warn(
          `[driftengine] the stored input bindings at ${JSON.stringify(key)} could not be read; ` +
            'the defaults are in force. Save again to replace the record.',
        );
      }
      return;
    }
    for (const [name, list] of Object.entries(parsed)) {
      /* An action the record knows and this build does not is dropped rather than kept: it is a
         binding for a verb that no longer exists, and holding it would resurrect it on a
         downgrade. An action this build has and the record does not keeps its default, which is
         the whole reason this is a diff. */
      if (!this.bindings.has(name) || !Array.isArray(list)) continue;
      this.bindings.set(name, list.filter(isBinding));
    }
  }

  private any(action: string, holds: (binding: Binding) => boolean): boolean {
    const bindings = this.bindings.get(action);
    if (bindings === undefined) return false;
    for (const binding of bindings) if (holds(binding)) return true;
    return false;
  }
}

function bindingsOf(definition: DigitalAction): Binding[] {
  const list: Binding[] = [];
  for (const code of definition.keys ?? []) list.push({ device: 'keyboard', code });
  for (const button of definition.buttons ?? []) list.push({ device: 'gamepad', button });
  return list;
}

function sameBinding(a: Binding, b: Binding): boolean {
  if (a.device !== b.device) return false;
  return a.device === 'keyboard' && b.device === 'keyboard'
    ? a.code === b.code
    : a.device === 'gamepad' && b.device === 'gamepad' && a.button === b.button;
}

function sameList(a: readonly Binding[], b: readonly Binding[]): boolean {
  return a.length === b.length && a.every((entry, at) => sameBinding(entry, b[at] as Binding));
}

/** A stored entry is data from disk, so it is checked rather than trusted. */
function isBinding(value: unknown): value is Binding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { device?: unknown; code?: unknown; button?: unknown };
  if (candidate.device === 'keyboard') return typeof candidate.code === 'string';
  return candidate.device === 'gamepad' && typeof candidate.button === 'string';
}
