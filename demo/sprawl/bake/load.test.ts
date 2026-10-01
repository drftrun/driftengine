import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LAYERS, missingSource } from './load.ts';

describe('the bake’s source', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('REFUSES WITH THE PATH IT LOOKED FOR WHEN THE SOURCE IS ABSENT OR PARTIAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sprawl-source-'));
    made.push(dir);
    const root = join(dir, 'etc');
    expect(missingSource(root)).toContain(root);

    mkdirSync(root);
    for (const layer of LAYERS.slice(0, 3)) writeFileSync(join(root, `${layer}.flecs`), '');
    expect(missingSource(root)).toContain(join(root, `${LAYERS[3]}.flecs`));

    for (const layer of LAYERS) writeFileSync(join(root, `${layer}.flecs`), '');
    expect(missingSource(root)).toBeNull();
  });
});
