import { describe, expect, it } from 'vitest';

import { plumeShaders, type PlumeMaterial } from '../../plumeMaterial.ts';
import {
  ARCANE_FRAG_SIZE,
  FIRE_FRAG_SIZE,
  PLUME_FRAG_FIELDS,
  PLUME_FRAG_SIZE,
  SMOKE_FRAG_SIZE,
} from './plumePass.ts';

/*
 * The plume fragment block, which one binding has to serve for every material.
 *
 * **This file exists because the four gates passed while the arcane pipeline could not be
 * built.** Nothing here compiles a shader or touches a device, so nothing here noticed that
 * `arcane` declares 144 bytes against a layout that promised 128 — the device did, at
 * `createRenderPipeline`, with *"The shader uses more bytes of the buffer (144) than the
 * layout's minBindingSize (128)"*. By the 2026-08-14 rule that is not a wrong picture, it is
 * no picture, so it is worth an assertion that fails in CI rather than on a card.
 */

const MATERIALS: readonly PlumeMaterial[] = ['fire', 'smoke', 'arcane'];

describe('the plume fragment uniform block', () => {
  it('is bound at the width of the widest material, not the first one', () => {
    expect(PLUME_FRAG_SIZE).toBe(Math.max(FIRE_FRAG_SIZE, SMOKE_FRAG_SIZE, ARCANE_FRAG_SIZE));
    /* The case that broke: the widest is not the one the writer used to be keyed on. */
    expect(ARCANE_FRAG_SIZE).toBeGreaterThan(FIRE_FRAG_SIZE);
  });

  /*
   * One field table serves every material, so a generator that moved a shared field in one
   * shader and not the others would have this writer reading fog out of a clip plane. The
   * table is the widest block's, so it must also *contain* every other block's fields.
   */
  it('places every shared field at the same offset in all three materials', () => {
    const blocks = MATERIALS.map((material) => {
      const bindings = plumeShaders(material).fragmentBindings as {
        readonly fields: Record<string, { readonly offset: number }>;
      };
      return { material, fields: bindings.fields };
    });

    for (const { material, fields } of blocks) {
      for (const [name, field] of Object.entries(fields)) {
        expect(
          PLUME_FRAG_FIELDS[name],
          `${material} declares ${name}, which the shared field table does not carry`,
        ).toBeDefined();
        expect(
          PLUME_FRAG_FIELDS[name]?.offset,
          `${material}.${name} sits at a different offset`,
        ).toBe(field.offset);
      }
    }
  });

  /*
   * `uTint` is the field the arcane material was added for, and the one the WebGPU path never
   * wrote. An unwritten uniform is zero, and zero on an additive plume is an invisible one
   * rather than a wrongly coloured one — which is why this asserts the offset exists at all.
   */
  it('carries uTint, which only the arcane material reads', () => {
    expect(PLUME_FRAG_FIELDS['uTint']).toBeDefined();
    expect(PLUME_FRAG_FIELDS['uTint']?.offset).toBeGreaterThanOrEqual(FIRE_FRAG_SIZE);
    expect(PLUME_FRAG_SIZE).toBeGreaterThanOrEqual((PLUME_FRAG_FIELDS['uTint']?.offset ?? 0) + 12);
  });

  it('resolves both compilations of every material in the table', () => {
    for (const material of MATERIALS) {
      const shaders = plumeShaders(material);
      expect(shaders.fragmentSource.length, `${material} has no GLSL`).toBeGreaterThan(0);
      expect(shaders.fragmentWgsl.length, `${material} has no WGSL`).toBeGreaterThan(0);
      expect(shaders.label).toBe(`plume:${material}`);
    }
  });
});
