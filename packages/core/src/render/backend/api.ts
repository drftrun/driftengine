import type { Bounds } from '../../math/bounds.ts';
import type { Vec3 } from '../../math/color.ts';
import type { ReadonlyMat4 } from 'gl-matrix';
import type { MeshData } from '../mesh.ts';
import type { ProbeBakeOptions } from '../reflectionProbe.ts';
import type { Renderer, TranslucentMeshOptions } from './webgl2/renderer.ts';
import type { MeshInstances } from '../instances.ts';
import type { SurfaceMaterial } from '../surfaceTexture.ts';
import type { TextStyle } from '../textLayout.ts';
import type { SdfFont } from '../sdfFont.ts';
import type { SdfTextStyle } from '../sdfTextLayout.ts';
import type { FrameTimer } from './timer.ts';

/**
 * Geometry on the device, as something a consumer holds and hands back.
 *
 * **Opaque on purpose, and the opacity is forced rather than chosen.** `Mesh` has private
 * fields, which makes it *nominal* in TypeScript: no other type can ever satisfy it, however
 * identical its shape, so a WebGPU mesh cannot be a `Mesh` and the shared surface cannot
 * name one. That is not a flaw in `Mesh` — the privacy is what keeps `WebGLBuffer`s out of
 * reach — it just means the surface has to describe the handle rather than the object.
 *
 * A consumer receives one from `createMesh` and passes it to `drawMesh`. There is nothing to
 * read on it, which is the point: the backend that made it is the only thing that can.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface MeshHandle {
  /*
   * Otherwise empty. A *brand* property would make this a weak type, and TypeScript then rejects
   * every assignment that shares no property with it — including a real `Mesh`, which is
   * precisely what this has to accept.
   *
   * `bounds` is not a brand: both backends' meshes genuinely carry one, measured at upload, so
   * naming it here costs nothing and is what lets a consumer cull or pick a level of detail
   * without reaching past this surface for a backend-specific type.
   */
  readonly bounds: Bounds;
  /**
   * Whether all of this mesh's geometry has reached the device.
   *
   * True for every mesh `createMesh` returns; false between the steps of one from
   * `createMeshIncremental`, until its last. **Nothing incomplete is drawn** — see that method
   * for why, and for what a `done` upload with this still false means.
   *
   * Named here for the reason `bounds` is: both backends' meshes genuinely carry it, so a
   * consumer can ask without reaching past this surface for a backend-specific type.
   */
  readonly complete: boolean;
}

/** A mesh on its way to the device, and the iterator that gets it there. */
export interface IncrementalMeshHandle {
  /**
   * Usable at once — it can be held, measured against `bounds`, and disposed — but not drawn
   * until the upload finishes.
   */
  readonly mesh: MeshHandle;
  /**
   * Advance the upload by one bounded step. Done when it returns `done`.
   *
   * The call that returns `done` is the one that does the last step's work rather than an empty
   * call after it, so a mesh takes exactly as many calls as it has chunks and a caller counting
   * stops against a frame budget counts the right number.
   */
  readonly upload: Iterator<void, void>;
}

/**
 * An instanced batch on the device, held by a consumer and handed back.
 *
 * **The second nominal type this surface hit, and for the same reason as `MeshHandle`.**
 * `InstancedMesh` holds `WebGLBuffer`s in private fields, which makes it nominal: no WebGPU
 * object can ever satisfy it however identical its shape. The privacy is right — it is what
 * keeps a VAO out of a consumer's reach — so the surface describes the handle instead.
 *
 * A consumer gets one from `createScatter` and passes it to `drawScatter` and
 * `uploadScatter`. Passing one backend's handle to the other is a caller error.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface ScatterHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * A mesh made drawable many times over, held by a consumer and handed back.
 *
 * Opaque for the reason `ScatterHandle` is, and distinct from it because what it batches is
 * different: a scatter owns its own base geometry, and this one is *attached to a mesh the
 * consumer already uploaded*. A car body is tens of megabytes and a second copy of it to draw it
 * thirty times would defeat the point.
 *
 * A consumer gets one from `createInstanced` and passes it to `uploadInstanced`,
 * `drawInstanced` and `drawTranslucentInstanced`.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface InstancedHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * A body of water on the device: its meshes and the numbers its grid settled.
 *
 * Opaque for the reason `MeshHandle` and `ScatterHandle` are — `WaterRenderer` holds
 * `WebGLBuffer`s privately and is therefore nominal. The third of these, and the last one the
 * derivation could not carry without help.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface WaterHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * A plume batch on the device. Opaque for the reason `MeshHandle` explains.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface PlumeHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/** A particle pool on the device. Opaque for the reason `MeshHandle` explains. */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface ParticleHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * A wind-streak lattice on the device. Opaque for the reason `MeshHandle` explains.
 *
 * **`strengthFor` does not survive the widening, and that is deliberate.** It is on
 * `WindStreakRenderer` so a caller can size its own budget against the same ramp the draw uses;
 * naming it here would oblige every backend to carry a method rather than a lattice. The ramp
 * itself is `windStreakStrength` in `windStreakDraw.ts`, which a consumer can call with the
 * thresholds it chose and which is the one both backends draw with.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface WindStreakHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/** A flock on the device. Opaque for the reason `MeshHandle` explains. */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface FlockHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/** A water-lit surface on the device. Opaque for the reason `MeshHandle` explains. */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface CausticsHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/** A batch of electrical arcs on the device. Opaque for the reason `MeshHandle` explains. */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface BoltHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/** A batch of polyline segments on the device. Opaque for the reason `MeshHandle` explains. */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface LineHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * One text object: a string laid out as instanced glyph cubes. Opaque for the reason
 * `MeshHandle` explains, and opaque *at all* for a reason the others did not have — it used to
 * be a class holding a `WebGL2RenderingContext`, which pinned every caller of it to WebGL2.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface TextHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * One SDF text label: a string laid out as flat, textured quads from a distance-field font.
 * Opaque for the reason `MeshHandle` explains, and for `TextHandle`'s own reason too — the
 * concrete class on each backend holds a `WebGL2RenderingContext` or a `GPUDevice`'s buffers
 * privately, so no shared type could name one without this.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface SdfTextHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * A caller's image on the device. Opaque for the reason `MeshHandle` explains.
 *
 * The boundary it guards is the interesting one: the engine ships no image assets and fetches
 * nothing, so what goes in is a `TexImageSource` the consumer already has and what comes back
 * is a GPU object with sane sampler state. Where the pixels came from stays theirs.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque by design */
export interface SurfaceTextureHandle {
  /* Deliberately empty, for the weak-type reason `MeshHandle` explains. */
}

/**
 * The public surface of the renderer, as a type a second backend can be checked against.
 *
 * **Derived rather than written.** `keyof` over a class yields its public members only — every
 * `private` field, and this class has ninety-four of them holding `WebGLProgram`s and
 * `WebGLUniformLocation`s, is excluded automatically. So this is exactly what a consumer can
 * reach and nothing else, without a list anybody has to maintain.
 *
 * The point is that it cannot drift. Add a method to `Renderer` and `WebGPURenderer` stops
 * compiling until it has one too, which is the compile-time form of the failure the
 * 2026-08-02 design spec named as the real risk: a fallback that rots because only the
 * developer's own backend is ever exercised. **That mechanism is free and it is the whole
 * reason this file exists.**
 *
 * Eighty members: up from seventy-five with the five instanced-draw methods, which are widened
 * for the reason the scatter ones are — a batch handle is nominal on WebGL2, holding a
 * `WebGLBuffer` in a private field, so no WebGPU object can satisfy it however identical its
 * shape. It is not meant to be read; it is meant to be enforced.
 */
/** What a mesh needs to be told at creation that its geometry cannot say. */
export interface MeshOptions {
  /**
   * Whether this mesh's positions will be rewritten with `updateMesh`.
   *
   * Costs a `DYNAMIC_DRAW` hint on WebGL2 and a CPU-side copy of the interleaved vertex data on
   * WebGPU, which interleaves every attribute into one buffer and so cannot patch a position
   * without the rest of the vertex in hand. Both are paid only where a consumer asks.
   */
  readonly dynamic?: boolean;
}

export type RendererApi = Omit<
  { [K in keyof Renderer]: Renderer[K] },
  | 'gpuTimer'
  | 'createMesh'
  | 'createMeshIncremental'
  | 'updateMesh'
  | 'drawMesh'
  | 'disposeMesh'
  | 'drawTranslucentMesh'
  | 'drawLightVolume'
  | 'drawFilm'
  | 'createScatter'
  | 'drawScatter'
  | 'uploadScatter'
  | 'disposeScatter'
  | 'createInstanced'
  | 'uploadInstanced'
  | 'drawInstanced'
  | 'drawTranslucentInstanced'
  | 'disposeInstanced'
  | 'createWater'
  | 'drawWater'
  | 'disposeWater'
  | 'createPlumes'
  | 'drawPlumes'
  | 'disposePlumes'
  | 'setPlumeScale'
  | 'createCaustics'
  | 'drawCaustics'
  | 'disposeCaustics'
  | 'createParticles'
  | 'drawParticles'
  | 'disposeParticles'
  | 'createWindStreaks'
  | 'drawWindStreaks'
  | 'disposeWindStreaks'
  | 'createFlock'
  | 'drawFlock'
  | 'disposeFlock'
  | 'createBolts'
  | 'drawBolts'
  | 'disposeBolts'
  | 'createLines'
  | 'drawLines'
  | 'disposeLines'
  | 'createText'
  | 'setText'
  | 'setPlate'
  | 'drawText'
  | 'textWidth'
  | 'disposeText'
  | 'createSdfText'
  | 'setSdfText'
  | 'drawSdfText'
  | 'disposeSdfText'
  | 'createSurfaceTexture'
  | 'updateSurfaceTexture'
  | 'disposeSurfaceTexture'
  | 'setSurfaceTexture'
  | 'setMaterial'
> & {
  /** Upload a caller's image. See `SurfaceTextureHandle` for the boundary this guards. */
  createSurfaceTexture(
    source: TexImageSource,
    options?: Parameters<Renderer['createSurfaceTexture']>[1],
  ): SurfaceTextureHandle;

  /**
   * Replace a texture's pixels, keeping the GPU object and its sampler state.
   *
   * The binding a draw loop already holds stays valid, so the swap is a swap rather than a
   * rebuild. Not a hot path: it re-uploads the whole image and rebuilds the mip chain.
   */
  updateSurfaceTexture(texture: SurfaceTextureHandle, source: TexImageSource): void;

  disposeSurfaceTexture(texture: SurfaceTextureHandle): void;

  /**
   * Choose the texture the following `drawMesh` calls sample, or null for none.
   *
   * Pass state, because a texture belongs to a material and a material covers many draws.
   * `bindMeshPass` resets it, so a pass cannot inherit a material from the one before it.
   */
  setSurfaceTexture(
    texture: SurfaceTextureHandle | null,
    uScale?: number,
    vScale?: number,
    cutout?: number,
  ): void;

  /**
   * Everything the following `drawMesh` calls sample, in one call. Null for none.
   *
   * Pass state, exactly as `setSurfaceTexture` is, and `bindMeshPass` resets it for the same
   * reason. This is the shape the maps of Phase 1.3 arrive through — a field each rather than a
   * setter each — and `setSurfaceTexture` is now a wrapper over it.
   */
  setMaterial(material: SurfaceMaterial<SurfaceTextureHandle> | null): void;

  /**
   * A 3D text object: one string, drawn as instanced glyph cubes over the scene.
   *
   * Create one per message slot and reuse it — `setText` is a no-op when the string has not
   * changed, and that skip is the difference between a free overlay and a per-frame upload.
   */
  createText(): TextHandle;

  /** Lay a string out. A no-op when it is the string already laid out. */
  setText(text: TextHandle, content: string): void;

  /**
   * A solid rectangle of cells, for a keycap or a backing plate — not a run of block glyphs,
   * which comes out striped and sized in whole glyph widths. See `TextLayout.setPlate`.
   */
  setPlate(text: TextHandle, widthCells: number, heightCells: number, bottomCell: number): void;

  /**
   * Draw a laid-out string over the scene.
   *
   * The viewport is the caller's rather than the drawing buffer's, because an overlay is
   * positioned in whatever box the caller is laying out in and that is not always the canvas.
   * `originY` is a baseline, measured from the top.
   */
  drawText(
    text: TextHandle,
    viewportWidth: number,
    viewportHeight: number,
    originX: number,
    originY: number,
    style: TextStyle,
    timeSec: number,
  ): void;

  /** Width of the string this handle currently holds. See `textWidthPx` for the static form. */
  textWidth(text: TextHandle, cellSize: number): number;

  /** Release a text object. Takes no context; see `Renderer.disposeScatter`. */
  disposeText(text: TextHandle): void;

  /**
   * A text label from an SDF font. Opt-in: a consumer that never calls this pays nothing,
   * which is what keeps `pixelFont.ts`'s no-asset promise true for everybody else.
   */
  createSdfText(): SdfTextHandle;

  /**
   * Lay a string out against a font, and retain the atlas `drawSdfText` will sample.
   *
   * The engine fetches nothing: `font` was parsed from a metrics document the caller already
   * had, and `atlas` is a texture the caller already uploaded through `createSurfaceTexture`.
   * A no-op, and no re-upload, when neither the text nor the style moved since the last call.
   */
  setSdfText(
    text: SdfTextHandle,
    font: SdfFont,
    atlas: SurfaceTextureHandle,
    content: string,
    style: SdfTextStyle,
  ): void;

  /**
   * Draw a laid-out SDF string into the scene, at `model`, against the frame's own
   * view-projection — the same one `drawMesh` uses. See `Renderer.drawSdfText`.
   */
  drawSdfText(text: SdfTextHandle, model: Float32Array, color: Vec3, opacity: number): void;

  /** Release an SDF text label. Takes no context; see `Renderer.disposeScatter`. */
  disposeSdfText(text: SdfTextHandle): void;

  /** Build a lattice of wind-borne debris. See `WindStreakHandle` for why it is opaque. */
  createWindStreaks(options?: Parameters<Renderer['createWindStreaks']>[0]): WindStreakHandle;

  /** Draw the wind, after the opaque scene. The engine decides whether the camera is under. */
  drawWindStreaks(
    streaks: WindStreakHandle,
    camera: Parameters<Renderer['drawWindStreaks']>[1],
    wind: Parameters<Renderer['drawWindStreaks']>[2],
    timeSeconds: number,
    tint: Vec3,
    env: Parameters<Renderer['drawWindStreaks']>[5],
  ): void;

  /** Release a lattice. Takes no context; see `Renderer.disposeScatter`. */
  disposeWindStreaks(streaks: WindStreakHandle): void;

  /** Scale one plume in a batch, 0 to hide it — a fire that is not always burning. */
  setPlumeScale(plumes: PlumeHandle, index: number, scale: number): void;

  /**
   * A surface lit by nearby water. Null where the profile has water off or there are no sheets,
   * so a scene's own `drawCaustics(null, …)` guard reads the same on either backend.
   */
  createCaustics(sheets: Parameters<Renderer['createCaustics']>[0]): CausticsHandle | null;

  /** Add the water's light to an already-shaded scene. Draw after the opaque pass. */
  drawCaustics(
    caustics: CausticsHandle | null,
    camera: Parameters<Renderer['drawCaustics']>[1],
    timeSeconds: number,
    env: Parameters<Renderer['drawCaustics']>[3],
    windX?: number,
    windZ?: number,
    strength?: number,
  ): void;

  disposeCaustics(caustics: CausticsHandle | null): void;

  /** Build a flock of `count` birds. See `FlockHandle` for why it is opaque. */
  createFlock(count: number): FlockHandle;

  /** Draw a flock. Every bird's path comes from its index and the clock. */
  drawFlock(
    flock: FlockHandle,
    camera: Parameters<Renderer['drawFlock']>[1],
    timeSeconds: number,
    params: Parameters<Renderer['drawFlock']>[3],
    tint: Vec3,
    windX?: number,
    windZ?: number,
  ): void;

  /** Release a flock. Takes no context; see `Renderer.disposeScatter`. */
  disposeFlock(flock: FlockHandle): void;

  /** Build a batch for electrical arcs. `capacity` is in segments, not arcs. */
  createBolts(segmentCapacity: number, label?: string): BoltHandle;

  /** Draw a pool of arcs, after the opaque scene. */
  drawBolts(
    batch: BoltHandle,
    data: Parameters<Renderer['drawBolts']>[1],
    camera: Parameters<Renderer['drawBolts']>[2],
    env: Parameters<Renderer['drawBolts']>[3],
    timeSeconds: number,
    core: Vec3,
    edge: Vec3,
    widthM: number,
    coreGain: number,
    minWidthPerMetre?: number,
  ): void;

  /** Release a batch of arcs. Takes no context; see `Renderer.disposeScatter`. */
  disposeBolts(batch: BoltHandle): void;

  /**
   * Build a batch for a polyline. `capacity` is in segments, not points.
   *
   * There is no portable wide line: WebGL2 clamps `lineWidth` to one pixel on nearly every
   * driver and WebGPU has no line width at all, so a stroke is a triangle everywhere or it
   * is nowhere. See `Renderer.createLines`.
   *
   * **One handle, one polyline's geometry, for the frame it is drawn in.** Drawing a handle
   * more than once a frame with unchanged content is fine; drawing it more than once with
   * *different* content in the same frame is not — see `Renderer.createLines` for the reason,
   * which is backend-specific: WebGPU reads the last write only, WebGL2 reads whichever content
   * was current at each call. A consumer that wants several polylines whose geometry differs
   * within one frame needs several handles.
   */
  createLines(segmentCapacity: number, label?: string): LineHandle;

  /**
   * Draw a polyline, after the opaque scene.
   *
   * `widthM` is the stroke's own half-width and `minWidthPerMetre` the floor that keeps a
   * distant line above a pixel. `softness` widens the antialiased edge inward, as a fraction
   * of the half-width; zero is a clean edge. See `Renderer.drawLines`.
   */
  drawLines(
    lines: LineHandle,
    data: Parameters<Renderer['drawLines']>[1],
    model: Parameters<Renderer['drawLines']>[2],
    camera: Parameters<Renderer['drawLines']>[3],
    env: Parameters<Renderer['drawLines']>[4],
    color: Vec3,
    widthM: number,
    opacity: number,
    softness?: number,
    minWidthPerMetre?: number,
    additive?: boolean,
  ): void;

  /** Release a batch of line segments. Takes no context; see `Renderer.disposeScatter`. */
  disposeLines(lines: LineHandle): void;

  /** Base geometry plus placement in, handle out. See `ScatterHandle` for why it is opaque. */
  createScatter(base: MeshData, data: Parameters<Renderer['createScatter']>[1]): ScatterHandle;

  /** Draw every live instance of a batch this renderer made, in one call. */
  drawScatter(
    scatter: ScatterHandle,
    data: Parameters<Renderer['drawScatter']>[1],
    camera: Parameters<Renderer['drawScatter']>[2],
    env: Parameters<Renderer['drawScatter']>[3],
    windX: number,
    windZ: number,
    windGust: number,
    timeSeconds: number,
    trample?: Float32Array | null,
  ): void;

  /** Push changed instances. Only for batches that move; foliage is uploaded once. */
  uploadScatter(scatter: ScatterHandle, data: Parameters<Renderer['uploadScatter']>[1]): void;

  /** Release a batch this renderer made. Takes no context; see `Renderer.disposeScatter`. */
  disposeScatter(scatter: ScatterHandle): void;

  /**
   * Make a mesh drawable many times over, at up to `capacity` placements.
   *
   * **Takes a mesh already on the device**, unlike `createScatter`, which uploads its own base.
   * The geometry an instanced draw repeats is usually the expensive kind — a loaded model rather
   * than a blade of grass — and a second copy of it is the cost this exists to avoid.
   *
   * **One batch per mesh.** WebGL2 attaches the per-instance attributes to that mesh's own vertex
   * array, of which a mesh has one, so a second batch would rebind the attributes the first draws
   * through and place one batch's instances by the other's matrices. Refused, loudly.
   *
   * **What it gives up** is skinning and morphing on the instanced mesh: the joint attributes
   * want the two locations the matrix does, and a morph weight is per draw, so every instance
   * would wear one expression. Both are refused where the variant is built rather than dropped
   * quietly.
   */
  createInstanced(mesh: MeshHandle, capacity: number): InstancedHandle;

  /**
   * Push placement and colour to the device. Only `data.count` instances are written.
   *
   * Called per frame for a batch that moves, exactly as `uploadScatter` is for one that does.
   * Allocates nothing: the staging array belongs to the batch.
   */
  uploadInstanced(batch: InstancedHandle, data: MeshInstances): void;

  /**
   * Draw every live instance of a batch, in one call and one material.
   *
   * The material is whatever `setMaterial` and the surface setters last established, exactly as
   * for `drawMesh` — which is the point: a batch spends **one** slot of the frame's material ring
   * where the same meshes drawn individually spend one each.
   */
  drawInstanced(batch: InstancedHandle, data: MeshInstances): void;

  /**
   * The blended twin, for an instanced mesh whose material is not opaque.
   *
   * Takes the same options as `drawTranslucentMesh` and for the same reasons — a set of blended
   * surfaces that all write depth rejects itself, so a model whose interior is glass wants
   * `depthWrite: false` here as much as it does there.
   */
  drawTranslucentInstanced(
    batch: InstancedHandle,
    data: MeshInstances,
    opacity: number,
    options?: TranslucentMeshOptions,
  ): void;

  /** Release a batch. The mesh it was attached to is the caller's and is not released. */
  disposeInstanced(batch: InstancedHandle): void;

  /** Build a body of water. See `WaterHandle` for why it is opaque. */
  createWater(resolution?: number, nearExtent?: number, farHalfExtent?: number): WaterHandle;

  /** Draw a body of water this renderer made, after the opaque scene. */
  drawWater(
    water: WaterHandle,
    camera: Parameters<Renderer['drawWater']>[1],
    timeSeconds: number,
    settings: Parameters<Renderer['drawWater']>[3],
    env: Parameters<Renderer['drawWater']>[4],
    windX?: number,
    windZ?: number,
  ): void;

  /** Release a body of water. Takes no context; see `Renderer.disposeScatter`. */
  disposeWater(water: WaterHandle): void;

  /** Build a plume batch from placements and a named material. */
  createPlumes(
    plumes: Parameters<Renderer['createPlumes']>[0],
    options: Parameters<Renderer['createPlumes']>[1],
  ): PlumeHandle;

  /** Draw a plume batch, after the opaque scene. */
  drawPlumes(
    plumes: PlumeHandle,
    camera: Parameters<Renderer['drawPlumes']>[1],
    timeSeconds: number,
    env: Parameters<Renderer['drawPlumes']>[3],
    windX?: number,
    windZ?: number,
    originX?: number,
    originY?: number,
    originZ?: number,
  ): void;

  /** Release a plume batch. */
  disposePlumes(plumes: PlumeHandle): void;

  /**
   * Build a particle pool from a capacity and a named material.
   *
   * **`reuse` is re-typed here, and it has to be.** `ParticleBatchOptions.reuse` names the
   * concrete `ParticleBatch`, so the surface handed back a `ParticleHandle` from this very
   * method and then refused to accept it — a consumer that had done everything else right
   * could not share a program without holding the WebGL2 class it had just been moved off.
   * That is the same defect as the one that pinned callers to `Renderer` itself, arrived at
   * from the input side.
   *
   * **WebGPU ignores it, and that is correct rather than a gap.** Its pipelines are cached on
   * `particle:${material}:${blend}` — exactly what decides the program — so pools that would
   * have shared one already do. WebGL2 still needs telling, and still checks that the two
   * materials match.
   */
  createParticles(
    capacity: number,
    options: Omit<Parameters<Renderer['createParticles']>[1], 'reuse'> & {
      readonly reuse?: ParticleHandle;
    },
  ): ParticleHandle;

  /** Draw a pool's live particles, after the opaque scene. */
  drawParticles(
    batch: ParticleHandle,
    data: Parameters<Renderer['drawParticles']>[1],
    camera: Parameters<Renderer['drawParticles']>[2],
    env: Parameters<Renderer['drawParticles']>[3],
    timeSeconds: number,
  ): void;

  /** Release a particle pool. */
  disposeParticles(batch: ParticleHandle): void;

  /** Draw a wet film over geometry, using a handle as the surface it lies on. */
  drawFilm(
    mesh: MeshHandle,
    camera: Parameters<Renderer['drawFilm']>[1],
    timeSeconds: number,
    env: Parameters<Renderer['drawFilm']>[3],
    sheen: number,
    options?: Parameters<Renderer['drawFilm']>[5],
  ): void;

  /**
   * Light the scene from an environment it did not photograph.
   *
   * Takes the equirectangular image rather than six faces, so the renderer converts at its own
   * probe size and a caller cannot hand it faces of the wrong dimension. Downstream of the cube
   * this is exactly a bake: the same prefilter, the same spherical-harmonic projection.
   *
   * Answers `false` and says why when the profile has no probe — `reflectionProbeSize` defaults to
   * zero, so a consumer that never asked for one gets a refusal in words rather than an
   * environment that silently did nothing.
   */
  setEnvironmentImage(
    image: {
      readonly width: number;
      readonly height: number;
      readonly data: Float32Array;
    },
    options?: ProbeBakeOptions,
  ): boolean;

  /** Draw a volume of light along the view ray, using a handle as its bounding geometry. */
  drawLightVolume(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    camera: Parameters<Renderer['drawLightVolume']>[2],
    strength: number,
    reachM: number,
    spread: number,
    options?: Parameters<Renderer['drawLightVolume']>[6],
  ): void;

  /**
   * Geometry in, handle out. Widened for the reason `MeshHandle` explains: `Mesh` is nominal.
   *
   * The second member the derivation could not carry, and found the same way as the first —
   * by a second backend failing to compile against it rather than by anybody noticing.
   */
  createMesh(data: MeshData, options?: MeshOptions): MeshHandle;

  /**
   * Geometry in, handle out — but the geometry lands over as many frames as the caller gives it.
   *
   * **What this is for.** A game streaming a world in squares held a 4 ms frame budget and
   * honoured it exactly, for the half of the work it owned. The other half was one `createMesh`
   * per material group, about two dozen a square, all of them in whichever frame the build
   * happened to finish in and outside every budget. Attributed in the browser over a drive into
   * a town, every frame over 50 ms was `createMesh` and nothing else, and disposal and
   * bookkeeping never reached 2. Spreading a square across its groups would not have been
   * enough: one group was 248,928 of that square's 367,542 triangles, so the group itself had to
   * become divisible, and `createMesh` is where that is decided.
   *
   * Drive `upload` under a frame budget — `StepBudget` is the pump built for it — and the
   * geometry arrives over as many frames as that allows. A mesh of *n* chunks takes exactly *n*
   * calls, and the call that returns `done` is the one that does the last of the work.
   *
   * **A mesh that has not finished arriving is not drawn.** `complete` says so, and `drawMesh`,
   * `drawTranslucentMesh` and `drawLightVolume` skip it in silence. Drawing what had landed was
   * the alternative and is worse — a mesh whose triangle count grows over several frames is a
   * stranger artefact than a square that is briefly absent, and it is the direction a streaming
   * consumer already treats as safe. So a consumer that never drives the iterator gets a mesh
   * that never appears, not a fan of triangles through the origin.
   *
   * **A lost device or context ends the upload.** The iterator reports `done` and the mesh stays
   * incomplete, which is the pair that distinguishes an abandoned upload from a finished one.
   * There is no way to detect a half-uploaded mesh from the outside, so the engine says what it
   * does rather than leaving a consumer to guess.
   *
   * What is paid up front and not spread: validation, the bounds, the buffer allocations and the
   * pipeline warming. The bounds are the deliberate one — a streamer places and culls a region
   * from them before a byte of it has landed.
   */
  createMeshIncremental(data: MeshData, options?: MeshOptions): IncrementalMeshHandle;

  /**
   * Rewrite a mesh's positions, and its normals where the caller has them.
   *
   * **What this exists for is cloth**, and it is a gap the engine shipped with: `ClothBody` has
   * been in `@driftengine/physics` since 2.9 and nothing could draw its output. A mesh was
   * immutable, so a deforming surface could only be drawn by recreating it every frame — a GPU
   * buffer allocation per frame, which the frame rules forbid — or by splitting it into rigid
   * quads with a matrix each, which caps the resolution at the number of draw calls a consumer
   * can afford. A consumer found it by trying to hang a banner.
   *
   * **Only positions and normals.** Colour, emissive and the rest describe what a surface *is*
   * and do not change because it bent; rewriting them every frame would be uploading unchanged
   * bytes. The vertex *count* is fixed: the index buffer, the pipeline and every other attribute
   * are sized against it, and an update of a different size is refused naming both.
   *
   * The mesh must have been created with `{ dynamic: true }`. That is not ceremony — it decides
   * the buffer hint on one backend and what has to be kept on the other, and a mesh that never
   * deforms should pay for neither.
   */
  updateMesh(mesh: MeshHandle, positions: Float32Array, normals?: Float32Array): void;

  /** Draw a handle this renderer made. Passing one from the other backend is a caller error. */
  drawMesh(mesh: MeshHandle, model: ReadonlyMat4, depthLayer?: number, tint?: Vec3 | null): void;

  /** Release the geometry behind a handle. */
  disposeMesh(mesh: MeshHandle): void;

  /**
   * Draw a handle with blending, back to front against what is already there.
   *
   * Lit and fogged by default; `options` can turn either off, independently — see
   * `TranslucentMeshOptions` and `Renderer.drawTranslucentMesh` for what each means and why
   * a caller might want one without the other. Both backends read the same defaults, so a
   * call with no fourth argument draws exactly as it did before this existed.
   *
   * `depthWrite` and `depthLayer` are the two that decide how a *set* of blended surfaces
   * resolves against itself: whether this draw claims the depth buffer, and which of two
   * coplanar surfaces wins where they coincide. Per-draw state on WebGL2 and pipeline state on
   * WebGPU, and the same depth either way — `depthOffsetForLayer` is the one decision both read.
   */
  drawTranslucentMesh(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    opacity: number,
    options?: TranslucentMeshOptions,
  ): void;

  /**
   * Widened, because this is the one member that cannot cross as it stands.
   *
   * `GpuTimer` is a `WebGLQuery` pool. Left derived, it would oblige a WebGPU renderer to
   * produce one, which it cannot do and should not fake. Every other member of this surface
   * is already backend-neutral; the audit that established that is worth repeating before
   * anything else is overridden here, because each override is a place the two backends are
   * allowed to differ and therefore a place the compiler stops helping.
   */
  readonly gpuTimer: FrameTimer;
};

/** Which backend is actually drawing. Reported, never inferred. */
export type RenderBackend = 'webgl2' | 'webgpu';
