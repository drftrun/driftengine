/**
 * A lamp-lit court after dark: the engine drawing itself, out of nothing.
 *
 * Every surface here is a coloured triangle the engine generated at mount. There is
 * no model file, no texture, no material library and no download — the whole scene is
 * a few hundred lines of arithmetic, which is the claim this engine makes and the one
 * thing a screenshot cannot prove on its own.
 *
 * **What it is composed to show, in the order it earns attention:**
 *
 *   1. **Five point lights that occlude.** Four lanterns and a fire, each with its own
 *      shadow cubemap, throwing the colonnade across the stone from five directions at
 *      once. Soft-edged, because a lantern is a physical object of some size rather
 *      than a mathematical point, and penumbra width follows from that size.
 *   2. **A reflection that is the scene, not the sky.** The basin re-renders the world
 *      from the mirrored camera, so the fire and the columns are in the water because
 *      they are in front of it.
 *   3. **Fire and smoke from one component.** Both plumes are the same renderer with a
 *      different fragment shader and a different response to wind: a flame is anchored
 *      to its fuel, smoke is carried off.
 *   4. **It never allocates.** Geometry, lights and matrices are built once at mount.
 *      The frame reads them and returns what it cost.
 *
 * A single mesh carries the entire fixed world, which is why the frame count stays in
 * single figures no matter how much stone is on screen. That is not a trick for a demo;
 * it is what `MeshBuilder` exists to do.
 */

import type { DemoBudget, DemoHandle, DemoScene, DemoStats, ResolutionControl } from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  Camera,
  MeshBuilder,
  TAU,
  clamp,
  computeLightMatrix,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  damp,
  lerp,
  mixColorInto,
  mulberry32,
  selectPointLights,
} from '../packages/core/src/index';
import type {
  Environment,
  MeshHandle,
  MeshData,
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

/* -- The court, in metres ------------------------------------------------- */

/** Half the paved square. Wide enough that its far edge falls into the fog. */
const COURT_HALF_M = 17;
/** Paving pitch and the joint between slabs, which is what catches lamp light. */
const SLAB_PITCH_M = 1.625;
const SLAB_JOINT_M = 0.06;
/** The basin: water to `POOL_HALF_M`, kerb out to `KERB_HALF_M`. */
const POOL_HALF_M = 4.6;
const KERB_HALF_M = 5.2;
const WATER_LEVEL_M = -0.14;
const BASIN_FLOOR_M = -0.85;
/** Lanterns standing on the kerb, at the four corners of the basin. */
const LANTERN_COUNT = 4;
const LANTERN_HALF_M = 4.9;
const LANTERN_HEAD_M = 3.35;
/** A ring of columns outside the lanterns, so the light has something to throw. */
const COLUMN_COUNT = 8;
const COLUMN_RING_M = 9.6;
const COLUMN_HEIGHT_M = 3.9;
/**
 * Figures on a ring between the lanterns and the colonnade.
 *
 * On the axes, where the lanterns are on the diagonals, so each figure stands about
 * five metres from two of them rather than inside one. That is where a point light does
 * its most legible work: the near side is lit, the far side falls away, and the shadow
 * behind runs out to the columns and softens as it goes, because penumbra widens with
 * distance from the caster.
 */
const FIGURE_COUNT = 4;
const FIGURE_RING_M = 7.1;
/**
 * The fire, on a plinth in the middle of the water.
 *
 * It was set back behind the basin at first, which put the reflection in frame for
 * about a third of the orbit and left the other two thirds looking at an empty pool.
 * In the middle it is mirrored from every angle, so there is no stretch of the loop
 * that is the weak half.
 */
const FIRE_X_M = 0;
const FIRE_Z_M = 0;
const FIRE_BOWL_M = 1.3;

/* -- The camera ----------------------------------------------------------- */

/**
 * One unhurried circuit, and a rise and fall on a period that does not divide it.
 *
 * Coprime-ish on purpose: a bob that completed a whole number of cycles per orbit
 * would make the whole thing visibly repeat, and a hero loop that a reader can see
 * repeating stops being a scene and starts being a GIF.
 */
const ORBIT_SECONDS = 72;
/**
 * Outside every fixture, and that is a constraint rather than a preference.
 *
 * The first arrangement had the lanterns on a ring of 12.7 m and the camera on one of
 * 14, which reads as comfortable and is not: the two rings are 1.3 m apart, so the
 * camera flew through a lantern head four times per orbit and a hero frame taken at
 * the wrong second was a bright orange slab filling a third of the screen. The
 * clearance from the outermost fixture is now about five metres.
 */
const ORBIT_RADIUS_M = 16;
/*
 * High enough to look over the near columns rather than up at them.
 *
 * At eye level the capitals of whichever columns the camera is passing crop across the
 * top of the frame as two dark beams, which reads as damage rather than as architecture.
 * Above them the same columns become a colonnade with a floor behind it, and the basin
 * opens up enough for the reflection to be worth having.
 */
const ORBIT_HEIGHT_M = 4.4;
const BOB_SECONDS = 23;
const BOB_M = 0.55;
/** What the camera holds: the fire on its plinth, a little above the water. */
const LOOK_Y_M = 1.6;
const LOOK_Z_M = 0;

/* -- Palette -------------------------------------------------------------- */

const STONE: Vec3 = [0.215, 0.213, 0.226];
/**
 * What is under the joints between the slabs, and it has to be something.
 *
 * Each slab is its own box with `SLAB_JOINT_M` of clear air between it and its neighbour, and
 * until this existed there was nothing behind that air at all: a joint was a hole straight
 * through the floor, and at the grazing angle this scene is photographed from you saw the
 * background through it. Reported as squared black lines across the paving, which is exactly
 * what a 6 cm gap over a void looks like from here. The comment on `SLAB_JOINT_M` says the
 * joint is there so the light finds edges, and a hole has no edge to find: the light needs a
 * bed to fall on.
 *
 * Darker than the slabs, because mortar is, and because a joint that reads as the same stone
 * reads as nothing.
 */
const JOINT_BED: Vec3 = [0.13, 0.128, 0.138];
const KERB: Vec3 = [0.26, 0.252, 0.262];
/* Pale, so the basin floor is visible through the water rather than being a void. */
const BASIN: Vec3 = [0.2, 0.215, 0.228];
const IRON: Vec3 = [0.085, 0.083, 0.09];
const COLUMN_STONE: Vec3 = [0.245, 0.24, 0.252];
/* Marble, and far paler than anything else here so a lantern has something to find. */
const MARBLE: Vec3 = [0.74, 0.725, 0.685];
const MARBLE_SHADE: Vec3 = [0.6, 0.585, 0.55];
/** What the lantern glass and the coals emit, as opposed to what they are made of. */
const LANTERN_GLOW: Vec3 = [1, 0.72, 0.38];
const EMBER_GLOW: Vec3 = [1, 0.44, 0.15];
/** The light a lantern and a fire actually cast. Magnitude near one; reach is `radius`. */
const LANTERN_LIGHT: Vec3 = [1, 0.66, 0.3];
const FIRE_LIGHT: Vec3 = [1, 0.5, 0.16];

/* -- Weather -------------------------------------------------------------- */

/**
 * A steady breath of air rather than a gust, and the reason it is a constant.
 *
 * Wind drives the smoke's lean, the wave field and nothing else here. A varying one
 * would need a state machine and would read, at this scale, as the smoke changing its
 * mind. `sampleWind` exists in the engine for worlds that want weather.
 */
const WIND_X = 0.55;
const WIND_Z = 0.22;

/** The one model matrix in the scene: the fixed world is authored in world space. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Nothing in this scene moves, so the live-caster enumeration is empty by construction. */
const NO_MOVING_CASTERS: ShadowCasters = () => {};

/**
 * Everything fixed, merged into one mesh.
 *
 * Built at mount rather than at module scope: a reader who asked for reduced motion,
 * or who is on a machine that declines the scene, should not have paid for a single
 * vertex of it. Merging is what keeps the frame at a handful of draw calls — the paving
 * alone is several hundred slabs, and several hundred draw calls for a floor is how a
 * browser engine earns its reputation.
 */
function buildCourt(): MeshData {
  const builder = new MeshBuilder();
  /*
   * Seeded, so the stone is identical on every machine and in every session.
   *
   * `Math.random()` would have done visually and would have made the scene a
   * different scene on every load, which is the one property that makes a rendering
   * bug impossible to report and impossible to confirm fixed.
   */
  const random = mulberry32(0x5eed_c0de);

  /* --- Paving. Skipped where the basin is, and jointed so the light finds edges. */
  builder.setRoughness(0.82);
  /* Cut stone, and so is everything down to the lanterns: paving, kerb, basin, columns. */
  builder.setGrain(0.85);
  const slabs = Math.ceil((COURT_HALF_M * 2) / SLAB_PITCH_M);
  const slabHalf = SLAB_PITCH_M / 2 - SLAB_JOINT_M / 2;
  for (let ix = 0; ix < slabs; ix++) {
    for (let iz = 0; iz < slabs; iz++) {
      const cx = -COURT_HALF_M + (ix + 0.5) * SLAB_PITCH_M;
      const cz = -COURT_HALF_M + (iz + 0.5) * SLAB_PITCH_M;
      if (Math.abs(cx) < KERB_HALF_M && Math.abs(cz) < KERB_HALF_M) continue;
      // A few percent either side. Enough that the floor is not a flat field of one
      // colour, far too little to read as a pattern.
      const shade = 0.92 + random() * 0.16;
      builder.addBox(
        [cx, -0.08, cz],
        [slabHalf, 0.08, slabHalf],
        [STONE[0] * shade, STONE[1] * shade, STONE[2] * shade],
      );
      /*
       * And the bed the joint sits on, at full pitch so it meets its neighbour's rather than
       * leaving a second, thinner gap. Emitted here rather than as one slab under the whole
       * court so that it inherits the basin skip above by construction: a separate shape with
       * its own idea of where the basin is would sit above the water the first time either
       * moved. Its top is 4 cm down and its bottom is level with the slab's, so it fills the
       * joint without standing proud of the paving or hanging below it.
       */
      builder.addBox([cx, -0.1, cz], [SLAB_PITCH_M / 2, 0.06, SLAB_PITCH_M / 2], JOINT_BED);
    }
  }

  /* --- The basin: a kerb, and a floor for the water to show. */
  const kerbMid = (POOL_HALF_M + KERB_HALF_M) / 2;
  const kerbHalf = (KERB_HALF_M - POOL_HALF_M) / 2;
  builder.setRoughness(0.6);
  builder.addBox([0, 0.02, kerbMid], [KERB_HALF_M, 0.14, kerbHalf], KERB, 0, 0.25);
  builder.addBox([0, 0.02, -kerbMid], [KERB_HALF_M, 0.14, kerbHalf], KERB, 0, 0.25);
  builder.addBox([kerbMid, 0.02, 0], [kerbHalf, 0.14, POOL_HALF_M], KERB, 0, 0.25);
  builder.addBox([-kerbMid, 0.02, 0], [kerbHalf, 0.14, POOL_HALF_M], KERB, 0, 0.25);
  builder.setRoughness(0.5);
  builder.addBox([0, BASIN_FLOOR_M, 0], [POOL_HALF_M, 0.1, POOL_HALF_M], BASIN, 0, 0.3);

  /* --- The colonnade. Offset half a step off the axes so nothing lines up with the
         fire, and so a camera coming round never has two columns eclipse. */
  builder.setRoughness(0.75);
  for (let i = 0; i < COLUMN_COUNT; i++) {
    const angle = ((i + 0.5) / COLUMN_COUNT) * TAU;
    const cx = Math.cos(angle) * COLUMN_RING_M;
    const cz = Math.sin(angle) * COLUMN_RING_M;
    builder.addBox([cx, 0.09, cz], [0.42, 0.09, 0.42], COLUMN_STONE);
    builder.addCylinder(
      [cx, COLUMN_HEIGHT_M / 2 + 0.18, cz],
      0.26,
      COLUMN_HEIGHT_M / 2,
      'y',
      COLUMN_STONE,
      0,
      14,
    );
    builder.addBox([cx, COLUMN_HEIGHT_M + 0.24, cz], [0.4, 0.1, 0.4], COLUMN_STONE);
  }

  /*
   * --- Lanterns: an iron cage with the light inside it.
   *
   * The first attempt was a solid iron block with a glowing box in the same place, and
   * the glowing box was 1.5 cm larger on every side — so the housing was entirely
   * inside the glass and what a reader saw was a bright yellow crate with a lid. A
   * lantern is a frame with panes set *into* it, which is four thin uprights, two
   * plates, and a light that is smaller than all of them.
   */
  const CAGE = 0.19;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * LANTERN_HALF_M;
      const cz = sz * LANTERN_HALF_M;
      builder.setRoughness(0.4);
      /* Wrought iron and glass. Both are worked rather than quarried, so neither grains. */
      builder.setGrain(0);
      builder.addBox([cx, 0.24, cz], [0.3, 0.12, 0.3], IRON, 0, 0.4);
      builder.addCylinder([cx, 1.85, cz], 0.07, 1.55, 'y', IRON, 0, 10, 0.5);
      // Floor and roof of the cage, both a little wider than the panes they hold.
      builder.addBox([cx, LANTERN_HEAD_M - 0.27, cz], [0.24, 0.045, 0.24], IRON, 0, 0.5);
      builder.addBox([cx, LANTERN_HEAD_M + 0.27, cz], [0.27, 0.05, 0.27], IRON, 0, 0.5);
      builder.addBox([cx, LANTERN_HEAD_M + 0.36, cz], [0.16, 0.04, 0.16], IRON, 0, 0.5);
      for (const ux of [-1, 1]) {
        for (const uz of [-1, 1]) {
          builder.addBox(
            [cx + ux * CAGE, LANTERN_HEAD_M, cz + uz * CAGE],
            [0.032, 0.27, 0.032],
            IRON,
            0,
            0.5,
          );
        }
      }
      // The flame, set inside the frame so the uprights read as being in front of it.
      builder.setRoughness(0.2);
      builder.setEmissiveColor(LANTERN_GLOW);
      builder.addBox([cx, LANTERN_HEAD_M, cz], [0.165, 0.24, 0.165], LANTERN_GLOW, 1);
      builder.setEmissiveColor(null);
    }
  }

  /* --- The fire, on a plinth that comes up out of the water. */
  builder.setRoughness(0.55);
  /* Back to stone for the plinth and its cap. */
  builder.setGrain(0.85);
  builder.addBox(
    [FIRE_X_M, (BASIN_FLOOR_M + 0.5) / 2, FIRE_Z_M],
    [0.92, (0.5 - BASIN_FLOOR_M) / 2, 0.92],
    COLUMN_STONE,
    0,
    0.2,
  );
  builder.addBox([FIRE_X_M, 0.58, FIRE_Z_M], [1.04, 0.09, 1.04], KERB, 0, 0.25);
  builder.setRoughness(0.45);
  /* And the bowl it stands in is iron again. */
  builder.setGrain(0);
  builder.addCylinder([FIRE_X_M, 0.85, FIRE_Z_M], 0.22, 0.22, 'y', IRON, 0, 8, 0.4);
  builder.addCylinder([FIRE_X_M, FIRE_BOWL_M - 0.2, FIRE_Z_M], 0.72, 0.22, 'y', IRON, 0, 16, 0.4);
  builder.setEmissiveColor(EMBER_GLOW);
  builder.addCylinder([FIRE_X_M, FIRE_BOWL_M - 0.02, FIRE_Z_M], 0.6, 0.05, 'y', EMBER_GLOW, 1, 16);
  builder.setEmissiveColor(null);

  /* --- Four figures, one mesh, stamped facing the fire. */
  const figure = buildFigure();
  for (let i = 0; i < FIGURE_COUNT; i++) {
    const angle = (i / FIGURE_COUNT) * TAU;
    stampFacingCentre(
      builder,
      figure,
      Math.cos(angle) * FIGURE_RING_M,
      Math.sin(angle) * FIGURE_RING_M,
    );
  }

  builder.setRoughness(null);

  return builder.build();
}

/**
 * A standing marble figure, built from what everything else here is built from:
 * capsules and spheres, no model file.
 *
 * **Geometry rather than a photograph on a card, and that is not a shortcut avoided.**
 * The page prints "0 image assets" over this scene, so a photographic texture would
 * make the site's own headline false; the photographs of the works this is modelled on
 * are somebody's copyright besides. The better argument is that a flat card would
 * demonstrate none of what this scene exists to demonstrate. A curved figure standing a
 * few metres from a point light is the one shape that shows what soft shadows actually
 * do: the shadow it throws is sharp at the ankles and diffuse by the time it reaches
 * the colonnade, because penumbra widens with distance from the caster, and every
 * surface of it is a different angle to the flame.
 *
 * The pose is contrapposto: weight on one leg, the hip over that ankle, the shoulders
 * counter-rotated, one arm raised. It costs four extra limb placements and it is the
 * difference between a figure and a mannequin.
 *
 * Built in its own local space with the feet at the origin and facing +Z, so it can be
 * stamped anywhere at any bearing.
 */
function buildFigure(): MeshData {
  const marble = new MeshBuilder();
  marble.setRoughness(0.3);
  /*
   * Marble, and the clearest case there is for grain being its own property: it is
   * polished, so it is barely rough at all, and it has the most visible mineral structure
   * of anything in this scene. Deriving grain from roughness would have given the figures
   * almost none and the painted things around them a great deal.
   */
  marble.setGrain(0.8);

  /* The plinth it stands on, which is also what lifts it into the lantern's light. */
  marble.setRoughness(0.6);
  marble.addBox([0, 0.09, 0], [0.62, 0.09, 0.62], KERB, 0, 0.2);
  marble.addBox([0, 0.28, 0], [0.54, 0.11, 0.54], COLUMN_STONE, 0, 0.2);
  marble.addCylinder([0, 0.52, 0], 0.46, 0.13, 'y', COLUMN_STONE, 0, 20, 0.2);
  const base = 0.65;

  marble.setRoughness(0.3);
  const limb = (from: Vec3, to: Vec3, radius: number): void => {
    addLimb(marble, from, to, radius, MARBLE);
  };

  /* Weight leg, straight and under the body's centre. Free leg trails and bends. */
  limb([0.13, base + 0.06, 0.02], [0.11, base + 0.86, 0], 0.115);
  limb([-0.15, base + 0.5, -0.12], [-0.13, base + 0.86, -0.02], 0.115);
  limb([-0.22, base + 0.07, -0.26], [-0.15, base + 0.5, -0.12], 0.1);
  // Feet: the free one on its toes, which is what the trailing leg is for.
  marble.addBox([0.13, base + 0.04, 0.06], [0.09, 0.04, 0.15], MARBLE, 0, 0.15);
  marble.addBox([-0.23, base + 0.05, -0.22], [0.08, 0.05, 0.13], MARBLE, 0, 0.15);

  /* Pelvis, tilted with the weight; waist; chest, counter-rotated above it. */
  marble.addCapsule([0.02, base + 0.92, 0], 0.185, 0.05, MARBLE, 0, 14, 7, 0.15);
  limb([0.02, base + 0.94, 0], [0, base + 1.2, 0.01], 0.17);
  marble.addCapsule([-0.01, base + 1.36, 0.01], 0.225, 0.1, MARBLE, 0, 16, 8, 0.15);
  marble.addCapsule([-0.02, base + 1.5, 0], 0.115, 0.21, MARBLE, 0, 12, 6, 0.15);

  /* Neck and head, turned to follow the raised arm. */
  limb([-0.01, base + 1.56, 0.01], [0.01, base + 1.66, 0.03], 0.07);
  marble.addSphere([0.03, base + 1.75, 0.03], 0.115, MARBLE, 0, 16, 8);
  // Hair as a second, rougher shell, cut back off the face.
  marble.setRoughness(0.72);
  marble.addSphere([0.03, base + 1.79, -0.01], 0.128, MARBLE_SHADE, 0, 14, 7);
  marble.setRoughness(0.3);

  /* The raised arm, which is what the whole pose is arranged around. */
  limb([0.2, base + 1.52, 0.01], [0.42, base + 1.71, -0.06], 0.075);
  limb([0.42, base + 1.71, -0.06], [0.5, base + 1.99, 0.02], 0.062);
  marble.addSphere([0.51, base + 2.05, 0.04], 0.058, MARBLE, 0, 10, 5);

  /* And the low arm, falling toward the drape. */
  limb([-0.24, base + 1.5, 0], [-0.31, base + 1.14, 0.05], 0.075);
  limb([-0.31, base + 1.14, 0.05], [-0.27, base + 0.82, 0.14], 0.062);
  marble.addSphere([-0.26, base + 0.76, 0.16], 0.058, MARBLE, 0, 10, 5);

  /*
   * The drape, hanging from the raised arm down the back.
   *
   * Cloth from six flat panels, which is exactly as convincing as it sounds up close
   * and entirely convincing at the distance a hero is read at. It is here because the
   * silhouette needs something asymmetric in it: a figure that is bilaterally clean
   * reads as a diagram of a person.
   */
  marble.setRoughness(0.55);
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const y = base + 1.72 - t * 1.15;
    const sway = Math.sin(t * 2.2) * 0.09;
    marble.addBox(
      [0.34 - t * 0.42 + sway, y, -0.13 - t * 0.1],
      [0.13 - t * 0.03, 0.11, 0.035 + t * 0.02],
      MARBLE_SHADE,
      0,
      0.12,
    );
  }
  marble.setRoughness(null);

  return marble.build();
}

/**
 * One capsule laid along an arbitrary segment.
 *
 * `addCapsule` builds along Y only, which is right for the primitive and useless for a
 * limb. `addOrientedMesh` is the engine's answer: build the piece once in its own space
 * and stamp it on a basis. The basis has to be genuinely orthonormal or the builder
 * refuses it, which is a good error to get at build time rather than a sheared arm.
 */
function addLimb(target: MeshBuilder, from: Vec3, to: Vec3, radius: number, color: Vec3): void {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-4) return;

  const up: Vec3 = [dx / length, dy / length, dz / length];
  // Any vector not parallel to `up` will do to start; the cross products fix the rest.
  const seed: Vec3 = Math.abs(up[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const right = normalise(cross(seed, up));
  /*
   * `right × up`, and the order is the whole of it.
   *
   * `up × right` is the negative, which is a basis that is perfectly orthonormal and
   * mirrored — so every face winds backwards and back-face culling deletes the entire
   * figure. The builder catches it by determinant and says so, which is the difference
   * between finding this in one build and hunting an invisible statue.
   */
  const forward = normalise(cross(right, up));

  const piece = new MeshBuilder();
  piece.setRoughness(0.3);
  piece.addCapsule([0, 0, 0], radius, length / 2, color, 0, 12, 6, 0.15);
  target.addOrientedMesh(
    piece.build(),
    [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
    right,
    up,
    forward,
  );
}

/** Stamp a figure on the ring, turned to look at the fire in the middle. */
function stampFacingCentre(target: MeshBuilder, figure: MeshData, x: number, z: number): void {
  const length = Math.hypot(x, z) || 1;
  const forward: Vec3 = [-x / length, 0, -z / length];
  // `right × up = forward` with up as world up. Derived rather than guessed, because
  // the builder checks it and a mirrored figure is a subtle thing to spot by eye.
  const right: Vec3 = [forward[2], 0, -forward[0]];
  target.addOrientedMesh(figure, [x, 0, z], right, [0, 1, 0], forward);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** The five sources, in the order the shadow system will meet them. */
function buildLights(): PointLightSource[] {
  const lights: PointLightSource[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      lights.push({
        x: sx * LANTERN_HALF_M,
        y: LANTERN_HEAD_M,
        z: sz * LANTERN_HALF_M,
        r: LANTERN_LIGHT[0],
        g: LANTERN_LIGHT[1],
        b: LANTERN_LIGHT[2],
        radius: 14,
        // Barely there. A lantern is not a candle, and four of them breathing in
        // unison is the failure this number is kept small to avoid.
        flicker: 0.045,
        shadowNear: 0.3,
        // Physical size of the emitter, and the whole of what sets penumbra width:
        // a hand-sized flame behind glass gives an edge that softens over a metre or so.
        sourceRadius: 0.16,
      });
    }
  }
  lights.push({
    x: FIRE_X_M,
    y: FIRE_BOWL_M + 0.55,
    z: FIRE_Z_M,
    r: FIRE_LIGHT[0],
    g: FIRE_LIGHT[1],
    b: FIRE_LIGHT[2],
    radius: 17,
    flicker: 0.2,
    shadowNear: 0.25,
    sourceRadius: 0.45,
  });
  return lights;
}

/**
 * The court at two hours, and everything the scene moves between them.
 *
 * One structure rather than two sets of builders, because a scene that can only be
 * built at one hour is a scene that has to be torn down and remounted to change it —
 * losing its shadow bakes, its compiled programs and its place in the orbit to show
 * the same court in different light. Every field here is a number or a colour, so the
 * move between them is a lerp and the scene can sit anywhere in between.
 *
 * It exists because the page has a light mode. A lamp-lit court under a light page is
 * a night render with a white document wrapped round it, and asking somebody who chose
 * light mode to look at black is the wrong answer to the wrong question.
 */
interface CourtHour {
  /** Where the dominant source is. Lerped and re-normalised, so shadows swing. */
  directionalDir: Vec3;
  directionalColor: Vec3;
  ambient: Vec3;
  ambientGround: Vec3;
  fogColor: Vec3;
  fogDensity: number;
  /** How much self-illuminated geometry shows. A lantern is nothing at midday. */
  emissiveGain: number;
  /** What each lantern and the fire is actually putting out, as a fraction. */
  lampGain: number;
  shadowStrength: number;
  skyTop: Vec3;
  skyHorizon: Vec3;
  skyDeep: Vec3;
  nightFactor: number;
  waterDeep: Vec3;
  waterShallow: Vec3;
  waterMirror: number;
}

/** How fast the hour moves when it is asked to change. About a second, end to end. */
const DAYLIGHT_RATE = 3.4;

/** Where the sun stands in the afternoon, and where the moon stands at night. */
const SUN_DIR: Vec3 = [-0.4, 0.74, 0.54];
const MOON_DIR: Vec3 = [-0.34, 0.79, 0.51];

const NIGHT: CourtHour = {
  directionalDir: MOON_DIR,
  /*
   * Moonlight, and stronger than the first attempt at it.
   *
   * That one was faithful to a real moonlit night and produced a scene where the
   * colonnade read as black cut-outs: every column stands outside the lanterns, so the
   * side facing the camera got nothing but ambient. A demo is looked at for eight
   * seconds in a browser tab rather than studied, and geometry nobody can see is
   * geometry that may as well not have been built.
   */
  directionalColor: [0.15, 0.18, 0.27],
  ambient: [0.078, 0.089, 0.122],
  // Cooler and darker from below: the stone underfoot is not lit by the same sky the
  // tops of things are, and a uniform fill is what makes an outdoor scene read as a room.
  ambientGround: [0.034, 0.038, 0.05],
  fogColor: [0.031, 0.038, 0.056],
  // Enough to close the far paving. More and the colonnade goes with it.
  fogDensity: 0.009,
  emissiveGain: 0.9,
  lampGain: 1,
  // Weak, and it should be: the moon is here to keep the far paving off pure ambient
  // rather than to compete with five lamps.
  shadowStrength: 0.4,
  skyTop: [0.012, 0.017, 0.038],
  skyHorizon: [0.042, 0.052, 0.086],
  skyDeep: [0.008, 0.01, 0.022],
  nightFactor: 1,
  /*
   * A water body's own colour is multiplied by the light arriving at it, so under a
   * moon it is black whatever the palette says. What a reader sees in a night basin is
   * what is reflected in it, so at night that is the term to spend on.
   */
  waterDeep: [0.055, 0.088, 0.105],
  waterShallow: [0.1, 0.15, 0.17],
  waterMirror: 0.88,
};

const AFTERNOON: CourtHour = {
  directionalDir: SUN_DIR,
  /*
   * Late rather than noon, and that is the whole reason this hour was chosen.
   *
   * A sun overhead flattens everything: shadows collapse under their casters and the
   * colonnade stops having a third dimension. Low and warm gives long shadows across
   * the paving, a rim on every column, and the marble reading as marble — which is the
   * daylight equivalent of what the lanterns do after dark.
   */
  directionalColor: [1.12, 0.98, 0.8],
  /*
   * A high ambient, and it is doing more work here than at night.
   *
   * The camera makes a full circuit, so for half of every orbit the court is backlit
   * and the faces pointing at the reader receive nothing from the sun at all. Outdoors
   * that light comes from the sky, which is a hemisphere rather than a point; without
   * enough of it the afternoon has a dark half and looks like a mistake.
   */
  ambient: [0.42, 0.46, 0.55],
  ambientGround: [0.29, 0.275, 0.25],
  fogColor: [0.6, 0.66, 0.75],
  fogDensity: 0.0055,
  // A lit lantern in daylight is its glass catching the sun, not a glow.
  emissiveGain: 0.16,
  lampGain: 0.12,
  shadowStrength: 0.9,
  skyTop: [0.2, 0.38, 0.7],
  skyHorizon: [0.7, 0.75, 0.8],
  skyDeep: [0.12, 0.26, 0.56],
  nightFactor: 0,
  // By day the water has light to work with, so its own colour carries most of it and
  // the mirror term comes down to something a real pool would do.
  waterDeep: [0.09, 0.17, 0.2],
  waterShallow: [0.22, 0.36, 0.38],
  waterMirror: 0.36,
};

/** Set up at night; `setDaylight` moves it from there. */
function buildEnvironment(): Environment {
  return createEnvironment({
    directionalDir: [MOON_DIR[0], MOON_DIR[1], MOON_DIR[2]],
    directionalColor: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    emissiveGain: 1,
    nightFactor: 1,
    fogColor: [0, 0, 0],
    fogDensity: 0,
    fogHeightFalloff: 0.05,
    fogBaseY: 0,
  });
}

function buildSky(env: Environment): SkyColors {
  return {
    top: [0, 0, 0],
    horizon: [0, 0, 0],
    deep: [0, 0, 0],
    // Both bodies are always in the sky and `nightFactor` decides which one is shown,
    // which is what that uniform is for. The lighting direction lerps between them
    // separately, so the shadows swing as the hour moves.
    sunDir: SUN_DIR,
    sunColor: [1, 0.92, 0.76],
    sunAngularRadius: 0.0046,
    moonDir: MOON_DIR,
    moonColor: [0.62, 0.68, 0.85],
    moonAngularRadius: 0.013,
    moonPhase: 0.68,
    nightFactor: 1,
    cloudOffsetX: 0,
    cloudOffsetZ: 0,
  };
}

/** Shallow, still, and allowed to mirror more than physics would give it. */
function buildWaterBody(): WaterBody {
  return {
    level: WATER_LEVEL_M,
    deepColor: [0, 0, 0],
    shallowColor: [0, 0, 0],
    // Mostly opaque looking straight down. The basin floor showing through is what
    // stops it reading as a hole, and no more than that is wanted.
    density: 0.6,
    visibility: 1,
    mirror: 0,
    waveScale: 0.22,
    agitation: 0.1,
    bounds: { centreX: 0, centreZ: 0, halfM: POOL_HALF_M },
  };
}

const FIRE_PLUME: PlumePlacement = {
  x: FIRE_X_M,
  y: FIRE_BOWL_M,
  z: FIRE_Z_M,
  width: 0.6,
  height: 2.5,
};

const SMOKE_PLUME: PlumePlacement = {
  x: FIRE_X_M,
  y: FIRE_BOWL_M + 1.9,
  z: FIRE_Z_M,
  width: 1.05,
  height: 4,
};

/**
 * What each budget costs, and what it gives up to get there.
 *
 * `full` trims two things the default profile spends that this scene has no use for: a
 * second directional depth layer, which exists to keep overlapping *static* geometry
 * from bleeding through and buys almost nothing on a flat court, and the widest PCF
 * kernel, which is being paid on every fragment for every one of five lights.
 *
 * `lean` gives up the planar reflection, and that is the whole of why it is worth
 * having. The reflection is a **second complete submission of the scene** from the
 * mirrored camera; dropping it removes about a third of the frame in one line. The water
 * is still there and still moves, it simply mirrors the sky rather than the court.
 */
const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  /*
   * The engine's own defaults, deliberately, and the empty object is the point.
   *
   * This used to trim three of them: a single directional depth layer, 384 pixel cube
   * faces and an eight tap filter. Every one measured as a saving here and every one put
   * the scene on a configuration nothing else runs, which is how it came to render as a
   * fire floating in the dark on WebKit while a shipping game using the same engine on
   * the same phone was fine. 384 is the likeliest culprit of the three: it is not a power
   * of two, and a cube map of depth at an unusual size is exactly the kind of allocation
   * a mobile driver accepts and then mishandles.
   *
   * The defaults are the configuration with production evidence behind them. A demo is
   * the worst possible place to be the first consumer of an untested combination, because
   * a scene that fails here fails in front of the people being asked to trust the engine.
   * The two draw calls this costs are the cheapest insurance in the project.
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
    // Half the pixels of the good profile, which on a phone is most of the answer on its
    // own: this renderer is roughly ninety percent fragment-bound.
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
    /*
     * The moon goes first. It costs a full depth pass over the whole court and a
     * per-fragment sample, to add a weak fill that five lamps are already doing better.
     * The cube shadows stay, because they are the thing worth looking at.
     */
    directionalShadows: false,
    pointShadowFaceSize: 256,
    pointShadowFacesPerFrame: 1,
    shadowFilterTaps: 4,
    waterReflections: false,
    // No off-screen target and no resolve pass: one write and one read of every pixel,
    // saved, and nothing in this scene uses a screen-space effect.
    screenEffects: false,
    waterResolution: 64,
    plumeNoiseOctaves: 1,
  },
};

class NightCourtHandle implements DemoHandle {
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
  /** Handed out through the contract, so a viewer can take the camera at any time. */
  readonly view = new OrbitView(4, 46, 0.6);
  private readonly mesh: MeshHandle;
  private readonly water: WaterHandle;
  private readonly fire: PlumeHandle;
  private readonly smoke: PlumeHandle;
  private readonly env: Environment;
  private readonly sky: SkyColors;
  private readonly body: WaterBody;
  private readonly lights: PointLightSource[];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly lightMatrix = new Float32Array(16);
  private readonly staticCasters: ShadowCasters;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };

  private elapsedSec = 0;
  private disposed = false;
  /** Held between samples: the timer answers roughly seven frames a second. */
  private lastGpuMs = 0;
  /**
   * Where the hour is, and where it is being asked to go.
   *
   * Two values rather than one so the change is a move rather than a cut. Somebody
   * pressing a light switch on a page gets sunrise over about a second, which reads as
   * the scene responding to them; snapping between two palettes reads as a bug.
   */
  private daylight = 0;
  private targetDaylight = 0;
  /** Both written by `applyHour`, both read by `frame`. */
  private baseEmissiveGain = NIGHT.emissiveGain;
  private shadowStrength = NIGHT.shadowStrength;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2');
    this.canvas = canvas;
    /*
     * The renderer acquires the context itself, and gets the one that already exists.
     *
     * A second `getContext('webgl2')` on the same canvas returns the first context and
     * ignores the attributes, which is why whatever mounts a scene has to create it
     * with the attributes the engine wants rather than with its own. See `DemoScene`.
     */
    this.renderer = renderer;
    const renderer_ = renderer;
    this.mesh = renderer.createMesh(buildCourt());
    this.lights = buildLights();
    this.env = buildEnvironment();
    this.sky = buildSky(this.env);
    this.body = buildWaterBody();

    /*
     * The environment reads the selection buffer directly rather than copying out of
     * it. Two arrays holding the same ten lights is two arrays that can disagree.
     */
    this.env.lightPositions = this.lightBuffer.positions;
    this.env.lightColors = this.lightBuffer.colors;
    this.env.lightRadii = this.lightBuffer.radii;
    /* The emitter's own size, which is what lets a highlight be as wide as the light is. */
    this.env.lightSourceRadii = this.lightBuffer.sourceRadii;
    this.env.lightWeights = this.lightBuffer.weights;
    this.env.activeLightWorldIndices = this.lightBuffer.sourceIndex;

    /*
     * One closure, called by the directional pass and by every cubemap face.
     *
     * It counts as it goes, which is how the figure printed over the scene comes to
     * include the shadow work: a bake is a real pass over real geometry, and a demo
     * that quoted only the passes it could see would be quoting the easy half.
     */
    this.staticCasters = (sink) => {
      this.stats.draws++;
      sink.mesh(this.mesh, IDENTITY);
    };

    this.water = renderer.createWater();
    this.fire = renderer.createPlumes([FIRE_PLUME], {
      material: 'fire',
      blend: 'additive',
      sizePulse: 0.16,
      // A flame is tied to what it is burning and barely leans.
      windResponse: 0.12,
    });
    this.smoke = renderer.createPlumes([SMOKE_PLUME], {
      material: 'smoke',
      blend: 'alpha',
      sizePulse: 0.3,
      // Smoke has nothing holding it down and goes where the air goes.
      windResponse: 1.35,
      tint: [0.42, 0.4, 0.44],
    });

    this.camera.fovYDeg = 46;
    this.camera.near = 0.3;
    // The court is thirty metres across. A far plane at the engine's default 500 would
    // spend most of the depth buffer on empty air.
    this.camera.far = 140;

    this.applyHour();
    renderer.resize();
    renderer.prepareStaticPointShadows(this.lights);
  }

  /**
   * Ask for an hour: 0 is the lamp-lit night, 1 a clear afternoon.
   *
   * Anything in between is a real state rather than an interpolation artefact, which is
   * what lets the move between them be animated instead of switched.
   */
  setDaylight(amount: number): void {
    this.targetDaylight = clamp(amount, 0, 1);
  }

  /**
   * Write the current hour into the environment, the sky, the water and the lamps.
   *
   * In place, into objects that already exist, because this can run on any frame while
   * the hour is moving and a scene that allocated a palette per frame would be failing
   * the claim printed over it. Called again only when `daylight` actually changes.
   */
  private applyHour(): void {
    const t = this.daylight;
    const env = this.env;
    const sky = this.sky;

    mixColorInto(env.directionalDir as Vec3, NIGHT.directionalDir, AFTERNOON.directionalDir, t);
    // Two unit vectors lerped are not a unit vector, and the shading maths assumes one.
    const dir = env.directionalDir as Vec3;
    const length = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    dir[0] /= length;
    dir[1] /= length;
    dir[2] /= length;

    mixColorInto(env.directionalColor, NIGHT.directionalColor, AFTERNOON.directionalColor, t);
    mixColorInto(env.ambient, NIGHT.ambient, AFTERNOON.ambient, t);
    mixColorInto(env.ambientGround as Vec3, NIGHT.ambientGround, AFTERNOON.ambientGround, t);
    mixColorInto(env.fogColor as Vec3, NIGHT.fogColor, AFTERNOON.fogColor, t);
    env.fogDensity = lerp(NIGHT.fogDensity, AFTERNOON.fogDensity, t);
    env.nightFactor = lerp(NIGHT.nightFactor, AFTERNOON.nightFactor, t);
    this.baseEmissiveGain = lerp(NIGHT.emissiveGain, AFTERNOON.emissiveGain, t);
    this.shadowStrength = lerp(NIGHT.shadowStrength, AFTERNOON.shadowStrength, t);

    mixColorInto(sky.top, NIGHT.skyTop, AFTERNOON.skyTop, t);
    mixColorInto(sky.horizon, NIGHT.skyHorizon, AFTERNOON.skyHorizon, t);
    mixColorInto(sky.deep, NIGHT.skyDeep, AFTERNOON.skyDeep, t);
    sky.nightFactor = env.nightFactor;

    mixColorInto(this.body.deepColor, NIGHT.waterDeep, AFTERNOON.waterDeep, t);
    mixColorInto(this.body.shallowColor, NIGHT.waterShallow, AFTERNOON.waterShallow, t);
    this.body.mirror = lerp(NIGHT.waterMirror, AFTERNOON.waterMirror, t);

    // The lamps are still lit at noon; they are simply not what anybody is seeing by.
    const gain = lerp(NIGHT.lampGain, AFTERNOON.lampGain, t);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      if (light === undefined) continue;
      const base = i < LANTERN_COUNT ? LANTERN_LIGHT : FIRE_LIGHT;
      light.r = base[0] * gain;
      light.g = base[1] * gain;
      light.b = base[2] * gain;
    }
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    if (this.disposed) return this.stats;

    this.elapsedSec += dtSec;
    const now = this.elapsedSec;
    this.stats.draws = 0;

    /*
     * Move the hour, and only touch the palette on frames where it actually moved.
     *
     * Exponential rather than linear so it eases out on its own, and snapped at the end
     * so it settles rather than approaching forever and re-applying a palette every
     * frame for the rest of the visit.
     */
    if (this.daylight !== this.targetDaylight) {
      this.daylight = damp(this.daylight, this.targetDaylight, DAYLIGHT_RATE, dtSec);
      if (Math.abs(this.daylight - this.targetDaylight) < 0.002) {
        this.daylight = this.targetDaylight;
      }
      this.applyHour();
    }

    renderer.resize();

    /* --- Where the camera is this instant. */
    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      const angle = (now / ORBIT_SECONDS) * TAU;
      camera.position[0] = Math.sin(angle) * ORBIT_RADIUS_M;
      camera.position[1] = ORBIT_HEIGHT_M + Math.sin((now / BOB_SECONDS) * TAU) * BOB_M;
      camera.position[2] = Math.cos(angle) * ORBIT_RADIUS_M;
      camera.lookAt(0, LOOK_Y_M, LOOK_Z_M);
      this.view.follow(camera, 0, LOOK_Y_M, LOOK_Z_M);
    }
    // Read after `resize`, which is what owns the drawing buffer's dimensions.
    const height = this.canvas.height;
    camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    /* --- Which lights are shading this frame, and where their flicker has them. */
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

    /*
     * The fire's own light spilling onto everything that glows.
     *
     * Small on purpose: enough that the lantern glass and the coals are not perfectly
     * still, not so much that four lanterns pulse in time with a fire twenty metres off.
     */
    env.emissiveGain =
      this.baseEmissiveGain * (1 + Math.sin(now * 5.3) * 0.02 + Math.sin(now * 2.1) * 0.013);

    // Clouds drift rather than sit. Accumulated, so the sky is never quite the frame before.
    this.sky.cloudOffsetX += WIND_X * dtSec;
    this.sky.cloudOffsetZ += WIND_Z * dtSec;

    renderer.gpuTimer.beginFrame();

    /* --- Five cubemaps, refreshed at the renderer's own pace. Nothing moves here, so
           the maps settle in the first few frames and are never rebuilt after that. */
    renderer.updatePointShadows(
      this.lights,
      this.lightBuffer.sourceIndex,
      env.lightCount,
      0,
      LOOK_Y_M,
      0,
      dtSec,
      this.staticCasters,
      NO_MOVING_CASTERS,
      this.lightBuffer.shadowIndex,
      this.lightBuffer.shadowCount,
    );

    /* --- Moonlight. Weak, and it should be: it is here to keep the far paving from
           going to pure ambient, not to compete with the lanterns. */
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      0,
      0,
      COURT_HALF_M,
      renderer.shadowMapSize,
      this.lightMatrix,
    );
    env.lightViewProj = this.lightMatrix;
    env.shadowStrength = this.shadowStrength;
    renderer.beginShadowPass(this.lightMatrix, 'static');
    renderer.drawShadowCasters(this.staticCasters);
    renderer.endShadowPass();
    renderer.beginShadowPass(this.lightMatrix, 'static-peel');
    renderer.drawShadowCasters(this.staticCasters);
    renderer.endShadowPass();

    renderer.beginFrame(this.sky.horizon);

    /* --- The reflection: the same submissions from the mirrored camera. Water is
           excluded from it, which is what stops a basin reflecting itself. */
    const mirrored = renderer.beginPlanarReflection(camera, WATER_LEVEL_M, this.sky.horizon);
    if (mirrored !== null) {
      this.drawWorld(mirrored);
      renderer.endPlanarReflection();
    }

    renderer.gpuTimer.begin('rest');
    this.drawWorld(camera);
    // After the opaque scene and after the sky: its far edge fades out and needs
    // something behind it to fade into.
    renderer.drawWater(this.water, camera, now, this.body, env, WIND_X, WIND_Z);
    this.stats.draws++;
    renderer.gpuTimer.end();

    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;

    return this.stats;
  }

  /**
   * Everything the mirrored camera and the real one both submit.
   *
   * One method rather than two call sites, because the failure a planar reflection
   * produces when the two disagree is a reflection of a world that is not there, and
   * it is found by somebody looking closely at the water rather than by a test.
   */
  private drawWorld(camera: Camera): void {
    const renderer = this.renderer;
    const env = this.env;
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(this.mesh, IDENTITY);
    renderer.drawSky(camera, this.sky, env);
    renderer.drawPlumes(this.fire, camera, this.elapsedSec, env, WIND_X, WIND_Z);
    renderer.drawPlumes(this.smoke, camera, this.elapsedSec, env, WIND_X, WIND_Z);
    this.stats.draws += 4;
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
    this.renderer.disposeMesh(this.mesh);
    /* Null on any backend but WebGL2, whose objects are the only ones that took one. */
    if (this.gl !== null) {
    }
    // The canvas belongs to whatever mounted this, so the context is left alive.
    this.renderer.disposePlumes(this.fire);
    this.renderer.disposePlumes(this.smoke);
    this.renderer.disposeWater(this.water);
    this.renderer.dispose();
  }
}

export const nightCourt: DemoScene = {
  id: 'night-court',
  title: 'Night court',
  note: 'Five shadow-casting lights, a planar reflection and two plumes, from geometry generated at load. No textures, no models, nothing downloaded.',
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
    return new NightCourtHandle(renderer, canvas);
  },
};
