/**
 * Passive mobs: the geometry, the ground under them, and the spawn budget.
 *
 * **Every animal is procedural.** The Kenney pack ships none, and the reference builds its cow,
 * pig, sheep and chicken out of axis-aligned boxes for exactly that reason — a body, a head and
 * legs, in flat colours. This does the same, and each species is baked into one `MeshData` at
 * construction so a mob is one draw.
 *
 * `mobs.drs` decides what a mob *wants*: its mood, how long until it reconsiders, and which way
 * it is facing. Everything that needs to know what a block is stays here — gravity, the ground,
 * whether a step is blocked, and how far away the player is. That is the boundary the spec asks
 * for, and it is what keeps the script readable.
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
  mulberry32,
  type Camera,
  type Environment,
  type MeshData,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';

import { blockDef } from './blocks';
import { WORLD_H } from './constants';
import * as declared from './mobs.drs';
import type { World } from './world';

/* The reference's budget, kept host-side because it is cost rather than behaviour. */
const MAX_MOBS = 10;
const INITIAL_MOBS = 6;
const SPAWN_MIN = 10;
const SPAWN_MAX = 44;
const DESPAWN_DIST = 96;
const SPAWN_INTERVAL_SEC = 1.4;

/** Within this, a mob takes fright. */
const STARTLE_DIST = 7;

const STEP_SEC = 1 / 60;
const MAX_STEPS = 4;
const GRAVITY = 24;
const MAX_FALL = 40;

interface BoxDef {
  min: Vec3;
  max: Vec3;
  color: Vec3;
}

/**
 * Which part of an animal a box belongs to, and therefore how it moves.
 *
 * The joint is the whole of the animation: a leg swings about its hip, a head nods, a wing beats,
 * and a body does none of those. Naming them rather than indexing parts means a species declares
 * what it has — a chicken has two legs and two wings, a cow has four legs and neither.
 */
type Joint = 'body' | 'head' | 'legFL' | 'legFR' | 'legBL' | 'legBR' | 'legL' | 'legR' | 'wing';

interface PartDef {
  readonly joint: Joint;
  /**
   * Where the joint sits in the mob's own frame, feet on the ground at y = 0 and facing +Z.
   *
   * The part's boxes are given *relative to this*, which is what makes the rotation a rotation
   * about the hip rather than about the animal's feet.
   */
  readonly pivot: Vec3;
  readonly boxes: readonly BoxDef[];
}

interface SpeciesDef {
  readonly parts: readonly PartDef[];
  /** Leg-swing amplitude in radians at a full walk. */
  readonly swing: number;
  /** How far the body rises and falls over a stride, in blocks. */
  readonly bob: number;
}

/** A cow, pig or sheep: one body, one head, four legs, from proportions and a palette. */
function quadruped(
  dims: {
    legLen: number;
    legW: number;
    bodyW: number;
    bodyH: number;
    bodyL: number;
    headSize: number;
  },
  palette: {
    body: Vec3;
    head: Vec3;
    leg: Vec3;
    snoutDepth?: number;
    snoutColor?: Vec3;
    belly?: Vec3;
  },
  motion: { swing: number; bob: number },
): SpeciesDef {
  const { legLen, legW, bodyW, bodyH, bodyL, headSize: hs } = dims;
  const bodyY = legLen + bodyH / 2;
  const hx = bodyW / 2 - legW / 2;
  const hz = bodyL / 2 - legW / 2;

  const bodyBoxes: BoxDef[] = [
    {
      min: [-bodyW / 2, -bodyH / 2, -bodyL / 2],
      max: [bodyW / 2, bodyH / 2, bodyL / 2],
      color: palette.body,
    },
  ];
  if (palette.belly !== undefined) {
    bodyBoxes.push({
      min: [-bodyW / 2 + 0.02, -bodyH / 2 - 0.01, -bodyL / 2 + 0.1],
      max: [bodyW / 2 - 0.02, -bodyH / 2 + 0.12, bodyL / 2 - 0.1],
      color: palette.belly,
    });
  }
  /* A tail nub at the back, which is most of what tells a cow's front from its back at distance. */
  bodyBoxes.push({
    min: [-0.05, bodyH / 2 - 0.18, -bodyL / 2 - 0.1],
    max: [0.05, bodyH / 2 - 0.02, -bodyL / 2],
    color: palette.leg,
  });

  const headBoxes: BoxDef[] = [
    { min: [-hs / 2, -hs * 0.45, 0], max: [hs / 2, hs * 0.55, hs], color: palette.head },
  ];
  if (palette.snoutDepth !== undefined && palette.snoutColor !== undefined) {
    headBoxes.push({
      min: [-hs * 0.32, -hs * 0.35, hs - 0.02],
      max: [hs * 0.32, hs * 0.18, hs + palette.snoutDepth],
      color: palette.snoutColor,
    });
  }
  headBoxes.push({
    min: [-hs / 2 - 0.05, hs * 0.4, hs * 0.2],
    max: [-hs / 2 + 0.04, hs * 0.62, hs * 0.45],
    color: palette.head,
  });
  headBoxes.push({
    min: [hs / 2 - 0.04, hs * 0.4, hs * 0.2],
    max: [hs / 2 + 0.05, hs * 0.62, hs * 0.45],
    color: palette.head,
  });

  const legBox: BoxDef = {
    min: [-legW / 2, -legLen, -legW / 2],
    max: [legW / 2, 0, legW / 2],
    color: palette.leg,
  };

  return {
    swing: motion.swing,
    bob: motion.bob,
    parts: [
      { joint: 'body', pivot: [0, bodyY, 0], boxes: bodyBoxes },
      { joint: 'head', pivot: [0, bodyY + bodyH * 0.15, bodyL / 2], boxes: headBoxes },
      { joint: 'legFL', pivot: [hx, legLen, hz], boxes: [legBox] },
      { joint: 'legFR', pivot: [-hx, legLen, hz], boxes: [legBox] },
      { joint: 'legBL', pivot: [hx, legLen, -hz], boxes: [legBox] },
      { joint: 'legBR', pivot: [-hx, legLen, -hz], boxes: [legBox] },
    ],
  };
}

/** A chicken: two legs it walks on, two wings it beats, a beak, a comb and a wattle. */
function chicken(): SpeciesDef {
  const white: Vec3 = [0.95, 0.95, 0.92];
  const beak: Vec3 = [0.95, 0.66, 0.18];
  const legCol: Vec3 = [0.9, 0.62, 0.15];
  const red: Vec3 = [0.82, 0.18, 0.16];
  const legLen = 0.22;
  const bodyY = legLen + 0.16;

  return {
    swing: 0.7,
    bob: 0.05,
    parts: [
      {
        joint: 'body',
        pivot: [0, bodyY, 0],
        boxes: [{ min: [-0.16, -0.16, -0.2], max: [0.16, 0.18, 0.18], color: white }],
      },
      {
        joint: 'wing',
        pivot: [0.16, bodyY + 0.02, 0],
        boxes: [{ min: [0, -0.13, -0.16], max: [0.05, 0.12, 0.12], color: white }],
      },
      {
        joint: 'wing',
        pivot: [-0.16, bodyY + 0.02, 0],
        boxes: [{ min: [-0.05, -0.13, -0.16], max: [0, 0.12, 0.12], color: white }],
      },
      {
        joint: 'head',
        pivot: [0, bodyY + 0.16, 0.06],
        boxes: [
          { min: [-0.12, -0.1, 0], max: [0.12, 0.14, 0.2], color: white },
          { min: [-0.05, -0.02, 0.2], max: [0.05, 0.06, 0.31], color: beak },
          { min: [-0.05, 0.14, 0.04], max: [0.05, 0.22, 0.12], color: red },
          { min: [-0.05, -0.14, 0.05], max: [0.05, -0.06, 0.12], color: red },
        ],
      },
      {
        joint: 'legL',
        pivot: [0.07, legLen, 0],
        boxes: [{ min: [-0.025, -legLen, -0.025], max: [0.025, 0, 0.025], color: legCol }],
      },
      {
        joint: 'legR',
        pivot: [-0.07, legLen, 0],
        boxes: [{ min: [-0.025, -legLen, -0.025], max: [0.025, 0, 0.025], color: legCol }],
      },
    ],
  };
}

/** Four species, in flat colours, because the pack ships no animal art. */
const SPECIES: readonly SpeciesDef[] = [
  quadruped(
    { legLen: 0.55, legW: 0.17, bodyW: 0.56, bodyH: 0.5, bodyL: 0.95, headSize: 0.42 },
    {
      body: [0.4, 0.27, 0.17],
      head: [0.32, 0.21, 0.13],
      leg: [0.21, 0.15, 0.1],
      snoutDepth: 0.08,
      snoutColor: [0.83, 0.66, 0.64],
      belly: [0.86, 0.83, 0.75],
    },
    { swing: 0.55, bob: 0.05 },
  ),
  quadruped(
    { legLen: 0.4, legW: 0.17, bodyW: 0.52, bodyH: 0.46, bodyL: 0.85, headSize: 0.4 },
    {
      body: [0.92, 0.59, 0.61],
      head: [0.9, 0.56, 0.58],
      leg: [0.82, 0.48, 0.5],
      snoutDepth: 0.07,
      snoutColor: [0.76, 0.4, 0.44],
    },
    { swing: 0.5, bob: 0.045 },
  ),
  quadruped(
    { legLen: 0.5, legW: 0.16, bodyW: 0.62, bodyH: 0.62, bodyL: 0.92, headSize: 0.34 },
    { body: [0.92, 0.92, 0.88], head: [0.34, 0.29, 0.27], leg: [0.31, 0.27, 0.25] },
    { swing: 0.45, bob: 0.04 },
  ),
  chicken(),
];

/** How fast the walk cycle turns while a mob is walking, and while it is standing. */
const GAIT_WALK = 8;
const GAIT_IDLE = 1.5;
/** How quickly a mob eases into and out of its stride, and how quickly it turns to face a heading. */
const AMP_EASE = 8;
const YAW_EASE = 6;

export class Mobs {
  private readonly renderer: RendererApi;
  private readonly world: World;

  private readonly entities = new EntityWorld();
  private readonly registry: ComponentRegistry = new Map();
  private readonly module: ReturnType<typeof loadModule>;
  private readonly schedule: Schedule;
  private readonly Mob: never;

  /** One mesh per part per species, in `SPECIES[i].parts` order. */
  private readonly meshes: ReturnType<RendererApi['createMesh']>[][];
  /** Rewritten per part per frame; one matrix, not one per draw call allocated. */
  private readonly model = new Float32Array(16);
  private readonly speciesOf = new Map<number, number>();
  /**
   * The animation state a mob carries between frames, which is the host's and not the script's.
   *
   * Where a mob *wants* to go is behaviour and lives in `mobs.drs`. How far through its stride it
   * is, how much of that stride is showing and which way it has turned so far are properties of
   * the picture, and a script that had to carry them would be keeping rendering state.
   */
  private readonly gaitOf = new Map<number, number>();
  private readonly ampOf = new Map<number, number>();
  private readonly yawOf = new Map<number, number>();

  private readonly random = mulberry32(0x5eed);
  private accum = 0;
  private sinceSpawn = 0;
  private tick = 0;
  private elapsed = 0;
  private disposed = false;

  constructor(renderer: RendererApi, world: World) {
    this.renderer = renderer;
    this.world = world;

    this.module = loadModule(declared as unknown as Record<string, unknown>);
    const registered = registerEntityModule(this.module, this.registry);
    const bound = bindModule(this.module, { entities: { components: this.registry } });
    if (!bound.bound) throw new Error(`voxel mobs: ${bound.reason}`);
    this.schedule = buildSchedule(registered.systems);

    const mob = this.registry.get('Mob');
    if (mob === undefined) throw new Error('voxel mobs: the module declared no Mob');
    this.Mob = mob as never;

    this.meshes = SPECIES.map((species) =>
      species.parts.map((part) => renderer.createMesh(bakeBoxes(part.boxes))),
    );
  }

  get count(): number {
    return this.speciesOf.size;
  }

  /**
   * Where every mob currently is.
   *
   * Allocating, and deliberately not on the draw path: this is for a readout or a test, which
   * is what `mobs.test.ts` uses it for. `draw` reads the same columns directly.
   */
  positions(): { x: number; y: number; z: number }[] {
    const view = this.entities.view(this.Mob);
    const sparse = view.sparse as Int32Array;
    const xs = view['x'] as Float64Array;
    const ys = view['y'] as Float64Array;
    const zs = view['z'] as Float64Array;
    const out: { x: number; y: number; z: number }[] = [];
    for (const entity of this.entities.query(this.Mob)) {
      const at = sparse[entity % 2 ** 26] as number;
      out.push({ x: xs[at] as number, y: ys[at] as number, z: zs[at] as number });
    }
    return out;
  }

  /** Spawn the first few, once the world around the player is real. */
  populate(px: number, pz: number): void {
    for (let i = 0; i < INITIAL_MOBS; i++) this.trySpawn(px, pz);
  }

  update(dtSec: number, playerX: number, playerY: number, playerZ: number): void {
    this.elapsed += dtSec;
    this.sinceSpawn += dtSec;
    if (this.sinceSpawn >= SPAWN_INTERVAL_SEC) {
      this.sinceSpawn = 0;
      if (this.count < MAX_MOBS) this.trySpawn(playerX, playerZ);
    }

    this.accum += dtSec;
    let steps = 0;
    while (this.accum >= STEP_SEC && steps < MAX_STEPS) {
      this.accum -= STEP_SEC;
      steps++;
      this.startleNear(playerX, playerY, playerZ);
      runSchedule(this.entities, this.schedule, this.tick);
      this.tick += 1;
      this.grantHeadings();
      this.move(STEP_SEC, playerX, playerZ);
    }
    this.animate(dtSec);
  }

  /**
   * Advance the walk cycle, which is the picture's clock rather than the simulation's.
   *
   * Stepped from the frame's own `dt` and not the fixed 60 Hz tick, because it drives an angle
   * and not a position: a stride that advanced per tick would stutter with the accumulator.
   */
  private animate(dtSec: number): void {
    const view = this.entities.view(this.Mob);
    const sparse = view.sparse as Int32Array;
    const hxs = view['headingX'] as Float64Array;
    const hzs = view['headingZ'] as Float64Array;
    const moods = view['mood'] as Float64Array;

    for (const entity of this.entities.query(this.Mob)) {
      const at = sparse[entity % 2 ** 26] as number;
      const walking = moods[at] !== 0 && Math.hypot(hxs[at]!, hzs[at]!) > 0.01;

      /* Eased rather than set, so a mob does not snap into a full stride the tick it sets off. */
      const amp = this.ampOf.get(entity) ?? 0;
      const eased = amp + ((walking ? 1 : 0) - amp) * Math.min(1, dtSec * AMP_EASE);
      this.ampOf.set(entity, eased);

      /* The idle rate is not zero: a standing animal still breathes, and a leg frozen mid-swing
         is what a stopped walk cycle looks like. */
      this.gaitOf.set(
        entity,
        (this.gaitOf.get(entity) ?? 0) + dtSec * (walking ? GAIT_WALK : GAIT_IDLE),
      );

      /* Turn toward the heading rather than onto it, and hold the last one while standing —
         `atan2(0, 0)` is zero, so a mob that stopped would otherwise snap to face +Z. */
      if (walking) {
        const target = Math.atan2(hxs[at]!, hzs[at]!);
        const yaw = this.yawOf.get(entity) ?? target;
        let delta = target - yaw;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        this.yawOf.set(entity, yaw + delta * Math.min(1, dtSec * YAW_EASE));
      }
    }
  }

  /**
   * One draw per part per mob, with the part turned about its own joint.
   *
   * **The joint is the whole of the animation.** A mob used to be one baked mesh and one matrix,
   * which meant a leg could not move without the body moving with it — so the chicken had a
   * single stump for a leg and nothing walked, it slid. Each part is its own mesh now, placed at
   * its pivot and rotated there: `root · translate(pivot) · rotate(joint)`, composed by hand
   * because it is six multiplications and the alternative is a matrix library on the draw path.
   *
   * Six parts times ten mobs is sixty draws, which is what the reference spends on the same
   * picture and is cheaper than the bookkeeping to batch it.
   */
  draw(camera: Camera, env: Environment): void {
    const view = this.entities.view(this.Mob);
    const sparse = view.sparse as Int32Array;
    const xs = view['x'] as Float64Array;
    const ys = view['y'] as Float64Array;
    const zs = view['z'] as Float64Array;

    this.renderer.setMaterial(null);
    for (const entity of this.entities.query(this.Mob)) {
      const at = sparse[entity % 2 ** 26] as number;
      const index = this.speciesOf.get(entity);
      if (index === undefined) continue;
      const species = SPECIES[index] as SpeciesDef;
      const meshes = this.meshes[index] as ReturnType<RendererApi['createMesh']>[];

      const gait = this.gaitOf.get(entity) ?? 0;
      const amp = this.ampOf.get(entity) ?? 0;
      const yaw = this.yawOf.get(entity) ?? 0;

      /* Absolute, so the body rises twice a stride — once per footfall — rather than once. */
      const bob = amp * Math.abs(Math.sin(gait)) * species.bob;
      const swing = amp * species.swing;
      /* Diagonal pairs, half a cycle apart, which is what a walk is. */
      const near = Math.sin(gait) * swing;
      const far = Math.sin(gait + Math.PI) * swing;

      for (let i = 0; i < species.parts.length; i++) {
        const part = species.parts[i] as PartDef;
        let angle = 0;
        let aboutZ = false;
        switch (part.joint) {
          case 'legFL':
          case 'legBR':
          case 'legL':
            angle = near;
            break;
          case 'legFR':
          case 'legBL':
          case 'legR':
            angle = far;
            break;
          case 'head':
            /* Half rate and shallow, and it never quite stops: a still head reads as taxidermy. */
            angle = Math.sin(gait * 0.5) * 0.05 * (amp + 0.3);
            break;
          case 'wing':
            angle = Math.sin(gait * 1.5) * 0.3 * amp;
            aboutZ = true;
            break;
          default:
            break;
        }
        writeJoint(this.model, xs[at]!, ys[at]! + bob, zs[at]!, yaw, part.pivot, angle, aboutZ);
        this.renderer.drawMesh(meshes[i]!, this.model);
      }
    }
  }

  reset(): void {
    for (const entity of [...this.entities.query(this.Mob)]) this.entities.destroy(entity);
    this.speciesOf.clear();
    this.gaitOf.clear();
    this.ampOf.clear();
    this.yawOf.clear();
    this.accum = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const parts of this.meshes) for (const mesh of parts) this.renderer.disposeMesh(mesh);
  }

  /** Somewhere in the ring around the player, on ground, in the open. */
  private trySpawn(px: number, pz: number): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = this.random() * Math.PI * 2;
      const radius = SPAWN_MIN + this.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = Math.floor(px + Math.cos(angle) * radius);
      const z = Math.floor(pz + Math.sin(angle) * radius);
      if (!this.world.hasChunk(Math.floor(x / 16), Math.floor(z / 16))) continue;

      const top = this.world.surfaceY(x, z);
      if (top < 1 || top >= WORLD_H - 3) continue;
      if (!this.solid(x, top, z)) continue;
      if (this.solid(x, top + 1, z) || this.solid(x, top + 2, z)) continue;

      const entity = this.entities.create();
      this.entities.add(entity, this.Mob, {
        mood: 0,
        x: x + 0.5,
        y: top + 1,
        z: z + 0.5,
        headingX: 0,
        headingZ: 0,
        vy: 0,
        timer: 1,
        startled: 0,
        wantsHeading: 1,
      });
      this.speciesOf.set(entity, Math.floor(this.random() * SPECIES.length));
      return;
    }
  }

  /**
   * Give a mob the direction it asked for.
   *
   * The script raises `wantsHeading` and this answers it, because DriftScript has no `sin`,
   * `cos`, `floor` or modulo and no maths module — so a script can decide *when* to turn but not
   * *where* to. Recorded in `GAPS.md`; the split it forces happens to be a reasonable one.
   */
  private grantHeadings(): void {
    const view = this.entities.view(this.Mob);
    const sparse = view.sparse as Int32Array;
    const wants = view['wantsHeading'] as Float64Array;
    const hxs = view['headingX'] as Float64Array;
    const hzs = view['headingZ'] as Float64Array;

    for (const entity of this.entities.query(this.Mob)) {
      const at = sparse[entity % 2 ** 26] as number;
      if (wants[at] === 0) continue;
      const angle = this.random() * Math.PI * 2;
      hxs[at] = Math.cos(angle);
      hzs[at] = Math.sin(angle);
      wants[at] = 0;
    }
  }

  /** Tell a mob the player is close. The script decides what to do about it. */
  private startleNear(px: number, py: number, pz: number): void {
    const view = this.entities.view(this.Mob);
    const sparse = view.sparse as Int32Array;
    const xs = view['x'] as Float64Array;
    const ys = view['y'] as Float64Array;
    const zs = view['z'] as Float64Array;
    const startled = view['startled'] as Float64Array;

    for (const entity of this.entities.query(this.Mob)) {
      const at = sparse[entity % 2 ** 26] as number;
      const dx = xs[at]! - px;
      const dy = ys[at]! - py;
      const dz = zs[at]! - pz;
      if (dx * dx + dy * dy + dz * dz < STARTLE_DIST * STARTLE_DIST) {
        startled[at] = 1;
        /* Away from the player, which is the one steering decision the host owns because it is
           the only one that needs to know where the player is. */
        const away = Math.hypot(dx, dz) || 1;
        (view['headingX'] as Float64Array)[at] = dx / away;
        (view['headingZ'] as Float64Array)[at] = dz / away;
      }
    }
  }

  /**
   * Gravity, the ground, and a step that a wall refuses.
   *
   * The script never sees any of this: it has no way to ask what a cell holds, and giving it one
   * would mean handing a script the whole world.
   */
  private move(dt: number, px: number, pz: number): void {
    const view = this.entities.view(this.Mob);
    const sparse = view.sparse as Int32Array;
    const xs = view['x'] as Float64Array;
    const ys = view['y'] as Float64Array;
    const zs = view['z'] as Float64Array;
    const hxs = view['headingX'] as Float64Array;
    const hzs = view['headingZ'] as Float64Array;
    const vys = view['vy'] as Float64Array;
    const moods = view['mood'] as Float64Array;

    for (const entity of [...this.entities.query(this.Mob)]) {
      const at = sparse[entity % 2 ** 26] as number;
      const x = xs[at]!;
      let y = ys[at]!;
      const z = zs[at]!;

      if (Math.hypot(x - px, z - pz) > DESPAWN_DIST) {
        this.entities.destroy(entity);
        this.speciesOf.delete(entity);
        continue;
      }

      /* Speed comes from the mood the script chose. Idle is zero, and a zero heading means it
         is standing rather than walking. */
      const speed = moods[at] === 1 ? 1.8 : moods[at] === 2 ? 3.6 : 0;
      if (speed > 0) {
        const nx = x + hxs[at]! * speed * dt;
        const nz = z + hzs[at]! * speed * dt;
        const feet = Math.floor(y);
        /* A step up of one block is walkable; two is a wall, and it turns rather than climbing. */
        if (!this.solid(Math.floor(nx), feet + 1, Math.floor(nz))) {
          xs[at] = nx;
          zs[at] = nz;
          /*
           * **And the step is actually taken.** The test above allows walking into a column
           * whose feet-level block is solid, which is what makes a one-block rise walkable —
           * but nothing raised the mob onto it, and gravity only ever settles downwards. So a
           * mob that walked up a step stood inside it, and stayed there: `solid` under its feet
           * and `solid` at its feet, one block into the hillside, for the rest of its life.
           */
          if (this.solid(Math.floor(nx), feet, Math.floor(nz))) {
            y = feet + 1;
            ys[at] = y;
            vys[at] = 0;
          }
        } else {
          hxs[at] = -hxs[at]!;
          hzs[at] = -hzs[at]!;
        }
      }

      /*
       * Gravity, then snap to whatever stopped the fall.
       *
       * **The block that stops a fall is the one the feet are entering, `floor(ny)`.** A mob
       * standing on block `b` has `y = b + 1`, that block's top, which is the convention
       * `trySpawn` writes; so the support under a mob at `ny` is `floor(ny)` and landing puts
       * it back at `floor(ny) + 1`.
       *
       * There was a branch before this one asking about `floor(ny) - 1` — the block *below*
       * the one being entered — and settling the mob at `floor(ny)`, a block lower than it
       * was standing. That is true again on the next tick and every tick after, so a mob at
       * rest walked down through the terrain one block per step until the floor clamp below
       * caught it. Ten mobs, nine of them at `y = 1` with the player at `y = 34`: drawn the
       * whole time, thirty-three blocks under the ground, which reads as mobs never spawning.
       */
      vys[at] = Math.max(vys[at]! - GRAVITY * dt, -MAX_FALL);
      const ny = y + vys[at]! * dt;
      if (this.solid(Math.floor(xs[at]!), Math.floor(ny), Math.floor(zs[at]!))) {
        ys[at] = Math.floor(ny) + 1;
        vys[at] = 0;
      } else {
        ys[at] = ny;
      }
      if (ys[at]! < 1) {
        ys[at] = 1;
        vys[at] = 0;
      }
    }
  }

  private solid(x: number, y: number, z: number): boolean {
    if (y < 0 || y >= WORLD_H) return y < 0;
    return blockDef(this.world.getBlock(x, y, z))?.collidable === true;
  }
}

/**
 * One part's world matrix: the mob's place and facing, then the joint, then the turn about it.
 *
 * `root · translate(pivot) · rotate(angle)`, multiplied out by hand. Three matrices composed
 * through a library would allocate two intermediates per part per frame, which at six parts and
 * ten mobs is a hundred and twenty allocations a frame on the draw path — the thing `AGENTS.md`
 * rules out. Written out, it is nine products and a rotated translation.
 *
 * The mob's frame is feet at y = 0 facing +Z, and `yaw` follows `atan2(headingX, headingZ)` so
 * that a heading of +Z is a yaw of zero, matching the frame the boxes were authored in.
 *
 * `aboutZ` picks the axis: a leg and a head swing about X, and a wing beats about Z.
 */
function writeJoint(
  out: Float32Array,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pivot: Vec3,
  angle: number,
  aboutZ: boolean,
): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);

  if (aboutZ) {
    out[0] = cy * ca;
    out[1] = sa;
    out[2] = -sy * ca;
    out[4] = -cy * sa;
    out[5] = ca;
    out[6] = sy * sa;
    out[8] = sy;
    out[9] = 0;
    out[10] = cy;
  } else {
    out[0] = cy;
    out[1] = 0;
    out[2] = -sy;
    out[4] = sy * sa;
    out[5] = ca;
    out[6] = cy * sa;
    out[8] = sy * ca;
    out[9] = -sa;
    out[10] = cy * ca;
  }
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;

  /* The pivot is in the mob's frame, so it turns with the mob before it is added to its place. */
  const px = pivot[0];
  const pz = pivot[2];
  out[12] = x + cy * px + sy * pz;
  out[13] = y + pivot[1];
  out[14] = z - sy * px + cy * pz;
  out[15] = 1;
}

/** Axis-aligned boxes into one mesh, flat-coloured per box. */
function bakeBoxes(boxes: readonly BoxDef[]): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  /*
   * **Every list runs counter-clockwise seen from outside the box**, which is what the renderer
   * culls by: back faces, counter-clockwise front, on both backends.
   *
   * Five of the six ran the other way and the sixth did not, so the table could not be fixed by
   * reversing the quad at emission — that repaired five faces and broke the one that had been
   * right. Each list is stated in the correct order instead, and `mobs.test.ts` measures all six
   * against their normals so an inconsistent seventh cannot be added quietly.
   *
   * Drawn backwards, a mob is inside out: near faces discarded, far ones kept, an animal reading
   * as a flat slab. It went unseen because `SceneTarget.resolve` was leaving `CULL_FACE` disabled
   * and WebGL2 drew every mob double-sided.
   */
  const faces: readonly (readonly [Vec3, readonly number[][]])[] = [
    [
      [0, 1, 0],
      [
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
        [0, 1, 0],
      ],
    ],
    [
      [0, -1, 0],
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    ],
    [
      [1, 0, 0],
      [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
        [0, 0, 0],
      ],
    ],
    [
      [0, 0, 1],
      [
        [1, 1, 1],
        [0, 1, 1],
        [0, 0, 1],
        [1, 0, 1],
      ],
    ],
    [
      [0, 0, -1],
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [1, 0, 0],
      ],
    ],
  ];

  for (const box of boxes) {
    const [x0, y0, z0] = box.min;
    const [x1, y1, z1] = box.max;
    for (const [normal, corners] of faces) {
      const base = positions.length / 3;
      for (const c of corners) {
        positions.push(c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0);
        normals.push(normal[0], normal[1], normal[2]);
        colors.push(box.color[0], box.color[1], box.color[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    emissive: new Float32Array(positions.length / 3),
    indices: new Uint32Array(indices),
  };
}
