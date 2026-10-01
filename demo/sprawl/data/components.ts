/**
 * What the bake tells the runtime beyond geometry and light, as components of the entity model:
 * the scene `ENTS` carries, which the bake writes and the runtime loads with these same types.
 *
 * **A field is a number, a flag or a string, and a list goes in a string as JSON.** The entity
 * model's columns are typed arrays, so an outline or a texture plan has no column of its own; each
 * field below that holds JSON says what its JSON is. That costs a parse where the runtime reads
 * one, once, at load; what would make it wrong is a list read every frame, which then wants
 * entities of its own.
 *
 * Names of the reference's world — its districts, its lines and stations — live only in the data
 * these carry, in the gitignored output.
 */
import { defineComponent } from '../../../packages/entities/src/index.ts';

/** The city as a whole: one entity. */
export const City = defineComponent('City', {
  /** Metres a region spans. */
  regionSize: 'f32',
  /** What one of the reference's light intensity units is, as the volume summed it. */
  lightUnit: 'f32',
  /**
   * The texture plan, JSON: `{ classes: { size, layers: { albedo, emissive, mr, frame, effect }[]
   * }[] }`, each picture named as the container's `TEXS` names it, or null.
   */
  textures: 'String',
});

/** Where the walker starts. */
export const Spawn = defineComponent('Spawn', { x: 'f32', y: 'f32', z: 'f32', yaw: 'f32' });

/** A region, as its meshes in the container are to be drawn. */
export const CityRegion = defineComponent('CityRegion', {
  id: 'u32',
  /**
   * Each level's material classes, finest first, in the order the container lists that level's
   * meshes, JSON: `{ blend, texture, alpha, sway }[][]`.
   */
  levels: 'String',
  /** Each instance group's class, in the order the container lists the region's groups, JSON. */
  groups: 'String',
});

/** A district: its name, its colour, and where its label stands. */
export const District = defineComponent('District', {
  index: 'u32',
  name: 'String',
  /** Its accent, 0xRRGGBBAA. */
  accent: 'u32',
  labelX: 'f32',
  labelZ: 'f32',
});

/** A block, for the map: its outline, JSON `[x, z, x, z, …]`, and its district. */
export const MapBlock = defineComponent('MapBlock', { district: 'u32', outline: 'String' });

/** A straight street of the grid, with what its traffic and its walkers need to know of it. */
export const Street = defineComponent('Street', {
  /** Runs along z, at x `at`; or along x, at z `at`. */
  vertical: 'bool',
  at: 'f32',
  from: 'f32',
  to: 'f32',
  lanes: 'u8',
  laneWidth: 'f32',
  median: 'f32',
  sidewalk: 'f32',
  /** Metres a second. */
  speed: 'f32',
  /** Closed to traffic: a landmark stands across it. */
  closed: 'bool',
  /** Seconds of green its class gives it at a signalled junction. */
  green: 'f32',
  /** The carriageway's top. */
  y: 'f32',
});

/** Where streets meet: the streets, by their index among the `Street`s, JSON `[i, …]`. */
export const Junction = defineComponent('Junction', { x: 'f32', z: 'f32', streets: 'String' });

/** A road that is not on the grid — the elevated road, the diagonal — JSON `[x, y, z, …]`. */
export const Route = defineComponent('Route', {
  name: 'String',
  points: 'String',
  lanes: 'u8',
  laneWidth: 'f32',
  median: 'f32',
  speed: 'f32',
});

/** A monorail line: its track, JSON `[x, y, z, …]`, closed. */
export const RailLine = defineComponent('RailLine', {
  name: 'String',
  path: 'String',
  /** Its trains, the gap it keeps between them, and one car's length. */
  trains: 'u32',
  minGap: 'f32',
  carLength: 'f32',
  /** Metres a second: the cruise cap, acceleration, braking, and the lateral limit in a curve. */
  cruise: 'f32',
  accel: 'f32',
  brake: 'f32',
  curveAccel: 'f32',
  /** Seconds a train stands at a platform, and its doors take each way. */
  dwell: 'f32',
  doorTime: 'f32',
  /** 0xRRGGBBAA. */
  tint: 'u32',
  /** The platforms' deck height. */
  deck: 'f32',
  /** Its cars front to back, JSON `{ kind, flipped }[]`, each kind a mover's name. */
  cars: 'String',
});

/** An air taxi's tower: where it stands, its turn, and its deck's height. */
export const Skyport = defineComponent('Skyport', { x: 'f32', z: 'f32', yaw: 'f32', deck: 'f32' });

/** A place a ride can be asked to go. */
export const Destination = defineComponent('Destination', { x: 'f32', z: 'f32', name: 'String' });

/** A monorail stop. */
export const RailStop = defineComponent('RailStop', {
  name: 'String',
  line: 'String',
  x: 'f32',
  z: 'f32',
  /** The yaw pointing its platform along the track. */
  heading: 'f32',
  /** Metres along its line. */
  along: 'f32',
});

/**
 * A drone depot: its yard's centre and turn, the top of its landing deck, and its charging grid —
 * `slots` a side at `pitch`, centred over the deck.
 */
export const DroneDepot = defineComponent('DroneDepot', {
  x: 'f32',
  z: 'f32',
  yaw: 'f32',
  deck: 'f32',
  slots: 'u32',
  pitch: 'f32',
});

/** A kerbside drop point: where a drone lowers its cargo, on the pavement at `y`. */
export const DropPad = defineComponent('DropPad', { x: 'f32', y: 'f32', z: 'f32' });

/**
 * A door people go to: a venue of `kind` — a home, an office, a café — on the pavement in front of
 * the building that holds it, one entity a venue.
 */
export const Venue = defineComponent('Venue', { x: 'f32', z: 'f32', kind: 'String' });

/**
 * What moves through the city: one entity. `kinds` is JSON — `{ name, role, meshes: { mesh, tint,
 * limb }[], limbs: { pivot, phase, swing, lift }[] }[]`, each mesh by its ordinal in the container,
 * where movers come first — and `data` the numbers they move by (`bake/output/life.ts`).
 */
export const Life = defineComponent('Life', { kinds: 'String', data: 'String' });

/**
 * A volume of light standing in the air — a lamp's cone, a pylon's beam — as the engine's light
 * volume draws it (`bake/mesh/volumes.ts`): the apex it opens from and its axis, a unit vector;
 * where its light starts and ends along the axis, in metres from the apex; its half-width over
 * distance; its colour at full night, linear; the metres from the eye it fades out over, and
 * inside, 0 for none; and its pulse, in hertz and depth.
 */
export const LightShaft = defineComponent('LightShaft', {
  x: 'f32',
  y: 'f32',
  z: 'f32',
  dx: 'f32',
  dy: 'f32',
  dz: 'f32',
  near: 'f32',
  length: 'f32',
  spread: 'f32',
  r: 'f32',
  g: 'f32',
  b: 'f32',
  fadeStart: 'f32',
  fadeEnd: 'f32',
  nearFade: 'f32',
  pulseHz: 'f32',
  pulseDepth: 'f32',
});

/** Every type the scene holds, in the order the bake writes and the runtime loads them. */
export const SCENE_TYPES = [
  City,
  Spawn,
  CityRegion,
  District,
  MapBlock,
  Street,
  Junction,
  Route,
  RailLine,
  RailStop,
  DroneDepot,
  DropPad,
  Venue,
  Skyport,
  Destination,
  Life,
  LightShaft,
] as const;
