/**
 * A provider refuses in words, or it is ready in words. Never silently either.
 *
 * This is `AGENTS.md`'s 2026-08-13 rule applied to a provider instead of a backend.
 * The engine already runs it for compute on WebGL2, and a provider quietly ignoring a
 * capability is the same failure with a bigger bill attached.
 */
import { describe, expect, it } from 'vitest';
import { createAiProvider } from './create.ts';
import type { AiProvider, AiProviderCapabilities, AiSession } from './types.ts';

const NOTHING: AiProviderCapabilities = {
  text: false,
  streamingText: false,
  structuredOutput: false,
  toolCalling: false,
  realtimeAudio: false,
  imageInput: false,
  local: false,
};

function stub(id: string, capabilities: Partial<AiProviderCapabilities>): AiProvider {
  return {
    id,
    capabilities: { ...NOTHING, ...capabilities },
    createSession: (): AiSession => {
      throw new Error('not reached in these tests');
    },
  };
}

const CONFIG = { kind: 'deterministic' as const, session: { model: 'test' } };

describe('createAiProvider', () => {
  it('refuses an unsupported capability, naming it, the provider and the word unsupported', async () => {
    const result = await createAiProvider(
      { ...CONFIG, provider: stub('local-small-text', { text: true }) },
      { realtimeAudio: true },
    );

    expect(result.provider).toBeNull();
    expect(result.reason).toContain('realtimeAudio');
    expect(result.reason).toContain('local-small-text');
    expect(result.reason).toContain('unsupported');
  });

  it('returns the provider and says it is ready when the requirement is met', async () => {
    const result = await createAiProvider(
      { ...CONFIG, provider: stub('local-small-text', { text: true }) },
      { text: true },
    );

    expect(result.provider).not.toBeNull();
    expect(result.reason).toContain('ready');
  });

  it('never returns an empty reason, on either path', async () => {
    const refused = await createAiProvider({ ...CONFIG, provider: stub('p', {}) }, { text: true });
    const ready = await createAiProvider(
      { ...CONFIG, provider: stub('p', { text: true }) },
      { text: true },
    );

    /* A caller logging `result.reason` always gets a sentence. An empty string here
       would be the silent no-op this whole function exists to prevent, wearing the
       shape of a success. */
    expect(refused.reason.length).toBeGreaterThan(0);
    expect(ready.reason.length).toBeGreaterThan(0);
  });

  it('names only the unsupported capability when one of two is met', async () => {
    const result = await createAiProvider(
      { ...CONFIG, provider: stub('p', { text: true }) },
      { text: true, toolCalling: true },
    );

    expect(result.provider).toBeNull();
    expect(result.reason).toContain('toolCalling');
    /* `text` was satisfied. Listing it would send a reader looking for a fault in the
       half that worked, which is how a refusal message costs more time than no message. */
    expect(result.reason).not.toContain('text');
  });

  it('lists every unsupported capability when several are missing', async () => {
    const result = await createAiProvider(
      { ...CONFIG, provider: stub('p', {}) },
      { text: true, toolCalling: true, imageInput: true },
    );

    expect(result.reason).toContain('text');
    expect(result.reason).toContain('toolCalling');
    expect(result.reason).toContain('imageInput');
  });
});
