/**
 * The city's materials, in `MATERIAL`'s order: four facades that glow by their masks, a curtain
 * wall's glass, and the roofs, trim, tanks, crowns, spires, streets and street lights between them.
 *
 * Apart from `city.ts` so a test can read them without a device.
 *
 * **Every facade's UV is scaled by the width of its tile in windows**, because a unit of facade UV
 * is one window and the image is `STYLE_WINDOWS` of them a side — without it every bay shows the
 * whole tile, which the first captures of the city did.
 */
import { MATERIAL, MATERIAL_COUNT, STYLE_WINDOWS } from './manhattan';
import { cityStyles } from './styles';

import type { GpuDrivenMaterial } from '../../packages/core/src/index';

/**
 * How bright a lit window is: the albedo of its lamp times its mask times this. A facade's walls
 * are black in their mask and take the sky and the last of the sun instead.
 *
 * **A flat brighter than an office**, because a flat's lamp is a point in a room and an office's
 * is a ceiling of them seen through tinted glass: at one glow for both, the first capture's near
 * glass towers blew out to white and the bloom spread them over half the frame.
 */
export const WINDOW_GLOW = 3;
export const OFFICE_GLOW = 1.4;
/** How bright a street light's head is. With bloom it is the point a street at dusk is drawn by. */
export const LAMP_GLOW = 10;
/** How brightly a floodlit crown gives back its lights. */
export const CROWN_GLOW = 1.4;
/** How bright a neon tube is: its colour, from its vertices, times this. */
export const NEON_GLOW = 6;

export function cityPalette(seed: number): GpuDrivenMaterial[] {
  const styles = cityStyles(seed);
  const scale = { uScale: 1 / STYLE_WINDOWS, vScale: 1 / STYLE_WINDOWS };
  const materials: GpuDrivenMaterial[] = [];
  materials[MATERIAL.brick] = {
    tint: [1, 1, 1],
    emissive: WINDOW_GLOW,
    roughness: 0.9,
    specular: 0.05,
    textures: { ...styles.brick, ...scale },
  };
  materials[MATERIAL.limestone] = {
    tint: [1, 1, 1],
    emissive: WINDOW_GLOW,
    roughness: 0.85,
    specular: 0.08,
    textures: { ...styles.limestone, ...scale },
  };
  materials[MATERIAL.deco] = {
    tint: [1, 1, 1],
    emissive: OFFICE_GLOW * 1.6,
    roughness: 0.8,
    specular: 0.1,
    textures: { ...styles.deco, ...scale },
  };
  materials[MATERIAL.office] = {
    tint: [1, 1, 1],
    emissive: OFFICE_GLOW,
    roughness: 0.5,
    specular: 0.2,
    textures: { ...styles.office, ...scale },
  };
  /* The curtain wall: its image carries its coverage, so the material is fully opaque by itself. */
  materials[MATERIAL.glass] = {
    tint: [0.72, 0.86, 0.95],
    emissive: 0,
    roughness: 0.05,
    specular: 0.8,
    reflectivity: 0.6,
    blend: true,
    opacity: 1,
    textures: { baseColour: styles.curtain, ...scale },
  };
  materials[MATERIAL.roof] = { tint: [0.08, 0.08, 0.09], emissive: 0, roughness: 0.95 };
  materials[MATERIAL.trim] = {
    tint: [0.82, 0.78, 0.7],
    emissive: 0,
    roughness: 0.7,
    specular: 0.06,
  };
  materials[MATERIAL.tank] = { tint: [0.33, 0.27, 0.22], emissive: 0, roughness: 0.95 };
  materials[MATERIAL.crown] = { tint: [1, 0.92, 0.78], emissive: CROWN_GLOW, roughness: 0.6 };
  materials[MATERIAL.spire] = {
    tint: [0.8, 0.82, 0.86],
    emissive: 0,
    roughness: 0.2,
    specular: 0.7,
    metalness: 0.9,
  };
  /*
   * **Glossy, as a street after rain is**: low roughness and a high specular, so it gives back the
   * sky's gradient and the last of the sun as a sheen. What it cannot give back is the street
   * lights and the neon — this pipeline reflects a probe or a gradient, not the frame.
   */
  materials[MATERIAL.street] = {
    tint: [0.05, 0.05, 0.06],
    emissive: 0,
    roughness: 0.18,
    specular: 0.7,
    reflectivity: 0.5,
  };
  materials[MATERIAL.sidewalk] = { tint: [0.3, 0.29, 0.28], emissive: 0, roughness: 0.9 };
  materials[MATERIAL.lamp] = { tint: [1, 0.8, 0.55], emissive: LAMP_GLOW, roughness: 0.4 };
  materials[MATERIAL.pole] = {
    tint: [0.06, 0.07, 0.08],
    emissive: 0,
    roughness: 0.5,
    metalness: 0.6,
  };
  /* Every sign's colour is its vertices', so one material draws them all. */
  materials[MATERIAL.neon] = { tint: [1, 1, 1], emissive: NEON_GLOW, roughness: 0.3 };
  if (materials.length !== MATERIAL_COUNT) {
    throw new Error(
      `[driftengine] the city has ${MATERIAL_COUNT} materials and ${materials.length} were made`,
    );
  }
  return materials;
}
