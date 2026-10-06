/**
 * What surfaces reflect: a room captured once, a grid of probes baked a little each frame, light
 * bounced around a space, a photographed sky, captures made in another tool, a draw's own ambient,
 * and a floor that reflects what the frame drew.
 *
 * A snippet, typechecked with the examples and quoted by the manual's reflections chapter.
 */
import { readRadianceHdr } from '@driftengine/assets';
import { ReflectiveSurface } from '@driftengine/core';
import type {
  Camera,
  Environment,
  MeshHandle,
  RenderQualityOptions,
  RendererApi,
  Vec3,
} from '@driftengine/core';

// #region room
/** One probe in the middle of a finished room, baked once the room exists. */
export function captureRoom(
  renderer: RendererApi,
  drawRoom: (camera: Camera) => void,
  clear: Vec3,
): boolean {
  return renderer.bakeReflectionProbe([0, 1.6, 0], clear, drawRoom);
}
// #endregion

// #region grid
/**
 * A grid of probes through a courtyard, baked two faces a frame so no frame pays for a whole
 * probe. The grid is not used until every probe has landed.
 */
export function pacedGrid(
  renderer: RendererApi,
  drawScene: (camera: Camera) => void,
  clear: Vec3,
): () => boolean {
  renderer.setProbeGrid({ origin: [-12, 1.5, -12], spacing: [8, 4, 8], counts: [4, 2, 4] });
  const probes = 4 * 2 * 4;
  let probe = 0;
  let face = 0;
  return function step(): boolean {
    if (probe === probes) return true;
    renderer.bakeProbe(probe, clear, drawScene, { faces: [face, 2] });
    face += 2;
    if (face === 6) {
      face = 0;
      probe += 1;
    }
    return probe === probes;
  };
}
// #endregion

// #region bounce
/**
 * Each bake lit by the last, so light bounces deeper into an enclosed space with every sweep. A
 * scene that holds one moment bakes the grid two or three times.
 */
export function bounceInto(
  renderer: RendererApi,
  drawScene: (camera: Camera) => void,
  clear: Vec3,
): void {
  for (let sweep = 0; sweep < 3; sweep += 1)
    renderer.bakeProbeGrid(clear, drawScene, { bounce: true });
}
// #endregion

// #region sky
/** A photographed sky, from a Radiance `.hdr` file, as the environment everything reflects. */
export async function loadSky(renderer: RendererApi, url: string): Promise<boolean> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return renderer.setEnvironmentImage(readRadianceHdr(bytes));
}
// #endregion

// #region dials
/** A polished floor in a dim hall: reflect fully, and lift what is reflected. */
export function polishedFloor(renderer: RendererApi, env: Environment, camera: Camera): void {
  renderer.bindMeshPass(camera, env);
  renderer.setSurfaceReflectivity(1);
  renderer.setEnvironmentGain(1.6);
}
// #endregion

// #region capture
/**
 * A reflection capture baked in another tool, into one layer of the grid `setProbeGrid` declared:
 * prefiltered as the environment is, the other layers left as they are.
 */
export async function loadCapture(
  renderer: RendererApi,
  layer: number,
  url: string,
): Promise<boolean> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return renderer.setProbeLayerImage(layer, readRadianceHdr(bytes));
}
// #endregion

// #region ambient
/**
 * A character lit by where it stands: nine coefficients of the light around it, red, green and
 * blue of each, sampled from a baked volume every frame and set around its draws alone.
 */
export function drawLitWhereItStands(
  renderer: RendererApi,
  character: MeshHandle,
  placement: Float32Array,
  coefficients: Float32Array,
): void {
  renderer.setAmbientSH(coefficients);
  renderer.drawMesh(character, placement);
  renderer.setAmbientSH(null);
}
// #endregion

// #region screen
/**
 * A polished stone floor that reflects what the frame drew on it, weighed as the stone itself
 * would: four per cent head-on, rising toward the horizon, at the stone's roughness.
 */
export const stoneFloor = new ReflectiveSurface({
  center: [0, 0, 0],
  halfExtents: [12, 12, 0.2],
  forward: [0, -1, 0],
  up: [0, 0, 1],
  strength: 0.04,
  fresnel: true,
  roughness: 0.2,
});

/** Submitted each frame between `beginFrame` and `endFrame`, and traced when the frame ends. */
export function drawFloorReflection(renderer: RendererApi): void {
  renderer.drawReflection(stoneFloor);
}
// #endregion

// #region materials
/**
 * Every opaque lit surface reflecting the frame by its own material: a glossy panel mirrors what
 * stands on it, a satin one shows it softened, and past a roughness of 0.5 a surface keeps the
 * probes' reflection alone. A quality option, so chosen when the renderer is built.
 */
export const reflectiveQuality: RenderQualityOptions = {
  screenEffects: true,
  hdrScene: true,
  screenSpaceReflections: { maxRoughness: 0.5 },
};
// #endregion
