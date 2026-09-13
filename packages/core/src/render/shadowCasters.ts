import type { ReadonlyMat4 } from 'gl-matrix';
import type { InstanceData } from './instancedMesh.ts';
import type { InstancedHandle, MeshHandle, ScatterHandle } from './backend/api.ts';
import type { MeshInstances } from './instances.ts';
import type { SurfaceMaterial } from './surfaceTexture.ts';
import type { SurfaceTextureHandle } from './backend/api.ts';

/**
 * What a shadow-caster enumeration may hand to a depth pass.
 *
 * **Occluding light and stopping a body are two independent properties of a piece
 * of geometry, and this interface exists to keep them apart.** The set that
 * collides is a physics question; the set that casts is an optics one. They overlap
 * heavily — most solid things do both — but neither contains the other, and a
 * renderer that derives one from the other gets a whole class of geometry wrong in
 * one stroke.
 *
 * The failure this was written for: a tree's canopy is deliberately not a collider
 * (nothing should be halted mid-run by leaves) and is therefore not merged into the
 * static world mesh either, because it bends in the wind and merged geometry cannot.
 * The only thing a depth pass could accept was a rigid `Mesh`, so the canopy had no
 * way in — and a crown that occludes nothing reads as sunlight passing straight
 * through several metres of solid foliage. Nothing was switched off; there was
 * simply no route for that kind of geometry to travel.
 *
 * So a sink takes both kinds. A caller enumerates what casts, once, and the same
 * enumeration serves the directional cascade and every point-light cubemap.
 *
 * **Every draw may also carry its material, which is what lets one enumeration serve a colour
 * pass as well as a depth one.** A depth pass ignores it, correctly: a material cannot change a
 * depth, which is why this interface was right to carry only a handle, a matrix and a palette for
 * as long as depth was the only thing replaying it. What that cost was measured from outside. A
 * consumer wanting the scene from a second viewpoint — a mirror, a probe face — had one option,
 * which was to run its whole draw path again; the first attempt to avoid it replayed this sink
 * into the mirror and got **every car unpainted**, because the list carries no material. So the
 * game re-enters its own draw with a mirrored camera, and pays its heaviest phase twice.
 *
 * Optional, and for the reason `instanced` gives at length: this interface is implemented
 * outwards, so a required parameter added in a minor stops every consumer's sink and every test
 * double compiling. A sink that ignores it behaves exactly as it did.
 */
export type SceneCasterMaterial = SurfaceMaterial<SurfaceTextureHandle> | null;

export interface ShadowCasterSink {
  /** A rigid mesh at a model transform: the world, a prop, a static piece of scenery. */
  mesh(mesh: MeshHandle, model: ReadonlyMat4, material?: SceneCasterMaterial): void;
  /**
   * A skinned mesh, deformed by the same palette the visible draw uses.
   *
   * **The palette is not optional in spirit**, for the reason `scatter` below states about the
   * wind: handing the depth pass a different deformation from the colour pass is how a shadow
   * comes loose from its caster. A skinned character submitted through `mesh` does not drift
   * slightly — it casts its **bind pose**, so a running figure throws the shadow of a statue.
   *
   * Sixteen floats a joint, column-major, exactly as `Skeleton.palette` produces.
   */
  skinnedMesh(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    palette: Float32Array,
    material?: SceneCasterMaterial,
  ): void;
  /**
   * An instanced batch of rigid meshes, placed by the same matrices the visible draw uses.
   *
   * **Not optional in spirit, for the reason `scatter` gives about the wind**: a batch whose
   * depth pass read a different placement casts shadows that have come loose from the things
   * casting them — and a batch submitted through `mesh` instead casts *one* shadow, from
   * whichever matrix happened to be bound, with the other twenty-nine missing entirely.
   *
   * **Optional in the type, and only because this interface is implemented outwards.** A
   * consumer's own sinks and its test doubles satisfy this type, so a required member added in a
   * minor stops every one of them compiling — which is what happened: 3.29.0 broke three test
   * doubles in a consumer that has no instanced batches at all. The renderer always supplies
   * it, so `sink.instanced?.(batch, data)` never actually skips, and a consumer written before
   * instanced draws existed has nothing to declare through it.
   */
  instanced?(batch: InstancedHandle, data: MeshInstances, material?: SceneCasterMaterial): void;
  /**
   * A scatter batch, deformed exactly as the visible draw deforms it.
   *
   * The wind and press arguments are the same values the matching `drawScatter`
   * receives, and they are not optional in spirit: handing the depth pass a
   * different gust from the colour pass is how a shadow comes loose from its
   * caster. Positional rather than a bundled object, so a per-frame call site
   * allocates nothing.
   */
  scatter(
    scatter: ScatterHandle,
    data: InstanceData,
    windX: number,
    windZ: number,
    windGust: number,
    timeSeconds: number,
    trample?: Float32Array | null,
  ): void;
}

/**
 * A caller-supplied enumeration of everything that casts.
 *
 * Called once per directional layer and once per cubemap face, so it must be
 * allocation-free — close over the meshes and read them, never build a list.
 */
export type ShadowCasters = (sink: ShadowCasterSink) => void;

/**
 * Replay a caster enumeration into the colour pass that is open, materials and all.
 *
 * The counterpart of `drawShadowCasters`, and the reason `ShadowCasterSink` carries a material at
 * all. A consumer enumerates what its frame contains once and hands the same closure to the
 * shadow cascade, to every cubemap face, and to a mirror or a probe face — rather than re-entering
 * its own draw path with a second camera, which is what the alternative costs: a consumer
 * measures the phase it would run twice at 2.3 to 9.4 ms, the largest single row in its frame.
 *
 * **Scatter is declined rather than drawn**, and visibly. A scatter batch's colour draw needs the
 * camera and the environment of the frame it is being drawn into, and this enumeration carries
 * neither — it records what a thing *is*, not what the pass around it looks like. Handing the
 * colour path a stale camera would put the grass of the last pass into this one, which is the
 * silent-plausible-picture failure the two-backends rule exists to forbid. So a replayed pass has
 * no scatter in it, the absence is in the picture rather than in a comment, and a caller wanting
 * grass in a mirror draws it itself with the camera it already has.
 */
export type SceneCasters = ShadowCasters;
