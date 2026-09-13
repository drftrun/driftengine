/**
 * What a frame asked of a backend, against what that backend allows.
 *
 * **This exists because a ceiling firing was unobservable.** The WebGPU backend holds ten per-frame
 * ceilings — draws, material changes, overlays, water bodies, light volumes, plumes, three kinds of
 * effect batch and the scatter shadow round — and past any of them it skips the work and writes one
 * `console.warn` for the lifetime of the renderer. WebGL2 holds none of them and draws everything.
 * So a scene over a ceiling renders differently on the two backends, silently, and a consumer
 * developing against WebGL2 has no way to see it coming.
 *
 * **The cost of that was measured from outside.** A consumer spent weeks on ground that
 * vanished and reappeared as the camera moved; its own report still lists, as the decisive
 * experiment nobody has run, *"ask the reporter for the console"*. It wrote a draw counter and a
 * per-material `reach` field of its own to guess at a worst case this renderer already knew
 * exactly.
 *
 * **A count, not a log.** A warning cannot be asserted on, cannot be read from a headless check,
 * and is gone by the time anybody looks. A number can be all three, and the whole point of the
 * shape below is that `dropped` is one boolean a consumer's own suite can fail on.
 */

/** One ceiling's frame. Updated in place, so holding a reference to it is the intended use. */
export interface BudgetLine {
  /** What a consumer would call the thing, not what the ring holding it is called. */
  readonly name: string;
  /**
   * How many were **asked for**, including any that were refused.
   *
   * The distinction is the whole value of this field. A ring naturally knows how many slots it
   * handed out, which tops out at the ceiling and says a frame is exactly full; what a consumer
   * needs is how far past it the scene went, because that is the number that says how much to cut.
   */
  readonly used: number;
  /** The ceiling, or `null` where this backend imposes none. */
  readonly ceiling: number | null;
  /** How many were asked for and not drawn. */
  readonly dropped: number;
}

/**
 * The half a backend writes: a line it can count against.
 *
 * Separate from `BudgetLine` so that what a consumer is handed is read-only — a caller able to
 * call `drop()` on the renderer's own budget could clear a check that was about to fail.
 */
export interface BudgetCounter extends BudgetLine {
  /** One more of this thing was asked for, whether or not it will fit. */
  ask(): void;
  /** One of them was refused, and the frame is marked. */
  drop(): void;
}

class Line implements BudgetCounter {
  used = 0;
  dropped = 0;

  constructor(
    readonly name: string,
    readonly ceiling: number | null,
    private readonly budget: FrameBudget,
  ) {}

  /** One more of this thing was asked for, whether or not it will fit. */
  ask(): void {
    this.used += 1;
  }

  /** One of them was refused. Marks the frame, which is what a consumer asserts on. */
  drop(): void {
    this.dropped += 1;
    this.budget.markDropped();
  }

  reset(): void {
    this.used = 0;
    this.dropped = 0;
  }
}

/**
 * Every ceiling a backend imposes, counted for the frame just drawn.
 *
 * **The lines and the array holding them are allocated once and updated in place**, so a consumer
 * reading this every frame allocates nothing — which is what `AGENTS.md` requires of anything on a
 * per-frame path, and a budget nobody can afford to read every frame is a budget nobody reads.
 */
export class FrameBudget {
  private readonly all: Line[] = [];
  private anyDropped = false;

  /**
   * Declare a line. Called at construction, never in a frame.
   *
   * `ceiling` is `null` for a backend that imposes none — reported rather than omitted, because a
   * line that disappears on one backend is a line a cross-backend check cannot compare.
   */
  line(name: string, ceiling: number | null): BudgetCounter {
    for (const existing of this.all) {
      if (existing.name === name) {
        throw new Error(
          `frame budget: a line named ${name} is already declared. Two subsystems sharing one ` +
            'ceiling constant still need a line each, or a consumer told which number ran out ' +
            'cannot tell which of them to cut.',
        );
      }
    }
    const line = new Line(name, ceiling, this);
    this.all.push(line);
    return line;
  }

  /** Every line, in the order declared. The same array every frame. */
  get lines(): readonly BudgetLine[] {
    return this.all;
  }

  /**
   * Whether anything at all was refused this frame.
   *
   * **The one thing worth asserting on**, and the reason it is a field rather than a walk over
   * `lines`: a consumer's headless check wants `expect(renderer.frameBudget.dropped).toBe(false)`
   * on every scene it renders, and a check that has to know which lines exist is a check that
   * misses the line added after it was written.
   */
  get dropped(): boolean {
    return this.anyDropped;
  }

  /** @internal Marked by a line, not by a caller. */
  markDropped(): void {
    this.anyDropped = true;
  }

  /** Start a frame. Keeps every line object; clears what they hold. */
  reset(): void {
    for (const line of this.all) line.reset();
    this.anyDropped = false;
  }
}
