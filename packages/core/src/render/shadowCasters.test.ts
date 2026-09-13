import { describe, expect, it } from 'vitest';

/*
 * **From the barrel and nowhere else, which is the whole point of this file.**
 *
 * `src/index.ts` is the entire public surface — `scripts/docs-api.mjs` says so in as many words,
 * and anything not exported there is private whatever its own module does. So a test that reached
 * into `./shadowCasters` for these would pass while a consumer could not write the same code, and
 * it is exactly that gap this exists to close.
 */
import type {
  SceneCasterMaterial,
  SceneCasters,
  ShadowCasterSink,
  ShadowCasters,
} from '../index.ts';

/**
 * A consumer can implement `ShadowCasterSink` using only names the barrel publishes.
 *
 * **This interface is implemented outwards**, which its own comments say twice: consumers' sinks
 * and their test doubles satisfy it, which is why `instanced` is optional and why the material
 * added in 3.46.0 is optional too. An interface a consumer is expected to implement is only as
 * usable as the names it obliges them to write, and `mesh` and `skinnedMesh` take a
 * `SceneCasterMaterial` that the barrel did not publish — so the parameter could be accepted and
 * not named.
 *
 * The report that found it did what this repository's rules prescribe rather than reasoning about
 * it: wrote the import, ran the typechecker, and quoted what came back — *Module
 * `"@driftengine/core"` has no exported member `SceneCasterMaterial`*. Their workaround was
 * `Parameters<ShadowCasterSink['mesh']>[2]`, which is exact by construction and cost them a line
 * and a paragraph explaining why it was not an import.
 *
 * **The assertion is that this file compiles.** There is no runtime shape to check — a type that
 * is not exported is a `tsc` error and nothing at all at run time — so the test body only proves
 * the sink it declares is really a sink. `npm run typecheck` is the instrument, and it went red on
 * exactly the line the report quoted before this was fixed.
 */
describe('the caster sink is implementable from the barrel', () => {
  it('names every type a sink must accept', () => {
    const seen: SceneCasterMaterial[] = [];

    const sink: ShadowCasterSink = {
      mesh: (_mesh, _model, material: SceneCasterMaterial = null) => {
        seen.push(material);
      },
      skinnedMesh: (_mesh, _model, _palette, material: SceneCasterMaterial = null) => {
        seen.push(material);
      },
      instanced: (_batch, _data, material: SceneCasterMaterial = null) => {
        seen.push(material);
      },
      scatter: () => {},
    };

    /* And the two names for the enumeration itself, one per pass it can feed. */
    const casters: ShadowCasters = (s) => s.mesh(null as never, null as never);
    const replay: SceneCasters = casters;
    replay(sink);

    expect(seen, 'the sink ran and the material arrived as a value it can name').toEqual([null]);
  });
});
