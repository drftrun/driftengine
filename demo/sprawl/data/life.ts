/**
 * The shape of what moves through the city, as the scene's `Life` entity carries it in JSON: the
 * bake writes it (`bake/output/life.ts`) and the runtime reads it, both against these types.
 *
 * Colours are linear. Numbers are the reference's own, by the names its tables give them.
 */

export type Rgb = [number, number, number];

/**
 * What an instance of a mover mesh is tinted by: a paint, a glow, a palette slot, a light that
 * blinks — white or black as the instance's own beat says — or nothing.
 */
export type Tint =
  'paint' | 'glow' | 'skin' | 'cloth' | 'cloth2' | 'hair' | 'accent' | 'blink' | null;

/** A mover kind: its meshes by ordinal in the container, and the limbs its person meshes hang from. */
export interface MoverKindData {
  readonly name: string;
  readonly role: 'vehicle' | 'person' | 'drone' | 'train' | 'aircraft';
  readonly meshes: readonly { readonly mesh: number; readonly tint: Tint; readonly limb: number }[];
  readonly limbs: readonly LimbData[];
  /** Its blinking lights' beat, where it has any: hertz, and the share of each beat lit. */
  readonly blink?: readonly [number, number];
}

export interface LimbData {
  /** Where the limb turns, in the body's frame. */
  readonly pivot: readonly [number, number, number];
  readonly phase: number;
  /** How far it swings each way, radians. */
  readonly swing: number;
  readonly lift: number;
}

export interface VehicleRow {
  readonly kind: string;
  readonly template: string;
  readonly taxi: boolean;
  readonly length: number;
  readonly width: number;
  readonly maxSpeed: number;
  readonly accel: number;
  readonly brake: number;
  /** Its share of the fleet in each district. */
  readonly weights: Readonly<Record<string, number>>;
  /** How the shared distant body is stretched to stand for it. */
  readonly lite: readonly [number, number, number];
}

export interface PaletteRow {
  readonly weight: number;
  readonly skin: Rgb;
  readonly cloth: Rgb;
  readonly cloth2: Rgb;
  readonly hair: Rgb;
  readonly accent: Rgb;
  readonly glow: number;
}

export interface PersonRow {
  readonly kind: string;
  readonly body: string;
  readonly lite: string;
  readonly job: string;
  readonly weight: number;
  readonly scale: number;
  readonly speed: readonly [number, number];
  readonly homes: Readonly<Record<string, number>>;
  readonly streets: Readonly<Record<string, number>>;
  readonly jaywalk: number;
  readonly transit: number;
  readonly palettes: readonly PaletteRow[];
}

export interface JobStep {
  readonly hour: number;
  readonly jitter: number;
  readonly place: string;
  readonly kind: string;
  readonly radius: number;
  readonly dwell: number;
  readonly repeat: number;
  readonly outside: number;
}

export interface JobRow {
  readonly home: string;
  readonly work: string;
  readonly favorite: string;
  readonly workRadius: number;
  readonly favoriteRadius: number;
  readonly steps: readonly JobStep[];
}

export interface DroneRow {
  readonly kind: string;
  readonly body: string;
  readonly lite: string;
  readonly weight: number;
  readonly scale: number;
  readonly speed: number;
  readonly speedVar: number;
  readonly altitude: number;
  readonly hover: number;
}

export interface TaxiRow {
  readonly kind: string;
  readonly prefab: string;
  readonly weight: number;
  readonly cruise: number;
  /** Metres its cruise flies above the others'. */
  readonly bias: number;
  readonly dwellScale: number;
}

/** Where a ride's eye sits in its vehicle, and what it sees with. */
export interface CameraRow {
  readonly forward: number;
  readonly side: number;
  readonly eye: number;
  readonly near: number;
  readonly far: number;
  readonly fov: number;
  readonly smooth: number;
}

export interface LifeData {
  readonly vehicles: readonly VehicleRow[];
  readonly paints: readonly Rgb[];
  readonly glows: readonly Rgb[];
  /** Head, tail, taxi paint and taxi glow, by those names. */
  readonly palette: Readonly<Record<string, Rgb>>;
  readonly people: readonly PersonRow[];
  readonly jobs: Readonly<Record<string, JobRow>>;
  readonly drones: readonly DroneRow[];
  readonly taxis: readonly TaxiRow[];
  /** By the seat's name: walking, the air taxi, the monorail. */
  readonly cameras: Readonly<Record<string, CameraRow>>;
  /** Every number the scripts' configuration exports, by its name. */
  readonly config: Readonly<Record<string, number>>;
}
