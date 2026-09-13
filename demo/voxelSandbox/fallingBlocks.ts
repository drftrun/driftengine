/**
 * The host side of the falling blocks: the grid, the landing, and the draw.
 *
 * **The first DriftScript module in the port, and the split is the point.** `fallingBlocks.drs`
 * decides how something falls; everything that needs to know what a *block* is stays here — which
 * cell is solid, when a fall has landed, what to write back into the world, and how to draw a
 * cube. A script that read the voxel grid would be a script that had to be handed the whole world.
 *
 * The wiring follows `demo/dev/entities.ts`, which is the repository's own worked example:
 * `loadModule`, `registerEntityModule` into a registry kept across reloads, `bindModule`, and a
 * `World` created once *outside* the reload path so an edit to the script lands on the entities
 * that already exist.
 */
import {
  World as EntityWorld,
  buildSchedule,
  runSchedule,
  type Schedule,
} from '@driftengine/entities';
import { bindModule, registerEntityModule, type ComponentRegistry } from '@driftengine/script';
import { loadModule } from 'driftscript';

import {
  createInstanceData,
  writeInstance,
  type Camera,
  type Environment,
  type InstanceData,
  type RendererApi,
} from '../../packages/core/src/index';

import type { BlockAtlas } from './atlas';
import { Block, blockColor, blockDef } from './blocks';
import type { ChunkRenderer } from './chunkRenderer';
import { WORLD_H } from './constants';
import * as declared from './fallingBlocks.drs';
import type { World } from './world';

/** The script's step. Its constants are per tick, so this rate is part of its contract. */
const STEP_SEC = 1 / 60;
/** A catch-up cap, so a stall cannot avalanche into hundreds of steps in one frame. */
const MAX_STEPS = 4;

/** Budget, kept host-side because it is a cost decision rather than a behaviour. */
const MAX_ACTIVE = 512;

export class FallingBlocks {
  private readonly renderer: RendererApi;
  private readonly world: World;
  private readonly chunks: ChunkRenderer;

  private readonly entities = new EntityWorld();
  private readonly registry: ComponentRegistry = new Map();
  private readonly module: ReturnType<typeof loadModule>;
  private schedule: Schedule;
  private readonly Falling: never;
  private readonly Landed: never;

  private readonly cube: ReturnType<RendererApi['createScatter']>;
  private readonly instances: InstanceData = createInstanceData(MAX_ACTIVE);
  private accum = 0;
  private tick = 0;
  private disposed = false;

  constructor(renderer: RendererApi, world: World, chunks: ChunkRenderer, _atlas: BlockAtlas) {
    this.renderer = renderer;
    this.world = world;
    this.chunks = chunks;

    this.module = loadModule(declared as unknown as Record<string, unknown>);
    const registered = registerEntityModule(this.module, this.registry);
    const bound = bindModule(this.module, { entities: { components: this.registry } });
    if (!bound.bound) throw new Error(`voxel falling blocks: ${bound.reason}`);
    this.schedule = buildSchedule(registered.systems);

    const falling = this.registry.get('Falling');
    const landed = this.registry.get('Landed');
    if (falling === undefined || landed === undefined) {
      throw new Error('voxel falling blocks: the module declared no Falling or Landed');
    }
    this.Falling = falling as never;
    this.Landed = landed as never;

    /* A scatter rather than a mesh per block: the same cube at many places is exactly what it
       is for, and it is one draw however many are in the air. */
    this.cube = renderer.createScatter(unitCube(), this.instances);
  }

  /**
   * A block was broken: whatever sat on top of it may now have nothing to stand on.
   *
   * Only the cell directly above, because a fall is vertical and a diagonal neighbour is still
   * supported by its own column.
   */
  onBreak(x: number, y: number, z: number): void {
    this.considerColumn(x, y + 1, z);
  }

  /** A block was placed: it may itself be unsupported. */
  onPlace(x: number, y: number, z: number): void {
    this.considerColumn(x, y, z);
  }

  update(dtSec: number): void {
    this.accum += dtSec;
    let steps = 0;
    while (this.accum >= STEP_SEC && steps < MAX_STEPS) {
      this.accum -= STEP_SEC;
      steps++;
      runSchedule(this.entities, this.schedule, this.tick);
      this.tick += 1;
      this.land();
    }
  }

  /** One instanced draw for however many blocks are in the air. */
  draw(camera: Camera, env: Environment): void {
    const view = this.entities.view(this.Falling);
    const sparse = view.sparse as Int32Array;
    const xs = view['x'] as Float64Array;
    const ys = view['y'] as Float64Array;
    const zs = view['z'] as Float64Array;
    const blocks = view['block'] as Float64Array;

    let count = 0;
    for (const entity of this.entities.query(this.Falling)) {
      if (count >= MAX_ACTIVE) break;
      const at = sparse[entity % 2 ** 26] as number;
      const tint = blockColor(blocks[at]!);
      writeInstance(
        this.instances,
        count,
        xs[at]! + 0.5,
        ys[at]! + 0.5,
        zs[at]! + 0.5,
        1,
        0,
        tint[0],
        tint[1],
        tint[2],
        /* No wind response: a falling block is not a plant. */
        0,
        0,
        0,
      );
      count++;
    }
    this.instances.count = count;
    if (count === 0) return;
    /* These move every frame, so the batch is re-uploaded; foliage is uploaded once. */
    this.renderer.uploadScatter(this.cube, this.instances);
    this.renderer.drawScatter(this.cube, this.instances, camera, env, 0, 0, 0, 0);
  }

  reset(): void {
    for (const entity of [...this.entities.query(this.Falling)]) this.entities.destroy(entity);
    this.accum = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeScatter(this.cube);
  }

  /** Turn an unsupported falling block into an entity, and take it out of the grid. */
  private considerColumn(x: number, y: number, z: number): void {
    if (y < 1 || y >= WORLD_H) return;
    const id = this.world.getBlock(x, y, z);
    if (blockDef(id)?.falls !== true) return;
    if (this.supported(x, y, z)) return;

    this.world.setBlock(x, y, z, Block.AIR, false);
    this.chunks.remeshEdit(x, z);

    const entity = this.entities.create();
    this.entities.add(entity, this.Falling, { x, y, z, vy: 0, block: id });

    /*
     * **And whatever was resting on this cell, which has just lost what held it up.**
     *
     * Without this the column comes down one block per landing: each block waits for the one
     * beneath it to hit the ground, because `land` is the only other place that looks upward.
     * Reported from a real session as the cube on top not falling — it does fall, several beats
     * later, hanging unsupported in between.
     *
     * Recursing here instead makes the whole column leave the grid in the same step, which is
     * what a stack of sand does. It terminates on the first cell that is not a falling block or
     * is supported, and on the `y >= WORLD_H` guard above.
     */
    this.considerColumn(x, y + 1, z);
  }

  /** Whether the cell below can hold a block up. */
  private supported(x: number, y: number, z: number): boolean {
    return blockDef(this.world.getBlock(x, y - 1, z))?.collidable === true;
  }

  /**
   * Land whatever has reached solid ground, and write it back into the world.
   *
   * The script never sees this: it has no way to ask what a cell holds, which is exactly the
   * boundary the spec asks for.
   */
  private land(): void {
    const view = this.entities.view(this.Falling);
    const sparse = view.sparse as Int32Array;
    const xs = view['x'] as Float64Array;
    const ys = view['y'] as Float64Array;
    const zs = view['z'] as Float64Array;
    const blocks = view['block'] as Float64Array;

    for (const entity of [...this.entities.query(this.Falling)]) {
      const at = sparse[entity % 2 ** 26] as number;
      const x = Math.floor(xs[at]!);
      const z = Math.floor(zs[at]!);
      const y = ys[at]!;
      const below = Math.floor(y);
      if (y > 0 && !this.supported(x, below + 1, z) && below > 0) continue;

      /* Snap to the cell above whatever stopped it, and become terrain again. */
      const restY = Math.max(1, below + 1);
      this.world.setBlock(x, restY, z, blocks[at]! as Block, false);
      this.chunks.remeshEdit(x, z);
      this.entities.destroy(entity);
      /* Whatever was resting on the cell this one left may now fall in turn. */
      this.considerColumn(x, restY + 1, z);
    }
  }
}

/** A unit cube at the origin, tinted per instance. */
function unitCube(): Parameters<RendererApi['createMesh']>[0] {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const faces: readonly (readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ])[] = [
    [0, 1, 0, 1, 0, 0, 0, 0, 1],
    [0, -1, 0, 1, 0, 0, 0, 0, -1],
    [1, 0, 0, 0, 0, 1, 0, 1, 0],
    [-1, 0, 0, 0, 0, -1, 0, 1, 0],
    [0, 0, 1, -1, 0, 0, 0, 1, 0],
    [0, 0, -1, 1, 0, 0, 0, 1, 0],
  ];
  for (const [nx, ny, nz, ux, uy, uz, vx, vy, vz] of faces) {
    const base = positions.length / 3;
    const ox = (nx > 0 ? 1 : 0) + (ux < 0 ? 1 : 0) + (vx < 0 ? 1 : 0) - 0.5;
    const oy = (ny > 0 ? 1 : 0) + (uy < 0 ? 1 : 0) + (vy < 0 ? 1 : 0) - 0.5;
    const oz = (nz > 0 ? 1 : 0) + (uz < 0 ? 1 : 0) + (vz < 0 ? 1 : 0) - 0.5;
    for (let c = 0; c < 4; c++) {
      const cu = c === 1 || c === 2 ? 1 : 0;
      const cv = c === 2 || c === 3 ? 1 : 0;
      positions.push(ox + cu * ux + cv * vx, oy + cu * uy + cv * vy, oz + cu * uz + cv * vz);
      normals.push(nx, ny, nz);
      colors.push(1, 1, 1);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    emissive: new Float32Array(positions.length / 3),
    indices: new Uint32Array(indices),
  };
}
