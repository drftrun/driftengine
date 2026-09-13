import type {
  AiEvent,
  AiProvider,
  AiProviderCapabilities,
  AiRequest,
  AiSession,
  AiSessionOptions,
} from '../provider/types.ts';

/**
 * A remote provider reached through the consumer's own endpoint.
 *
 * **No credential ever reaches this package.** The consumer runs a proxy holding its
 * key, and this speaks to that. A test reads this module's own source and fails if a
 * credential-shaped word appears in it, which is what keeps the rule true rather than
 * remembered.
 *
 * *What it costs:* a consumer has to run something. *What would make it wrong:* a
 * provider offering genuinely scoped, short-lived browser credentials, where the proxy
 * buys nothing — and that is an adapter of its own rather than a loosening of this one.
 */
export interface ProxyProviderConfig {
  readonly endpoint: string;
  readonly model: string;
  /** What the endpoint says it can do. Declared, because this cannot probe it. */
  readonly capabilities: AiProviderCapabilities;
  readonly fetch?: typeof globalThis.fetch;
}

interface WireEvent {
  readonly type?: string;
  readonly text?: string;
  readonly callId?: string;
  readonly toolId?: string;
  readonly args?: unknown;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Returns a provider directly, where the local path returns a `Promise<AiProviderResult>`.
 *
 * A proxy has nothing to probe: its capabilities are whatever the consumer's endpoint
 * declares, and finding out otherwise costs a network round trip nobody asked for.
 * `createAiProvider` wraps either behind the capability check, so a caller sees one shape.
 */
export function createProxyProvider(config: ProxyProviderConfig): AiProvider {
  const doFetch = config.fetch ?? globalThis.fetch;

  return {
    id: `proxy:${config.model}`,
    capabilities: config.capabilities,
    createSession(_options: AiSessionOptions): AiSession {
      const controller = new AbortController();

      return {
        abort(reason?: string): void {
          controller.abort(reason ?? 'aborted');
        },
        run(request: AiRequest): AsyncIterable<AiEvent> {
          return stream(doFetch, config, request, controller);
        },
      };
    },
  };
}

async function* stream(
  doFetch: typeof globalThis.fetch,
  config: ProxyProviderConfig,
  request: AiRequest,
  controller: AbortController,
): AsyncIterable<AiEvent> {
  /* Either the session's abort or the request's own cancels this. A session outlives
     one request, so both are real and neither subsumes the other. */
  const onAbort = (): void => {
    controller.abort('signal');
  };
  request.signal.addEventListener('abort', onAbort);

  try {
    const response = await doFetch(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        preamble: request.preamble,
        context: request.context,
        toolIds: request.toolIds,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      /* Never a throw and never silence. A caller inside a session loop reads a `done`
         and reports it; an exception here would surface as an unhandled rejection in a
         microtask nobody is awaiting. */
      yield {
        kind: 'done',
        reason: 'error',
        message: `proxy responded ${response.status} ${response.statusText}`,
      };
      return;
    }

    for await (const line of lines(response)) {
      const event = parse(line);
      if (event === null) continue;
      yield event;
      if (event.kind === 'done') return;
    }

    yield { kind: 'done', reason: 'complete' };
  } catch (error) {
    const aborted = controller.signal.aborted;
    yield {
      kind: 'done',
      reason: aborted ? 'aborted' : 'error',
      message: aborted ? String(controller.signal.reason ?? 'aborted') : describe(error),
    };
  } finally {
    request.signal.removeEventListener('abort', onAbort);
  }
}

async function* lines(response: Response): AsyncIterable<string> {
  const body = response.body;
  if (body === null) return;

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield line;
      newline = buffer.indexOf('\n');
    }
  }

  const rest = buffer.trim();
  if (rest.length > 0) yield rest;
}

/**
 * One frame, or `null` if it cannot be read.
 *
 * A malformed frame is skipped rather than ending the stream. One bad chunk must not
 * end an agent's session — the agent would drop to its floor for a byte.
 */
function parse(line: string): AiEvent | null {
  let wire: WireEvent;
  try {
    wire = JSON.parse(line) as WireEvent;
  } catch {
    return null;
  }

  switch (wire.type) {
    case 'text':
      return typeof wire.text === 'string' ? { kind: 'text', text: wire.text } : null;
    case 'toolCall':
      if (typeof wire.callId !== 'string' || typeof wire.toolId !== 'string') return null;
      return { kind: 'toolCall', callId: wire.callId, toolId: wire.toolId, args: wire.args };
    case 'usage':
      return {
        kind: 'usage',
        inputTokens: wire.inputTokens ?? 0,
        outputTokens: wire.outputTokens ?? 0,
      };
    case 'done':
      return { kind: 'done', reason: 'complete' };
    default:
      return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
