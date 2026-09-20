import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

/**
 * **The manifest is the only record of what a capture runs, so it is held to the rules that made
 * each entry acceptable.** A model is pinned to a revision and a hash, or a later upload replaces it
 * unseen; its licence is one a game can ship under, or the engine hands its consumers terms they
 * cannot meet; and the models a licence refused stay refused, which is a decision rather than a
 * measurement. `NOTICE` and `CREDITS.md` name every one, because a model's attribution travels with
 * the work that runs it.
 */

interface Model {
  readonly name: string;
  readonly title: string;
  readonly targets: readonly string[];
  readonly upstream: string;
  readonly revision: string;
  readonly file: string;
  readonly url: string;
  readonly format: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Files a definition reads beside the checkpoint — a tokenizer's — pinned as it is. */
  readonly extra?: readonly {
    readonly file: string;
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly licence: string;
  readonly attribution: string;
  readonly datasetTerms: string;
  readonly code: { readonly upstream: string; readonly revision: string; readonly licence: string };
}

const ROOT = new URL('../../', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, ROOT), 'utf8');
const { models } = JSON.parse(read('tools/capture-weights/manifest.json')) as {
  models: readonly Model[];
};

/* Licences a game can ship a model's weights under without passing on terms it cannot keep. */
const SHIPPABLE = ['Apache-2.0', 'MIT'];

test('EVERY MODEL IS PINNED TO A REVISION AND A HASH, and licensed to ship', () => {
  for (const model of models) {
    const at = `${model.name}: `;
    expect(model.revision, `${at}a full commit, not a branch`).toMatch(/^[0-9a-f]{40}$/);
    expect(model.url, `${at}fetched at the pinned revision`).toContain(model.revision);
    expect(model.url.endsWith(model.file), `${at}the url names the file`).toBe(true);
    expect(model.sha256, `${at}a SHA-256`).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(model.bytes) && model.bytes > 0, `${at}a size`).toBe(true);
    expect(['safetensors', 'pytorch'], `${at}a format the converter reads`).toContain(model.format);
    expect(SHIPPABLE, `${at}the weights' licence`).toContain(model.licence);
    expect(SHIPPABLE, `${at}the code's licence`).toContain(model.code.licence);
    expect(model.code.revision, `${at}the code pinned too`).toMatch(/^[0-9a-f]{40}$/);
    expect(model.attribution.length, `${at}an attribution`).toBeGreaterThan(0);
    expect(model.datasetTerms.length, `${at}the dataset-terms question answered`).toBeGreaterThan(
      0,
    );
    expect(model.targets.length, `${at}where it runs`).toBeGreaterThan(0);
    for (const extra of model.extra ?? []) {
      const of = `${at}${extra.file}: `;
      expect(extra.url, `${of}fetched at the pinned revision`).toContain(model.revision);
      expect(extra.url.endsWith(`/${extra.file}`), `${of}the url names the file`).toBe(true);
      expect(extra.sha256, `${of}a SHA-256`).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(extra.bytes) && extra.bytes > 0, `${of}a size`).toBe(true);
    }
  }
  expect(new Set(models.map((model) => model.name)).size).toBe(models.length);
});

test('no model a licence refused is in the manifest', () => {
  /* The rejected table of `plans/notes/2026-09-17-wave6-weights-proposal.md`: non-commercial, gated,
     field-of-use restricted, or use-based terms that travel with the weights. */
  const refused =
    /DA3-(LARGE|GIANT|NESTED)|Depth-Anything-V2-(Base|Large|Giant)|vggt|dust3r|mast3r|sam3|marigold|compphoto|map-anything(?!-apache)/i;
  for (const model of models) {
    expect(model.upstream, model.name).not.toMatch(refused);
    expect(model.url, model.name).not.toMatch(refused);
  }
});

test('NOTICE and CREDITS name every model the manifest pins', () => {
  const notice = read('NOTICE');
  const credits = read('CREDITS.md');
  for (const model of models) {
    expect(notice, `NOTICE names ${model.title}`).toContain(model.title);
    expect(credits, `CREDITS.md names ${model.title}`).toContain(model.title);
    expect(credits, `CREDITS.md links ${model.title}'s upstream`).toContain(model.upstream);
  }
});
