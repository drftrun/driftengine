import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { ScriptWorld } from '../script/world.ts';
import { flatten, identity } from './flatten.ts';
import { surfaceOf, uvStretch } from './materials.ts';
import type { Surface } from './materials.ts';

const SCRIPT = [
  'prefab brick_tex { Texture: {"etc/assets/brick.svg", 256, 512} }',
  'prefab sign_tex { Texture: {"etc/assets/sign.svg", 512, 128} }',
  'prefab rooms_tex { Texture: {"etc/assets/rooms.svg", 512, 512} }',
  'prefab Facade {',
  '  Rgba: {255, 128, 0, 255}',
  '  PbrMaterial: {metallic: 0.25, roughness: 0.75}',
  '  PbrTextures: {albedo: brick_tex}',
  '  TextureTiling: {meters_x: 4, meters_y: 3, fit: true}',
  '  TextureTransform: {scale_x: 0.25, scale_y: 0.5, offset_x: 0.75}',
  '  Emissive: {strength: 0, color: {255, 255, 255, 255}}',
  '  WindowLights: {strength: 2, offset: 0.1, level: -1}',
  '  InteriorMap: {atlas: rooms_tex, cells_x: 4, cells_y: 4, depth: 0.6, lit_ratio: 0.3, seed: 7}',
  '  SurfaceWear: {dust: 0.5, grime: 0.25, scratch: 0.125}',
  '}',
  'prefab Neon {',
  '  Rgba: {0, 0, 255, 128}',
  '  Emissive: {strength: 0, color: {0, 128, 255, 255}}',
  '  NightLight: {strength: 3, light: 0, offset: 0.05, flicker: 0}',
  '  PbrTextures: {albedo: sign_tex, emissive: sign_tex}',
  '  MaterialAnim: {emissive_pulse_hz: 2, emissive_pulse_depth: 0.5, flicker_depth: 0.25, uv_scroll_x: 0.1}',
  '  Additive',
  '  DryMaterial',
  '}',
  'wall { Box: {13, 3, 0.3}',
  '  (IsA, Facade) }',
  'tube { Cylinder: {segments: 8, smooth: true, length: 5}',
  '  (IsA, Neon) }',
  'plain { Box: {1, 1, 1} }',
  'sign { Box: {1, 0.6, 0.06}',
  '  (IsA, Neon)',
  '  NightLight: {strength: 3, light: 0, offset: 0.05, flicker: 0.05} }',
  'panel { Box: {1, 0.6, 0.06}',
  '  Rgba: {255, 92, 200, 255}',
  '  Emissive: {strength: 0, color: {255, 92, 200, 255}}',
  '  NightLight: {strength: 1.7, light: 0, offset: 0.2, flicker: 0.05} }',
  'cone { Frustum: {segments: 8, smooth: true, length: 4, radius_bottom: 1, radius_top: 0.1}',
  '  Rgba: {20, 20, 20, 255}',
  '  VolumeGlow: {edge_power: 2, axis_falloff: 1, head_fade: 0.5, near_fade: 1, intensity: 0.6} }',
].join('\n');

const read = readScripts(['m.flecs'], (f) => (f === 'm.flecs' ? SCRIPT : null));
function surface(name: string): Surface {
  const e = ScriptWorld.walk(read.world.root, [name]);
  const part = e === null ? undefined : flatten(e, identity()).parts[0];
  if (part === undefined) throw new Error(`no ${name}`);
  return surfaceOf(part.material);
}
const round = (a: ArrayLike<number>): number[] =>
  Array.from(a, (v) => Math.round(v * 1e5) / 1e5 + 0);
/** Every number in a value to five places: the scripts' f32s are not the decimals they were written as. */
const rounded = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v), (_k, x: unknown) =>
    typeof x === 'number' ? Math.round(x * 1e5) / 1e5 + 0 : x,
  );

describe('a material set as the surface a copy wears', () => {
  it('COLOURS ARE LINEAR, NIGHT LIGHT IS THE ENGINE’S NIGHT-GATED EMISSIVE, AND THE MAPS ARE NAMED BY THEIR FILES', () => {
    expect(read.errors).toEqual([]);
    const facade = surface('wall');
    /* 128 in sRGB is 0.21586 linear: ((128/255 + 0.055) / 1.055)^2.4. */
    expect(round(facade.color)).toEqual([1, 0.21586, 0]);
    expect([facade.metallic, facade.roughness, facade.alpha]).toEqual([0.25, 0.75, 1]);
    expect(facade.textures.albedo).toEqual({
      file: 'etc/assets/brick.svg',
      width: 256,
      height: 512,
    });
    const neon = surface('tube');
    /* NightLight's strength, not Emissive's zero; the emissive colour from Emissive. */
    expect([neon.emissive, round(neon.emissiveColor ?? [])]).toEqual([3, [0, 0.21586, 1]]);
    expect(neon.textures.emissive?.file).toBe('etc/assets/sign.svg');
    expect([neon.blend, round([neon.alpha])]).toEqual(['additive', [0.50196]]);
    /* A fake volume of light adds its light, tagged or not: drawn over, it was a solid dark cone. */
    expect(surface('cone').blend).toBe('additive');
    const plain = surface('plain');
    expect([plain.color, plain.textures.albedo, plain.effect]).toEqual([
      [1, 1, 1],
      null,
      undefined,
    ]);
  });

  it('window lights, rooms, wear, animation and dryness become the layer’s effect', () => {
    const facade = surface('wall');
    /* The windows glow by the facade's WindowLights: the layer says where the windows are, and
       the building's own light — its colour at its strength, 2 × white — rides the vertices, as
       its seed rides the copy. No vertex emissive, which would light the whole wall. */
    expect(facade.emissive).toBe(0);
    expect(facade.effect?.windows).toEqual({ cells: [4, 4], glass: true, glow: 1 });
    expect([facade.emissiveColor, facade.windowSeed]).toEqual([[2, 2, 2], 7]);
    expect(facade.rooms).toEqual({ file: 'etc/assets/rooms.svg', width: 512, height: 512 });
    expect(rounded(facade.effect?.interior)).toEqual({ roomLayer: -1, depth: 0.6, lit: 0.3 });
    expect(facade.effect?.wear).toEqual({ dust: 0.5, grime: 0.25, streaks: 0.125, fade: 0 });
    const neon = surface('tube');
    expect(rounded(neon.effect?.animation)).toEqual({
      scroll: [0.1, 0],
      pulse: [2, 0.5],
      flicker: 0.25,
      flipbook: [0, 0],
      fade: 0,
    });
    expect(neon.effect?.dry).toBe(true);
  });

  it('A NIGHT LIGHT’S FLICKER IS ITS EMISSION STUTTERING, with nothing else animated', () => {
    /* A sign panel hung from a street span: its night light flickers by 0.05 and it has no
       MaterialAnim. Dropped, the reference's spans of stuttering signs hung dead still. */
    expect(rounded(surface('panel').effect?.animation)).toEqual({ flicker: 0.05 });
    /* And a light that also has a MaterialAnim keeps the larger of the two, the animation's 0.25,
       with the rest of the animation as it was. */
    expect(rounded(surface('sign').effect?.animation)).toEqual({
      scroll: [0.1, 0],
      pulse: [2, 0.5],
      flicker: 0.25,
      flipbook: [0, 0],
      fade: 0,
    });
  });

  it('A COPY’S STRETCH IS SIZE OVER TILE ALONG EACH PIECE AXIS, ROUNDED TO WHOLE REPEATS WHERE IT FITS, THEN SCALED AND OFFSET', () => {
    /* 13 × 3 × 0.3 at 4 m by 3 m, fitted: round(3.25) = 3 across x; 1 up y; and the 0.3 m depth
       still one repeat, never none. Then TextureTransform's quarter and half, and its offset. */
    expect(round(uvStretch(surface('wall'), 'box', [13, 3, 0.3]))).toEqual([
      0.75, 0.25, 0.25, 2, 0.5, 0.5, 0.75, 0,
    ]);
    /* Unfitted it is 13/4 across and 3/3 up. */
    const loose = { ...surface('wall'), tiling: { mx: 4, my: 3, cylinder: false, fit: false } };
    expect(round(uvStretch(loose, 'box', [13, 3, 0.3]))).toEqual([
      0.8125, 0.1875, 0.01875, 2.16667, 0.5, 0.05, 0.75, 0,
    ]);
    /* Round, tiled at 1 m around and 2 m along: a 2 m diameter is 2π around, 5 m is 2.5 along. */
    const tiled = { ...surface('tube'), tiling: { mx: 1, my: 2, cylinder: true, fit: false } };
    expect(round(uvStretch(tiled, 'round', [2, 5, 2]))).toEqual(
      round([2 * Math.PI, 2.5, 2 * Math.PI, 2 * Math.PI, 2.5, 2 * Math.PI, 0, 0]),
    );
    /* No tiling: the piece's own coordinates, stretched by nothing. */
    expect(round(uvStretch(surface('plain'), 'box', [1, 1, 1]))).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
  });
});
