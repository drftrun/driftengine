/**
 * The city's quality tiers — low, medium, high, ultra — as renderer options, which are chosen when
 * the renderer is built: a tier is changed by building it again, which the pause screen does by
 * opening the scene at the next one (`?tier=`).
 *
 * What each gives up, from ultra down: the full-resolution reconstruction for one at two thirds
 * (high), then three fifths (medium) and a half (low); the contact shade, lighter at medium and
 * gone at low; the sun's shadow at 4,096, 2,048 and 1,024. Bloom, HDR and the lamps' clustered light
 * stay at every tier: without them a night street is not the reference's night street.
 */
import type { RenderQualityOptions } from '../../packages/core/src/index';

export type Tier = 'low' | 'medium' | 'high' | 'ultra';

export const TIERS: readonly Tier[] = ['low', 'medium', 'high', 'ultra'];

/** The tier `?tier=` asks for, or high. */
export function tierFrom(search: string): Tier {
  const asked = new URLSearchParams(search).get('tier');
  return TIERS.find((t) => t === asked) ?? 'high';
}

/** The next tier round, as the pause screen's quality control steps them. */
export function nextTier(tier: Tier): Tier {
  return TIERS[(TIERS.indexOf(tier) + 1) % TIERS.length] as Tier;
}

/** The options a tier sets; the scene adds those every tier shares. */
export function tierQuality(tier: Tier, drawing: string): RenderQualityOptions {
  const webgpu = drawing === 'webgpu';
  switch (tier) {
    case 'low':
      return {
        ambientOcclusion: 0,
        reconstruction: webgpu ? 2 : 0,
        directionalShadowMapSize: 1024,
      };
    case 'medium':
      return {
        ambientOcclusion: 0.3,
        reconstruction: webgpu ? 1.66 : 0,
        directionalShadowMapSize: 2048,
      };
    case 'ultra':
      return {
        ambientOcclusion: 0.5,
        reconstruction: webgpu ? 1 : 0,
        directionalShadowMapSize: 4096,
      };
    default:
      return {
        ambientOcclusion: 0.4,
        reconstruction: webgpu ? 1.5 : 0,
        directionalShadowMapSize: 4096,
      };
  }
}
