import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderConfig,
  AiProviderResult,
} from './types.ts';

/**
 * Accept a provider only if it declares what was asked of it, and say so either way.
 *
 * Renderer creation already works this way: `createRenderer` reports which backend it
 * took and why, and `probeDevice` refuses in the device's own words. A provider is the
 * same shape of decision with a bigger bill attached — a request to a provider that
 * cannot do the thing costs latency and tokens before it fails, where a refusal here
 * costs a string comparison.
 *
 * **There is no fallback path.** A downgrade from a local model to a paid remote one
 * changes where a user's data goes, and a package that does it quietly makes every
 * privacy notice written against it wrong. A caller wanting a second choice asks for
 * it explicitly, having read the first refusal.
 */
export async function createAiProvider(
  config: AiProviderConfig,
  required: Partial<AiProviderCapabilities>,
): Promise<AiProviderResult> {
  const provider = config.provider;
  if (provider === undefined) {
    return {
      provider: null,
      reason: `no provider was supplied for kind "${config.kind}" — build one with its own factory and pass it in`,
    };
  }

  const missing = unsupported(provider, required);
  if (missing.length > 0) {
    return {
      provider: null,
      reason:
        `provider "${provider.id}" is unsupported for this request: ` +
        `it declares no ${missing.join(', no ')}`,
    };
  }

  return {
    provider,
    reason: `provider "${provider.id}" ready, declaring ${declared(provider).join(', ')}`,
  };
}

/**
 * Only the capabilities that were asked for *and* are absent.
 *
 * Naming a satisfied requirement in a refusal sends a reader looking for a fault in
 * the half that worked, which is how a message costs more time than no message.
 */
function unsupported(provider: AiProvider, required: Partial<AiProviderCapabilities>): string[] {
  const missing: string[] = [];
  for (const key of Object.keys(required) as (keyof AiProviderCapabilities)[]) {
    if (required[key] === true && provider.capabilities[key] !== true) missing.push(key);
  }
  return missing;
}

function declared(provider: AiProvider): string[] {
  const names: string[] = [];
  for (const key of Object.keys(provider.capabilities) as (keyof AiProviderCapabilities)[]) {
    if (provider.capabilities[key]) names.push(key);
  }
  return names.length > 0 ? names : ['nothing'];
}
