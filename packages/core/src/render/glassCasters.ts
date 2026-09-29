/**
 * The glass a shadow pass was offered, kept aside to be drawn twice once the opaque casters are in:
 * where the nearest pane is, and what the panes let through. See `glassShadow.ts`.
 *
 * **Recorded rather than drawn at once**, because the two glass passes each need the whole set and
 * a pass of their own, and the caster enumeration is the consumer's to run exactly once per pass.
 * A pool of entries grown on demand and never shrunk, so a steady scene records into the entries
 * the frame before it made — no allocation per frame, the house rule for a per-pass path.
 *
 * What it keeps by reference is only what outlives the pass that recorded it: the mesh, the batch
 * and its instance data, a skinned caster's palette, and the material. The model matrix is copied,
 * because a caller is entitled to reuse one scratch matrix between sink calls.
 */
import type { ReadonlyMat4 } from 'gl-matrix';
import type { ResolvedGlass } from './glass.ts';
import type { InstancedHandle, MeshHandle } from './backend/api.ts';
import type { MeshInstances } from './instances.ts';
import type { SceneCasterMaterial } from './shadowCasters.ts';

const MESH = 0;
const INSTANCED = 1;
const SKINNED = 2;

interface GlassEntry {
  kind: number;
  mesh: MeshHandle | null;
  batch: InstancedHandle | null;
  data: MeshInstances | null;
  palette: Float32Array | null;
  readonly model: Float32Array;
  material: SceneCasterMaterial | undefined;
  readonly glass: ResolvedGlass;
}

/** Where a replay goes: each entry with its own glass, as the depth and tint passes want it. */
export interface GlassReplaySink {
  mesh(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): void;
  instanced(
    batch: InstancedHandle,
    data: MeshInstances,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): void;
  skinnedMesh(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    palette: Float32Array,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): void;
}

export class GlassCasterList {
  private readonly pool: GlassEntry[] = [];
  private used = 0;

  /** How many glass casters this pass has recorded. */
  get count(): number {
    return this.used;
  }

  /** How many entries the pool holds, recorded or not: what a steady scene stops growing. */
  get pooled(): number {
    return this.pool.length;
  }

  recordMesh(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): void {
    const entry = this.take(MESH, material, glass);
    entry.mesh = mesh;
    entry.model.set(model as ArrayLike<number>);
  }

  recordInstanced(
    batch: InstancedHandle,
    data: MeshInstances,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): void {
    const entry = this.take(INSTANCED, material, glass);
    entry.batch = batch;
    entry.data = data;
  }

  recordSkinned(
    mesh: MeshHandle,
    model: ReadonlyMat4,
    palette: Float32Array,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): void {
    const entry = this.take(SKINNED, material, glass);
    entry.mesh = mesh;
    entry.palette = palette;
    entry.model.set(model as ArrayLike<number>);
  }

  /** Every recorded caster, in the order it was offered. */
  replay(sink: GlassReplaySink): void {
    for (let i = 0; i < this.used; i++) {
      const entry = this.pool[i] as GlassEntry;
      if (entry.kind === INSTANCED && entry.batch !== null && entry.data !== null) {
        sink.instanced(entry.batch, entry.data, entry.material, entry.glass);
      } else if (entry.kind === SKINNED && entry.mesh !== null && entry.palette !== null) {
        sink.skinnedMesh(entry.mesh, entry.model, entry.palette, entry.material, entry.glass);
      } else if (entry.mesh !== null) {
        sink.mesh(entry.mesh, entry.model, entry.material, entry.glass);
      }
    }
  }

  /** Forget this pass's casters; the entries stay for the next one. */
  clear(): void {
    for (let i = 0; i < this.used; i++) {
      const entry = this.pool[i] as GlassEntry;
      /* Released so a disposed mesh is not held alive by a list nobody will replay again. */
      entry.mesh = null;
      entry.batch = null;
      entry.data = null;
      entry.palette = null;
      entry.material = undefined;
    }
    this.used = 0;
  }

  private take(
    kind: number,
    material: SceneCasterMaterial | undefined,
    glass: ResolvedGlass,
  ): GlassEntry {
    let entry = this.pool[this.used];
    if (entry === undefined) {
      entry = {
        kind,
        mesh: null,
        batch: null,
        data: null,
        palette: null,
        model: new Float32Array(16),
        material,
        glass: { transmission: 0, frost: 0, tint: [1, 1, 1] },
      };
      this.pool.push(entry);
    }
    this.used++;
    entry.kind = kind;
    entry.material = material;
    entry.glass.transmission = glass.transmission;
    entry.glass.frost = glass.frost;
    entry.glass.tint[0] = glass.tint[0];
    entry.glass.tint[1] = glass.tint[1];
    entry.glass.tint[2] = glass.tint[2];
    return entry;
  }
}
