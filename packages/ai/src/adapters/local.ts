import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderResult,
  AiSession,
  AiSessionOptions,
} from '../provider/types.ts';

/**
 * A provider running on this device, accepted by running it.
 *
 * The engine's 2.7.0 rule for devices: `probeDevice` compiles what it is given and
 * reads back a known pixel, because a device that reports support and then draws
 * nothing is a device that lied. A local model is the same shape of question — whether
 * it works here is a property of this machine, not of the configuration — so it is
 * asked by doing rather than by reading a capability flag.
 *
 * **A failed probe never falls back to a remote provider.** That would move where a
 * user's data goes, quietly, and make every privacy notice written against this wrong.
 * The result carries no provider and a sentence saying why; choosing a second option
 * is the caller's, having read the first refusal.
 */
export interface LocalProviderConfig {
  readonly id: string;
  readonly model: string;
  readonly capabilities: Omit<AiProviderCapabilities, 'local'>;
  /**
   * Run the model once and report whether it worked.
   *
   * Resolving false, or throwing, are the same answer with different words. Both
   * refuse; neither substitutes anything.
   */
  probe(): Promise<boolean>;
  createSession(options: AiSessionOptions): AiSession;
}

export async function createLocalProvider(config: LocalProviderConfig): Promise<AiProviderResult> {
  let works: boolean;
  let detail = '';

  try {
    works = await config.probe();
  } catch (error) {
    works = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  if (!works) {
    return {
      provider: null,
      reason:
        `local provider "${config.id}" is unavailable on this device: the probe did not run` +
        (detail === '' ? '' : ` — ${detail}`),
    };
  }

  const provider: AiProvider = {
    id: config.id,
    capabilities: { ...config.capabilities, local: true },
    createSession: (options) => config.createSession(options),
  };

  return { provider, reason: `local provider "${config.id}" ready, probed on this device` };
}
