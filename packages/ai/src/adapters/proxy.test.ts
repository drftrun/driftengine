/**
 * A remote adapter that never sees a credential.
 */
import { describe, expect, it } from 'vitest';
import { createProxyProvider } from './proxy.ts';
import type { AiEvent, AiProviderCapabilities, AiRequest } from '../provider/types.ts';

const CAPABILITIES: AiProviderCapabilities = {
  text: true,
  streamingText: true,
  structuredOutput: false,
  toolCalling: true,
  realtimeAudio: false,
  imageInput: false,
  local: false,
};

function request(signal = new AbortController().signal): AiRequest {
  return { preamble: '', context: { capturedAtTick: 0 }, toolIds: [], signal };
}

function responding(lines: string[], init: ResponseInit = {}): typeof globalThis.fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, ...init });
  }) as unknown as typeof globalThis.fetch;
}

async function drain(iterable: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const seen: AiEvent[] = [];
  for await (const event of iterable) seen.push(event);
  return seen;
}

function provider(fetchImpl: typeof globalThis.fetch) {
  return createProxyProvider({
    endpoint: 'https://consumer.example/ai',
    model: 'test-model',
    capabilities: CAPABILITIES,
    fetch: fetchImpl,
  });
}

describe('createProxyProvider', () => {
  it('yields streamed text in order and a terminal done', async () => {
    const session = provider(
      responding([
        JSON.stringify({ type: 'text', text: 'one' }),
        JSON.stringify({ type: 'text', text: 'two' }),
        JSON.stringify({ type: 'done' }),
      ]),
    ).createSession({ model: 'test-model' });

    const events = await drain(session.run(request()));

    expect(events).toEqual([
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two' },
      { kind: 'done', reason: 'complete' },
    ]);
  });

  it('carries a tool call through with its ids and raw arguments', async () => {
    const session = provider(
      responding([
        JSON.stringify({ type: 'toolCall', callId: 'c1', toolId: 'inspect@1', args: { t: 'D4' } }),
        JSON.stringify({ type: 'done' }),
      ]),
    ).createSession({ model: 'test-model' });

    const events = await drain(session.run(request()));

    expect(events[0]).toEqual({
      kind: 'toolCall',
      callId: 'c1',
      toolId: 'inspect@1',
      args: { t: 'D4' },
    });
  });

  it('reports a non-200 as done with the status, never as a throw', async () => {
    const failing = (async () =>
      new Response('nope', {
        status: 503,
        statusText: 'Service Unavailable',
      })) as unknown as typeof globalThis.fetch;

    const session = provider(failing).createSession({ model: 'test-model' });
    const events = await drain(session.run(request()));

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.kind).toBe('done');
    if (event?.kind === 'done') {
      expect(event.reason).toBe('error');
      expect(event.message).toContain('503');
    }
  });

  it('skips a malformed frame and keeps streaming', async () => {
    const session = provider(
      responding([
        JSON.stringify({ type: 'text', text: 'one' }),
        '{ this is not json',
        JSON.stringify({ type: 'text', text: 'two' }),
        JSON.stringify({ type: 'done' }),
      ]),
    ).createSession({ model: 'test-model' });

    const events = await drain(session.run(request()));

    /* One bad chunk must not end a session. The agent would drop to its floor for a
       byte, and the byte is the provider's fault rather than the world's. */
    expect(events.filter((e) => e.kind === 'text')).toHaveLength(2);
  });

  it('propagates the request signal to fetch and reports an abort', async () => {
    let sawSignal: AbortSignal | null = null;
    const watching = (async (_url: string, init: RequestInit) => {
      sawSignal = init.signal ?? null;
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    const session = provider(watching).createSession({ model: 'test-model' });
    const events = drain(session.run(request(controller.signal)));

    controller.abort();
    const seen = await events;

    expect(sawSignal).not.toBeNull();
    const [event] = seen;
    expect(event?.kind).toBe('done');
    if (event?.kind === 'done') expect(event.reason).toBe('aborted');
  });
});
