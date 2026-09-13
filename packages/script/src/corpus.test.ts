import { describe, expect, it } from 'vitest';
import { compileDriftScript } from 'driftscript/compiler';
import type { ModuleHost } from 'driftscript/compiler';
import { engineRegistry, engineTarget } from './host.ts';

/**
 * The wired corpus, compiled against **this engine's real capabilities**.
 *
 * **The gap this closes let a corpus file call `audio.play` with one argument.** It was caught by a
 * person hovering it in an editor, not by a test, and two things had to be true at once for that:
 *
 * - `docs/corpus/`'s own test hand-writes a registry describing the wired surfaces, because
 *   `driftscript` may not import an engine package. A hand-written description is a second
 *   definition of a signature, and the corpus drifted from the first.
 * - The language server's agreement test compiles both sides with **no registry**, so capability
 *   calls resolve to nothing and arity is never checked. Both sides agreed on an empty list, which
 *   is agreement about nothing.
 *
 * This package is the one place the engine and the language meet, so it is the only place a corpus
 * file can be checked against the signatures a script author will actually be given. Nothing here
 * describes a capability; it asks `engineRegistry()`, which is what the bindings answer with.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/*
 * Read through the bundler rather than the filesystem: this package's config sets `types: []`, which
 * is what stops a Node global reaching a consumer's bundle. Both patterns spelled out in full,
 * because the bundler matches them in the syntax tree and one built from a variable reaches nothing.
 */
const sources: Record<string, string> = {
  ...import.meta.glob('../../../docs/corpus/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob('../../../docs/corpus/animals/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

/** The corpus keyed the way a reader names a file: `AudioReactive.drs`, `animals/wolf.drs`. */
const CORPUS_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(sources).map(([full, source]) => {
    const parts = full.split('/');
    const name = parts[parts.length - 1];
    const parent = parts[parts.length - 2];
    return [parent === 'corpus' ? name : `${parent}/${name}`, source];
  }),
);

/** Corpus files every capability of which this engine provides today. */
const WIRED = [
  'AgentNavigates.drs',
  'animals/traits.drs',
  'animals/wolf.drs',
  'AudioReactive.drs',
  'CampfireTending.drs',
  'EcsCoroutines.drs',
  'GuardBehaviour.drs',
  'PhysicsGrapple.drs',
  'TimedToggle.drs',
];

const CORPUS = '/corpus';

function read(relative: string): string {
  return CORPUS_FILES[relative] ?? '';
}

/** Resolves a relative specifier against the corpus, which is where these files live. */
const host: ModuleHost = {
  resolve(specifier, from) {
    const parts = from.slice(0, from.lastIndexOf('/')).split('/');
    for (const segment of specifier.split('/')) {
      if (segment === '.') continue;
      else if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return `${parts.join('/')}.drs`;
  },
  load: (id) => CORPUS_FILES[id.slice(`${CORPUS}/`.length)] ?? null,
};

const compile = (relative: string) =>
  compileDriftScript(read(relative), {
    filename: `${CORPUS}/${relative}`,
    host,
    registry: engineRegistry(),
    manifest: engineTarget(),
    mode: 'development',
  });

describe('the wired corpus against this engine', () => {
  it('reads every file it claims to, so none of this is vacuous', () => {
    for (const relative of WIRED) {
      expect(read(relative).length, `${relative} is empty or missing`).toBeGreaterThan(0);
    }
  });

  it('compiles and links every wired file with no diagnostics at all', () => {
    /*
     * Not "no errors" — no diagnostics. A warning here is a corpus file importing something it does
     * not use, which is exactly the kind of drift a file written to be *read* accumulates.
     */
    for (const relative of WIRED) {
      const result = compile(relative);
      expect(
        result.diagnostics.map((d) => `${d.code} ${d.message}`),
        `${relative} does not compile against this engine`,
      ).toEqual([]);
    }
  });

  it('would have caught a call with the wrong number of arguments', () => {
    /*
     * The perturbation, kept rather than run once by hand. `audio.play` takes a resolved `Sound` and
     * a gain; the corpus called it with a slot name and nothing else, and every existing test passed.
     */
    const wrong = read('animals/traits.drs').replace('audio.play(s, 1)', 'audio.play(c.name)');
    const result = compileDriftScript(wrong, {
      filename: `${CORPUS}/animals/traits.drs`,
      host,
      registry: engineRegistry(),
      manifest: engineTarget(),
      mode: 'development',
    });
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0262');
  });

  it('names every corpus file, so one added is not silently unchecked', () => {
    /*
     * A file dropped into `docs/corpus/` that nothing compiles is a file that rots. Listing the
     * wired ones by hand is deliberate — the rest are unwired on purpose and must *not* link — but
     * the list has to be complete against what is on disk, or adding a wired file changes nothing.
     */
    const unaccounted = Object.keys(CORPUS_FILES).filter(
      (file) => !WIRED.includes(file) && !UNWIRED.includes(file),
    );
    expect(unaccounted, 'corpus files this test neither compiles nor exempts').toEqual([]);
  });
});

/**
 * Corpus files that deliberately use surfaces no target provides.
 *
 * They must parse and type-check and fail *only* at linking — which `docs/corpus/`'s own test
 * asserts. They are listed here so the completeness check above cannot be satisfied by forgetting
 * about them.
 *
 * **`EcsCoroutines.drs` was in this list and in `WIRED` at the same time**, which the completeness
 * check tolerates because it is an `or`. It stopped being unwired when Track M shipped, and the
 * entry stayed — a comment describing a file as deliberately unlinkable while another list compiled
 * it. Removed when the file was rewritten to the entity forms.
 */
const UNWIRED = ['EditorMetadata.drs', 'NetworkReplicatedActor.drs'];
