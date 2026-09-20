import { expect, test } from 'vitest';

/**
 * **A texture's usage bits are not a buffer's, and two files here name the buffer's bare.**
 *
 * `COPY_DST` is `0x0008` on a buffer and `STORAGE_BINDING` on a texture, where copying in is
 * `0x02`. `gpuDrivenPass.ts` has now reached for the buffer's name on a texture twice: once for a
 * copy out, which its own comment records, and on 2026-09-17 for the latent array's copy in — the
 * device refused the upload with a warning, the array stayed zeros, and no capture could have
 * said so because nothing was textured yet. The texture names carry a `TEXTURE_` prefix; this
 * holds every texture these files create to those names.
 */
const FILES = ['gpuDrivenPass.ts', 'giFieldPass.ts'];
const BUFFER_BITS = [
  'COPY_SRC',
  'COPY_DST',
  'UNIFORM',
  'STORAGE',
  'INDIRECT',
  'MAP_READ',
  'QUERY_RESOLVE',
];

/** Every `createTexture(...)` argument in a source, found by balancing parentheses. */
function textureCalls(source: string): string[] {
  const calls: string[] = [];
  let from = source.indexOf('createTexture(');
  while (from !== -1) {
    let depth = 0;
    let at = from + 'createTexture'.length;
    for (; at < source.length; at += 1) {
      if (source[at] === '(') depth += 1;
      if (source[at] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(from, at + 1));
    from = source.indexOf('createTexture(', at);
  }
  return calls;
}

test('A TEXTURE IS CREATED WITH TEXTURE USAGE BITS, never a buffer’s of the same name', async () => {
  let seen = 0;
  for (const file of FILES) {
    // Vite's `?raw` suffix carries no type declaration; the variable path keeps TS quiet and
    // vitest resolves it at run time, as `flat.test.ts` does.
    const path = `./${file}?raw`;
    const source = ((await import(/* @vite-ignore */ path)) as { default: string }).default;
    for (const call of textureCalls(source)) {
      const usage = /usage:\s*([^,\n}]+)/.exec(call)?.[1] ?? '';
      const names = usage.match(/\b[A-Z][A-Z_]*\b/g) ?? [];
      expect(names.length, `${file}: ${call.slice(0, 80)}`).toBeGreaterThan(0);
      for (const name of names) {
        expect(BUFFER_BITS, `${file} creates a texture with ${name}`).not.toContain(name);
      }
      seen += 1;
    }
  }
  /* The scan found the textures it is about, rather than passing over none. */
  expect(seen).toBeGreaterThanOrEqual(6);
});
