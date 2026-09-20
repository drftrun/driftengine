/**
 * Named sound slots, resolved once at load: real file if present, synthesised
 * buffer if not.
 *
 * Synthesis is a placeholder, never the destination. Addressing every sound by
 * slot means dropping a file into the assets folder replaces it — no code
 * change, no graph rebuild, no registration step. Until then the game is
 * audible rather than silent, so development is never blocked on assets
 * existing.
 *
 * Game-agnostic on purpose: this knows slots and buffers, not that one of them
 * is a footstep.
 */
export type SoundSlot = string;

export interface SoundSource {
  /**
   * Candidate locations, tried in order; the first that loads wins.
   *
   * A list rather than one path so a slot can accept whatever format the sound
   * actually arrives in. Asking a composer to transcode before they can hear
   * their track in the game is friction with nothing on the other side of it —
   * the browser decodes all of these natively.
   */
  urls: readonly string[];
  /** Built only when no candidate is present or usable. */
  synth: (ctx: BaseAudioContext) => AudioBuffer;
}

/** How a slot ended up being filled. Useful in dev to see what is still synth. */
export type SoundOrigin = 'file' | 'synth';

/** Injectable so the resolution rules can be tested without a network. */
export type FetchLike = (url: string) => Promise<Response>;

export class SoundRegistry {
  private readonly sources = new Map<SoundSlot, SoundSource>();
  private readonly buffers = new Map<SoundSlot, AudioBuffer>();
  private readonly origins = new Map<SoundSlot, SoundOrigin>();
  /** Slots whose stand-in threw. Empty is the normal state; see `unbuilt`. */
  private readonly failed = new Map<SoundSlot, string>();

  // platform: browser default — `FetchLike` is the seam and this is its default
  constructor(private readonly fetchImpl: FetchLike = (url) => fetch(url)) {}

  register(slot: SoundSlot, source: SoundSource): void {
    this.sources.set(slot, source);
  }

  /** Which slots exist, so callers can pick among them (e.g. a daily track). */
  get slots(): readonly SoundSlot[] {
    return [...this.sources.keys()];
  }

  /**
   * Slots whose stand-in threw, and what it said.
   *
   * Empty is the normal state. A consumer with a dev overlay should show this: a silent slot is
   * otherwise indistinguishable from one nobody triggered.
   */
  get unbuilt(): ReadonlyMap<SoundSlot, string> {
    return this.failed;
  }

  get resolved(): ReadonlyMap<SoundSlot, SoundOrigin> {
    return this.origins;
  }

  /**
   * Adopt already-decoded buffers, skipping every fetch and decode.
   *
   * For building a second graph over the same sounds — an offline render of a mix that
   * is already loaded. An `AudioBuffer` is PCM and a sample rate, not a handle onto the
   * context that made it, so it can be used by any context running at the same rate;
   * decoding the library again would cost the whole payload a second time and, worse,
   * could resolve a slot differently from the mix being reproduced.
   */
  adopt(from: SoundRegistry): void {
    for (const [slot, buffer] of from.buffers) this.buffers.set(slot, buffer);
    for (const [slot, origin] of from.origins) this.origins.set(slot, origin);
    for (const [slot, source] of from.sources) {
      if (!this.sources.has(slot)) this.sources.set(slot, source);
    }
  }

  get(slot: SoundSlot): AudioBuffer | undefined {
    return this.buffers.get(slot);
  }

  /**
   * Resolve every slot: the files in parallel, then the stand-ins one at a time.
   *
   * Slots settle independently: one missing or corrupt asset must not silence
   * the rest of the game, which is the likeliest real failure once assets are
   * being dropped in by hand. Every failure mode — network error, HTTP status,
   * undecodable bytes — lands on the same fallback, because from the player's
   * side they are the same event.
   *
   * **The two halves are separated because they cost completely different
   * things.** Fetching is waiting, and twenty slots should wait together.
   * Synthesis is arithmetic on the main thread — an ambience bed is seven
   * seconds of filtered noise at the context's sample rate — and twenty of those
   * settling together lands as one block of work.
   *
   * Which is exactly what it did. Traced on 2026-08-07 on a game that starts its
   * audio at boot, the fallbacks arrived as microtask blocks of 11, 14, 14, 21
   * and 34 ms while the player was already running, and the frame loop went
   * 125 ms between frames because the vsync deadline kept landing inside one.
   * So each stand-in gets its own task. The work is the same; what changes is
   * that a frame can be drawn between any two of them.
   *
   * The yield is a timer rather than a microtask, and that is the whole point —
   * a microtask would rejoin the block it is trying to leave. Whatever the
   * browser clamps the delay to only spaces the work further.
   */
  async load(ctx: BaseAudioContext): Promise<void> {
    const entries = [...this.sources.entries()];
    await Promise.allSettled(entries.map(([slot, source]) => this.loadFile(ctx, slot, source)));

    for (const [slot, source] of entries) {
      if (this.buffers.has(slot)) continue;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      /*
       * **Each stand-in settles on its own, which is what the paragraph above already promised
       * and what this loop did not deliver.** File failures land on `allSettled` and every one of
       * them is contained; a *synth* that threw took the whole `load` down with it — so every slot
       * after it in registration order was left with no buffer, and `play` returns silently on an
       * undefined one. The symptom is a game where the first few sounds work and the rest do not,
       * with nothing in the console after the one throw, and the boundary falling wherever the
       * consumer happened to register the bad slot.
       *
       * Caught rather than rethrown for the same reason a missing file is: from the player's side
       * a slot that cannot be built and one that cannot be fetched are the same event, and neither
       * is worth the rest of the game's audio.
       */
      try {
        this.buffers.set(slot, source.synth(ctx));
        this.origins.set(slot, 'synth');
      } catch (error) {
        this.failed.set(slot, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** The first candidate that loads and decodes wins; none of them is normal. */
  private async loadFile(
    ctx: BaseAudioContext,
    slot: SoundSlot,
    source: SoundSource,
  ): Promise<void> {
    for (const url of source.urls) {
      try {
        const response = await this.fetchImpl(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(bytes);
        this.buffers.set(slot, buffer);
        this.origins.set(slot, 'file');
        return;
      } catch {
        // Try the next format. A missing candidate is the normal case, not
        // an error: most slots will only ever have one of these present.
      }
    }
  }
}
