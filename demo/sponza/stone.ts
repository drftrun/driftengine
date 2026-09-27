/**
 * The courtyard's stone: the colour light bounces off it, which of its maps to believe, and its floor.
 *
 * **The bounce colour is the mean of the file's stone maps, decoded as glTF says they are**, over the
 * eighteen base-colour images its stone, brick, plaster, column, ornament, arch and floor materials
 * wear: 0.24, a weathered grey limestone. One colour for the whole field, because the field is one
 * for the whole courtyard; what it gives up is the darker floor, tinted as the walls are.
 *
 * **The images were read undecoded from 2026-09-26 until the same day's evening**, on a measurement
 * against the maker's renders that the dirt decal had spoiled: the decal drew every wall it covered
 * white with its grime left dark (see the glTF reader's `specular` lane), and the undecoded reading
 * softened that into something that matched. With the decal fixed the decoded images are the
 * renders' own grey stone, and the undecoded ones read as milk.
 */
import type { DrftMaterial, MeshData } from '@driftengine/drft';

export const STONE_ALBEDO: readonly [number, number, number] = [0.24, 0.22, 0.195];

/**
 * **The stone is a dielectric, whatever its maps' metallic channel says.** Intel's stone, brick,
 * plaster and wood maps carry up to 0.37 in that channel, on the clean stone rather than the grime
 * (a correlation of +0.77 with the colour). In shade each such patch swapped its diffuse light for a
 * reflection of a dark gallery and read as a black blotch: measured on the upper gallery at 18:47,
 * the shaded pillar went from blotched to even with the channel off, and nothing in the maker's
 * renders shows a metallic sheen on stone. The metal door, the window frames, the glass and the
 * lamps keep what their maps say.
 */
const DIELECTRIC = /stone|brick|plaster|column|ornament|floor|roof|wood/;
const NOT_METAL = { metallicScale: 0 } as const;

export function stoneSurface(material: DrftMaterial | undefined): typeof NOT_METAL | undefined {
  return DIELECTRIC.test(material?.name ?? '') ? NOT_METAL : undefined;
}

/**
 * **The floor lifted toward the walls, and nothing else touched.** Decoded, the floor tiles average
 * 0.10 against the walls' 0.24: the darkest stone in the courtyard, where every render and photograph
 * of the place shows paving about as pale as the walls it sits between. The tile's vertex colour,
 * which multiplies its map, lifts it half again, to 0.15, without a tint; at 1.8 the sunlit
 * paving went to white at noon. The walls were tinted cream
 * too until 2026-09-26; the warmth belongs to the light, and with it on the stone a warm sun made the
 * whole frame one sepia.
 */
const FLOOR = /^floor_/;
const FLOOR_LIFT = 1.5;

export function paleFloor(mesh: MeshData, material: DrftMaterial | undefined): MeshData {
  if (!FLOOR.test(material?.name ?? '')) return mesh;
  const colors = new Float32Array(mesh.colors.length);
  for (let i = 0; i < colors.length; i++) colors[i] = (mesh.colors[i] as number) * FLOOR_LIFT;
  return { ...mesh, colors };
}
