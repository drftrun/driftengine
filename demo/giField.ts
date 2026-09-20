/**
 * The world's own distance field, composed on the device and marched.
 *
 * A draft: what it draws is a diagnostic rather than a material. See `giFieldRig.ts`.
 */
import { mountGiField } from './giFieldRig';

import type { RenderQualityOptions } from '../packages/core/src/index';
import type { DemoBudget, DemoHandle, DemoScene } from './types';

export const giField: DemoScene = {
  id: 'gi-field',
  title: 'The world as one distance field',
  note:
    'Eighteen objects composed into three camera-centred cascades by a compute dispatch each ' +
    'frame, then sphere-traced. It is the first level of the global illumination chain running ' +
    'where it has to run: the same composition costs 707 ms on a processor.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    return mountGiField(canvas, overrides);
  },
};
