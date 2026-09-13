/**
 * A burial chamber, cut like a film: the scene this engine is asked to be judged on.
 *
 * The other demos each make one argument. This one makes the argument a studio actually
 * cares about, which is whether all of it works *together* — whether the lighting, the
 * water, the materials, the particles and the camera can be in one room at one time and
 * still hold a frame rate worth printing.
 *
 * **What is in here, and why each of it is here:**
 *
 *   1. **Materials that are different materials.** Gold, sandstone, lapis and carnelian
 *      differ in albedo, in how much light comes back (`specular`) and over how wide an
 *      angle it comes back (`roughness`). That last one is the difference between metal
 *      and stone, and it is why the sarcophagus reads as gold rather than as a yellow box.
 *   2. **A shaft of daylight into a dark room.** The directional light comes through an
 *      opening in the ceiling at a steep angle, and the visible beam is geometry drawn
 *      translucent, with dust turning over inside it.
 *   3. **Firelight that occludes.** Four braziers, each with its own shadow cubemap, so
 *      the colossi throw four separate shadows up the walls and the glyph registers are
 *      raked from below.
 *   4. **A channel of still water** carrying a planar reflection of the whole room.
 *   5. **Ten thousand carved glyphs**, generated from a seeded table rather than drawn,
 *      inlaid with gold that catches the firelight.
 *   6. **A camera that cuts.** Shots come from a timeline through `CinematicPlayer`, and
 *      `CinematicCamera` moves onto each one: instant on the cut, sprung within the shot,
 *      with the boom kept out of the columns by the room's own colliders.
 *
 * Nothing here is loaded. There is no model, no texture and no image: every surface is
 * arithmetic evaluated once when the page opened.
 */

import type { DemoBudget, DemoHandle, DemoScene, DemoStats, ResolutionControl } from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  Camera,
  CinematicCamera,
  CinematicPlayer,
  ColliderSet,
  MeshBuilder,
  ParticlePool,
  TAU,
  boxCollider,
  buildLightVolume,
  computeLightMatrix,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  defineCinematic,
  mulberry32,
  selectPointLights,
} from '../packages/core/src/index';
import type {
  CinematicScript,
  Collider,
  Environment,
  MeshHandle,
  MeshData,
  ParticleHandle,
  PlumePlacement,
  PlumeHandle,
  PointLightSource,
  RenderQualityOptions,
  RenderBackend,
  RendererApi,
  ShadowCasters,
  SkyColors,
  Vec3,
  WaterBody,
  WaterHandle,
} from '../packages/core/src/index';

/* -- The chamber, in metres ------------------------------------------------ */

/**
 * A hall rather than a room.
 *
 * The first cut of this was eleven metres by seventeen with a nine metre ceiling, which
 * is a large room and reads as a small one: the camera was never far enough from
 * anything for the space itself to be the subject. Scale is the cheapest grandeur there
 * is, and it costs nothing here because the walls are two boxes however far apart they
 * stand.
 */
const HALL_HALF_X = 16;
const HALL_HALF_Z = 32;
const WALL_HEIGHT = 15;
/** The opening in the ceiling, and where its light lands. */
const SHAFT_HALF = 3.2;
const SHAFT_Z = -7;

/** The dais and what stands on it, at the far end of the processional axis. */
const DAIS_Z = -21;
const DAIS_TOP = 1.6;
/** The subject every shot is composed around. */
const SUBJECT_Y = DAIS_TOP + 1.8;

/** The water channel: narrow, long, and running the length of the processional axis. */
const CHANNEL_HALF_X = 3;
const CHANNEL_Z = 4;
const CHANNEL_HALF_Z = 21;
const WATER_LEVEL = -0.35;

/** Two rows of columns down the hall. */
const COLUMN_ROWS = 8;
const COLUMN_X = 10.5;
const COLUMN_SPACING = 7;
const COLUMN_HEIGHT = 12.5;

/** Braziers down both sides, between the columns and the wall. */
const BRAZIER_X = 13.4;
const BRAZIER_ROWS = 3;
const BRAZIER_SPACING = 14;
const BRAZIER_TOP = 2.1;

/* -- Palette --------------------------------------------------------------- */

const SANDSTONE: Vec3 = [0.52, 0.42, 0.29];
const SANDSTONE_DEEP: Vec3 = [0.36, 0.29, 0.2];
const SANDSTONE_PALE: Vec3 = [0.63, 0.53, 0.38];
const GRANITE: Vec3 = [0.2, 0.18, 0.18];
const GRANITE_RED: Vec3 = [0.29, 0.16, 0.13];
/** Gold: warm, and it earns its look from specular and roughness rather than colour. */
const GOLD: Vec3 = [0.94, 0.7, 0.24];
/**
 * Polished iron, and the darker side of the same metal.
 *
 * Deliberately cool and slightly blue: every other metal in this room is warm, so the
 * only thing that reads as steel is something the fires cannot tint. Near-white rather
 * than grey because a mirror finish shows the light and not the material.
 */
const IRON_BRIGHT: Vec3 = [0.68, 0.72, 0.79];
const IRON_DARK: Vec3 = [0.3, 0.33, 0.39];
const GOLD_DEEP: Vec3 = [0.72, 0.48, 0.13];
const LAPIS: Vec3 = [0.13, 0.22, 0.62];
const CARNELIAN: Vec3 = [0.66, 0.19, 0.11];
const EMERALD: Vec3 = [0.09, 0.5, 0.32];
const TURQUOISE: Vec3 = [0.1, 0.55, 0.55];
const EMBER: Vec3 = [1, 0.42, 0.13];
const FIRE_LIGHT: Vec3 = [1, 0.52, 0.18];
/** Sand that has blown in over a few thousand years. */
const DRIFT: Vec3 = [0.66, 0.56, 0.39];

/**
 * Daylight, and it is deliberately **cold**.
 *
 * The single most valuable change in this scene. The first version lit the shaft with
 * the same warm colour as the fires, so the room had one temperature and everything in
 * it read as flat orange. Real interiors are lit by two sources that disagree: a hot
 * one close by and a cold one from outside. Splitting them is what gives a surface a
 * warm side and a cool side, and that division is most of what "realistic" means when
 * somebody looks at a render and cannot say why it works.
 */
const SUN: Vec3 = [0.86, 0.95, 1.18];
const SHAFT_COLOR: Vec3 = [0.78, 0.88, 1];

/**
 * How rough each material is, in one place.
 *
 * The single most important set of numbers in this scene. Albedo tells you what colour
 * a thing is; roughness tells you whether it is *metal*, because it decides how tightly
 * the highlight is gathered. Gold at stone's roughness is a yellow wall.
 */
const ROUGH_STONE = 0.88;
const ROUGH_GRANITE = 0.5;
const ROUGH_GOLD = 0.16;
const ROUGH_GEM = 0.08;
/** The processional floor is polished, and the water beside it proves it. */
const ROUGH_FLOOR = 0.45;

/**
 * How much visible mineral structure each material has, paired with the roughness above.
 *
 * **This scene is why grain had to stop being derived from roughness.** Its gold and its
 * sandstone are one merged mesh, so a pass-level control cannot separate them — and the
 * two lists below run in opposite directions on purpose. Granite is half as rough as
 * sandstone and just as mineral; gold is the smoothest thing in the room and has no grain
 * at all; gem is smoother still and has none either. Any weighting of one by the other
 * gets at least two of those four wrong.
 */
const GRAIN_STONE = 0.9;
const GRAIN_GRANITE = 0.85;
const GRAIN_GOLD = 0;
const GRAIN_GEM = 0;
const GRAIN_FLOOR = 0.7;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The edit.
 *
 * Six shots over a minute, composed around one fixed subject. A cutscene does not need
 * a moving character to be worth cutting: what an edit is *for* is choosing when the
 * audience is allowed to see a thing, and a sarcophagus that never moves gives the cuts
 * something to be about.
 *
 * `defineCinematic` validates on import, so a timeline that overlaps or runs past its
 * own duration fails when the module loads rather than halfway through a shot.
 */
const EDIT: CinematicScript = defineCinematic('gilded-chamber', {
  durationSec: 62,
  shots: [
    // Open wide and low, from the far end, so the room is established before the object.
    { atSec: 0, camera: { kind: 'lowWide', distance: 38, height: 3.2, fovDeg: 58, holdSec: 11 } },
    // Down onto the dais, looking along the shaft of light.
    /*
     * Overhead, and *under the ceiling*.
     *
     * At 17 the rig sat above a roof 15.5 m up and filmed the room through solid stone.
     * A ceiling is the one piece of geometry a camera can leave the room through without
     * the boom noticing, because the boom only shortens toward the subject and straight
     * up is a legal direction to be pushed.
     */
    { atSec: 11, camera: { kind: 'overhead', distance: 19, height: 12.5, fovDeg: 52, holdSec: 9 } },
    // The long slow one: round the sarcophagus, close, where the gold is doing its work.
    {
      atSec: 20,
      camera: {
        kind: 'orbit',
        distance: 15,
        height: 4.2,
        fovDeg: 46,
        orbitRate: 0.14,
        holdSec: 18,
      },
    },
    // Past a column, from the water, so the reflection is in frame.
    {
      atSec: 38,
      camera: {
        kind: 'flyby',
        distance: 20,
        height: 1.3,
        fovDeg: 50,
        holdSec: 10,
        // In the open aisle between the water and the colonnade, not beside a column.
        // At `COLUMN_X + 2` the station sat a metre and a half from a shaft, so the shot
        // opened on a wall of stone filling the frame.
        anchor: [COLUMN_X - 4, 1.3, CHANNEL_Z + 11],
      },
    },
    // A held two-shot of the colossi, framed from the doorway end.
    {
      atSec: 48,
      camera: {
        kind: 'lookAt',
        distance: 26,
        height: 5.5,
        fovDeg: 48,
        holdSec: 8,
        anchor: [0, 5, DAIS_Z],
      },
    },
    // Back out wide to close, so the loop rejoins where it began.
    { atSec: 56, camera: { kind: 'lowWide', distance: 34, height: 4, fovDeg: 58, holdSec: 6 } },
  ],
  lines: [],
});

/**
 * A tapered form of revolution, swept as a tube.
 *
 * **This exists because the demos were making the engine look like it only builds boxes,
 * and the first attempt at fixing that made everything look like bubbles.** That version
 * chained overlapping spheres, and a sphere bulges past the line between its neighbours'
 * radii, so a taper came out lumpy: cubic traded for blobby, which is worse.
 *
 * `addTube` is the primitive that was wanted all along. It sweeps a ring of vertices
 * along a path with a radius per station, so the surface between two stations is a
 * straight taper and nothing bulges anywhere. Twenty sides is round at every distance
 * this camera reaches, and the whole thing is generated once at mount.
 */
function addSpindle(
  builder: MeshBuilder,
  cx: number,
  cz: number,
  samples: readonly (readonly [number, number])[],
  color: Vec3,
  emissive: number,
): void {
  const path: number[] = [];
  const radii: number[] = [];
  for (const [y, r] of samples) {
    path.push(cx, y, cz);
    radii.push(r);
  }
  builder.addTube(path, radii, color, emissive, 20);
}

/**
 * The cavetto cornice and its torus roll: the profile that says Egypt from any distance.
 *
 * A cavetto is the concave flare crowning an Egyptian wall and the torus is the rolled
 * edge under it. Together they are the most recognisable silhouette the architecture has,
 * and they are what a bare box of a wall is missing.
 */
function addCornice(
  builder: MeshBuilder,
  x: number,
  y: number,
  halfZ: number,
  facing: number,
): void {
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addCylinder([x + facing * 0.16, y, 0], 0.3, halfZ, 'z', SANDSTONE_PALE, 0, 16, 0.2);
  for (let i = 0; i < 3; i++) {
    const t = (i + 1) / 3;
    builder.addBox(
      [x + facing * (0.1 + t * 0.42), y + 0.5 + i * 0.44, 0],
      [0.24 + t * 0.2, 0.22, halfZ],
      i === 2 ? SANDSTONE_PALE : SANDSTONE,
      0,
      0.15,
    );
  }
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  builder.addBox([x + facing * 0.66, y + 1.55, 0], [0.1, 0.12, halfZ], GOLD_DEEP, 0.1, 0.9);
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * A frieze of rearing cobras along the wall head.
 *
 * Repetition is the point: a hundred of the same small bright shape catches a moving
 * light one element at a time rather than all at once.
 */
function addUraeusFrieze(builder: MeshBuilder, x: number, y: number, facing: number): void {
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (let i = -24; i <= 24; i++) {
    const z = i * 1.3;
    builder.addCapsule([x + facing * 0.3, y + 0.36, z], 0.13, 0.16, GOLD, 0.16, 10, 5, 0.95);
    builder.addSphere([x + facing * 0.38, y + 0.66, z], 0.1, GOLD, 0.2, 10, 5);
    builder.addSphere([x + facing * 0.26, y + 0.1, z], 0.14, GOLD_DEEP, 0.1, 10, 5);
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/** An obelisk: a tapered shaft with a gilded pyramidion, flanking the entrance. */
function addObelisk(builder: MeshBuilder, x: number, z: number, height: number): void {
  builder.setRoughness(ROUGH_GRANITE);
  builder.setGrain(GRAIN_GRANITE);
  builder.addBox([x, 0.5, z], [1.5, 0.5, 1.5], GRANITE_RED, 0, 0.3);
  const courses = 8;
  for (let i = 0; i < courses; i++) {
    const t = i / courses;
    const half = 0.95 * (1 - t * 0.42);
    builder.addBox(
      [x, 1 + (height / courses) * (i + 0.5), z],
      [half, height / courses / 2, half],
      GRANITE_RED,
      0,
      0.3,
    );
  }
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    builder.addBox(
      [x, 1 + height + 0.15 + i * 0.26, z],
      [0.54 * (1 - t) + 0.05, 0.13, 0.54 * (1 - t) + 0.05],
      GOLD,
      0.2,
      0.95,
    );
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/** A standing attendant, half a colossus, lining the avenue. Body curved, base cut. */
function addAttendant(builder: MeshBuilder, x: number, z: number): void {
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([x, 0.22, z], [0.8, 0.22, 0.8], SANDSTONE_DEEP, 0, 0.15);
  addSpindle(
    builder,
    x,
    z,
    [
      [0.44, 0.36],
      [1.3, 0.44],
      [2.2, 0.5],
      [2.75, 0.42],
    ],
    SANDSTONE_PALE,
    0,
  );
  for (const side of [-1, 1]) {
    builder.addCapsule([x + side * 0.46, 1.7, z], 0.14, 0.55, SANDSTONE_PALE, 0, 12, 6, 0.2);
  }
  builder.addCapsule([x, 3.0, z], 0.16, 0.1, SANDSTONE_PALE, 0, 12, 6, 0.2);
  builder.addSphere([x, 3.32, z], 0.32, SANDSTONE_PALE, 0, 16, 8);
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  addSpindle(
    builder,
    x,
    z,
    [
      [3.2, 0.36],
      [3.6, 0.38],
      [3.8, 0.2],
    ],
    GOLD_DEEP,
    0.08,
  );
  addSpindle(
    builder,
    x,
    z,
    [
      [2.62, 0.5],
      [2.5, 0.56],
      [2.4, 0.5],
    ],
    GOLD,
    0.12,
  );
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * The false door on the wall behind the dais: a threshold for the dead rather than the
 * living, and the most recognisable element an Egyptian tomb has.
 *
 * Recessed jambs, which is what it is: frames stepping back into the wall, each narrower
 * than the last, so a raking light lays a different shadow in every step.
 */
function addFalseDoor(builder: MeshBuilder, random: () => number, z: number, facing: number): void {
  const doorHalf = 2.3;
  const doorTop = 6.4;
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    const half = doorHalf * (1 - t * 0.45);
    const top = doorTop * (1 - t * 0.12);
    const zz = z + facing * (0.1 + i * 0.22);
    const colour = i % 2 === 0 ? SANDSTONE_PALE : GRANITE_RED;
    builder.setRoughness(i % 2 === 0 ? ROUGH_STONE : ROUGH_GRANITE);
    builder.setGrain(i % 2 === 0 ? GRAIN_STONE : GRAIN_GRANITE);
    for (const side of [-1, 1]) {
      builder.addBox([side * (half - 0.24), top / 2, zz], [0.24, top / 2, 0.11], colour, 0, 0.2);
    }
    builder.addBox([0, top - 0.24, zz], [half, 0.24, 0.11], colour, 0, 0.2);
  }
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox(
    [0, doorTop / 2, z + facing * 1.0],
    [1.05, doorTop / 2, 0.12],
    SANDSTONE_DEEP,
    0,
    0.1,
  );
  for (let i = 0; i < 7; i++) {
    addGlyph(builder, random, 0, 0.9 + i * 0.72, z + facing * 0.92, 0.34, facing as 1 | -1);
  }
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (const side of [-1, 1]) {
    builder.addCylinder(
      [side * doorHalf, doorTop / 2, z + facing * 0.08],
      0.14,
      doorTop / 2,
      'y',
      GOLD_DEEP,
      0.1,
      12,
      0.9,
    );
  }
  builder.addCylinder(
    [0, doorTop, z + facing * 0.08],
    0.14,
    doorHalf + 0.14,
    'x',
    GOLD_DEEP,
    0.1,
    12,
    0.9,
  );
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * A winged disc over the door: a sun with two spread wings, in gold.
 *
 * Built from stepped feathers rather than a curve, which is both what this project has
 * and how the original is carved: rows of separate feathers, each catching light at its
 * own angle.
 */
function addWingedDisc(builder: MeshBuilder, y: number, z: number, facing: number): void {
  const zz = z + facing * 0.2;
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  builder.addCylinder([0, y, zz], 0.85, 0.13, 'z', GOLD, 0.26, 24, 0.96);
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  builder.addCylinder([0, y, zz + facing * 0.1], 0.4, 0.06, 'z', CARNELIAN, 0.5, 18, 1);
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      const feathers = 9 - row;
      for (let i = 0; i < feathers; i++) {
        const t = i / feathers;
        builder.addBox(
          [side * (1.0 + i * 0.52 + row * 0.16), y - (row * 0.34 + t * 0.5), zz],
          [0.24, 0.3 - row * 0.06, 0.09],
          row === 0 ? GOLD : GOLD_DEEP,
          0.2 - row * 0.05,
          0.94,
        );
      }
    }
    builder.addCapsule([side * 0.5, y - 1.0, zz], 0.1, 0.34, GOLD, 0.18, 10, 5, 0.94);
    builder.addSphere([side * 0.62, y - 1.48, zz], 0.11, GOLD, 0.22, 10, 5);
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * One carved glyph, as a handful of blocks in a cell.
 *
 * Generated rather than drawn, from a seeded table, which is the only honest thing to do
 * at this count: there are thousands of them and no image of any kind in this project.
 * They are not a writing system and do not pretend to be — what they have to do is carry
 * a register of dense, regular, hand-cut marks that the firelight can rake across, and
 * five blocks in a five by seven cell does that at every distance the camera reaches.
 *
 * Recessed a few millimetres and inlaid gold, so each one is a highlight rather than a
 * shape: at ten metres it is the *glint* that reads, and a flat painted glyph has none.
 */
function addGlyph(
  builder: MeshBuilder,
  random: () => number,
  x: number,
  y: number,
  z: number,
  cell: number,
  facing: 1 | -1,
): void {
  const marks = 3 + Math.floor(random() * 4);
  const unit = cell / 7;
  for (let i = 0; i < marks; i++) {
    const wide = random() < 0.45;
    const w = (wide ? 2 + random() * 2 : 0.8) * unit;
    const h = (wide ? 0.8 : 1.5 + random() * 2.5) * unit;
    const ox = (random() - 0.5) * (cell - w * 2) * 0.7;
    const oy = (random() - 0.5) * (cell - h * 2) * 0.8;
    builder.addBox(
      [x + ox, y + oy, z + facing * 0.035],
      [w, h, 0.035],
      GOLD,
      // A trace of self-illumination, so a glyph in a shadowed register does not vanish
      // entirely. Gold in a dark room is not black, it is dim.
      0.1,
      0.85,
    );
  }
}

/** A papyrus column: a bundled shaft, a collar and a spreading capital. */
function addColumn(builder: MeshBuilder, random: () => number, x: number, z: number): void {
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([x, 0.18, z], [1.15, 0.18, 1.15], SANDSTONE_DEEP, 0, 0.15);

  // Eight reeds around the shaft rather than one cylinder: a bundle catches a moving
  // light along every rib, which is most of why a column reads as carved.
  const reeds = 8;
  for (let i = 0; i < reeds; i++) {
    const angle = (i / reeds) * TAU;
    const shade = 0.9 + random() * 0.2;
    builder.addCylinder(
      [x + Math.cos(angle) * 0.72, COLUMN_HEIGHT / 2 + 0.36, z + Math.sin(angle) * 0.72],
      0.3,
      COLUMN_HEIGHT / 2,
      'y',
      [SANDSTONE[0] * shade, SANDSTONE[1] * shade, SANDSTONE[2] * shade],
      0,
      12,
      0.12,
    );
  }

  /* Gold collars, which are the thing that makes it a column in a rich room. */
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (const y of [1.5, COLUMN_HEIGHT - 0.9]) {
    builder.addCylinder([x, y, z], 1.06, 0.16, 'y', GOLD_DEEP, 0.06, 20, 0.9);
  }

  /* The capital: a spreading bell, then the abacus the roof sits on. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addCylinder([x, COLUMN_HEIGHT + 0.1, z], 1.35, 0.55, 'y', SANDSTONE_PALE, 0, 20, 0.15);
  builder.addBox([x, COLUMN_HEIGHT + 0.85, z], [1.2, 0.24, 1.2], SANDSTONE_DEEP, 0, 0.15);

  /* One gem per column, at eye height, catching whatever passes. */
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  const gem = random() < 0.5 ? LAPIS : random() < 0.5 ? CARNELIAN : EMERALD;
  builder.addBox([x, 2.6, z + 0.95], [0.16, 0.16, 0.1], gem, 0.5, 1);
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * A seated colossus: the throne is cut stone, the figure is carved.
 *
 * Two wrong versions preceded this one, and both were instructive. All boxes read as a
 * stack of crates. All spheres read as a snowman. An Egyptian colossus is genuinely
 * rectilinear — it never leaves the block it was cut from, and the frontality is the
 * style rather than a limitation — so the honest shape is *mostly square, carefully
 * relieved*: a blocky throne and torso, with the shoulders, head and limbs swept as
 * tapered tubes so the silhouette has curves where a body has curves and nowhere else.
 */
function addColossus(builder: MeshBuilder, x: number, z: number, facing: number): void {
  const seatY = 1.2;

  /* Throne, plinth and backrest: cut stone, and it should look it. */
  builder.setRoughness(ROUGH_GRANITE);
  builder.setGrain(GRAIN_GRANITE);
  builder.addBox([x, 0.35, z], [2.1, 0.35, 1.9], GRANITE, 0, 0.35);
  builder.addBox([x, seatY / 2 + 0.35, z - facing * 0.2], [1.7, seatY / 2, 1.5], GRANITE, 0, 0.35);
  builder.addBox([x, seatY + 3.1, z - facing * 1.4], [1.7, 3.1, 0.35], GRANITE, 0, 0.3);
  for (const side of [-1, 1]) {
    builder.addBox(
      [x + side * 1.52, seatY + 1.05, z - facing * 0.35],
      [0.22, 1.05, 1.15],
      GRANITE,
      0,
      0.3,
    );
  }

  /* Legs: thigh forward, shin down, both tapering. Feet flat on the plinth. */
  for (const side of [-1, 1]) {
    const lx = x + side * 0.66;
    builder.addTube(
      [lx, seatY + 0.72, z - facing * 0.1, lx, seatY + 0.66, z + facing * 0.95],
      [0.4, 0.34],
      GRANITE,
      0,
      14,
    );
    builder.addTube(
      [lx, seatY + 0.62, z + facing * 1.0, lx, 0.95, z + facing * 1.12],
      [0.34, 0.26],
      GRANITE,
      0,
      14,
    );
    builder.addBox([lx, 0.85, z + facing * 1.45], [0.3, 0.15, 0.5], GRANITE, 0, 0.3);
  }

  /* Torso: a single taper from waist to shoulders, which is one clean highlight. */
  builder.addTube(
    [
      x,
      seatY + 0.85,
      z - facing * 0.15,
      x,
      seatY + 2.0,
      z - facing * 0.2,
      x,
      seatY + 2.95,
      z - facing * 0.22,
    ],
    [0.78, 0.92, 1.0],
    GRANITE,
    0,
    18,
  );

  /* Arms: shoulder to elbow to fist on the knee. */
  for (const side of [-1, 1]) {
    const sx = x + side * 0.98;
    builder.addTube(
      [sx, seatY + 2.8, z - facing * 0.2, sx + side * 0.06, seatY + 1.5, z - facing * 0.05],
      [0.34, 0.27],
      GRANITE,
      0,
      14,
    );
    builder.addTube(
      [
        sx + side * 0.06,
        seatY + 1.5,
        z - facing * 0.05,
        sx - side * 0.02,
        seatY + 0.85,
        z + facing * 0.95,
      ],
      [0.27, 0.23],
      GRANITE,
      0,
      14,
    );
    builder.addBox(
      [sx - side * 0.02, seatY + 0.78, z + facing * 1.2],
      [0.24, 0.2, 0.26],
      GRANITE,
      0,
      0.3,
    );
  }

  /* Neck and head. The skull is round; the face is the one flat plane on the figure. */
  builder.addTube(
    [x, seatY + 2.95, z - facing * 0.18, x, seatY + 3.4, z - facing * 0.16],
    [0.32, 0.26],
    GRANITE,
    0,
    14,
  );
  builder.addSphere([x, seatY + 3.85, z - facing * 0.12], 0.46, GRANITE, 0, 20, 10);
  builder.addBox([x, seatY + 3.8, z + facing * 0.3], [0.33, 0.42, 0.14], GRANITE, 0, 0.28);

  /* The nemes headdress: a swept cap with a lappet falling either side of the face. */
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  addSpindle(
    builder,
    x,
    z - facing * 0.12,
    [
      [seatY + 3.62, 0.5],
      [seatY + 4.05, 0.56],
      [seatY + 4.42, 0.4],
      [seatY + 4.62, 0.12],
    ],
    GOLD_DEEP,
    0.08,
  );
  for (const side of [-1, 1]) {
    builder.addBox(
      [x + side * 0.48, seatY + 3.5, z + facing * 0.06],
      [0.14, 0.58, 0.3],
      GOLD_DEEP,
      0.08,
      0.9,
    );
  }
  builder.addSphere([x, seatY + 4.14, z + facing * 0.38], 0.11, GOLD, 0.24, 12, 6);

  /* The broad collar over the shoulders: a flat gold ring, not a bulge. */
  addSpindle(
    builder,
    x,
    z - facing * 0.2,
    [
      [seatY + 2.98, 1.02],
      [seatY + 2.86, 1.14],
      [seatY + 2.76, 1.06],
    ],
    GOLD,
    0.14,
  );

  /* Eyes: lapis, and the only thing on the figure allowed to glow. */
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  for (const side of [-1, 1]) {
    builder.addBox(
      [x + side * 0.16, seatY + 3.9, z + facing * 0.4],
      [0.08, 0.05, 0.05],
      LAPIS,
      0.7,
      1,
    );
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * The coffin's cross-sections, foot to head: `[z offset, centre height, half width, half height]`.
 *
 * **Why a table and not a tube.** `addTube` sweeps a *circle*, so whatever profile it is
 * given comes out round in cross-section — and a long round taper is a baguette, which is
 * exactly what this looked like. A mummiform coffin is not round: it is markedly wider
 * than it is deep, because it holds a body lying on its back, and its silhouette has a
 * shoulder in it. Those two facts are the whole read, and neither survives a circle.
 *
 * So every station names width and height separately, and the numbers keep the shoulder
 * break sharp: widest at -0.95, a distinct pinch at the neck, then the head swelling back
 * out. A gradual sweep through those same extremes reads as a loaf however carefully the
 * radii are tuned — it is the *rate of change* around the shoulder that says shoulder.
 */
const COFFIN_STATIONS: readonly (readonly [number, number, number, number])[] = [
  [2.62, 1.0, 0.1, 0.1],
  [2.45, 1.0, 0.26, 0.21],
  [2.1, 1.01, 0.36, 0.27],
  [1.5, 1.02, 0.44, 0.32],
  [0.8, 1.03, 0.52, 0.37],
  [0.1, 1.04, 0.6, 0.42],
  [-0.5, 1.05, 0.67, 0.46],
  [-0.95, 1.06, 0.72, 0.49],
  [-1.3, 1.06, 0.71, 0.49],
  [-1.58, 1.07, 0.59, 0.46],
  [-1.82, 1.09, 0.52, 0.44],
  [-2.1, 1.1, 0.46, 0.42],
  [-2.34, 1.09, 0.33, 0.33],
  [-2.52, 1.06, 0.13, 0.15],
];

/** The section at any point along the coffin, interpolated between its stations. */
function coffinSectionAt(zOffset: number): { cy: number; hw: number; hh: number } {
  const first = COFFIN_STATIONS[0] as readonly [number, number, number, number];
  const last = COFFIN_STATIONS[COFFIN_STATIONS.length - 1] as readonly [
    number,
    number,
    number,
    number,
  ];
  if (zOffset >= first[0]) return { cy: first[1], hw: first[2], hh: first[3] };
  if (zOffset <= last[0]) return { cy: last[1], hw: last[2], hh: last[3] };
  for (let i = 0; i < COFFIN_STATIONS.length - 1; i++) {
    const a = COFFIN_STATIONS[i] as readonly [number, number, number, number];
    const b = COFFIN_STATIONS[i + 1] as readonly [number, number, number, number];
    if (zOffset <= a[0] && zOffset >= b[0]) {
      const span = a[0] - b[0];
      const t = span === 0 ? 0 : (a[0] - zOffset) / span;
      return {
        cy: a[1] + (b[1] - a[1]) * t,
        hw: a[2] + (b[2] - a[2]) * t,
        hh: a[3] + (b[3] - a[3]) * t,
      };
    }
  }
  return { cy: last[1], hw: last[2], hh: last[3] };
}

/**
 * Loft the coffin shell through its stations, as quads rather than a swept circle.
 *
 * Each ring is an ellipse, so the section stays wide and shallow end to end, and
 * consecutive rings are joined directly — which means the surface passes exactly through
 * the authored numbers instead of through a circle fitted to them.
 */
function addCoffinShell(
  builder: MeshBuilder,
  z: number,
  baseY: number,
  color: Vec3,
  emissive: number,
  sides: number,
): void {
  for (let i = 0; i < COFFIN_STATIONS.length - 1; i++) {
    const a = COFFIN_STATIONS[i] as readonly [number, number, number, number];
    const b = COFFIN_STATIONS[i + 1] as readonly [number, number, number, number];
    for (let j = 0; j < sides; j++) {
      const t0 = (j / sides) * Math.PI * 2;
      const t1 = ((j + 1) / sides) * Math.PI * 2;
      const point = (
        st: readonly [number, number, number, number],
        angle: number,
      ): [number, number, number] => [
        Math.cos(angle) * st[2],
        baseY + st[1] + Math.sin(angle) * st[3],
        z + st[0],
      ];
      builder.addQuad(
        point(a, t0),
        point(b, t0),
        point(b, t1),
        point(a, t1),
        color,
        emissive,
        0.95,
      );
    }
  }
}

/**
 * A band of inlay laid *onto* the lid, following its curve.
 *
 * The bands were flat boxes at a fixed height, which on a curved lid is a plank resting on
 * a barrel: it meets the surface along one line and lifts away from it everywhere else.
 * Reported, correctly, as the elements on top not bending over the shape.
 *
 * This samples the same section table the shell is built from, so each band is a strip of
 * short quads that sit a millimetre proud of the surface and turn with it. It cannot come
 * adrift, because there is only one description of where the surface is.
 */
function addLidBand(
  builder: MeshBuilder,
  z: number,
  baseY: number,
  zOffset: number,
  halfDepth: number,
  color: Vec3,
  emissive: number,
): void {
  /* Across the top of the lid only, stopping short of where it turns under. */
  const from = Math.PI * 0.22;
  const to = Math.PI * 0.78;
  const steps = 9;
  const lift = 0.015;
  for (let i = 0; i < steps; i++) {
    const t0 = from + ((to - from) * i) / steps;
    const t1 = from + ((to - from) * (i + 1)) / steps;
    const at = (angle: number, dz: number): [number, number, number] => {
      const section = coffinSectionAt(zOffset + dz);
      return [
        Math.cos(angle) * (section.hw + lift),
        baseY + section.cy + Math.sin(angle) * (section.hh + lift),
        z + zOffset + dz,
      ];
    };
    builder.addQuad(
      at(t0, -halfDepth),
      at(t0, halfDepth),
      at(t1, halfDepth),
      at(t1, -halfDepth),
      color,
      emissive,
      1,
    );
  }
}

/**
 * The sarcophagus: an anthropoid coffin, and the most curved object in the project.
 *
 * A mummiform coffin has no straight line anywhere on it — it is a tapered shell that
 * swells at the shoulders and closes at the feet, with a face on the lid. It was a gold
 * box before, and a gold box is exactly what a viewer means when they say an engine
 * looks like it only does cubes.
 *
 * Built as a profile of revolution lying on its side, so the highlight runs the whole
 * length of it in one unbroken sweep. At `ROUGH_GOLD` that sweep is what makes it read
 * as polished metal rather than as yellow stone, and it is the single clearest piece of
 * evidence in the scene that the shading is doing real work.
 */
function addSarcophagus(builder: MeshBuilder, random: () => number): void {
  const z = DAIS_Z;

  /* Three steps up, with a gold nosing on each. Architecture, so boxes are right. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  for (let i = 0; i < 3; i++) {
    const h = DAIS_TOP * ((i + 1) / 3);
    builder.addBox([0, h / 2, z], [5.2 - i * 0.7, h / 2, 4.4 - i * 0.6], SANDSTONE_PALE, 0, 0.15);
  }
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (let i = 0; i < 3; i++) {
    const h = DAIS_TOP * ((i + 1) / 3);
    builder.addBox([0, h, z + 4.4 - i * 0.6], [5.2 - i * 0.7, 0.05, 0.1], GOLD, 0.12, 0.95);
  }

  /* The stone chest the coffin lies in, and its plinth. */
  builder.setRoughness(ROUGH_GRANITE);
  builder.setGrain(GRAIN_GRANITE);
  builder.addBox([0, DAIS_TOP + 0.42, z], [1.5, 0.42, 3.1], GRANITE_RED, 0, 0.35);

  /*
   * The coffin itself: one tube swept head to foot.
   *
   * A mummiform coffin is a single continuous taper, so it is a single continuous sweep.
   * The first attempt built it from a chain of spheres and it came out as a caterpillar;
   * a tube gives the same profile with a straight taper between stations and one
   * unbroken highlight running the whole length, which at `ROUGH_GOLD` is what makes it
   * read as polished metal rather than as yellow stone.
   */
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  addCoffinShell(builder, z, DAIS_TOP, GOLD_DEEP, 0.1, 24);

  /*
   * The mask: a face on the head end, under a nemes, with a plaited beard.
   *
   * Every piece is placed against `coffinSectionAt`, so the face rides the lid instead of
   * hovering at a height chosen separately from it. Move a station and the mask follows.
   */
  /*
   * The face, lofted like the coffin and for the same reason.
   *
   * It was a sphere, which is a ball on a lid and reads as exactly that. A funerary mask
   * is a *face*: narrow at the chin, widest across the cheekbones and brow, rounding back
   * over the crown. Those three facts are the whole likeness and a sphere has none of
   * them — no amount of detail stuck onto a ball will read as a head, because the
   * silhouette is decided before any of it.
   *
   * Sections are `[z offset, half width, half height]`, centred just under the lid's own
   * top so the mask rises out of the coffin rather than resting on it.
   */
  const MASK: readonly (readonly [number, number, number])[] = [
    [-1.76, 0.13, 0.11],
    [-1.86, 0.21, 0.18],
    [-1.97, 0.27, 0.23],
    [-2.09, 0.3, 0.26],
    [-2.2, 0.29, 0.25],
    [-2.32, 0.24, 0.21],
    [-2.43, 0.15, 0.13],
    [-2.5, 0.06, 0.05],
  ];
  const maskSink = 0.12;
  const maskPoint = (
    st: readonly [number, number, number],
    angle: number,
  ): [number, number, number] => {
    const section = coffinSectionAt(st[0]);
    const centre = DAIS_TOP + section.cy + section.hh - maskSink;
    return [Math.cos(angle) * st[1], centre + Math.sin(angle) * st[2], z + st[0]];
  };
  for (let i = 0; i < MASK.length - 1; i++) {
    const a = MASK[i] as readonly [number, number, number];
    const b = MASK[i + 1] as readonly [number, number, number];
    for (let j = 0; j < 18; j++) {
      const t0 = (j / 18) * Math.PI * 2;
      const t1 = ((j + 1) / 18) * Math.PI * 2;
      builder.addQuad(
        maskPoint(a, t0),
        maskPoint(b, t0),
        maskPoint(b, t1),
        maskPoint(a, t1),
        GOLD,
        0.2,
        0.96,
      );
    }
  }

  /** The height of the mask surface straight above a point on its axis. */
  const maskTop = (zo: number): number => {
    let near = MASK[0] as readonly [number, number, number];
    for (const st of MASK) if (Math.abs(st[0] - zo) < Math.abs(near[0] - zo)) near = st;
    const section = coffinSectionAt(zo);
    return DAIS_TOP + section.cy + section.hh - maskSink + near[2];
  };

  /* Brow, nose and mouth: shallow, because a mask is modelled rather than assembled. */
  builder.addBox([0, maskTop(-2.2) - 0.03, z - 2.2], [0.24, 0.03, 0.04], GOLD, 0.24, 0.96);
  builder.addTube(
    [0, maskTop(-2.16) - 0.02, z - 2.16, 0, maskTop(-2.04) + 0.02, z - 2.04],
    [0.035, 0.05],
    GOLD,
    0.2,
    8,
  );
  builder.addBox([0, maskTop(-1.92) - 0.02, z - 1.92], [0.09, 0.02, 0.025], GOLD_DEEP, 0.16, 0.9);

  /* The nemes, swept over the crown rather than stood on it. */
  for (let i = 0; i < 5; i++) {
    const zo = -2.18 - i * 0.1;
    const section = coffinSectionAt(zo);
    builder.addBox(
      [0, DAIS_TOP + section.cy + section.hh - 0.02, z + zo],
      [section.hw * 0.8, 0.045, 0.05],
      GOLD,
      0.22,
      0.96,
    );
  }
  for (const side of [-1, 1]) {
    const lappet = coffinSectionAt(-1.94);
    builder.addCapsule(
      [side * lappet.hw * 0.74, DAIS_TOP + lappet.cy + lappet.hh * 0.3, z - 1.94],
      0.11,
      0.24,
      GOLD_DEEP,
      0.1,
      12,
      6,
      0.9,
    );
  }
  builder.addCapsule([0, maskTop(-1.78) - 0.16, z - 1.72], 0.07, 0.16, GOLD_DEEP, 0.12, 10, 5, 0.9);
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  for (const side of [-1, 1]) {
    builder.addSphere([side * 0.13, maskTop(-2.14) - 0.03, z - 2.14], 0.042, LAPIS, 0.75, 10, 5);
  }

  /* Crossed arms on the chest, holding a crook and a flail. */
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  /*
   * Forearms crossing the chest diagonally, which is the pose and not a decoration.
   *
   * They were two capsules standing on end beside each other — from above, two dots. An
   * upright capsule cannot be an arm at any size, because an arm is defined by where it
   * goes: from a shoulder, across the body, to a hand at the opposite side. Tubes follow
   * a path and so can say that; a capsule has only a centre.
   */
  for (const side of [-1, 1]) {
    const shoulder = coffinSectionAt(-1.42);
    const wrist = coffinSectionAt(-0.72);
    builder.addTube(
      [
        side * shoulder.hw * 0.72,
        DAIS_TOP + shoulder.cy + shoulder.hh - 0.1,
        z - 1.42,
        side * 0.16,
        DAIS_TOP + shoulder.cy + shoulder.hh + 0.01,
        z - 1.05,
        -side * 0.26,
        DAIS_TOP + wrist.cy + wrist.hh - 0.03,
        z - 0.78,
      ],
      [0.085, 0.075, 0.06],
      GOLD,
      0.16,
      12,
    );
  }
  /* The crook and the flail, held across the body in the same diagonal. */
  const grip = coffinSectionAt(-1.05);
  const gripTop = DAIS_TOP + grip.cy + grip.hh;
  builder.addTube(
    [
      -0.3,
      gripTop + 0.16,
      z - 1.42,
      -0.24,
      gripTop + 0.2,
      z - 0.98,
      -0.2,
      gripTop + 0.16,
      z - 0.72,
    ],
    [0.03, 0.035, 0.03],
    GOLD,
    0.2,
    8,
  );
  builder.addTube(
    [0.3, gripTop + 0.16, z - 1.42, 0.24, gripTop + 0.2, z - 0.98, 0.2, gripTop + 0.16, z - 0.72],
    [0.03, 0.035, 0.03],
    GOLD,
    0.2,
    8,
  );

  /* Inlaid bands down the body, which is how a real one is divided into registers. */
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  for (let i = 0; i < 7; i++) {
    const pick = random();
    const gem = pick < 0.4 ? LAPIS : pick < 0.7 ? CARNELIAN : pick < 0.88 ? TURQUOISE : EMERALD;
    addLidBand(builder, z, DAIS_TOP, 1.9 - i * 0.52, 0.11, gem, 0.55);
  }

  /*
   * A polished orb on a stand at the foot of the dais.
   *
   * One perfectly smooth sphere of gold, and it is here as evidence. A curved specular
   * surface is the hardest thing to fake and the easiest thing to check: the highlight
   * on it moves as the camera moves, stays a single unbroken spot, and gets narrower as
   * roughness falls. Nothing else in the room states that as plainly.
   */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([0, 0.22, z + 5.6], [0.6, 0.22, 0.6], SANDSTONE_PALE, 0, 0.2);
  addSpindle(
    builder,
    0,
    z + 5.6,
    [
      [0.44, 0.36],
      [0.9, 0.2],
      [1.05, 0.34],
    ],
    SANDSTONE_PALE,
    0,
  );
  builder.setRoughness(0.06);
  builder.setGrain(GRAIN_GOLD); // the gilded orb
  builder.addSphere([0, 1.65, z + 5.6], 0.58, GOLD, 0.12, 32, 16);
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * Greek vases along the aisle: an amphora, a krater and a hydria on low plinths.
 *
 * Deliberately not Egyptian, and that is the point of putting them here. A burial chamber
 * that only contains the one culture's shapes is a themed room; one holding traded goods
 * is a *place*, and the contrast does more for the read than another set of jars would.
 * Late-period Egypt was full of imported Greek pottery, so it is also not an anachronism.
 *
 * Every one is a profile of revolution, which is the honest method for a thrown pot and
 * the reason they hold a highlight the whole curve of the belly. The black glaze against
 * the terracotta gives the shading two very different roughnesses on one object, a metre
 * apart, which is a comparison the room did not otherwise offer.
 */
const TERRACOTTA: Vec3 = [0.62, 0.29, 0.16];
const VASE_GLAZE: Vec3 = [0.08, 0.07, 0.08];

/** One vessel: body, foot, neck, lip and a pair of handles. */
function addVase(
  builder: MeshBuilder,
  x: number,
  z: number,
  base: number,
  scale: number,
  profile: readonly (readonly [number, number])[],
  handleFrom: number,
  handleTo: number,
): void {
  builder.setRoughness(0.52);
  builder.setGrain(0.3); // unglazed terracotta, which is fired clay rather than cut stone
  addSpindle(
    builder,
    x,
    z,
    profile.map(([y, r]) => [base + y * scale, r * scale] as const),
    TERRACOTTA,
    0.02,
  );

  /*
   * The glazed register round the belly, at the widest station so it reads as painted on
   * rather than as a separate ring standing off the surface.
   */
  let widest = profile[0] as readonly [number, number];
  for (const sample of profile) if (sample[1] > widest[1]) widest = sample;
  builder.setRoughness(0.14);
  builder.setGrain(GRAIN_GEM); // the glaze
  addSpindle(
    builder,
    x,
    z,
    [
      [base + (widest[0] - 0.07) * scale, widest[1] * scale * 0.99],
      [base + widest[0] * scale, widest[1] * scale * 1.008],
      [base + (widest[0] + 0.07) * scale, widest[1] * scale * 0.99],
    ],
    VASE_GLAZE,
    0.03,
  );

  /* Handles: a short arc from the shoulder up to the neck, one each side. */
  builder.setRoughness(0.4);
  builder.setGrain(0); // the handles, painted over
  for (const side of [-1, 1]) {
    const path: number[] = [];
    const radii: number[] = [];
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = handleFrom + (handleTo - handleFrom) * t;
      // Bows outward at the middle, which is what makes it a handle and not a rib.
      const out = Math.sin(t * Math.PI) * 0.16 + 0.2;
      path.push(x + side * out * scale, base + y * scale, z);
      radii.push(0.035 * scale);
    }
    builder.addTube(path, radii, TERRACOTTA, 0.02, 10);
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/** The three of them, each on its own sandstone plinth. */
function addGreekVases(builder: MeshBuilder, x: number, z: number, facing: number): void {
  const AMPHORA: readonly (readonly [number, number])[] = [
    [0, 0.12],
    [0.05, 0.2],
    [0.16, 0.31],
    [0.3, 0.36],
    [0.45, 0.33],
    [0.58, 0.24],
    [0.68, 0.15],
    [0.8, 0.13],
    [0.9, 0.19],
    [0.95, 0.18],
  ];
  const KRATER: readonly (readonly [number, number])[] = [
    [0, 0.16],
    [0.06, 0.2],
    [0.12, 0.16],
    [0.22, 0.28],
    [0.38, 0.4],
    [0.55, 0.46],
    [0.68, 0.46],
    [0.74, 0.5],
    [0.78, 0.49],
  ];
  const HYDRIA: readonly (readonly [number, number])[] = [
    [0, 0.13],
    [0.06, 0.22],
    [0.2, 0.34],
    [0.36, 0.38],
    [0.5, 0.34],
    [0.6, 0.22],
    [0.72, 0.14],
    [0.84, 0.12],
    [0.9, 0.17],
  ];

  const set = [
    { dz: -1.5, scale: 1.15, profile: AMPHORA, from: 0.5, to: 0.86 },
    { dz: 0, scale: 1.35, profile: KRATER, from: 0.5, to: 0.72 },
    { dz: 1.5, scale: 1.0, profile: HYDRIA, from: 0.42, to: 0.8 },
  ];
  for (const entry of set) {
    const vz = z + entry.dz * facing;
    builder.setRoughness(ROUGH_STONE);
    builder.setGrain(GRAIN_STONE);
    builder.addBox([x, 0.16, vz], [0.5, 0.16, 0.5], SANDSTONE_DEEP, 0, 0.15);
    builder.addBox([x, 0.34, vz], [0.42, 0.04, 0.42], SANDSTONE_PALE, 0, 0.2);
    addVase(builder, x, vz, 0.38, entry.scale, entry.profile, entry.from, entry.to);
  }
}

/**
 * A ceremonial blade mounted flat on the end wall, above the dais.
 *
 * It is here to be *looked at*, and it is the one object in the room whose whole job is
 * the specular term. A broad polished face angled slightly out of the wall sweeps its
 * highlight across the entire blade as the camera tracks past — a moving, unbroken band
 * of light on a large flat surface, which is the hardest thing for a renderer to fake and
 * the easiest for a viewer to judge. Nothing else here states it at that size.
 *
 * Mounted proud of the stone on two pegs, with a shadow gap behind it, so it reads as
 * hung rather than as painted on.
 */
function addWallBlade(builder: MeshBuilder, z: number, facing: number): void {
  const y = 7.2;
  const front = z + 0.9 * facing;

  /* A recessed panel behind it, so the sword has something to sit against. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([0, y, z + 0.25 * facing], [2.2, 5.6, 0.2], SANDSTONE_DEEP, 0, 0.16);
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (const side of [-1, 1]) {
    builder.addBox([side * 2.1, y, z + 0.3 * facing], [0.12, 5.6, 0.26], GOLD_DEEP, 0.12, 0.9);
  }

  /*
   * The blade: long, straight and barely tapered, with a raised central spine.
   *
   * It is the one object in the room whose whole job is the specular term, so it is built
   * to show it — a tall polished face angled a little out of the stone, sweeping a single
   * unbroken band of light along its whole length as the camera tracks past. That band is
   * the hardest thing for a renderer to fake and the easiest for a viewer to judge.
   *
   * Quads meeting at a spine rather than a slab: a flat card lights all at once and reads
   * as painted on, where two faces meeting at an edge break the highlight and read as
   * metal with a thickness.
   */
  /*
   * Polished iron, not gold, and the contrast is the point.
   *
   * Gold is a soft metal nobody forges a blade from, and against a room already made of
   * it the sword had nothing to be. A cool near-mirror in the middle of all that warm
   * metal separates immediately — and it separates *because of the shading*: the gold
   * around it is a broad warm sheen at ROUGH_GOLD, and this is a hard white sliver at
   * 0.03 that slides along the blade as the camera moves. Two roughnesses, one frame,
   * with nothing else different between them.
   *
   * Emissive is kept low for the same reason. A blade that glows is a lamp; this has to
   * be *lit*, so what the viewer sees on it is a reflection and not a paint colour.
   */
  builder.setRoughness(0.03);
  builder.setGrain(GRAIN_GOLD); // a polished blade
  const outline: readonly (readonly [number, number])[] = [
    [5.0, 0.05],
    [4.6, 0.3],
    [3.9, 0.42],
    [2.0, 0.46],
    [0.0, 0.48],
    [-1.6, 0.46],
    [-2.5, 0.42],
  ];
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i] as readonly [number, number];
    const b = outline[i + 1] as readonly [number, number];
    for (const side of [-1, 1]) {
      builder.addQuad(
        [0, y + a[0], front + 0.16 * facing],
        [side * a[1], y + a[0], front],
        [side * b[1], y + b[0], front],
        [0, y + b[0], front + 0.16 * facing],
        IRON_BRIGHT,
        0.1,
        1,
      );
      builder.addQuad(
        [0, y + b[0], front - 0.1 * facing],
        [side * b[1], y + b[0], front],
        [side * a[1], y + a[0], front],
        [0, y + a[0], front - 0.1 * facing],
        IRON_DARK,
        0.05,
        0.95,
      );
    }
  }

  /* Crossguard, grip and pommel — what makes it a sword rather than a spearhead. */
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  builder.addBox([0, y - 2.72, front], [1.15, 0.16, 0.16], GOLD, 0.3, 0.97);
  for (const side of [-1, 1]) {
    builder.addSphere([side * 1.2, y - 2.72, front], 0.19, GOLD, 0.32, 14, 7);
  }
  builder.addCapsule([0, y - 3.5, front], 0.13, 0.6, GOLD_DEEP, 0.16, 14, 7, 0.9);
  for (let i = 0; i < 5; i++) {
    builder.addCapsule([0, y - 3.05 - i * 0.26, front], 0.15, 0.045, GOLD, 0.26, 14, 7, 0.96);
  }
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  builder.addSphere([0, y - 4.35, front], 0.24, LAPIS, 0.8, 18, 9);
  builder.addSphere([0, y - 2.72, front + 0.18 * facing], 0.13, CARNELIAN, 0.85, 14, 7);
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * Four canopic jars on a low table, beside the dais.
 *
 * Round shouldered and round bellied, because a jar is a thrown vessel and there is no
 * flat on one anywhere. The detail that does the most for the least: a viewer who knows
 * what they are gets a jolt of recognition, and one who does not still sees four small
 * carefully made objects, which tells them the room was furnished rather than decorated.
 */
function addCanopicJars(builder: MeshBuilder, x: number, z: number): void {
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([x, 0.62, z], [1.5, 0.09, 0.55], SANDSTONE_PALE, 0, 0.2);
  for (const side of [-1, 1]) {
    builder.addBox([x + side * 1.3, 0.31, z], [0.12, 0.31, 0.42], SANDSTONE_DEEP, 0, 0.15);
  }
  for (let i = 0; i < 4; i++) {
    const jx = x + (i - 1.5) * 0.66;
    builder.setRoughness(0.32);
    builder.setGrain(GRAIN_STONE); // alabaster, polished and still stone
    addSpindle(
      builder,
      jx,
      z,
      [
        [0.72, 0.11],
        [0.86, 0.2],
        [1.06, 0.23],
        [1.24, 0.16],
        [1.34, 0.13],
      ],
      SANDSTONE_PALE,
      0,
    );
    // Each stopper is a different head, which here means a different rounded shape.
    builder.setRoughness(ROUGH_GOLD);
    builder.setGrain(GRAIN_GOLD);
    builder.addSphere([jx, 1.5, z], 0.15, GOLD_DEEP, 0.12, 14, 7);
    if (i % 2 === 0) builder.addCapsule([jx, 1.66, z], 0.09, 0.09, GOLD, 0.16, 12, 6, 0.92);
    else builder.addSphere([jx, 1.66, z], 0.11, GOLD, 0.16, 12, 6);
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/**
 * A funerary barque on a stand: the boat that carries the dead through the night.
 *
 * The one object with a long sweeping silhouette, which is exactly why it is here. A
 * chamber built entirely of rectangles needs something that curves from end to end or
 * the eye finds no relief anywhere.
 */
function addBarque(builder: MeshBuilder, x: number, z: number): void {
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  for (const side of [-1, 1]) {
    builder.addBox([x + side * 1.6, 0.45, z], [0.22, 0.45, 0.3], SANDSTONE_DEEP, 0, 0.15);
  }

  /* The hull: one arc, swept, so it curves rather than beads. */
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  const hull: number[] = [];
  const hullRadii: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t = (i / 8) * 2 - 1;
    hull.push(x + t * 2.2, 1.12 + t * t * 0.62, z);
    hullRadii.push(0.32 - Math.abs(t) * 0.15);
  }
  builder.addTube(hull, hullRadii, GOLD_DEEP, 0.1, 16);

  /* Stem and stern rising into a papyrus curl. */
  for (const side of [-1, 1]) {
    addSpindle(
      builder,
      x + side * 2.16,
      z,
      [
        [1.7, 0.13],
        [2.2, 0.1],
        [2.5, 0.16],
        [2.62, 0.09],
      ],
      GOLD,
      0.18,
    );
  }
  /* A small gilded shrine amidships, which is the one square thing on the boat. */
  builder.addBox([x, 1.72, z], [0.5, 0.4, 0.36], GOLD, 0.18, 0.95);
  builder.setRoughness(ROUGH_GEM);
  builder.setGrain(GRAIN_GEM);
  builder.addBox([x, 1.72, z + 0.38], [0.16, 0.16, 0.03], TURQUOISE, 0.6, 1);
  builder.setRoughness(null);
  builder.setGrain(0);
}

/** An offering table with bowls, the furniture of a room still being served. */
function addOfferings(builder: MeshBuilder, x: number, z: number, random: () => number): void {
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([x, 0.55, z], [0.9, 0.08, 0.7], SANDSTONE_PALE, 0, 0.2);
  builder.addBox([x, 0.28, z], [0.16, 0.28, 0.16], SANDSTONE_DEEP, 0, 0.15);
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (let i = 0; i < 3; i++) {
    const bx = x + (i - 1) * 0.5;
    const bz = z + (random() - 0.5) * 0.3;
    // A bowl: a wide shallow bell, round everywhere.
    addSpindle(
      builder,
      bx,
      bz,
      [
        [0.64, 0.07],
        [0.74, 0.16],
        [0.86, 0.2],
      ],
      GOLD_DEEP,
      0.1,
    );
  }
  builder.setRoughness(null);
  builder.setGrain(0);
}

/** Where the braziers stand, derived once so the geometry and the lights cannot disagree. */
const BRAZIER_Z: readonly number[] = Array.from(
  { length: BRAZIER_ROWS },
  (_, i) => (i - (BRAZIER_ROWS - 1) / 2) * BRAZIER_SPACING - 2,
);

/** Everything that never moves, merged into one mesh, plus what the boom may not enter. */
function buildChamber(): { mesh: MeshData; colliders: Collider[] } {
  const builder = new MeshBuilder();
  const colliders: Collider[] = [];
  const random = mulberry32(0x60_1d_5eed);

  /* Bedrock under everything, then the floor laid on it in slabs. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox([0, -0.9, 0], [HALL_HALF_X + 3, 0.5, HALL_HALF_Z + 3], SANDSTONE_DEEP, 0, 0.1);

  const slab = 2.6;
  const acrossX = Math.ceil(HALL_HALF_X / slab);
  const acrossZ = Math.ceil(HALL_HALF_Z / slab);
  for (let ix = -acrossX; ix <= acrossX; ix++) {
    for (let iz = -acrossZ; iz <= acrossZ; iz++) {
      const cx = ix * slab;
      const cz = iz * slab;
      if (Math.abs(cx) < CHANNEL_HALF_X + 0.5 && Math.abs(cz - CHANNEL_Z) < CHANNEL_HALF_Z + 0.5) {
        continue;
      }
      /*
       * The processional strip is polished and the rest is not.
       *
       * A floor of one material is a floor nobody looks at. The band the camera travels
       * along takes a tighter highlight, so the firelight runs down it in a streak while
       * the aisles beside it stay matte, and the room acquires a direction.
       */
      const onAxis = Math.abs(cx) < 8;
      const shade = 0.86 + random() * 0.26;
      builder.setRoughness(onAxis ? ROUGH_FLOOR : ROUGH_STONE);
      builder.setGrain(onAxis ? GRAIN_FLOOR : GRAIN_STONE);
      builder.addBox(
        [cx, -0.2, cz],
        [slab / 2 - 0.06, 0.2, slab / 2 - 0.06],
        [SANDSTONE[0] * shade, SANDSTONE[1] * shade, SANDSTONE[2] * shade],
        0,
        onAxis ? 0.35 : 0.1,
      );
    }
  }

  /*
   * Sand drifted into the corners and along the walls.
   *
   * The room has been shut for a long time and the desert has been getting in the whole
   * while. A few dozen low wedges along the wall feet is the difference between a set
   * that was built and a place that has been standing.
   */
  builder.setRoughness(0.95);
  builder.setGrain(0.6); // drifted sand, which is crushed rock and reads granular
  for (let i = 0; i < 60; i++) {
    const side = random() < 0.5 ? -1 : 1;
    const z = (random() - 0.5) * HALL_HALF_Z * 2;
    const reach = 0.8 + random() * 2.6;
    builder.addBox(
      [side * (HALL_HALF_X - reach * 0.5), -0.04 + random() * 0.05, z],
      [reach * 0.5, 0.09 + random() * 0.11, 1 + random() * 2.4],
      DRIFT,
      0,
      0.05,
    );
  }

  /* The channel: a sunken trough with a gold lip, for the water to sit in. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox(
    [0, WATER_LEVEL - 0.5, CHANNEL_Z],
    [CHANNEL_HALF_X, 0.15, CHANNEL_HALF_Z],
    SANDSTONE_DEEP,
    0,
    0.2,
  );
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (const side of [-1, 1]) {
    builder.addBox(
      [side * (CHANNEL_HALF_X + 0.2), -0.02, CHANNEL_Z],
      [0.2, 0.16, CHANNEL_HALF_Z + 0.2],
      GOLD_DEEP,
      0.08,
      0.9,
    );
  }

  /* Walls, their registers of glyphs, the cornice that crowns them and the cobras on it. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  for (const side of [-1, 1]) {
    const wx = side * (HALL_HALF_X + 0.8);
    builder.addBox(
      [wx, WALL_HEIGHT / 2, 0],
      [0.8, WALL_HEIGHT / 2, HALL_HALF_Z + 3],
      SANDSTONE,
      0,
      0.1,
    );
    colliders.push(boxCollider(wx, WALL_HEIGHT / 2, 0, 0.8, WALL_HEIGHT / 2, HALL_HALF_Z + 3));

    /*
     * Registers: bands of glyph cells, divided by carved rules.
     *
     * Six bands now rather than four, because the wall is half as tall again and a blank
     * upper third would be the first thing anybody noticed. This is what gives the
     * firelight something to move across; a bare wall in a room lit by fire is a flat
     * brown field.
     */
    const cell = 0.62;
    for (let band = 0; band < 6; band++) {
      const y = 2.4 + band * 1.85;
      builder.setRoughness(ROUGH_GOLD);
      builder.setGrain(GRAIN_GOLD);
      builder.addBox(
        [wx - side * 0.82, y + 0.82, 0],
        [0.03, 0.05, HALL_HALF_Z],
        GOLD_DEEP,
        0.08,
        0.8,
      );
      builder.setRoughness(ROUGH_STONE);
      builder.setGrain(GRAIN_STONE);
      for (let i = -24; i <= 24; i++) {
        addGlyph(builder, random, wx - side * 0.8, y, i * (cell + 0.22), cell / 2, -side as 1 | -1);
      }
    }

    addCornice(builder, wx - side * 0.8, WALL_HEIGHT - 2.2, HALL_HALF_Z + 3, -side);
    addUraeusFrieze(builder, wx - side * 1.5, WALL_HEIGHT - 0.6, -side);
  }

  /* End walls. The far one is solid behind the dais; the near one has the doorway. */
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  builder.addBox(
    [0, WALL_HEIGHT / 2, -HALL_HALF_Z - 0.8],
    [HALL_HALF_X + 1.6, WALL_HEIGHT / 2, 0.8],
    SANDSTONE,
    0,
    0.1,
  );
  colliders.push(
    boxCollider(0, WALL_HEIGHT / 2, -HALL_HALF_Z - 0.8, HALL_HALF_X + 1.6, WALL_HEIGHT / 2, 0.8),
  );

  /*
   * And everything that goes on it. This is the wall every shot down the axis ends on.
   */
  const endZ = -HALL_HALF_Z;
  addFalseDoor(builder, random, endZ, 1);
  addWingedDisc(builder, 8.4, endZ, 1);
  // Registers either side of the door, and one band running the full width above it.
  builder.setRoughness(ROUGH_STONE);
  builder.setGrain(GRAIN_STONE);
  for (const side of [-1, 1]) {
    for (let band = 0; band < 5; band++) {
      const y = 1.6 + band * 1.5;
      for (let i = 0; i < 8; i++) {
        addGlyph(builder, random, side * (3.6 + i * 0.86), y, endZ + 0.1, 0.34, 1);
      }
    }
  }
  for (let i = -10; i <= 10; i++) {
    addGlyph(builder, random, i * 0.9, 11.4, endZ + 0.1, 0.36, 1);
  }
  /* No cornice here: `addCornice` builds along Z and this wall runs along X. The side
     walls' cornices already turn the corner in the eye, and a wrongly axed one would be
     a bar of stone floating across the room. */
  for (const side of [-1, 1]) {
    builder.addBox(
      [side * 9.5, WALL_HEIGHT / 2, HALL_HALF_Z + 0.8],
      [7.5, WALL_HEIGHT / 2, 0.8],
      SANDSTONE,
      0,
      0.1,
    );
  }
  // The lintel over the doorway, so the opening is a doorway rather than a gap.
  builder.addBox([0, WALL_HEIGHT - 3, HALL_HALF_Z + 0.8], [2.4, 3, 0.8], SANDSTONE, 0, 0.1);

  /*
   * The ceiling, with a rectangular opening over the axis.
   *
   * Four slabs around a hole rather than one slab with a hole in it, because a hole is
   * the one shape a box cannot be. The opening is what makes the room a room: without a
   * ceiling the shaft of light has nothing to be a shaft *through*.
   */
  const ceilY = WALL_HEIGHT + 0.5;
  const outerX = HALL_HALF_X + 1.6;
  const outerZ = HALL_HALF_Z + 3;
  for (const [cx, cz, hx, hz] of [
    [0, (SHAFT_Z - SHAFT_HALF - outerZ) / 2, outerX, (outerZ + SHAFT_Z - SHAFT_HALF) / 2],
    [0, (SHAFT_Z + SHAFT_HALF + outerZ) / 2, outerX, (outerZ - SHAFT_Z - SHAFT_HALF) / 2],
    [(SHAFT_HALF + outerX) / 2, SHAFT_Z, (outerX - SHAFT_HALF) / 2, SHAFT_HALF],
    [-(SHAFT_HALF + outerX) / 2, SHAFT_Z, (outerX - SHAFT_HALF) / 2, SHAFT_HALF],
  ] as const) {
    if (hz <= 0 || hx <= 0) continue;
    builder.addBox([cx, ceilY, cz], [hx, 0.5, hz], SANDSTONE_DEEP, 0, 0.1);
  }
  // A gilded rim around the opening, which is the brightest thing in the room by day.
  builder.setRoughness(ROUGH_GOLD);
  builder.setGrain(GRAIN_GOLD);
  for (const [ox, oz, hx, hz] of [
    [0, SHAFT_Z - SHAFT_HALF, SHAFT_HALF + 0.2, 0.2],
    [0, SHAFT_Z + SHAFT_HALF, SHAFT_HALF + 0.2, 0.2],
    [SHAFT_HALF, SHAFT_Z, 0.2, SHAFT_HALF],
    [-SHAFT_HALF, SHAFT_Z, 0.2, SHAFT_HALF],
  ] as const) {
    builder.addBox([ox, ceilY - 0.55, oz], [hx, 0.12, hz], GOLD, 0.24, 0.95);
  }

  /* The colonnade, and an attendant standing between each pair. */
  for (let i = 0; i < COLUMN_ROWS; i++) {
    const z = (i - (COLUMN_ROWS - 1) / 2) * COLUMN_SPACING + 1;
    for (const side of [-1, 1]) {
      addColumn(builder, random, side * COLUMN_X, z);
      colliders.push(
        boxCollider(side * COLUMN_X, COLUMN_HEIGHT / 2, z, 1.5, COLUMN_HEIGHT / 2, 1.5),
      );
      if (i < COLUMN_ROWS - 1) {
        addAttendant(builder, side * (COLUMN_X - 2.6), z + COLUMN_SPACING / 2);
      }
    }
  }

  /* Obelisks at the doorway end, framing the approach. */
  for (const side of [-1, 1]) {
    addObelisk(builder, side * 6.5, HALL_HALF_Z - 6, 9);
    colliders.push(boxCollider(side * 6.5, 5, HALL_HALF_Z - 6, 1.2, 5, 1.2));
  }

  /* The dais end: two colossi, the sarcophagus, and the things left for the dead. */
  for (const side of [-1, 1]) addColossus(builder, side * 7.5, DAIS_Z + 2.5, 1);
  addSarcophagus(builder, random);
  addCanopicJars(builder, -6.2, DAIS_Z + 4.5);
  /* Traded pottery down the near aisle, and the blade on the wall behind the dais. */
  addGreekVases(builder, HALL_HALF_X - 4.2, DAIS_Z + 9, 1);
  addGreekVases(builder, -(HALL_HALF_X - 4.2), DAIS_Z + 9, -1);
  addWallBlade(builder, -HALL_HALF_Z, 1);
  addBarque(builder, 6.6, DAIS_Z + 4.5);
  addOfferings(builder, -3.4, DAIS_Z + 7.5, random);
  addOfferings(builder, 3.4, DAIS_Z + 7.5, random);

  /* Braziers: a bowl on a stand, with coals in it. */
  for (const sx of [-1, 1]) {
    for (const bz of BRAZIER_Z) {
      const x = sx * BRAZIER_X;
      builder.setRoughness(ROUGH_GRANITE);
      builder.setGrain(GRAIN_GRANITE);
      builder.addBox([x, 0.16, bz], [0.62, 0.16, 0.62], GRANITE, 0, 0.4);
      builder.addCylinder([x, 1.05, bz], 0.16, 0.9, 'y', GRANITE, 0, 8, 0.4);
      builder.setRoughness(ROUGH_GOLD);
      builder.setGrain(GRAIN_GOLD);
      builder.addCylinder([x, BRAZIER_TOP - 0.24, bz], 0.78, 0.24, 'y', GOLD_DEEP, 0.06, 16, 0.85);
      builder.setEmissiveColor(EMBER);
      builder.addCylinder([x, BRAZIER_TOP - 0.02, bz], 0.62, 0.06, 'y', EMBER, 1, 16);
      builder.setEmissiveColor(null);
    }
  }

  builder.setRoughness(null);
  builder.setGrain(0);
  return { mesh: builder.build(), colliders };
}

/* -- The shaft of daylight ------------------------------------------------- */

/** Where the shaft becomes visible, and where it lands. */
const SHAFT_TOP_Y = WALL_HEIGHT - 0.2;
const SHAFT_BOTTOM_Y = DAIS_TOP + 1.4;
const SHAFT_FALL_M = SHAFT_TOP_Y - SHAFT_BOTTOM_Y;
/**
 * How far above the opening the cone this shaft is a slice of has its apex.
 *
 * `drawLightVolume` fades the light over a cone opening from its own origin, so a beam that is
 * nearly parallel is a narrow slice taken far down a very wide one. Twice the fall is the
 * trade: near enough that the light still dims usefully between the opening and the floor, far
 * enough that the shaft only widens by half over its length rather than flaring like a spot.
 */
const SHAFT_APEX_M = SHAFT_FALL_M * 2;
/** Half-width over distance, set so the cone is exactly the opening's width at the opening. */
const SHAFT_SPREAD = SHAFT_HALF / SHAFT_APEX_M;
/** The light reaches zero where the shaft lands, so nothing of it survives onto the floor. */
const SHAFT_REACH_M = SHAFT_APEX_M + SHAFT_FALL_M;

/**
 * The visible shaft of daylight, in the volume's own space: down its own +Z from an apex above
 * the roof.
 *
 * **It was invisible, and it was also in the wrong place.** Drawn with `drawTranslucentMesh` at
 * an opacity of 0.1, its contribution to a lit room rounded to nothing: switching the draw call
 * off changed the frame by not one pixel, at two separate camera shots. And because nothing was
 * ever on screen, nobody could see that the geometry was built about `z = 0` while the opening
 * it falls through is at `SHAFT_Z`, seven metres away. One defect hid the other, which is the
 * shape almost every bug in this project has had.
 *
 * Now drawn with `drawLightVolume`, which is what it is: light in the air, added rather than
 * blended, with the renderer shaping the falloff along the shaft and away from its axis. Three
 * panes crossing the axis rather than four leaning inward, because the shape is the shader's
 * now and the panes only have to cover the volume.
 *
 * `buildLightVolume` is given the same reach and aperture the draw call is, so the geometry and
 * the falloff cannot drift apart. `nearM` is what makes this a slice of a cone rather than a
 * beam: the apex is above the roof and only the part below the opening is ever drawn.
 */
function buildShaft(): MeshData {
  return buildLightVolume({
    nearM: SHAFT_APEX_M,
    lengthM: SHAFT_REACH_M,
    spread: SHAFT_SPREAD,
    color: SHAFT_COLOR,
  });
}

/**
 * The shaft's placement: its apex above the opening, its axis pointing at the floor.
 *
 * Column major, and a plain rotation rather than anything composed: local +X stays world +X,
 * local +Y becomes world +Z, and local +Z becomes world **-Y**, which is the direction daylight
 * falls. That triple is right-handed, which matters because the panes' normals come from their
 * winding and a mirrored frame would turn every one of them inside out.
 */
const SHAFT_MODEL = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  -1,
  0,
  0,
  0,
  SHAFT_TOP_Y + SHAFT_APEX_M,
  SHAFT_Z,
  1,
]);

const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  /*
   * The engine's defaults, and this scene is the reason that matters most.
   *
   * It is the one a studio is most likely to judge the engine on, so it runs the
   * configuration with production evidence behind it rather than anything trimmed here
   * on one machine. See `nightCourt` for what happened the last time a demo chose its own
   * render quality.
   */
  full: {
    /*
     * Four samples. The one place a demo deliberately asks for *more* than the engine
     * default, because the default is 1 only so that no scene written before multisampling
     * existed changes by a bit — not because 1 is the right look. These scenes are what the
     * engine is judged on, and a panel gap or a trim edge seen at a shallow angle is a
     * staircase without it.
     */
    sceneSamples: 4,
  },
  lean: {
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
    directionalShadows: false,
    pointShadowFaceSize: 256,
    pointShadowFacesPerFrame: 1,
    shadowFilterTaps: 4,
    waterReflections: false,
    screenEffects: false,
    waterResolution: 64,
    plumeNoiseOctaves: 1,
  },
};

class GildedChamberHandle implements DemoHandle {
  /**
   * Held only to dispose engine objects whose `dispose` still takes a context.
   *
   * Null on a backend that is not WebGL2. Asked of the canvas rather than accepted from a
   * host, because a canvas that has given a `webgpu` context cannot also give this one, and
   * a host that supplies it is choosing the backend by accident.
   */
  private readonly gl: WebGL2RenderingContext | null;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: RendererApi;

  /** Which backend is actually drawing, asked of the renderer rather than of the address bar. */
  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  /** Whether the device has gone, so a host can remount rather than show a black frame. */
  get lost(): boolean {
    return this.renderer.contextLost;
  }
  private readonly camera = new Camera();
  readonly view = new OrbitView(6, 80, 0.6);

  private readonly chamber: MeshHandle;
  private readonly shaft: MeshHandle;
  private readonly water: WaterHandle;
  private readonly fire: PlumeHandle;
  private readonly smoke: PlumeHandle;
  private readonly dust: ParticlePool;
  private readonly dustBatch: ParticleHandle;
  private readonly env: Environment;
  private readonly sky: SkyColors;
  private readonly body: WaterBody;
  private readonly lights: PointLightSource[];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly lightMatrix = new Float32Array(16);
  private readonly casters: ShadowCasters;
  private readonly player = new CinematicPlayer(EDIT, 'gilded-chamber');
  private readonly cinema: CinematicCamera;
  private readonly random = mulberry32(0xd0_5e_11a);
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };

  private elapsedSec = 0;
  private nextMoteSec = 0;
  private disposed = false;
  private lastGpuMs = 0;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2');
    this.canvas = canvas;
    this.renderer = renderer;
    const renderer_ = renderer;

    const chamber = buildChamber();
    this.chamber = renderer.createMesh(chamber.mesh);
    this.shaft = renderer.createMesh(buildShaft());
    /*
     * The room's own walls and columns, handed to the camera rig.
     *
     * `CinematicCamera` keeps its boom out of solid geometry, so a shot swinging round
     * the dais cannot end up inside a column. The set is the same one a game would build
     * for movement; here it exists purely so the edit cannot produce a shot from inside a
     * wall, which is the single most expensive-looking mistake a cutscene can make.
     */
    this.cinema = new CinematicCamera(new ColliderSet(chamber.colliders));

    this.water = renderer.createWater(96, 52, 140);
    this.fire = renderer.createPlumes(BRAZIER_PLUMES, {
      material: 'fire',
      blend: 'additive',
      sizePulse: 0.2,
      windResponse: 0.05,
    });
    this.smoke = renderer.createPlumes(SMOKE_PLUMES, {
      material: 'smoke',
      blend: 'alpha',
      sizePulse: 0.35,
      windResponse: 0.35,
      tint: [0.3, 0.26, 0.22],
    });

    /*
     * Dust in the shaft, and it is the cheapest thing in the scene by a distance.
     *
     * A beam of light with nothing turning over inside it reads as a solid object. Motes
     * are what make it air. Additive, because they are lit by the beam rather than by
     * the room, and slow, because dust in still air is the slowest thing in any room.
     */
    this.dust = new ParticlePool({
      capacity: 260,
      lifeSec: 9,
      sizeStart: 0.035,
      sizeEnd: 0.02,
      colorStart: [1, 0.9, 0.66],
      colorEnd: [0.6, 0.5, 0.34],
      gravity: 0.045,
      drag: 0.4,
      rise: 0.02,
      alphaStart: 0.8,
      alphaEnd: 0,
    });
    this.dustBatch = renderer.createParticles(260, {
      material: 'smoke',
      blend: 'additive',
      erosion: 0.2,
    });

    this.env = createEnvironment({
      // Steep, so the shaft lands on the dais rather than raking down a wall.
      directionalDir: [-0.12, 0.96, 0.25],
      directionalColor: SUN,
      // An interior lit by four fires and one hole. The ambient has to be low or the
      // firelight has nothing to be brighter than.
      ambient: [0.075, 0.062, 0.052],
      ambientGround: [0.04, 0.033, 0.028],
      emissiveGain: 1,
      nightFactor: 0.35,
      fogColor: [0.16, 0.12, 0.09],
      // Enough to give the far end of the hall some depth. A room this long with no
      // medium in it looks like a diagram.
      fogDensity: 0.011,
      fogHeightFalloff: 0.02,
      fogBaseY: 0,
    });
    this.env.lightPositions = this.lightBuffer.positions;
    this.env.lightColors = this.lightBuffer.colors;
    this.env.lightRadii = this.lightBuffer.radii;
    /* The emitter's own size, which is what lets a highlight be as wide as the light is. */
    this.env.lightSourceRadii = this.lightBuffer.sourceRadii;
    this.env.lightWeights = this.lightBuffer.weights;
    this.env.activeLightWorldIndices = this.lightBuffer.sourceIndex;

    this.sky = {
      // Only ever seen through the opening, so it is a hot desert noon and nothing else.
      top: [0.55, 0.68, 0.92],
      horizon: [0.86, 0.82, 0.72],
      deep: [0.4, 0.56, 0.85],
      sunDir: this.env.directionalDir,
      sunColor: [1.4, 1.25, 0.95],
      sunAngularRadius: 0.005,
      moonDir: [0, -1, 0],
      moonColor: [0, 0, 0],
      moonAngularRadius: 0.01,
      moonPhase: 0.5,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    };

    this.body = {
      level: WATER_LEVEL,
      deepColor: [0.05, 0.06, 0.07],
      shallowColor: [0.11, 0.12, 0.12],
      density: 0.55,
      visibility: 1,
      // Still water in a sheltered room, and a near mirror because that is what carries
      // the gold: the reflection is doing the work the colour cannot in this light.
      mirror: 0.86,
      waveScale: 0.15,
      agitation: 0.18,
      /*
       * The channel's own two extents, and it took until 2026-08-28 to be able to say so: this
       * was `halfM: CHANNEL_HALF_Z`, a 42-metre square of water over a 6-metre channel, hidden
       * everywhere but the trough because the floor stands above the water line. The trick worked
       * and it cost the scene the truth — anything cut into that floor would have flooded.
       */
      bounds: { centreX: 0, centreZ: CHANNEL_Z, halfX: CHANNEL_HALF_X, halfZ: CHANNEL_HALF_Z },
    };

    this.lights = [];
    for (const sx of [-1, 1]) {
      for (const bz of BRAZIER_Z) {
        this.lights.push({
          x: sx * BRAZIER_X,
          y: BRAZIER_TOP + 0.5,
          z: bz,
          r: FIRE_LIGHT[0],
          g: FIRE_LIGHT[1],
          b: FIRE_LIGHT[2],
          radius: 26,
          flicker: 0.22,
          shadowNear: 0.25,
          sourceRadius: 0.4,
        });
      }
    }

    this.casters = (sink) => {
      this.stats.draws++;
      sink.mesh(this.chamber, IDENTITY);
    };

    this.camera.near = 0.3;
    this.camera.far = 200;

    renderer.resize();
    renderer.prepareStaticPointShadows(this.lights);
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    if (this.disposed) return this.stats;

    this.elapsedSec += dtSec;
    const now = this.elapsedSec;
    this.stats.draws = 0;
    renderer.resize();

    /*
     * The edit, then the rig.
     *
     * The player owns *when*, the rig owns *how it gets there*, and the split is the
     * reason a cut is instant while the motion inside a shot is sprung. Looping by hand
     * at the end, because a demo that stopped after a minute would look broken.
     */
    this.player.update(dtSec);
    if (this.player.finished) this.player.reset();
    const shot = this.player.shot;
    if (this.player.shotChanged && shot !== null) this.cinema.cut(shot, this.player.timeSec);
    this.cinema.update(dtSec, 0, SUBJECT_Y, DAIS_Z, 0);

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
      camera.fovYDeg = 52;
    } else {
      // The rig's camera, copied onto the scene's own, so a viewer taking the controls
      // takes over the same object rather than a second one that has to be reconciled.
      const from = this.cinema.camera;
      camera.position[0] = from.position[0] ?? 0;
      camera.position[1] = from.position[1] ?? 0;
      camera.position[2] = from.position[2] ?? 0;
      camera.yaw = from.yaw;
      camera.pitch = from.pitch;
      camera.fovYDeg = from.fovYDeg;
      this.view.follow(camera, 0, SUBJECT_Y, DAIS_Z);
    }
    const height = this.canvas.height;
    camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    this.driftDust(dtSec);

    const env = this.env;
    selectPointLights(
      this.lights,
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
      this.lightBuffer,
      now,
    );
    env.lightCount = this.lightBuffer.count;

    renderer.gpuTimer.beginFrame();

    renderer.updatePointShadows(
      this.lights,
      this.lightBuffer.sourceIndex,
      env.lightCount,
      0,
      SUBJECT_Y,
      DAIS_Z,
      dtSec,
      this.casters,
      NO_MOVING_CASTERS,
      this.lightBuffer.shadowIndex,
      this.lightBuffer.shadowCount,
    );

    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      2,
      SHAFT_Z,
      22,
      renderer.shadowMapSize,
      this.lightMatrix,
    );
    env.lightViewProj = this.lightMatrix;
    env.shadowStrength = 0.9;
    renderer.beginShadowPass(this.lightMatrix, 'static');
    renderer.drawShadowCasters(this.casters);
    renderer.endShadowPass();
    renderer.beginShadowPass(this.lightMatrix, 'static-peel');
    renderer.drawShadowCasters(this.casters);
    renderer.endShadowPass();

    renderer.beginFrame(env.fogColor as Vec3);

    const mirrored = renderer.beginPlanarReflection(camera, WATER_LEVEL, env.fogColor as Vec3);
    if (mirrored !== null) {
      this.drawScene(mirrored);
      renderer.endPlanarReflection();
    }

    renderer.gpuTimer.begin('rest');
    this.drawScene(camera);
    /*
     * A current down the channel.
     *
     * The wave field travels along the direction it is handed, so a steady value here is
     * a flow rather than a breeze: the water moves from the dais toward the doorway, in
     * one direction, forever. It was passed zero before, which gave a surface that
     * rippled in place and read as glass somebody was shaking.
     */
    renderer.drawWater(this.water, camera, now, this.body, env, 0.15, 1.35);
    this.stats.draws++;
    renderer.drawParticles(this.dustBatch, this.dust.particles, camera, env, now);
    this.stats.draws++;
    /*
     * Last, and drawn as light rather than as a translucent surface. Blending a pale surface
     * over a lit room at a tenth of an opacity added nothing a frame could hold; light adds.
     */
    renderer.drawLightVolume(this.shaft, SHAFT_MODEL, camera, 0.72, SHAFT_REACH_M, SHAFT_SPREAD, {
      /*
       * The two terms that separate a shaft of daylight from a torch beam, which is the whole
       * difference this scene is here to show. `dust` breaks the body up, because what a shaft
       * lights is the motes in it and those are uneven; `sunShadow` cuts it to the shape of the
       * opening it falls through, so the light in the air agrees with the light on the floor.
       *
       * The drift is a slow lift rather than a lateral push. There is no wind indoors, but the
       * air over a room this warm is not still either, and motes standing perfectly still read
       * as a texture stuck to the screen.
       */
      dust: 0.26,
      dustScaleM: 2.8,
      driftM: [0, -now * 0.06, 0],
      sunShadow: 0.85,
      nearM: SHAFT_APEX_M,
      env,
    });
    this.stats.draws++;
    renderer.gpuTimer.end();

    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;
    this.stats.extra = shot === null ? 'cutting' : `${shot.kind} shot`;

    return this.stats;
  }

  /** Everything the mirrored camera and the real one both submit. */
  private drawScene(camera: Camera): void {
    const renderer = this.renderer;
    const env = this.env;
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(this.chamber, IDENTITY);
    renderer.drawSky(camera, this.sky, env);
    renderer.drawPlumes(this.fire, camera, this.elapsedSec, env, 0.2, 0.1);
    renderer.drawPlumes(this.smoke, camera, this.elapsedSec, env, 0.35, 0.15);
    this.stats.draws += 4;
  }

  /** Seed a mote somewhere in the shaft, now and then. Nothing here allocates. */
  private driftDust(dtSec: number): void {
    this.dust.update(dtSec);
    this.nextMoteSec -= dtSec;
    if (this.nextMoteSec > 0) return;
    this.nextMoteSec = 0.05;
    const random = this.random;
    this.dust.emit(
      (random() - 0.5) * SHAFT_HALF * 2,
      DAIS_TOP + 1.6 + random() * (WALL_HEIGHT - DAIS_TOP - 1.4),
      SHAFT_Z + (random() - 0.5) * SHAFT_HALF * 2,
      (random() - 0.5) * 0.14,
      (random() - 0.5) * 0.06,
      (random() - 0.5) * 0.14,
      random(),
    );
  }

  /**
   * Density, so a host that measures this scene can soften it rather than stop it.
   *
   * A getter rather than a stored object: `this.renderer` is assigned in the constructor body
   * on most of these scenes and a class field would be initialised before it, which would
   * capture `undefined` and fail at the first frame a governor moved.
   */
  get resolution(): ResolutionControl {
    return {
      ceiling: this.renderer.resolutionScale,
      apply: (scale: number): void => this.renderer.applyResolutionScale(scale),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeMesh(this.chamber);
    this.renderer.disposeMesh(this.shaft);
    /* Null on any backend but WebGL2, whose objects are the only ones that took one. */
    if (this.gl !== null) {
    }
    this.renderer.disposePlumes(this.fire);
    this.renderer.disposePlumes(this.smoke);
    this.renderer.disposeWater(this.water);
    this.renderer.disposeParticles(this.dustBatch);
    this.renderer.dispose();
  }
}

/** Nothing in this room moves, so the live-caster enumeration is empty. */
const NO_MOVING_CASTERS: ShadowCasters = () => {};

const BRAZIER_PLUMES: readonly PlumePlacement[] = BRAZIER_Z.flatMap((z) =>
  [-1, 1].map((side) => ({ x: side * BRAZIER_X, y: BRAZIER_TOP, z, width: 0.52, height: 1.9 })),
);

const SMOKE_PLUMES: readonly PlumePlacement[] = BRAZIER_PLUMES.map((plume) => ({
  x: plume.x,
  y: plume.y + 2,
  z: plume.z,
  width: 1,
  height: 4.4,
}));

export const gildedChamber: DemoScene = {
  id: 'gilded-chamber',
  title: 'The gilded chamber',
  note: 'A burial chamber cut like a film: four shadow-casting fires, a shaft of daylight with dust turning in it, gold and lapis that read as metal and stone, and a channel of water reflecting the room. The camera works from a timeline of shots.',
  async mount(
    canvas: HTMLCanvasElement,
    budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(
      canvas,
      { ...PROFILES[budget], ...overrides },
      DEMO_BACKEND,
    );
    /* Pipelines compiled before the first frame rather than inside it; on WebGPU
       `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
    await renderer.ready();
    return new GildedChamberHandle(renderer, canvas);
  },
};
