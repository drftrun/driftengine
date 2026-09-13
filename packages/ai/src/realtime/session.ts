import type { AiEvent, AiProvider, AiRequest, AiSession } from '../provider/types.ts';

/**
 * A realtime transport, emitting the same events every other session emits.
 *
 * **Additive.** Nothing downstream branches on transport: the buffered loop, the floor,
 * the admission guards and the command log all see the same `AiEvent` union they
 * already see. A session with realtime configured still has exactly one request in
 * flight, because the state machine does not know what a transport is.
 *
 * **Audio stays bridged, not coupled.** This module imports nothing from
 * `@driftengine/audio`, and the package declares no dependency on it. A consumer wires
 * its own microphone and speaker to whatever this yields, because the moment an AI
 * package owned an audio graph it would be an AI package that knew what a mix was.
 */
export interface RealtimeOptions {
  readonly model: string;
  /** Frames a consumer pushes in. Text here, because audio is the consumer's to carry. */
  readonly input?: AsyncIterable<string>;
}

export type RealtimeResult =
  | { readonly session: AiSession; readonly reason: string }
  | { readonly session: null; readonly reason: string };

/**
 * Open a realtime session, or refuse before connecting.
 *
 * Refused **before** any transport is opened, in the shape §32 requires of every other
 * provider decision: a socket opened against a provider that cannot hold a realtime
 * conversation is a socket that fails later and more expensively than a string
 * comparison.
 */
export function createRealtimeSession(
  provider: AiProvider,
  options: RealtimeOptions,
): RealtimeResult {
  if (!provider.capabilities.realtimeAudio) {
    return {
      session: null,
      reason: `provider "${provider.id}" declares no realtime transport — a session cannot be opened against it`,
    };
  }

  const inner = provider.createSession({ model: options.model });
  let disposed = false;

  return {
    session: {
      run(request: AiRequest): AsyncIterable<AiEvent> {
        return inner.run(request);
      },
      abort(reason?: string): void {
        /* A second disposal is a no-op rather than an error. Disposal races a scene
           replacement and a hot reload, and both may reach the same session. */
        if (disposed) return;
        disposed = true;
        inner.abort(reason ?? 'realtime session disposed');
      },
    },
    reason: `realtime session open against "${provider.id}"`,
  };
}
