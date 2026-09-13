/**
 * `drift/audio` — what this engine lets a script do to sound.
 *
 * **Five capabilities: a slot, two ways to play it, and the two cheap positional helpers.** This
 * header read "playback, placement, the mix, and the rhythm the music is doing" until 2026-08-27,
 * and three of those four were never here — there is no mix verb, no rhythm verb, no HRTF-panned
 * source, no listener and no reverb zone. The sentence was written from *Track G's* deliverables
 * rather than from the list beneath it, which is the same failure `drift/physics` had one file
 * over, and the same one the first `drift/camera` binding had: a comment describing what a
 * subsystem ought to expose rather than what this array does.
 *
 * It is still the right first binding and still the thing that shows what a binding *is* — registry
 * entries describing capabilities the engine already has, plus a map of implementations the host
 * supplies at link time. **No new engine code.**
 *
 * **What is missing, and why it is not guessed at here.** `MixConsole`, `AudioListenerGraph`,
 * `SpatialSource` and `ReverbZone` are four stateful objects with lifetimes, and a script-side
 * surface for them is a design about handles and ownership rather than a table entry — who disposes
 * a source, what happens to its probe slot, whether a zone outlives the script that made it.
 * `docs/CAPABILITIES.md` §4 records it. Taking that badly would put a leak in front of every script
 * author, which is worse than a surface they can see is absent.
 *
 * Three constraints this surface inherits, none of them negotiable:
 *
 * - **`audio.write` is outside the determinism boundary.** `ARCHITECTURE.md` places audio there, so
 *   a `@deterministic` function may not call any of it. A simulation decides *that* a door opened
 *   and emits an event; something outside the fixed step decides what it sounds like. The compiler
 *   is only making a line that already exists visible.
 * - **`audio.play` in a `@hot` function is a diagnostic**, for the reason the engine's own rules
 *   forbid allocation there.
 * - **A sound slot may be absent, so `sound` returns an option.** The registry probes several
 *   format candidates per slot and the file often is not there. A script that ignores that plays
 *   silence and reports success, which is the failure the language's no-implicit-null rule exists
 *   to prevent — and this is the first place in the engine where that rule earns its keep.
 */
import { AudioGraph, SoundRegistry, distanceGain, stereoPan } from '@driftengine/audio';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const AUDIO_MODULE = 'drift/audio';

/**
 * A decoded sound, held by a script and passed back to the engine.
 *
 * Opaque on purpose: it is an `AudioBuffer`, and a script that could read its fields would be a
 * script depending on a representation the engine cannot then change. The design calls these safe
 * handles, and this is one.
 */
export const AUDIO_TYPES: readonly OpaqueType[] = [
  {
    module: AUDIO_MODULE,
    name: 'Sound',
    doc: 'A decoded sound, resolved from a slot. Held and passed back; never read into.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  deterministic: boolean,
  doc: string,
  implementation: string,
): CapabilityDefinition =>
  defineCapability({
    module: AUDIO_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    deterministic,
    doc,
    implementation,
  });

export const AUDIO_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'sound',
    [{ name: 'slot', type: 'String' }],
    /*
     * `Sound?`, and the `?` is the whole point.
     *
     * The registry resolves a slot by probing format candidates, and a missing file is ordinary
     * rather than exceptional. Returning a bare `Sound` would make every script that forgot to
     * check play silence and report success.
     */
    'Sound?',
    ['pure'],
    true,
    'Resolve a sound slot. Absent when nothing was registered or nothing decoded.',
    'SoundRegistry.get',
  ),
  define(
    'play',
    [
      { name: 'sound', type: 'Sound' },
      { name: 'gain', type: 'f32' },
    ],
    'void',
    ['audio.write'],
    false,
    'Play a resolved sound through the mix.',
    'AudioGraph.play',
  ),
  define(
    'playPanned',
    [
      { name: 'sound', type: 'Sound' },
      { name: 'gain', type: 'f32' },
      { name: 'pan', type: 'f32' },
    ],
    'void',
    ['audio.write'],
    false,
    'Play a resolved sound at a stereo position, -1 left to 1 right.',
    'AudioGraph.play',
  ),
  define(
    'distanceGain',
    [
      { name: 'distance', type: 'f32' },
      { name: 'radius', type: 'f32' },
    ],
    'f32',
    /*
     * `pure`, and therefore callable from a `@deterministic` function.
     *
     * It is arithmetic over two numbers — the cheap positional function, not the HRTF path. That a
     * capability in an otherwise effectful module is deterministic is the reason effects are
     * declared per capability rather than per module.
     */
    ['pure'],
    true,
    'How loud something is at a distance, falling off to nothing at the radius.',
    'audio.distanceGain',
  ),
  define(
    'stereoPan',
    [
      { name: 'dx', type: 'f32' },
      { name: 'dz', type: 'f32' },
      { name: 'yaw', type: 'f32' },
    ],
    'f32',
    ['pure'],
    true,
    'Where something sits in the stereo field, relative to a listener facing yaw.',
    'audio.stereoPan',
  ),
];

/** How the runtime represents an option. Matches what the compiler generates for `some`/`none`. */
type Option<T> = { readonly tag: 'some'; readonly value: T } | { readonly tag: 'none' };

const some = <T>(value: T): Option<T> => ({ tag: 'some', value });
const none: Option<never> = { tag: 'none' };

/**
 * The implementations, which the host hands to a module's `__bind`.
 *
 * A plain object rather than anything the registry holds — R2: the registry describes and never
 * becomes the call path, so this is a separate thing that happens to have matching keys. The
 * registry's `implementation` strings name these; nothing enforces that mechanically, which is why
 * a test asserts every definition has an implementation here.
 */
export function audioImplementation(
  graph: AudioGraph,
  registry: SoundRegistry,
): Record<string, unknown> {
  return {
    sound(slot: string): Option<AudioBuffer> {
      const buffer = registry.get(slot);
      return buffer === undefined ? none : some(buffer);
    },
    play(sound: AudioBuffer, gain: number): void {
      graph.play(sound, gain);
    },
    playPanned(sound: AudioBuffer, gain: number, pan: number): void {
      graph.play(sound, gain, pan);
    },
    distanceGain,
    stereoPan,
  };
}
