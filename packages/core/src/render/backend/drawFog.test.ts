import { expect, test } from 'vitest';

import { fogModeOf } from './drawFog.ts';

/**
 * The values are the shader's: `flat/main.ts` compares `uFogEnabled` against 2 for a draw that
 * adds its light, and `!= 0` for any fog at all. So they are asserted as numbers, not as the
 * names this module gives them.
 */
test('ADDED LIGHT FADES IN THE MEDIUM, a surface recedes into it, and neither when fog is off', () => {
  expect(fogModeOf(true, true), 'an additive draw').toBe(2);
  expect(fogModeOf(true, false), 'a surface, as every draw was before').toBe(1);
  expect(fogModeOf(false, true), 'an additive draw kept out of the medium').toBe(0);
  expect(fogModeOf(false, false)).toBe(0);
});
