/**
 * Saying, once a mesh, that a material's maps cannot be read on it.
 *
 * **A mesh with no texture coordinates reads one constant coordinate**, so every map bound to it
 * samples a single texel: an emissive map makes nothing glow, a normal map tilts nothing, and the
 * frame is identical pixel for pixel with and without the material's images. Found when an example's
 * burning logs never glowed — `MeshBuilder` writes no coordinates unless `build({ planarUvs: true })`
 * asks — and nothing said why. One decision for both backends, each calling it from its draw.
 *
 * Once per mesh, held weakly: a mesh drawn every frame is said once, and a disposed one is
 * forgotten. **What it gives up** is a material shared between a textured mesh and an untextured one
 * on purpose, which is said once for the untextured one and is then quiet.
 */
import type { SurfaceMaterial } from './surfaceTexture.ts';

const told = new WeakSet<object>();

/**
 * Whether a material binds a map that is a picture: albedo, normal or emissive.
 *
 * **Not ORM**, because a one-colour ORM map is how a draw sets a constant roughness and metalness,
 * and read at one texel it is exactly that constant — the materials example draws its spheres so.
 * The three counted here are pictures nobody binds to be read at one point.
 */
export function materialHasMaps(material: SurfaceMaterial<unknown> | null): boolean {
  if (material === null) return false;
  return (
    (material.albedo ?? null) !== null ||
    (material.normal ?? null) !== null ||
    (material.emissive ?? null) !== null
  );
}

/** Warn the first time `mesh`, which has no coordinates, is drawn with a picture map bound. */
export function noteMapsWithoutUvs(mesh: object, hasUvs: boolean, materialHasMaps: boolean): void {
  if (hasUvs || !materialHasMaps || told.has(mesh)) return;
  told.add(mesh);
  console.warn(
    '[driftengine] a mesh with no texture coordinates is drawn with an albedo, normal or emissive ' +
      'map, which it cannot read: every map samples one texel. Give the mesh `uvs` — ' +
      '`MeshBuilder.build({ planarUvs: true })` writes them — or draw it without the maps.',
  );
}
