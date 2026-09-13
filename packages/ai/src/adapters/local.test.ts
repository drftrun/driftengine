/**
 * A local provider accepted by running it, and no quiet downgrade.
 */
import { describe, expect, it } from 'vitest';
import { createLocalProvider } from './local.ts';
import type { LocalProviderConfig } from './local.ts';
import type { AiSession } from '../provider/types.ts';

function config(over: Partial<LocalProviderConfig> = {}): LocalProviderConfig {
  return {
    id: 'local-small',
    model: 'small',
    capabilities: {
      text: true,
      streamingText: true,
      structuredOutput: false,
      toolCalling: true,
      realtimeAudio: false,
      imageInput: false,
    },
    probe: async () => true,
    createSession: (): AiSession => ({
      run: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      abort: () => undefined,
    }),
    ...over,
  };
}

describe('createLocalProvider', () => {
  it('accepts a provider whose probe runs', async () => {
    const result = await createLocalProvider(config());

    expect(result.provider).not.toBeNull();
    expect(result.provider?.capabilities.local).toBe(true);
    expect(result.reason).toContain('ready');
  });

  it('refuses when the probe reports failure, naming the device', async () => {
    const result = await createLocalProvider(config({ probe: async () => false }));

    expect(result.provider).toBeNull();
    expect(result.reason).toContain('unavailable on this device');
  });

  it('treats a throwing probe as a refusal carrying its words', async () => {
    const result = await createLocalProvider(
      config({
        probe: async () => {
          throw new Error('WebGPU compute unsupported');
        },
      }),
    );

    expect(result.provider).toBeNull();
    /* Resolving false and throwing are the same answer with different words, and the
       words are worth keeping — "unavailable" alone sends a reader to check a config
       that was fine. */
    expect(result.reason).toContain('WebGPU compute unsupported');
  });

  it('never substitutes a different provider when the probe fails', async () => {
    const result = await createLocalProvider(config({ probe: async () => false }));

    /*
     * A downgrade from a local model to a paid remote one changes where a user's data
     * goes. Doing it quietly makes every privacy notice written against this package
     * wrong, so the result carries nothing and the caller chooses next.
     */
    expect(result.provider).toBeNull();
  });

  it('gives a sentence on both paths', async () => {
    const ready = await createLocalProvider(config());
    const refused = await createLocalProvider(config({ probe: async () => false }));

    expect(ready.reason.length).toBeGreaterThan(0);
    expect(refused.reason.length).toBeGreaterThan(0);
  });
});
