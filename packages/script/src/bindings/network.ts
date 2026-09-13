import type { ScriptSession } from '@driftengine/network';
import type { CapabilityDefinition, Effect, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const NETWORK_MODULE = 'drift/network';

/**
 * `drift/network` — what a script can see of a session, and the scalars it can publish.
 *
 * **The linker has refused this module by name since the language shipped**, saying it waits on
 * Track J. The corpus carries `NetworkReplicatedActor.drs`, written *before* any provider existed
 * so that "the networking semantics are written down before networking couples itself to the state
 * and task design". Its names are honoured here — `replicate` and `authority` are both capabilities
 * — and its one illustrative call is not: it reads `network.replicate(character.x, character.y)`, with no
 * session, because when it was written there was no handle to take. Every capability takes the
 * thing it is about, the way every other binding in this directory does.
 *
 * ---
 *
 * ## The effect split, which the language asked this track to make
 *
 * `capability.ts` puts `network.read` **inside** `DETERMINISTIC_EFFECTS` and leaves `network.write`
 * outside, with a note that the exclusion is *"a deferral rather than a judgement: each belongs to a
 * track that has not shipped, and the track that builds one is the one that can say whether its
 * writes are the simulation or a consequence of it."* This is that track, so here is the answer.
 *
 * **`network.write` stays outside, and the rollback loop is the reason.** The tempting argument for
 * admitting it is that publishing a value changes no simulation state, so a replay would publish
 * the same thing and nothing would drift. That argument is exactly backwards once a rewind exists:
 * **a `@deterministic` function is precisely the kind that gets re-run**, several times, over ticks
 * that have already happened. A send is not idempotent — the replay would publish the same value
 * again for a tick a peer already has, and a correction that replayed twelve ticks would put twelve
 * duplicate messages on the wire. Deferring the effect was right and the deferral now has a reason
 * behind it rather than an absence.
 *
 * **`network.read` is kept for the two things that genuinely do not vary**: which participant this
 * is, and whether this peer is the authority. Both are fixed when the session is created, so a
 * `@deterministic` system may branch on them and replay identically.
 *
 * **Everything else a session knows is `nondeterministic`, and that is not pedantry.** The confirmed
 * watermark, the participant count and whether the session has halted all move with packet timing:
 * a system that branched on "is tick 400 confirmed" would take one path live and the other on
 * replay, which is the class of bug rollback netcode is famous for. `bindings/ui.ts` made the same
 * call for `hovered` and `pressed`, and this file's version of that sentence is: an effect that
 * type-checks can still be a lie.
 *
 * ## Slots rather than field names
 *
 * `replicate(session, slot, value)` writes into a numbered table. A name would need a string map on
 * a per-tick path and a miss would need an optional to answer with, which the language does not
 * have. A slot out of range does nothing on write and answers zero on read, so both are total.
 */
export const NETWORK_TYPES: readonly OpaqueType[] = [
  {
    module: NETWORK_MODULE,
    name: 'Session',
    doc: 'A networking session: who this peer is, what it can see of the others, and the scalars it publishes.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: readonly Effect[],
  deterministic: boolean,
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: NETWORK_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects: [...effects],
    deterministic,
    doc,
    implementation: `${NETWORK_MODULE}.${name}`,
  });

const ON = [{ name: 'session', type: 'Session' }] as const;

export const NETWORK_CAPABILITIES: readonly CapabilityDefinition[] = [
  /* The two that do not move. See the header for why only these two. */
  define(
    'self',
    ON,
    'i32',
    ['network.read'],
    true,
    'Which participant this peer is. Fixed for the life of the session, which is why a deterministic system may read it.',
  ),
  define(
    'authority',
    ON,
    'bool',
    ['network.read'],
    true,
    'Whether this peer’s world is the authoritative one. Fixed when the session is created.',
  ),

  /* Everything that moves with packet timing. */
  define(
    'participants',
    ON,
    'i32',
    ['nondeterministic'],
    false,
    'How many participants the session holds. Nondeterministic because somebody may join or leave between two runs of the same recording.',
  ),
  define(
    'confirmed',
    ON,
    'i32',
    ['nondeterministic'],
    false,
    'The highest tick every participant’s input has arrived for, or -1. Moves with packet timing, so a deterministic system may not branch on it.',
  ),
  define(
    'halted',
    ON,
    'bool',
    ['nondeterministic'],
    false,
    'Whether the session has stopped, because an input arrived too late to apply or two peers computed different worlds.',
  ),
  define(
    'haltReason',
    ON,
    'String',
    ['nondeterministic'],
    false,
    'Why it halted, as a sentence, or an empty string. Names the tick a divergence began at.',
  ),
  define(
    'slots',
    ON,
    'i32',
    ['nondeterministic'],
    false,
    'How many replicated scalars each participant has. A consumer sizes this when the session is made.',
  ),
  define(
    'replicated',
    [...ON, { name: 'participant', type: 'i32' }, { name: 'slot', type: 'i32' }],
    'f32',
    ['nondeterministic'],
    false,
    'Read a participant’s published scalar. An index out of range answers zero rather than failing, because a frame loop has nothing to do with a refusal.',
  ),

  /* And the one write. */
  define(
    'replicate',
    [...ON, { name: 'slot', type: 'i32' }, { name: 'value', type: 'f32' }],
    'void',
    ['network.write'],
    false,
    'Publish a value in one of this peer’s slots. Not callable from a deterministic system: a replay re-runs one and a send is not idempotent.',
  ),
];

export function networkImplementation(): Record<string, unknown> {
  return {
    self: (session: ScriptSession) => session.self,
    authority: (session: ScriptSession) => session.authority,
    participants: (session: ScriptSession) => session.participants,
    confirmed: (session: ScriptSession) => session.confirmed,
    halted: (session: ScriptSession) => session.halted,
    haltReason: (session: ScriptSession) => session.haltReason,
    slots: (session: ScriptSession) => session.slots,
    replicated: (session: ScriptSession, participant: number, slot: number) =>
      session.replicated(participant, slot),
    replicate: (session: ScriptSession, slot: number, value: number) => {
      session.replicate(slot, value);
    },
  };
}
