/**
 * The provider seam. Provider-specific concerns stay behind adapters.
 *
 * Capability is **declared rather than assumed**, so a session refuses an
 * unsupported requirement early and in words instead of discovering it in
 * production at whatever a failed request costs.
 */

/**
 * What a provider says it can do.
 *
 * Declared by the adapter rather than probed, except where a probe is cheap and
 * honest — `createLocalProvider` runs one, because a local model's availability is
 * a property of the device rather than of the configuration.
 */
export interface AiProviderCapabilities {
  readonly text: boolean;
  readonly streamingText: boolean;
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly realtimeAudio: boolean;
  readonly imageInput: boolean;
  readonly local: boolean;
}

/**
 * Context assembled for one request.
 *
 * Declared minimally here and widened where it is built. What the seam needs is
 * the capture tick: a model must be able to know its snapshot may be stale, and a
 * buffered agent widens that gap on purpose.
 */
export interface AssembledContextLike {
  readonly capturedAtTick: number;
}

export type AiEvent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'toolCall';
      readonly callId: string;
      readonly toolId: string;
      readonly args: unknown;
    }
  | { readonly kind: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly kind: 'done';
      readonly reason: 'complete' | 'aborted' | 'error';
      readonly message?: string;
    };

export interface AiRequest {
  readonly preamble: string;
  readonly context: AssembledContextLike;
  readonly toolIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface AiSessionOptions {
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface AiSession {
  run(request: AiRequest): AsyncIterable<AiEvent>;
  abort(reason?: string): void;
}

export interface AiProvider {
  readonly id: string;
  readonly capabilities: AiProviderCapabilities;
  createSession(options: AiSessionOptions): AiSession;
}

export interface AiProviderConfig {
  readonly kind: 'proxy' | 'local' | 'deterministic';
  readonly session: AiSessionOptions;
  /**
   * The provider itself, where the caller already has one.
   *
   * Adapters that must be constructed — a local model that has to probe the device —
   * are built by their own factory and handed here, so this function does one job:
   * comparing what is declared against what is required.
   */
  readonly provider?: AiProvider;
  /** Adapter-specific, and never a credential — see `adapters/proxy.ts`. */
  readonly adapter?: Readonly<Record<string, unknown>>;
}

export interface AiProviderResult {
  readonly provider: AiProvider | null;
  /** Always a sentence, on both paths. An empty reason is the silent no-op. */
  readonly reason: string;
}
