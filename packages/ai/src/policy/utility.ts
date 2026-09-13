import type { AgentPolicy, Intent, PolicyContext, PolicyOption } from './types.ts';

/**
 * The default floor: score every option, take the highest.
 *
 * Small on purpose. The seam is the deliverable and this is a convenience that has to
 * earn its place by being used. *What it costs:* every consumer links a scorer it may
 * not want. *What would make it wrong:* if consumers universally replace it, it is
 * dead weight and belongs behind its own export rather than in the barrel.
 *
 * **Allocates nothing per tick.** `select` returns one of the options' pre-built
 * intents — the same object identity every time that option wins. That is what makes
 * the claim true by construction, and `utility.alloc.test.ts` is what keeps it true.
 */
export class UtilityPolicy implements AgentPolicy {
  private readonly options: readonly PolicyOption[];

  constructor(options: readonly PolicyOption[]) {
    if (options.length === 0) {
      /*
       * At construction rather than at `select`. A floor with nothing to do is a
       * configuration error, and discovering it inside a fixed step is discovering it
       * at the worst possible moment — the one where there is nothing to fall back to.
       */
      throw new Error(
        'a UtilityPolicy needs at least one option — a floor with nothing to do is not a floor',
      );
    }
    this.options = options;
  }

  select(context: PolicyContext): Intent {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];
      if (option === undefined) continue;
      const score = option.score(context);
      /* Strictly greater, so a tie goes to the earlier declaration. Declaration order
         is something a consumer controls and can read off the file; any other
         tie-break is a rule they would have to be told. */
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    const chosen = this.options[best];
    if (chosen === undefined) throw new Error('unreachable: options is non-empty');
    return chosen.intent;
  }
}
