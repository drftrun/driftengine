import { expect, test } from 'vitest';
import { FLAT_FRAG_WGSL } from './generated/flat.wgsl.ts';

/**
 * **WebGPU refuses a fragment stage with more than sixteen inputs, and counts the builtins.** The
 * limit is `maxInterStageShaderVariables`, 16 by default, and the device adds `front_facing`,
 * `sample_index` and `sample_mask` to the user-defined ones. The flat shader carries sixteen, so
 * reading the rasteriser's facing flag for two-sided surfaces made every mesh pipeline invalid:
 * `17 = 16 (user-defined) + 1 (front_facing)`, and a frame with nothing in it. No gate here could
 * see it; the device was the first to count. This counts the same way, over every variant.
 */
test('EVERY FLAT FRAGMENT VARIANT STAYS WITHIN SIXTEEN INPUTS, counting the builtins the device counts', () => {
  const variants = Object.entries(FLAT_FRAG_WGSL);
  expect(variants.length).toBeGreaterThan(1);
  for (const [name, wgsl] of variants) {
    /* Up to the arrow that ends the signature: an attribute like \`@interpolate(flat)\` carries a
       closing bracket of its own, and stopping at the first one counted a third of the inputs. */
    const entry = /@fragment\s*fn\s+main\s*\(([\s\S]*?)\)\s*->/.exec(wgsl);
    expect(entry, `${name} has a fragment entry point`).not.toBeNull();
    const parameters = entry?.[1] ?? '';
    const located = (parameters.match(/@location\(/g) ?? []).length;
    const builtins = (
      parameters.match(/@builtin\((front_facing|sample_index|sample_mask)\)/g) ?? []
    ).length;
    expect(located + builtins, name).toBeLessThanOrEqual(16);
  }
});
