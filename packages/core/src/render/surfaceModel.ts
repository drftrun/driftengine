/**
 * A material's shading model: how its surface answers light, when the standard model is not what
 * it is made of — brushed metal, hair, skin, an eye.
 *
 * **A frozen descriptor, made once by a factory, carrying a kind and that model's numbers.** The
 * standard model is `null`, exactly today's shader, and a scene that never names a model compiles
 * nothing of any of them: each is a pipeline constant of its own (`MODEL_ANISOTROPIC` and the rest
 * in `shaders/flat/models.ts`), off in every pipeline but the ones a material asks for.
 *
 * **Two vectors of numbers a material, and no more.** The lit stage's eight-light build is 254 of
 * the 256 uniform vectors an Adreno 740 offers, so a model's numbers are packed into
 * `uModelParams[2]` — the last component of the second says whether a model map is bound — and
 * every model fits. See `packModel` for each layout.
 *
 * **The eye's axis is the one number that moves.** It is the eye's forward direction in the world,
 * which a turning head or a glance changes every frame; the lit stage has no room left for another
 * varying (sixteen, WebGPU's ceiling), so the renderer turns the descriptor's mesh-local axis by
 * the draw's model matrix and the eye's joint each draw, with `eyeAxisInWorld`.
 */
import type { Vec3 } from '../math/color.ts';
import { lightmapRegionOf } from './lightmap.ts';
import type { LightmapRegion } from './lightmap.ts';

/** Strands of brushed metal, satin or hair-like fibre: a highlight stretched across them. */
export interface AnisotropicModel {
  readonly kind: 'anisotropic';
  /** 0 to 1: how far the highlight is stretched along the tangent. */
  readonly strength: number;
  /** Radians, turning the stretch's direction from the tangent toward the bitangent. */
  readonly rotation: number;
}

/**
 * Hair: three lobes along the strand, which is the mesh's tangent, running from root to tip
 * (`hairLobes.ts`). A model map's green turns each strand's tilt by up to half of it either way and
 * its blue is occlusion.
 */
export interface HairModel {
  readonly kind: 'hair';
  /**
   * Radians the cuticle's scales tilt the strand's surface: positive moves the white highlight
   * toward the root and the coloured one toward the tip. A card whose tangent runs tip to root
   * takes it negative.
   */
  readonly shift: number;
  /** 0 to 1: the light scattered through many strands, tinted by their colour. */
  readonly scatter: number;
  /** How strongly light from behind glows through: the transmitted lobe. */
  readonly backlit: number;
}

/** Skin: light scattered beneath the surface, reddening its terminator and its thin parts. */
export interface SkinModel {
  readonly kind: 'skin';
  /** The colour light keeps travelling beneath the surface — the mean free path, as a colour. */
  readonly scatterColor: Vec3;
  /**
   * Metres: how far light travels beneath it, on average, before it leaves — from where it entered
   * to where it leaves, for a channel whose share of `scatterColor` is 1. Burley's profile, which
   * the lit stage and the screen-space blur both scatter by, does that at a distance `d` two fifths
   * of it, and carries a tail of light out to about three and a half times it.
   */
  readonly radius: number;
  /** 0 to 1: how much a light behind a thin part shows through it. */
  readonly transmission: number;
  /** Which of up to eight profiles the screen-space scattering blurs this skin by. */
  readonly profile: number;
}

/** An eye: an iris seen through a cornea, which refracts it, under a mirror-smooth highlight. */
export interface EyeModel {
  readonly kind: 'eye';
  /** The iris's radius, in texture coordinates from the centre of the eye's map. */
  readonly irisRadius: number;
  /** Metres from the cornea down to the iris. */
  readonly irisDepth: number;
  /** The cornea's index of refraction. */
  readonly ior: number;
  /** How smooth the cornea's highlight is. */
  readonly corneaRoughness: number;
  /** The eye's forward direction, in the mesh's own space at its bind pose. */
  readonly axis: Vec3;
  /** The joint the eye turns with, or -1 for an eye placed by its model matrix alone. */
  readonly joint: number;
}

/**
 * A surface whose static light was baked: the standard model, plus a lightmap page's light read at
 * the mesh's second coordinates (`MeshData.lightmapUvs`). The material's `modelMap` is the page,
 * from `createLightmap`; see `lightmap.ts` for what it adds and what it gives up.
 */
export interface LightmapModel {
  readonly kind: 'lightmap';
  /** Where this material's surfaces are on the page: `uv2 * scale + bias`. See `LightmapRegion`. */
  readonly region: LightmapRegion;
}

/** Every model a material can name, by its `kind`: see `SurfaceMaterial.model`. */
export type SurfaceModel = AnisotropicModel | HairModel | SkinModel | EyeModel | LightmapModel;
/** A model's name, which also picks its pipeline switch: `SURFACE_MODEL_SWITCH`. */
export type SurfaceModelKind = SurfaceModel['kind'];

/** Every kind, in the order the lit stage declares their switches. */
export const SURFACE_MODEL_KINDS: readonly SurfaceModelKind[] = [
  'anisotropic',
  'hair',
  'skin',
  'eye',
  'lightmap',
];

/** The lit stage's switch for each kind. */
export const SURFACE_MODEL_SWITCH: Readonly<Record<SurfaceModelKind, string>> = {
  anisotropic: 'MODEL_ANISOTROPIC',
  hair: 'MODEL_HAIR',
  skin: 'MODEL_SKIN',
  eye: 'MODEL_EYE',
  lightmap: 'MODEL_LIGHTMAP',
};

/** Floats a material's model takes: `uModelParams[2]`. */
export const MODEL_PARAM_FLOATS = 8;

function check(model: string, name: string, value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || value < low || value > high) {
    throw new Error(`${model}: ${name} must be from ${low} to ${high}, not ${String(value)}`);
  }
  return value;
}

function unit(model: string, name: string, v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 1e-6))
    throw new Error(`${model}: ${name} must be a direction, not [${v.join(', ')}]`);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Brushed metal and the like, after glTF's `KHR_materials_anisotropy`: a strength and a turn. */
export function anisotropicModel(
  options: { strength?: number; rotation?: number } = {},
): AnisotropicModel {
  return Object.freeze({
    kind: 'anisotropic',
    strength: check('anisotropicModel', 'strength', options.strength ?? 1, 0, 1),
    rotation: check(
      'anisotropicModel',
      'rotation',
      options.rotation ?? 0,
      -2 * Math.PI,
      2 * Math.PI,
    ),
  });
}

/** Hair, along the mesh's tangent from root to tip. A tilt of 3°, within the 2.5° to 5° measured. */
export function hairModel(
  options: { shift?: number; scatter?: number; backlit?: number } = {},
): HairModel {
  return Object.freeze({
    kind: 'hair',
    shift: check('hairModel', 'shift', options.shift ?? (3 * Math.PI) / 180, -0.5, 0.5),
    scatter: check('hairModel', 'scatter', options.scatter ?? 0.7, 0, 1),
    backlit: check('hairModel', 'backlit', options.backlit ?? 1, 0, 4),
  });
}

/**
 * How far Burley's normalised diffusion carries light on average, in units of its own distance
 * `d`: its radial density `(e^(−r/d) + e^(−r/3d)) / 4d` has the mean `(d² + 9d²) / 4d = 2.5 d`. So a
 * skin whose light travels `radius` scatters by a profile at `d = radius / 2.5`.
 *
 * **Until 4.8.7 `radius` was `d` itself**, so light travelled two and a half times as far as the
 * model said, and the screen-space blur — whose taps reach nine `d` — spread a face at arm's length
 * over sixty pixels: a nose, lips and brows washed into one blur where a centimetre covers a few.
 * The lit stage's pre-integrated fit, transmission and penumbra take the same `d`, so the two paths
 * still agree with each other.
 */
export const SKIN_MEAN_EXIT = 2.5;

/** Burley's distance `d` for one channel of a skin, in metres: see `SKIN_MEAN_EXIT`. */
export function skinProfileDistance(model: SkinModel, channel: 0 | 1 | 2): number {
  return ((model.scatterColor[channel] as number) * model.radius) / SKIN_MEAN_EXIT;
}

/** Skin. The defaults are a fair skin's: red light leaving a little over a centimetre away. */
export function skinModel(
  options: { scatterColor?: Vec3; radius?: number; transmission?: number; profile?: number } = {},
): SkinModel {
  const color = options.scatterColor ?? [0.85, 0.35, 0.22];
  for (let c = 0; c < 3; c++) check('skinModel', 'scatterColor', color[c] as number, 0, 1);
  const profile = check('skinModel', 'profile', options.profile ?? 0, 0, 7);
  if (!Number.isInteger(profile))
    throw new Error(`skinModel: profile must be a whole number, not ${profile}`);
  return Object.freeze({
    kind: 'skin',
    scatterColor: Object.freeze([color[0], color[1], color[2]]) as unknown as Vec3,
    radius: check('skinModel', 'radius', options.radius ?? 0.012, 0, 0.1),
    transmission: check('skinModel', 'transmission', options.transmission ?? 0.5, 0, 1),
    profile,
  });
}

/** An eye. The defaults are a human eye's, its axis along the mesh's +Z. */
export function eyeModel(
  options: {
    irisRadius?: number;
    irisDepth?: number;
    ior?: number;
    corneaRoughness?: number;
    axis?: Vec3;
    joint?: number;
  } = {},
): EyeModel {
  const joint = options.joint ?? -1;
  if (!Number.isInteger(joint) || joint < -1) {
    throw new Error(`eyeModel: joint must be a joint index or -1, not ${String(joint)}`);
  }
  return Object.freeze({
    kind: 'eye',
    irisRadius: check('eyeModel', 'irisRadius', options.irisRadius ?? 0.15, 0.001, 0.5),
    irisDepth: check('eyeModel', 'irisDepth', options.irisDepth ?? 0.003, 0, 0.02),
    ior: check('eyeModel', 'ior', options.ior ?? 1.336, 1, 2),
    corneaRoughness: check('eyeModel', 'corneaRoughness', options.corneaRoughness ?? 0.02, 0, 1),
    axis: Object.freeze(unit('eyeModel', 'axis', options.axis ?? [0, 0, 1])) as unknown as Vec3,
    joint,
  });
}

/**
 * A baked surface, reading its region of a lightmap page: the whole page where none is named. An
 * instanced batch's regions compose with this one, each instance's applied first: see
 * `MeshInstances.lightmapRegions`.
 */
export function lightmapModel(options: { region?: LightmapRegion } = {}): LightmapModel {
  const region = lightmapRegionOf(options.region);
  return Object.freeze({
    kind: 'lightmap',
    region: Object.freeze([region[0], region[1], region[2], region[3]]) as LightmapRegion,
  });
}

/**
 * A model's numbers into `out` — eight floats, `uModelParams[0]` then `[1]` — and whether a model
 * map is bound into the last. An eye's axis goes in with the descriptor's own until the draw turns
 * it: see `eyeAxisInWorld`. `physical` is `SurfaceMaterial.physicalSpecular`, in the lane the
 * models that read it leave free; skin, hair and the eye shade their own highlights and never do.
 *
 * - standard (null): − · −, −, physical, −
 * - anisotropic: strength, cos and sin of the rotation · −, −, physical, map
 * - hair: shift, scatter, backlit, − · −, −, −, map
 * - skin: the scatter colour, radius / `SKIN_MEAN_EXIT` · transmission, profile, −, map
 * - eye: iris radius, iris depth, ior, cornea roughness · the axis, map
 * - lightmap: the region's scale and bias · −, −, physical, map
 */
export function packModel(
  model: SurfaceModel | null,
  mapped: boolean,
  out: Float32Array,
  physical = false,
): void {
  out.fill(0);
  const highlight = physical ? 1 : 0;
  if (model === null) {
    out[6] = highlight;
    return;
  }
  out[7] = mapped ? 1 : 0;
  switch (model.kind) {
    case 'anisotropic':
      out[0] = model.strength;
      out[1] = Math.cos(model.rotation);
      out[2] = Math.sin(model.rotation);
      out[6] = highlight;
      return;
    case 'hair':
      out[0] = model.shift;
      out[1] = model.scatter;
      out[2] = model.backlit;
      return;
    case 'skin':
      out[0] = model.scatterColor[0];
      out[1] = model.scatterColor[1];
      out[2] = model.scatterColor[2];
      /* Burley's distance for a channel of share 1, which the shader scales by each share. */
      out[3] = model.radius / SKIN_MEAN_EXIT;
      out[4] = model.transmission;
      out[5] = model.profile;
      return;
    case 'eye':
      out[0] = model.irisRadius;
      out[1] = model.irisDepth;
      out[2] = model.ior;
      out[3] = model.corneaRoughness;
      out[4] = model.axis[0];
      out[5] = model.axis[1];
      out[6] = model.axis[2];
      return;
    case 'lightmap':
      out[0] = model.region[0];
      out[1] = model.region[1];
      out[2] = model.region[2];
      out[3] = model.region[3];
      out[6] = highlight;
      return;
  }
}

/**
 * An eye's axis in the world for one draw, into `out[at…at+2]`: the descriptor's mesh-local axis
 * turned by its joint's palette entry, where it names one and a palette is set, and then by the
 * draw's model matrix — the turn its vertices take, without the translation. Normalised, because
 * a palette carries a joint's scale.
 */
export function eyeAxisInWorld(
  model: EyeModel,
  placement: ArrayLike<number>,
  palette: ArrayLike<number> | null,
  out: Float32Array,
  at: number,
): void {
  let [x, y, z] = model.axis;
  const j = model.joint * 16;
  if (palette !== null && model.joint >= 0 && j + 16 <= palette.length) {
    const px =
      (palette[j] as number) * x + (palette[j + 4] as number) * y + (palette[j + 8] as number) * z;
    const py =
      (palette[j + 1] as number) * x +
      (palette[j + 5] as number) * y +
      (palette[j + 9] as number) * z;
    const pz =
      (palette[j + 2] as number) * x +
      (palette[j + 6] as number) * y +
      (palette[j + 10] as number) * z;
    x = px;
    y = py;
    z = pz;
  }
  const m = placement;
  const wx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z;
  const wy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z;
  const wz = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z;
  const length = Math.hypot(wx, wy, wz) || 1;
  out[at] = wx / length;
  out[at + 1] = wy / length;
  out[at + 2] = wz / length;
}
