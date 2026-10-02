import { describe, expect, it } from 'vitest';
import { compileDriftScript } from 'driftscript/compiler';
import { singleFileHost } from 'driftscript/compiler';
import { engineRegistry, engineTarget } from './host.ts';

/**
 * Every script the examples run, compiled against **this engine's real capabilities**.
 *
 * The examples keep their behaviour in `.drs` files the bundler compiles, and the manual quotes
 * regions of them. Nothing else compiles them: `npm run typecheck` does not read DriftScript, and a
 * bundler only meets a file when somebody opens the page. So a script calling `render.focus` with
 * the wrong arguments would ship in a chapter and fail in a reader's browser. This is the same gate
 * `corpus.test.ts` keeps for `docs/corpus/`, for the files a newcomer copies first.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/* Spelled out in full, because the bundler matches the pattern in the syntax tree. */
const sources: Record<string, string> = import.meta.glob('../../../examples/*/*.drs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const compile = (name: string, source: string) =>
  compileDriftScript(source, {
    filename: name,
    host: singleFileHost(),
    registry: engineRegistry(),
    manifest: engineTarget(),
    mode: 'development',
  });

describe('the examples’ scripts against this engine', () => {
  it('finds the scripts, so none of this is vacuous', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(3);
  });

  it('compiles and links every one with no diagnostics at all', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(
        compile(name, source).diagnostics.map((d) => `${d.code} ${d.message}`),
        `${name} does not compile against this engine`,
      ).toEqual([]);
    }
  });

  it('would have caught a dial called with the wrong number of arguments', () => {
    const lens = Object.entries(sources).find(([name]) => name.endsWith('look/lens.drs'));
    expect(lens, 'the lens script is where this perturbation is kept').toBeDefined();
    const wrong = (lens?.[1] ?? '').replace(
      'render.focus(renderer, 21, 3, lens.focusing)',
      'render.focus(renderer, 21, 3)',
    );
    expect(compile('look/lens.drs', wrong).diagnostics.map((d) => d.code)).toContain('DS0262');
  });
});
