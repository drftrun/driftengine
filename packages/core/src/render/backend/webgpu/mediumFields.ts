/**
 * The medium's fields, every uniform `shaders/fog.ts` declares, written into a pass's block by name
 * from one resolved atmosphere.
 *
 * **One writer for every pass that fogs.** Ten passes wrote the same ten fields by hand, so a field
 * the medium grows was ten places to remember and a pass that missed one read zero: the fourth
 * point of the rule `AGENTS.md` dates 2026-08-13. A field a pass's shader never reads is compiled
 * out of its block, so each is written only where the block holds it. An absent field is not an
 * offset of zero, which is the first field of the block.
 */
import type { ResolvedAtmosphere } from '../../atmosphere.ts';
import type { UniformFields } from './scatterPass.ts';
import type { UniformRing } from './uniformRing.ts';

/** A field's byte offset in the block, or -1 where the shader compiled it out. */
function placed(fields: UniformFields, name: string): number {
  return fields[name]?.offset ?? -1;
}

/** Into a block staged as floats, indexed in four-byte words. */
export function writeMediumFields(
  fields: UniformFields,
  f: Float32Array,
  m: ResolvedAtmosphere,
): void {
  let at = placed(fields, 'uFogColor');
  if (at >= 0) f.set(m.fogColor, at / 4);
  at = placed(fields, 'uFogMedium');
  if (at >= 0) {
    f[at / 4] = m.fogDensity;
    f[at / 4 + 1] = m.fogHeightFalloff;
    f[at / 4 + 2] = m.fogEyeY;
    f[at / 4 + 3] = m.underwaterFogDensity;
  }
  at = placed(fields, 'uFogRange');
  if (at >= 0) {
    f[at / 4] = m.fogNear;
    f[at / 4 + 1] = m.fogFar;
    f[at / 4 + 2] = m.fogMode;
    f[at / 4 + 3] = 0;
  }
  at = placed(fields, 'uUnderwaterColor');
  if (at >= 0) f.set(m.underwaterColor, at / 4);
  at = placed(fields, 'uUnderwaterFactor');
  if (at >= 0) f[at / 4] = m.underwaterFactor;
  at = placed(fields, 'uFogLayer2');
  if (at >= 0) f.set(m.fogLayer2, at / 4);
  at = placed(fields, 'uFogGlow');
  if (at >= 0) f.set(m.fogGlow, at / 4);
  at = placed(fields, 'uFogGlowDir');
  if (at >= 0) f.set(m.fogGlowDir, at / 4);
}

/** Into one slot of a ring, at the fields' byte offsets. */
export function writeMediumSlot(
  ring: UniformRing,
  slot: number,
  fields: UniformFields,
  m: ResolvedAtmosphere,
): void {
  let at = placed(fields, 'uFogColor');
  if (at >= 0) ring.writeFloats(slot, at, m.fogColor);
  at = placed(fields, 'uFogMedium');
  if (at >= 0) {
    ring.writeFloat(slot, at, m.fogDensity);
    ring.writeFloat(slot, at + 4, m.fogHeightFalloff);
    ring.writeFloat(slot, at + 8, m.fogEyeY);
    ring.writeFloat(slot, at + 12, m.underwaterFogDensity);
  }
  at = placed(fields, 'uFogRange');
  if (at >= 0) {
    ring.writeFloat(slot, at, m.fogNear);
    ring.writeFloat(slot, at + 4, m.fogFar);
    ring.writeFloat(slot, at + 8, m.fogMode);
    ring.writeFloat(slot, at + 12, 0);
  }
  at = placed(fields, 'uUnderwaterColor');
  if (at >= 0) ring.writeFloats(slot, at, m.underwaterColor);
  at = placed(fields, 'uUnderwaterFactor');
  if (at >= 0) ring.writeFloat(slot, at, m.underwaterFactor);
  at = placed(fields, 'uFogLayer2');
  if (at >= 0) ring.writeFloats(slot, at, m.fogLayer2);
  at = placed(fields, 'uFogGlow');
  if (at >= 0) ring.writeFloats(slot, at, m.fogGlow);
  at = placed(fields, 'uFogGlowDir');
  if (at >= 0) ring.writeFloats(slot, at, m.fogGlowDir);
}
