import type { AiProvider } from '../provider/types.ts';
import type { ContextProvider } from '../context/assemble.ts';
import type { ToolRegistry, ToolSchema } from '../tools/registry.ts';
import { validateArgs } from '../tools/validate.ts';

/**
 * What an agent is, written down.
 *
 * Describes the *agent* rather than its connection: the tools and context are the
 * agent's, and `providerId` is null when nothing is attached. An agent with no provider
 * is still a fully described agent — it runs on its floor — and a manifest that
 * required a connection would have nothing to say about the case this package was
 * built to make ordinary.
 */
export interface AiManifest {
  readonly tools: readonly { id: string; description: string; schema: ToolSchema }[];
  readonly context: readonly { id: string; title: string; schema: ToolSchema }[];
  readonly providerId: string | null;
  /** Effects a `@deterministic` function may still have, for a reader of a trace. */
  readonly determinismBoundary: readonly string[];
  /** Surfaces this engine refuses in writing, so a reader learns the shape of the hole. */
  readonly refused: readonly { id: string; waitsOn: string }[];
}

const DETERMINISM_BOUNDARY: readonly string[] = [
  'pure',
  'clock.read',
  'scene.read',
  'scene.write',
  'ecs.read',
  'ecs.write',
  'physics.read',
  'physics.write',
];

/**
 * The two bridges Track O refuses, named so a coding assistant learns them.
 *
 * A manifest that listed only what works teaches a reader to ask for the rest, and the
 * answer arrives as a failure rather than as a sentence. `docs/CAPABILITIES.md` carries
 * a sentinel for each, so the day either is built is the day this list is wrong and the
 * suite says so.
 */
/*
 * **Empty since 2026-09-05, and the emptiness is the point rather than an oversight.**
 *
 * Both entries that were here — the navigation bridge and the network authority — were refused for
 * reasons that stopped being true on 2026-09-03, and neither this list nor `CAPABILITIES.md` had
 * re-read them. `navigationBridge` and `AuthoritativeAgent` are built, so a refusal naming either
 * would be this file telling a model a capability is absent while a consumer registers it.
 *
 * An empty list is a supported state and not a broken one: `describeAgent` simply says nothing is
 * refused. What must not happen is an entry outliving the thing it waited on, which is what the
 * gate above catches and what both of these did for two days.
 */
const REFUSED: readonly { id: string; waitsOn: string }[] = [];

export function describeAgent<W>(
  tools: ToolRegistry<W>,
  context: readonly ContextProvider<unknown>[],
  provider: AiProvider | null,
): AiManifest {
  return {
    tools: tools.ids().map((id) => {
      const tool = tools.get(id);
      return {
        id,
        description: tool?.description ?? '',
        schema: tool?.schema ?? { kind: 'object', fields: {} },
      };
    }),
    context: context.map((entry) => {
      const described = entry.describe();
      return { id: entry.id, title: described.title, schema: described.schema };
    }),
    providerId: provider?.id ?? null,
    determinismBoundary: DETERMINISM_BOUNDARY,
    refused: REFUSED,
  };
}

export type StructuredResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

/**
 * Ask for output shaped like a schema, or refuse before spending anything.
 *
 * A provider declaring no structured output is refused **before** the request. Sending
 * it anyway and hoping the text parses is the silent-downgrade failure wearing a
 * different hat: it works often enough to ship and fails on the input nobody tested.
 */
export function requireStructuredOutput(
  provider: AiProvider | null,
  schema: ToolSchema,
  value: unknown,
): StructuredResult {
  if (provider === null) {
    return { ok: false, reason: 'no provider is attached, so nothing can be asked for' };
  }
  if (!provider.capabilities.structuredOutput) {
    return {
      ok: false,
      reason: `provider "${provider.id}" declares no structured output — asking anyway and parsing the text is a downgrade, not a fallback`,
    };
  }

  const validation = validateArgs(schema, value);
  if (validation.ok) return { ok: true, value: validation.value };
  return { ok: false, reason: `${validation.path}: ${validation.reason}` };
}

export interface DevelopmentManifest extends AiManifest {
  /** What this package will not do, in the words a reader needs to stop asking. */
  readonly refusals: readonly { id: string; waitsOn: string }[];
  /** The properties everything else here exists to make cheap. */
  readonly guarantees: readonly string[];
}

/**
 * The manifest a coding assistant reads.
 *
 * Carries what the runtime manifest carries **plus the refusals**, because a
 * description listing only what works teaches a reader to ask for the rest — and the
 * answer arrives as a failure rather than as a sentence. The parent design's §43 asks
 * for exactly this, and gives that reason.
 *
 * The refusal ids are the sentinel names in `docs/CAPABILITIES.md`, and a test asserts
 * the two agree. Two descriptions of one thing will drift, and this is the pair that
 * would.
 */
export function describeForDevelopment<W>(
  tools: ToolRegistry<W>,
  context: readonly ContextProvider<unknown>[],
  provider: AiProvider | null,
): DevelopmentManifest {
  const manifest = describeAgent(tools, context, provider);
  return {
    ...manifest,
    refusals: REFUSED,
    guarantees: [
      'an agent is never without a current intent, whether or not a provider is attached',
      'exactly one provider request is in flight per agent',
      'a buffered intent is revalidated at the drain and discarded, never deferred',
      'budget exhaustion degrades to the policy floor and throws nothing',
      'accepted commands and preemptions are recorded, so a run replays exactly',
    ],
  };
}
