/**
 * A showroom, generated, around a car that is loaded.
 *
 * Every other scene here draws geometry the engine invented on the spot, and that is the
 * argument they make together: nothing fetched, nothing cached, nothing to 404. This one
 * makes the opposite argument in the same room, which is why it is worth having — the
 * floor, the walls, the coving and the light rig are all built at mount, and the car in
 * the middle of them arrives from a `.drft` over the network. Two ways of getting geometry
 * onto a screen, lit by one renderer, in one frame.
 *
 * **The room is the point, not the backdrop.** A showroom is the honest setting for a
 * shading demonstration: a large flat polished floor is the hardest surface to fake, and
 * a car is nothing but curvature. A highlight that travels along a wing without breaking,
 * over a floor that reflects the light rig, is the whole claim stated at once.
 *
 * **The car is optional and its absence is not an error.** A model is tens of megabytes,
 * so it is not in the repository — see `models/` and `npm run bake`. Without one the room
 * stands empty on its turntable, correctly lit and perfectly presentable, and says so.
 * That matters beyond convenience: a scene that only works when a large asset is present
 * would be a scene nobody could open, and the graceful path is the one most consumers will
 * be on while they wire their own pipeline up.
 */

import type {
  DemoBudget,
  DemoHandle,
  DemoScene,
  DemoSceneOptions,
  DemoStats,
  ResolutionControl,
  RevealControl,
} from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import { LoadProgress } from './loadProgress';
import { MODEL_EXTENSIONS, isProgress } from './modelFormats';
import type { ModelProgress, ModelReply, ModelRequest } from './modelFormats';
import {
  Camera,
  MeshBuilder,
  TAU,
  buildShellFill,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
  shellFillMatrix,
  shellSkin,
} from '../packages/core/src/index';
import type {
  Environment,
  MeshHandle,
  MeshData,
  PointLightSource,
  RenderQualityOptions,
  RenderBackend,
  RendererApi,
  ShellStation,
  SurfaceTexture,
  Vec3,
} from '../packages/core/src/index';
import { CODEC_PNG, CODEC_RAW, CODEC_WEBP, streamDrft } from '@driftengine/drft';
import type { DrftMaterial, DrftTexture } from '@driftengine/drft';
import { DEFAULT_COARSE_CELLS, DrftLoader, TextureSet } from '@driftengine/assets';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Where the room is captured from: the middle of the turntable, at about the height of a wing.
 *
 * A cubemap is right for exactly one point, and everything reflective in this scene is within a
 * couple of metres of this one. The error a probe makes grows with the distance from where it was
 * baked, so the honest place for it is the middle of the subject rather than the middle of the
 * hall — which would put the walls at the wrong distance in every panel.
 */
const PROBE_ORIGIN: Vec3 = [0, 1.1, 0];

/**
 * Which baked model to stand on the turntable.
 *
 * `car.drft` by default and relative, so a host serves it from its own root. `?model=name`
 * loads `name.drft` beside it instead, which is how a bake from any reader gets looked at
 * without editing a scene: bake to `demo/dev/public/`, then open `?scene=6&model=name`.
 *
 * The name is restricted to plain characters rather than pasted into a URL as given. This
 * runs on a page a consumer may host, and a query parameter that reaches `fetch` unchecked
 * is one route to making somebody else's page request an arbitrary URL.
 */
const MODEL_PATTERN = /^[A-Za-z0-9 _-]{1,64}$/;

function modelBase(): string {
  const asked = new URLSearchParams(location.search).get('model');
  if (asked === null || asked === '') return 'car';
  if (!MODEL_PATTERN.test(asked)) {
    console.warn(`showroom: ignoring model "${asked}", which is not a plain file name`);
    return 'car';
  }
  return asked;
}

/**
 * Find which of the supported formats is actually sitting beside the page.
 *
 * `.drft` is asked for first because it is the one that needs no work: it streams, it is
 * zero-copy, and the reveal is the format's own layout. The source formats follow in the
 * order `MODEL_FORMATS` prefers them, so a host that commits `car.glb` and a host that
 * commits `car.fbx` both simply work, and neither has to edit a scene to say so.
 *
 * A `HEAD` rather than a `GET`, so probing six names that are not there costs six empty
 * replies instead of six downloads. The content type is checked for the same reason
 * `DrftLoader` checks it: a dev server answers an unknown path with the page under a 200,
 * and a probe that believed that would "find" every format it looked for.
 */
async function findModel(base: string): Promise<string | null> {
  /*
   * All of them at once, then the most preferred one that answered.
   *
   * Asked one after another this is up to nine round trips before anything starts, and the
   * formats are ordered by what they are worth rather than by what a host is likely to have,
   * so the common case of a single `.fbx` paid for all eight misses in series. Fired together
   * it costs one round trip and the same eight replies, which carry no body: a `HEAD` is used
   * precisely so a name that is not there costs nothing to rule out.
   */
  const found = await Promise.all(
    MODEL_EXTENSIONS.map(async (ext) => {
      const url = `${base}${ext}`;
      try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (!response.ok) return null;
        /*
         * A host that answers an unknown path with its own page under a 200 would otherwise
         * make every format appear to exist, and the first one asked for would win.
         */
        if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html'))
          return null;
        return url;
      } catch {
        /* A refusal is one more name that is not there. */
        return null;
      }
    }),
  );
  /* Preference order is the array's order, so the first that answered is the best that exists. */
  return found.find((url) => url !== null) ?? null;
}

const HALL_HALF = 22;
const WALL_HEIGHT = 9;
const TURNTABLE_RADIUS = 6.5;
/** The disc is centred at half its own half-height, so its surface is twice that. See buildRoom. */
const TURNTABLE_HALF_HEIGHT = 0.05;
const TURNTABLE_TOP_Y = TURNTABLE_HALF_HEIGHT * 2;

const FLOOR: Vec3 = [0.2, 0.21, 0.23];
const FLOOR_DARK: Vec3 = [0.14, 0.145, 0.16];
const WALL: Vec3 = [0.62, 0.63, 0.66];
const TRIM: Vec3 = [0.32, 0.34, 0.38];
const LIGHT_PANEL: Vec3 = [1, 0.98, 0.94];
const TURNTABLE: Vec3 = [0.1, 0.105, 0.115];
/** The recess between floor tiles, and the panel the far wall puts something on. */
const FLOOR_JOINT: Vec3 = [0.1, 0.105, 0.12];
const DISPLAY_PANEL: Vec3 = [0.13, 0.135, 0.15];
/** Cove and reveal strips: warmer than the ceiling panels, as an indirect source reads. */
const COVE_LIGHT: Vec3 = [1, 0.95, 0.86];
/** Floor tiles, and how much of each edge is joint rather than tile. */
const FLOOR_TILE_M = 4;
const FLOOR_JOINT_M = 0.035;

/** Polished concrete is the one surface a viewer has an instinct for. */
const ROUGH_FLOOR = 0.12;
const ROUGH_WALL = 0.85;
const ROUGH_TRIM = 0.3;

/**
 * The overhead panels, which are both the lighting and the thing the floor reflects.
 *
 * Four of them in a rectangle, because a single source gives one highlight and tells a
 * viewer nothing — it is the *pair* of streaks running down a wing that says the panel is
 * long and the surface is curved.
 */
const PANELS: readonly (readonly [number, number])[] = [
  [-7, -9],
  [7, -9],
  [-7, 9],
  [7, 9],
];

/**
 * The studio spots, in from the panels and closer to the subject.
 *
 * Four, arranged as a photographer would: two three-quarter front, two behind for the rim light
 * that separates a dark car from a dark wall. Their fixtures are built in `buildRoom` and their
 * lights in `buildLights`, from this one list, so the two cannot drift apart — a light whose
 * fixture is somewhere else is the failure the engine's own rule about pointing at things exists
 * to prevent.
 */
const SPOTS: readonly (readonly [number, number])[] = [
  [-4.6, 5.4],
  [4.6, 5.4],
  [-4.2, -5.6],
  [4.2, -5.6],
];
/** What the spots are aimed at: about the height of a bonnet, not the floor. */
const SPOT_TARGET_Y = 0.9;
const SPOT_BODY: Vec3 = [0.09, 0.095, 0.105];

/**
 * The paint, and why a scene is the right place for it.
 *
 * **The asset carries no colour.** Measured, not assumed: 96 of its 187 meshes store the FBX
 * default `0.8` grey, every one of its 175 vertex colour layers is entirely white, and no
 * material states any transparency at all. The vendor's own preview shows a red car with
 * tinted glass because that was assigned in the store's viewer and never exported. Importing
 * it faithfully therefore produces a white car with solid white windows, which is correct and
 * is not presentable.
 *
 * What the file *does* carry is the material **names**, and they are exact: `body`, `glass`,
 * `chrome`, `tire_mat5`, `calipers`, `interior`. So the geometry and its surface identity
 * come from the asset, and the look comes from the scene, which is the same division of
 * labour as the store's viewer and is honest about which half is which.
 *
 * Anything unnamed here keeps what the file said, so this dresses the car without hiding it.
 */
interface Paint {
  readonly color?: Vec3;
  readonly roughness?: number;
  readonly specular?: number;
  readonly opacity?: number;
  /** How much of the room this surface mirrors, 0 to 1. */
  readonly reflectivity?: number;
}

/**
 * The body finishes a viewer can ask for, by `?paint=name`.
 *
 * A configuration rather than a constant, because the body is the one surface this scene is
 * *about*: it carries the four soft panels above it, and which paint it wears decides what
 * the scene demonstrates. Black shows the room bent around the wings, which is the argument
 * for carrying reflectivity at all. Red shows a hue with the panels only shaping it, which
 * is the easier picture and the weaker demonstration. Being able to switch between them in
 * a URL is what makes that a claim somebody can check rather than one they have to take.
 *
 * None of them is zero albedo, deliberately: real black paint is a dark grey under clear
 * coat, and a true zero has nothing for a highlight to sit on, so it reads as a hole in the
 * frame rather than as a lacquered surface.
 */
const BODY_PAINT: Readonly<Record<string, Paint>> = {
  /* The default: lacquered black, and the most demanding thing to light in the room. */
  black: { color: [0.016, 0.016, 0.018], roughness: 0.025, specular: 1, reflectivity: 0.97 },
  /* What this scene shipped with. Toronto red, polished. */
  red: { color: [0.62, 0.05, 0.03], roughness: 0.045, specular: 1, reflectivity: 0.85 },
  /* Metallic, where the flake scatters the highlight wider than the clear coat would. */
  silver: { color: [0.38, 0.39, 0.42], roughness: 0.12, specular: 1, reflectivity: 0.7 },
  /* Unlacquered, for the contrast: same geometry, same lights, no reflection to speak of. */
  matte: { color: [0.05, 0.05, 0.055], roughness: 0.55, specular: 0.25, reflectivity: 0.05 },
};

const DEFAULT_BODY_PAINT = 'black';

/**
 * What a named material should wear: the fixed table, with the body taken from whichever
 * finish was asked for.
 *
 * One entry point so the choice cannot be applied in one place and forgotten in another —
 * the opacity and reflectivity of a surface are read separately from its colour, and a body
 * that was black in the colour pass and red in the reflectivity pass would be a bug nobody
 * would think to look for.
 */
function paintFor(name: string): Paint | undefined {
  if (BODY_NAME.test(name)) return BODY_PAINT[bodyChoice()];
  /* The exact table first, so an asset whose names it was written against is unchanged. */
  const exact = PAINT[name];
  if (exact !== undefined) return exact;
  return RULES.find((rule) => rule.match.test(name))?.paint;
}

/**
 * What a surface is, read from what it is *called*, for the assets the exact table was not
 * written against.
 *
 * **A name table is one model's vocabulary, and that is the trap it sets.** `PAINT` below is
 * keyed to a particular car: `body`, `glass`, `chrome`, `tire_mat5`. A second car names the same
 * surfaces `BodyMaterials(00297F)`, `WindscreenGlassGrey`, `AudiLogoChrome` and `Tyre`, so every
 * lookup missed, every one of its 84 materials kept the FBX default `0.8` grey it stores, and
 * the result was a white car that looked like a loader fault and was not one. Nothing had failed
 * to arrive; nothing had been asked for by a name the file uses.
 *
 * So the fallback matches on what a name *contains*. **Order is significant and is the whole
 * design**, because these overlap: `WindscreenGlassBlack` is glass rather than black paint, and
 * `FrontHighlightChrome` is chrome even though `Highlight` contains the word `light`. Each rule
 * is placed where the more specific reading wins.
 *
 * It stays a guess about a *name*, which is a very different thing from a guess about geometry:
 * a wrong entry gives one surface the wrong finish, in view, where anybody can see it. Anything
 * matching nothing keeps what the file said, so an asset is dressed rather than hidden.
 */
const BODY_NAME = /^body/i;

/**
 * Materials that are the photographer's kit rather than the car, dropped before anything
 * measures the model.
 *
 * **A bought model is frequently a scene, not an object.** An artist exports the file they were
 * working in, so the backdrop they stood the car on and the softboxes they lit it with come
 * along as geometry. Both are in one asset here, and they caused two separate complaints that
 * looked unrelated: white slabs floating beside the car, and a car far too small on the
 * turntable.
 *
 * They are one fault. Measured off the file: `Ground` is six vertices spanning 515 x 0 x 791,
 * a flat plane; the two `LightSource` meshes are twenty four vertices each, one centred 306
 * units out to the side and 223 up, one directly overhead. Nothing about that is wrong to draw.
 * What it does is widen the bounds: 606 x 288 x 791 with them and 204 x 124 x 442 without, and
 * the loader fits a model to a scene by those bounds, so the subject was scaled to a box that
 * was mostly empty air.
 *
 * Named exactly, and named here rather than inferred. A rule like "drop anything far from the
 * centre" would be a guess about geometry, and this asset has a real part called
 * `MirrorsLightSouces` sitting on the wing mirror that any loose match on `light` would take
 * with it.
 */
const NOT_THE_SUBJECT: readonly string[] = ['Ground', 'LightSource'];

/**
 * What to say while a source format is being turned into a container, and how far along it is.
 *
 * **The words live here for the same reason every other stage name does.** The worker reports a
 * stage and two byte counts and no prose, because what to call a step depends on who is reading
 * it, and a scene is the thing that knows its audience.
 *
 * The fractions are the honest part. Downloading is the only stage with a real measure, so it is
 * the only one that moves smoothly, and it is given the first two thirds of the bar because on a
 * twenty megabyte model it genuinely is most of the wait. The three after it are steps rather
 * than quantities: a parse cannot say how far through itself it is without inventing a number.
 * They advance the bar on entry instead, which is a claim about what has *finished* rather than
 * a guess about what is left.
 */
function convertingWords(
  progress: ModelProgress | null,
): { title: string; detail: string; fraction: number } | undefined {
  if (progress === null) return undefined;
  if (progress.stage === 'downloading') {
    const megabytes = (progress.received / 1e6).toFixed(1);
    /* A server that sent no length gets a count rather than a percentage it cannot support. */
    const detail =
      progress.total > 0
        ? `${megabytes} OF ${(progress.total / 1e6).toFixed(1)} MB`
        : `${megabytes} MB`;
    const fraction = progress.total > 0 ? (progress.received / progress.total) * 0.66 : 0.05;
    return { title: 'FETCHING THE MODEL', detail, fraction };
  }
  if (progress.stage === 'reading') {
    return { title: 'READING THE FORMAT', detail: 'PARSING, OFF THE MAIN THREAD', fraction: 0.72 };
  }
  if (progress.stage === 'building') {
    return { title: 'BUILDING THE MODEL', detail: 'WELDING VERTICES', fraction: 0.84 };
  }
  return { title: 'PACKING', detail: 'WRITING A CONTAINER', fraction: 0.94 };
}

/**
 * Glazing on an asset this table was not written for, and why it is darker than the exact entry.
 *
 * **How transparent a window should be is a fact about what is behind it.** The car the exact
 * table was written against carries a modelled cabin, so glass at a third transmission shows
 * seats and a dashboard, which is what sells the shape. This one is an exterior shell: measured,
 * its only interior material is 2,088 vertices of trim, against 1.4M in the body. There are no
 * seats to see. A third transmission there is a window onto nothing, and it reads as a car with
 * its inside missing rather than as glass.
 *
 * So the fallback carries no opacity at all and leans entirely on reflection, which is what
 * glass in a lit room mostly is anyway: near black, mirroring the panels overhead. The probe is
 * already baked from the middle of the turntable, so there is something true to reflect, and a
 * blacked-out window is a thing showrooms actually have rather than a dodge.
 *
 * Opacity is *absent* rather than set to 1, which is not the same thing: an opaque surface that
 * still declares itself transparent joins the blended pass, and a blended pass is sorted rather
 * than depth-tested against itself. That is how a windscreen ends up drawn behind the seat it
 * should hide.
 */
const GLASS: Paint = {
  color: [0.012, 0.014, 0.017],
  roughness: 0.04,
  specular: 1,
  reflectivity: 1,
};

const RULES: readonly { readonly match: RegExp; readonly paint: Paint }[] = [
  /*
   * Chrome first, and it has to be, because this asset spells its lamp lenses `Highlight` and one
   * of its chrome trims is called `FrontHighlightChrome`. Any rule reading `light` ahead of this
   * turns brightwork into a headlight.
   */
  {
    match: /chrome/i,
    paint: { color: [0.72, 0.73, 0.76], roughness: 0.03, specular: 1, reflectivity: 1 },
  },
  {
    match: /interior|seat|cabin|dash/i,
    paint: { color: [0.06, 0.055, 0.055], roughness: 0.7, specular: 0.15 },
  },
  /*
   * Lamp lenses, and they stay transparent while the windows do not.
   *
   * The distinction is the one the rest of this table is built on: how transparent a surface
   * should be is a fact about what is behind it. Behind a headlight is a reflector and a bulb,
   * which the asset models and which is the whole reason a lamp reads as glass rather than as a
   * white patch. Behind a windscreen here is nothing at all. So these keep their transmission and
   * the glazing below gives it up, and both are named `Glass` by this file, which is why the
   * order rather than the word decides it.
   */
  {
    match: /highlight|farlight|ring\(light\)|numberplatelight|headlight|taillight|lamp/i,
    paint: {
      color: [0.55, 0.56, 0.6],
      roughness: 0.06,
      specular: 1,
      opacity: 0.42,
      reflectivity: 0.8,
    },
  },
  /*
   * Glazing a name calls black is privacy glass or the surround it sits in, and neither is
   * something to see through. Ahead of the general rule because both words are in the name.
   */
  {
    match: /(glass|windscreen|window).*black|black.*(glass|windscreen|window)/i,
    paint: { color: [0.008, 0.009, 0.011], roughness: 0.07, specular: 0.9, reflectivity: 0.9 },
  },
  { match: /glass|windscreen|windshield|window/i, paint: GLASS },
  /* A mirror shell is brightwork, and the `MirrorsLightSouces` on it is not a lamp lens. */
  {
    match: /mirror/i,
    paint: { color: [0.72, 0.73, 0.76], roughness: 0.05, specular: 1, reflectivity: 0.95 },
  },
  {
    match: /carbon/i,
    paint: { color: [0.07, 0.07, 0.08], roughness: 0.3, specular: 0.5, reflectivity: 0.35 },
  },
  {
    match: /tyre|tire|rubber/i,
    paint: { color: [0.055, 0.055, 0.06], roughness: 0.85, specular: 0.08 },
  },
  /* The disc is machined steel; whatever else says brake is the caliper behind it. */
  {
    match: /brake\s*disc|disc\s*brake|rotor/i,
    paint: { color: [0.34, 0.34, 0.36], roughness: 0.28, specular: 0.6, reflectivity: 0.3 },
  },
  { match: /brake|caliper/i, paint: { color: [0.42, 0.06, 0.05], roughness: 0.35, specular: 0.4 } },
  {
    match: /honeycomb|grille|grill|mesh|vent/i,
    paint: { color: [0.03, 0.03, 0.035], roughness: 0.6, specular: 0.2 },
  },
  /* A folding roof is fabric on this shape of car, and fabric is the opposite of the body. */
  {
    match: /canvas|fabric|cloth|soft\s*top/i,
    paint: { color: [0.05, 0.05, 0.055], roughness: 0.95, specular: 0.04 },
  },
  { match: /plate/i, paint: { color: [0.78, 0.78, 0.76], roughness: 0.4, specular: 0.3 } },
  {
    match: /undercarriage|chassis|axle|axe|airback|bolt|centre|center/i,
    paint: { color: [0.04, 0.04, 0.045], roughness: 0.8, specular: 0.1 },
  },
  {
    match: /black/i,
    paint: { color: [0.035, 0.035, 0.04], roughness: 0.2, specular: 0.6, reflectivity: 0.4 },
  },
];

/**
 * Which body finish was asked for, falling back to the default and saying so.
 *
 * Read when a scene mounts rather than when this module loads. `location` does not exist in
 * a test process, and a module-level read of it takes the whole barrel down on import —
 * which is a scene file breaking every test that so much as mentions the demos.
 */
function bodyChoice(): string {
  const asked = new URLSearchParams(location.search).get('paint');
  if (asked === null || asked === '') return DEFAULT_BODY_PAINT;
  if (!Object.hasOwn(BODY_PAINT, asked)) {
    console.warn(
      `showroom: no paint called "${asked}". Try one of ${Object.keys(BODY_PAINT).join(', ')}.`,
    );
    return DEFAULT_BODY_PAINT;
  }
  return asked;
}

const PAINT: Readonly<Record<string, Paint>> = {
  /* Glass is the whole point of carrying opacity at all. Dark enough to read as tinted,
     clear enough that the interior behind it is visible, which is what sells a cabin. */
  glass: {
    color: [0.05, 0.06, 0.07],
    roughness: 0.03,
    specular: 1,
    opacity: 0.34,
    reflectivity: 1,
  },
  d_glass: {
    color: [0.05, 0.06, 0.07],
    roughness: 0.05,
    specular: 0.9,
    opacity: 0.34,
    reflectivity: 1,
  },
  r_glass: {
    color: [0.05, 0.06, 0.07],
    roughness: 0.05,
    specular: 0.9,
    opacity: 0.34,
    reflectivity: 1,
  },
  vd_glass: {
    color: [0.05, 0.06, 0.07],
    roughness: 0.05,
    specular: 0.9,
    opacity: 0.34,
    reflectivity: 1,
  },
  /* The M5's carbon roof, and the black trim around the glasshouse. */
  carbon: { color: [0.07, 0.07, 0.08], roughness: 0.3, specular: 0.5, reflectivity: 0.35 },
  black: { color: [0.035, 0.035, 0.04], roughness: 0.35, specular: 0.4 },
  black_matt: { color: [0.045, 0.045, 0.05], roughness: 0.75, specular: 0.12 },
  black_shiny: { color: [0.04, 0.04, 0.045], roughness: 0.12, specular: 0.7, reflectivity: 0.6 },
  /* Wheels are black on this car, not the bare metal the default grey reads as. */
  silver: { color: [0.09, 0.09, 0.1], roughness: 0.16, specular: 0.75, reflectivity: 0.5 },
  silver_d: { color: [0.5, 0.51, 0.53], roughness: 0.18, specular: 0.8 },
  chrome: { color: [0.72, 0.73, 0.76], roughness: 0.03, specular: 1, reflectivity: 1 },
  /* No entry for `calipers`: the file states that one correctly, as a gold, and letting it
     through is the point. Overriding it would hide whether the reader still gets it right. */
  brakes3: { color: [0.28, 0.28, 0.3], roughness: 0.45, specular: 0.35 },
  interior: { color: [0.06, 0.055, 0.055], roughness: 0.7, specular: 0.15 },
  tire_mat5: { color: [0.055, 0.055, 0.06], roughness: 0.85, specular: 0.08 },
  copper: { color: [0.45, 0.26, 0.13], roughness: 0.3, specular: 0.6 },
};

/** Apply the scene's palette to a mesh, leaving anything it does not name alone. */
function paint(mesh: MeshData, material: DrftMaterial | undefined): MeshData {
  const wanted = paintFor(material?.name ?? '');
  if (wanted === undefined) return mesh;
  const vertices = mesh.positions.length / 3;
  const out: MeshData = { ...mesh };
  if (wanted.color !== undefined) {
    const colors = new Float32Array(vertices * 3);
    for (let i = 0; i < vertices; i++) {
      colors[i * 3] = wanted.color[0];
      colors[i * 3 + 1] = wanted.color[1];
      colors[i * 3 + 2] = wanted.color[2];
    }
    /* Only where the file has no map of its own: a tyre's tread and a badge are the
       asset's, and overpainting them would throw away the textures just embedded. */
    if ((material?.albedo ?? -1) < 0) out.colors = colors;
  }
  if (wanted.roughness !== undefined)
    out.roughness = new Float32Array(vertices).fill(wanted.roughness);
  if (wanted.specular !== undefined)
    out.specular = new Float32Array(vertices).fill(wanted.specular);
  return out;
}

/**
 * An embedded texture into something the GPU can take.
 *
 * `createImageBitmap` is the browser's own decoder, so a `.drft` carrying JPEG, PNG or WEBP
 * costs this engine no decoder and no dependency. `RAW` is uncompressed RGBA8 and is what
 * the baker substitutes for a texture it could not find, so it has to work: without it a
 * missing file would take the whole model down at load rather than leaving one surface flat.
 *
 * **Straight alpha and no colour conversion**, as `@driftengine/assets`' loader decodes: premultiplied,
 * the emblem's transparent texels lose the colour padded past its edge and filtering draws that as
 * a dark rim, and colour management would rewrite the normal and ORM maps' values.
 */
async function decode(texture: DrftTexture): Promise<ImageBitmap> {
  if (texture.codec === CODEC_RAW) {
    const pixels = new Uint8ClampedArray(texture.bytes.slice().buffer);
    return createImageBitmap(new ImageData(pixels, texture.width, texture.height), AS_AUTHORED);
  }
  const type =
    texture.codec === CODEC_PNG
      ? 'image/png'
      : texture.codec === CODEC_WEBP
        ? 'image/webp'
        : 'image/jpeg';
  /* `slice` because the bytes are a view over the whole asset, and a Blob over the view
     would otherwise carry the entire file. */
  return createImageBitmap(new Blob([texture.bytes.slice()], { type }), AS_AUTHORED);
}

const AS_AUTHORED = {
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
} as const satisfies ImageBitmapOptions;

/**
 * What a car looks like from the side, for the engine's interior fill.
 *
 * **The only part of this the scene still owns.** Closing the inside of a hollow model is an
 * engine capability now, `buildShellFill` and `shellSkin`, because nothing about it is a
 * showroom: a car with no cabin and a building with no rooms are the same problem. What the
 * engine cannot know is the shape of the thing in front of it, so the silhouette is stated here
 * and everything else is a size.
 *
 * Full at both ends and symmetric. A bumper is nearly full width and a grille runs most of the
 * height of the nose, so tapering the ends as an outline tapers leaves nothing standing
 * behind the grille and a viewer looks through the front of the car at the floor beyond. Which
 * end of a model is the nose is not something the scene is told either.
 */
const CAR_PROFILE: readonly ShellStation[] = [
  { at: 0, width: 0.84, waist: 0.54, roofWidth: 0, top: 0.54 },
  { at: 0.08, width: 0.95, waist: 0.64, roofWidth: 0, top: 0.64 },
  { at: 0.22, width: 1, waist: 0.7, roofWidth: 0.5, top: 0.82 },
  { at: 0.4, width: 1, waist: 0.72, roofWidth: 0.68, top: 0.99 },
  { at: 0.6, width: 1, waist: 0.72, roofWidth: 0.68, top: 0.99 },
  { at: 0.78, width: 1, waist: 0.7, roofWidth: 0.5, top: 0.82 },
  { at: 0.92, width: 0.95, waist: 0.64, roofWidth: 0, top: 0.64 },
  { at: 1, width: 0.84, waist: 0.54, roofWidth: 0, top: 0.54 },
];

/** How far inside its own skin the copy is drawn. Just enough to be covered by it. */
const SKIN_SHRINK = 0.985;

/**
 * How coarse an outline to draw while the model arrives, and whether to draw one at all.
 *
 * **On, at `DEFAULT_COARSE_CELLS`, unless somebody refuses it.** `?outline=48` for a finer grid,
 * `?outline=0` to refuse, and `DemoSceneOptions.outline: false` for a host that knows its own
 * model decimates badly. The stage it buys is real: a whole recognisable object on screen inside
 * the first few hundred kilobytes of a seventy megabyte file.
 *
 * It was off unless asked for, because a coarse level is a decimation and the hull of the time
 * joined clusters lying on different surfaces, so an asset could come back as lumps and ridges
 * and somebody waiting for a car got white cliffs. The occupancy hull emits the boundary of a
 * solid, so the worst case is a coarse version of the shape.
 *
 * **The query answers for the person at the keyboard and `DemoSceneOptions` answers for the
 * page**, which is why the query wins where both speak. Somebody comparing two states of a model
 * locally is mid-experiment, and an experiment a page can overrule is not one.
 *
 * Only reaches the conversion of a *source* format. A `.drft` carries an outline or does not,
 * because that was decided when it was baked: see `npm run bake -- --no-lod`.
 */
function outlineCells(host: boolean | number | undefined): number | undefined {
  const fallback =
    host === false ? undefined : host === undefined || host === true ? DEFAULT_COARSE_CELLS : host;
  const asked = new URLSearchParams(location.search).get('outline');
  if (asked === null || asked === '') return fallback;
  if (asked === '0' || asked === 'off') return undefined;
  if (asked === '1' || asked === 'on') return DEFAULT_COARSE_CELLS;
  const cells = Number(asked);
  if (Number.isFinite(cells) && cells >= 4) return cells;
  console.warn(`showroom: "outline=${asked}" is not a number of cells. Try outline=40.`);
  return fallback;
}

/**
 * A tone curve and an exposure a viewer can ask for, so the dial can be *looked at*.
 *
 * `?exposure=0.6` or `?exposure=1.6`. Absent means the scene is graded exactly as it always
 * was, with no tone curve at all, because the six published demos are tuned as they stand and
 * a new transform that changes them by default is a regression however good it looks.
 *
 * It switches the curve on as well as setting the number, because the two are one decision:
 * exposure is how far a scene is scaled *into* a curve, so without one there is nothing for it
 * to mean and a viewer who asked for it would see no change and conclude it does not work.
 */
function askedExposure(): number | undefined {
  const asked = new URLSearchParams(location.search).get('exposure');
  if (asked === null || asked === '') return undefined;
  const value = Number(asked);
  if (Number.isFinite(value) && value > 0) return value;
  console.warn(`showroom: "exposure=${asked}" is not a positive number. Try exposure=1.2.`);
  return undefined;
}

/**
 * Whether to close the inside of the model, which is **off unless somebody says the model is
 * hollow**.
 *
 * It was on for everything, and it was wrong for the reason a feature built against one asset
 * usually is: it exists because the car the site ships is an *exterior shell*, so every opening
 * in it, a grille, a wheel arch, a window, looks straight through the body and out the far side.
 * Filling that is right for that model and wrong for a model that carries a cabin, where the
 * fill is a solid standing behind the glass with seats in front of it and reads as a black box
 * inside the car.
 *
 * Which of the two an asset is, is not something this scene can be told by the file, and it is
 * not something to guess from the geometry either: a car with a modelled interior and a car
 * without have the same bounds, the same materials and often the same material *names*. So it is
 * stated rather than inferred, by whoever chose the file.
 *
 * **Two channels, and they are for two different people.** `?fill=1` is the person at the
 * keyboard, holding a model up against a scene to settle how it should be shown. The
 * `DemoSceneOptions` bag is the page, which is not a person typing and cannot be asked to put a
 * query string on its own URL. The query wins where both speak, so a host's standing answer can
 * still be switched off in front of it with `?fill=0`.
 */
function wantsFill(host: boolean | undefined): boolean {
  const asked = new URLSearchParams(location.search).get('fill');
  if (asked === null || asked === '') return host === true;
  if (asked === '0' || asked === 'off') return false;
  if (asked === '1' || asked === 'on') return true;
  console.warn(`showroom: "fill=${asked}" is not a choice. Use fill=1 to close a hollow model.`);
  return host === true;
}

function buildRoom(): MeshData {
  const builder = new MeshBuilder();

  /*
   * The floor: large polished tiles with a recessed joint between them.
   *
   * It was six-metre stripes of two greys, and stripes read as a *stage* rather than as a floor —
   * they have no scale, because nothing about a stripe says how big it is. A tile grid does: a
   * viewer knows roughly how big a floor tile is, so the grid is what tells them the room is
   * eighteen metres wide and the car in it is four and a half. The joints are the same idea one
   * level down, and they are what a reflection breaks over.
   */
  builder.setRoughness(ROUGH_FLOOR);
  /* Ground and polished concrete: the one mineral surface in the room, and at roughness 0.12 the
     one that any weighting from roughness would have given almost no grain. */
  builder.setGrain(0.75);
  const tiles = Math.ceil(HALL_HALF / FLOOR_TILE_M);
  for (let ix = -tiles; ix < tiles; ix++) {
    for (let iz = -tiles; iz < tiles; iz++) {
      const x = (ix + 0.5) * FLOOR_TILE_M;
      const z = (iz + 0.5) * FLOOR_TILE_M;
      /* A whisper of variation between tiles, at the level of a real floor's batch difference
         rather than a checkerboard: two shades of the same grey, alternating on the diagonal. */
      const shade = (ix + iz) % 2 === 0 ? FLOOR : FLOOR_DARK;
      const half = FLOOR_TILE_M / 2 - FLOOR_JOINT_M;
      builder.addBox([x, -0.05, z], [half, 0.05, half], shade, 0, 0.55);
    }
  }
  /* The joints, as one recessed slab under the tiles rather than as gaps. A gap would show the
     void under the floor from a low camera. */
  builder.setRoughness(0.7);
  builder.setGrain(0.4);
  builder.addBox([0, -0.09, 0], [HALL_HALF, 0.04, HALL_HALF], FLOOR_JOINT, 0, 0.1);

  /* Walls and a coved ceiling edge, which is what stops a room reading as a box. */
  builder.setRoughness(ROUGH_WALL);
  /*
   * And nothing from here on. Painted plaster, painted trim, a lit panel and a lacquered
   * turntable are all manufactured finishes: rough, in the plaster's case very, and with no
   * mineral structure to show through the paint.
   */
  builder.setGrain(0);
  for (const side of [-1, 1]) {
    builder.addBox(
      [side * HALL_HALF, WALL_HEIGHT / 2, 0],
      [0.3, WALL_HEIGHT / 2, HALL_HALF],
      WALL,
      0,
      0.05,
    );
    builder.addBox(
      [0, WALL_HEIGHT / 2, side * HALL_HALF],
      [HALL_HALF, WALL_HEIGHT / 2, 0.3],
      WALL,
      0,
      0.05,
    );
  }
  builder.addBox([0, WALL_HEIGHT, 0], [HALL_HALF, 0.3, HALL_HALF], WALL, 0, 0.04);

  /*
   * A cove: a lit strip running the whole perimeter, tucked behind a lip so the source is hidden
   * and what a viewer sees is the wall above it glowing.
   *
   * **This is the single thing that most makes a room read as a showroom rather than as a lit
   * box.** Four ceiling panels light the car and leave the walls to the ambient term, which is
   * why the corners of the room were flat. A cove is how the trade actually lights these spaces,
   * and it costs one emissive strip and one lip per wall.
   */
  const coveY = WALL_HEIGHT - 1.4;
  for (const side of [-1, 1]) {
    /* The strip, facing inward and up. */
    builder.setRoughness(0.9);
    builder.addBox(
      [side * (HALL_HALF - 0.34), coveY, 0],
      [0.06, 0.1, HALL_HALF - 0.5],
      COVE_LIGHT,
      1,
      0.1,
    );
    builder.addBox(
      [0, coveY, side * (HALL_HALF - 0.34)],
      [HALL_HALF - 0.5, 0.1, 0.06],
      COVE_LIGHT,
      1,
      0.1,
    );
    /* The lip below it, which is what hides the source from a standing eye. */
    builder.setRoughness(ROUGH_TRIM);
    builder.addBox(
      [side * (HALL_HALF - 0.26), coveY - 0.16, 0],
      [0.14, 0.07, HALL_HALF - 0.4],
      TRIM,
      0,
      0.35,
    );
    builder.addBox(
      [0, coveY - 0.16, side * (HALL_HALF - 0.26)],
      [HALL_HALF - 0.4, 0.07, 0.14],
      TRIM,
      0,
      0.35,
    );
  }

  builder.setRoughness(ROUGH_TRIM);
  for (const side of [-1, 1]) {
    builder.addBox([side * (HALL_HALF - 0.4), 0.14, 0], [0.2, 0.14, HALL_HALF], TRIM, 0, 0.3);
    builder.addBox([0, 0.14, side * (HALL_HALF - 0.4)], [HALL_HALF, 0.14, 0.2], TRIM, 0, 0.3);
  }

  /*
   * Columns, set in from the walls.
   *
   * Their job is scale and it is the same job the floor grid does from another direction: a
   * vertical of a known size at a known distance is what makes a wall read as far away rather
   * than as large. They also break the reflection in the floor into something with structure.
   */
  builder.setRoughness(0.75);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (HALL_HALF - 3.2);
      const z = sz * (HALL_HALF - 7);
      builder.addBox([x, WALL_HEIGHT / 2, z], [0.42, WALL_HEIGHT / 2, 0.42], WALL, 0, 0.06);
      /* A darker base, because a column that meets the floor with no detail reads as a prop. */
      builder.setRoughness(ROUGH_TRIM);
      builder.addBox([x, 0.22, z], [0.52, 0.22, 0.52], TRIM, 0, 0.3);
      builder.setRoughness(0.75);
    }
  }

  /*
   * The display wall at the far end: a recessed dark panel with a lit reveal around it.
   *
   * A showroom has one wall it puts something on, and giving the room a *front* is what turns an
   * orbit into a composition — there is now a direction the car is being shown from. Deliberately
   * blank: a logo or a word would be either a real brand's, which is not ours to put here, or an
   * invented one, which reads as placeholder art.
   */
  builder.setRoughness(0.5);
  builder.addBox([0, 4.2, -(HALL_HALF - 0.32)], [8.4, 3.4, 0.06], DISPLAY_PANEL, 0, 0.2);
  builder.setRoughness(0.9);
  /* The reveal: four thin emissive strips framing it, which is what makes it read as recessed. */
  for (const sy of [-1, 1]) {
    builder.addBox([0, 4.2 + sy * 3.48, -(HALL_HALF - 0.3)], [8.5, 0.05, 0.05], COVE_LIGHT, 1, 0.1);
  }
  for (const sx of [-1, 1]) {
    builder.addBox([sx * 8.48, 4.2, -(HALL_HALF - 0.3)], [0.05, 3.4, 0.05], COVE_LIGHT, 1, 0.1);
  }

  /*
   * The studio spots: four barrels on the ceiling, aimed at the turntable.
   *
   * **Because a light has to come from something a viewer can point at.** The four ceiling panels
   * are a soft ambient wash and they are what makes a wing read as curved; what they cannot do is
   * put a hard accent along a shoulder line, which is the thing a photographer actually lights a
   * car with. So these are the second source, and they are aimed rather than hung: a barrel tilted
   * at the subject, with its lens visible, which is what tells the eye where the accent came from.
   *
   * `addOrientedMesh` needs an orthonormal right-handed frame, so the aim is built as one rather
   * than as an angle: forward from the fixture to the target, right across it and world up, up
   * completed from the other two.
   */
  for (const [x, z] of SPOTS) {
    const originY = WALL_HEIGHT - 1.05;
    /* Toward the middle of the car rather than the middle of the turntable, which is a metre
       lower and reads as lighting the floor. */
    let fx = -x;
    let fy = SPOT_TARGET_Y - originY;
    let fz = -z;
    const length = Math.hypot(fx, fy, fz) || 1;
    fx /= length;
    fy /= length;
    fz /= length;
    /* Across the aim and world up. Never degenerate here: no fixture points straight down. */
    let rx = fz;
    let rz = -fx;
    const across = Math.hypot(rx, rz) || 1;
    rx /= across;
    rz /= across;
    /* up = forward x right, which for a right-handed frame closes it. */
    const upx = fy * rz - fz * 0;
    const upy = fz * rx - fx * rz;
    const upz = fx * 0 - fy * rx;
    const upLength = Math.hypot(upx, upy, upz) || 1;

    const barrel = new MeshBuilder();
    barrel.setRoughness(0.4);
    /* The barrel, along its own +Z so the frame above aims it. */
    barrel.addCylinder([0, 0, 0.42], 0.3, 0.42, 'z', SPOT_BODY, 0, 20, 0.45);
    /* The lens, a shade proud of the barrel's mouth and emissive: this is the bit that says
       "this is where the light is coming from". */
    barrel.setRoughness(0.9);
    barrel.addCylinder([0, 0, 0.86], 0.26, 0.03, 'z', COVE_LIGHT, 1, 20, 0.1);
    /* And the yoke it hangs from, back at the ceiling. */
    barrel.setRoughness(0.35);
    barrel.addBox([0, 0, -0.16], [0.07, 0.2, 0.16], TRIM, 0, 0.4);
    builder.addOrientedMesh(
      barrel.build(),
      [x, originY, z],
      [rx, 0, rz],
      [upx / upLength, upy / upLength, upz / upLength],
      [fx, fy, fz],
      1,
    );
  }

  /*
   * The turntable: a low disc the car stands on, so the eye has a ground plane for it even before
   * the car arrives — and so an empty room still reads as a room *for* something rather than as an
   * unfinished one.
   */
  builder.setRoughness(0.2);
  /* A cylinder rather than a fan of quads: a fan meets at the centre, where two corners coincide
     and a quad has no normal, which the engine refuses, correctly. */
  builder.addCylinder(
    [0, TURNTABLE_HALF_HEIGHT, 0],
    TURNTABLE_RADIUS,
    TURNTABLE_HALF_HEIGHT,
    'y',
    TURNTABLE,
    0,
    56,
    0.5,
  );
  builder.setRoughness(0.35);
  builder.addCylinder([0, 0.11, 0], TURNTABLE_RADIUS + 0.14, 0.03, 'y', TRIM, 0.05, 56, 0.6);
  /* And a lit ring in the floor around it, which is the other thing these rooms all have. */
  builder.setRoughness(0.9);
  builder.addCylinder([0, 0.015, 0], TURNTABLE_RADIUS + 0.5, 0.015, 'y', COVE_LIGHT, 0.85, 64, 0.1);
  builder.setRoughness(null);
  return builder.build();
}

function buildEnvironment(): Environment {
  /*
   * Barely any directional light, and that is the setting. A showroom is lit by its
   * ceiling, so the panels do the work and the sun is a faint fill — which also means the
   * four point lights are what a viewer is actually judging.
   */
  return createEnvironment({
    directionalDir: [-0.25, 0.93, 0.27],
    directionalColor: [0.62, 0.63, 0.7],
    ambient: [0.52, 0.53, 0.58],
    ambientGround: [0.26, 0.265, 0.29],
    emissiveGain: 1,
    nightFactor: 1,
    fogColor: [0.28, 0.29, 0.32],
    fogDensity: 0.004,
    fogHeightFalloff: 0.02,
    fogBaseY: 0,
  });
}

/**
 * The four panel lights, built as what they are rather than cast into it.
 *
 * **The cast this replaces is what made the room black.** These literals went through
 * `as unknown as PointLightSource[]`, which silences the compiler completely — so `flicker`
 * being absent and `intensity` being a field that does not exist were both invisible. The
 * failure is worse than an inert light: `flickerScale` reads `light.flicker`, `undefined <= 0`
 * is false so it does not take the steady path, and `1 + undefined * wobble` is `NaN`. That
 * NaN is multiplied into the light's colour, uploaded as a uniform, and NaN propagates
 * through every term it touches, so the whole fragment resolves to black rather than to an
 * unlit room. A scene lit by nothing still shows its ambient; this one showed nothing at all,
 * which is the tell that the lights were poisoning the shading rather than missing from it.
 *
 * There is no `intensity`. Brightness is the magnitude of `r`, `g` and `b`, which is why they
 * sit above one — a panel is brighter than the white it illuminates.
 */
function buildLights(): PointLightSource[] {
  const panels: PointLightSource[] = PANELS.map(([x, z]) => ({
    x,
    y: WALL_HEIGHT - 0.9,
    z,
    r: 1.15,
    g: 1.12,
    b: 1.05,
    radius: 26,
    /* A panel is mains-powered and steady. Flicker belongs to a flame. */
    flicker: 0,
    /* Well below the panel and far above anything it lights, so the cube spends its
       depth precision on the room rather than on the metre of air under the housing. */
    shadowNear: 1,
    /* Wide, because that is the whole argument of the scene: a large soft source draws a
       long gradient down a wing where a point source draws a dot. */
    sourceRadius: 1.6,
  }));

  /*
   * And the spots, from the same list their fixtures are built from.
   *
   * Tighter and warmer than the panels, with a small source radius, because that is the whole
   * point of having both: a large soft source draws the long gradient down a wing and a small one
   * draws the hard accent along its shoulder. A room with only the first reads as evenly lit and
   * slightly dead, which is what this one did.
   *
   * Placed at the lens rather than at the ceiling, or the fixture would be between its own light
   * and the car and would shadow it.
   */
  const spots: PointLightSource[] = SPOTS.map(([x, z]) => ({
    x: x * 0.86,
    y: WALL_HEIGHT - 1.75,
    z: z * 0.86,
    r: 1.25,
    g: 1.18,
    b: 1.04,
    radius: 17,
    flicker: 0,
    shadowNear: 0.6,
    /* Small, so it throws an accent with an edge to it. */
    sourceRadius: 0.34,
  }));

  return [...panels, ...spots];
}

class ShowroomHandle implements DemoHandle {
  /**
   * **The gap is closed.** This scene held its own `WebGL2RenderingContext` and refused to
   * mount without one, because `LoadProgress` built two `TextRenderer`s and a `TextRenderer`
   * took a context. Text is a handle the renderer draws now, so the context is gone and so is
   * the refusal — a scene whose whole subject is watching a model arrive draws its bar on
   * either backend.
   */
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
  /** Whether the room has been captured into the probe. One bake, not one per frame. */
  private probeBaked = false;
  /*
   * A wide zoom range, because this scene loads whatever it is given.
   *
   * Six metres was the floor and it suits a car. The same limit against a character is a
   * wall: the model is fitted to about two and a half metres, so the wheel stopped more than
   * twice its height away and there was no getting closer. The near limit is now under a
   * metre, which is close enough to read a badge or a stitch, and the far one covers standing
   * back from the whole room.
   */
  readonly view = new OrbitView(0.6, 60, 0.2);
  private readonly room: MeshHandle;
  /** The matrix that draws the fill inside the model, rebuilt when a model lands. */
  private readonly fillMatrix = new Float32Array(16);
  /** The black shell accumulating while parts arrive, and the mesh built from it at the end. */
  private fillBuilder: MeshBuilder | null = null;
  private fillMesh: MeshHandle | null = null;
  /** The generated solid, which closes the openings a copy of the shell reproduces. */
  private solidMesh: MeshHandle | null = null;
  /** Whether the model on the turntable is a hollow shell to be closed. See `wantsFill`. */
  private readonly fills: boolean;
  /**
   * How coarse an outline to open the load on, or undefined for none. See `outlineCells`.
   *
   * Held rather than read twice. It reaches the loader at construction and the worker when a
   * source format is converted, and those are two different moments: a value read again at the
   * second one would let a scene ask its worker for an outline the loader has already decided
   * not to draw.
   */
  private readonly outline: number | undefined;
  /** The model's own size once fitted, in metres. Zero until something has landed. */
  private fitted = { x: 0, y: 0, z: 0 };
  private readonly env: Environment;
  private readonly lights: PointLightSource[];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };
  /** What a viewer asked the tone curve to be exposed at, or undefined for no curve at all. */
  private readonly exposure: number | undefined;

  /**
   * The loaded model, one entry per texture it wears, and empty until it arrives.
   *
   * Empty is also the permanent state when there is no model to load, which is not an error:
   * the room stands on its own and says so.
   */
  /**
   * The car, loaded by the engine rather than by this file.
   *
   * Everything about *how* a model arrives — streaming it, budgeting the uploads so the frame does
   * not hitch, fading each part in, merging down to one draw per material at the end — is the
   * engine's, because none of it is about a showroom. What stays here is the three things that
   * are: the size of the turntable, what a surface named `body` should be painted, and which
   * surfaces are glass.
   */
  private readonly loader: DrftLoader;
  /**
   * The load, as something a viewer can move back and forth through.
   *
   * **Why this is worth having at all**: the reveal is over in a second on a fast connection, and
   * it is the thing this scene is *about*. A stage that can only be seen by reloading and
   * catching it can be admired but not examined, and "the order you see is the file" is a claim
   * somebody should be able to check at their own pace rather than take on trust.
   *
   * The scene owns what a state is and whatever mounted it owns the control, which is the same
   * split `view` makes for the camera. Nothing here knows what a slider looks like.
   */
  readonly reveal: RevealControl;
  /** Which state a viewer parked the reveal on, or -1 while the load speaks for itself. */
  private scrubbed = -1;
  /**
   * What the worker is doing, while it is doing it, or null when nothing is converting.
   *
   * Only ever set for a source format. A `.drft` needs no conversion, so this stays null and the
   * bar reads the container's own phases exactly as it always has.
   */
  private conversion: ModelProgress | null = null;
  private readonly progress: LoadProgress;

  /**
   * The car's textures, addressable by the name the source gave them.
   *
   * Kept so a caller can replace one without knowing where it sits: `textures.get("logo.png")`
   * rather than a position in `parts`, which is ordered by how the meshes happened to bucket.
   */
  private carTextureNames: readonly string[] = [];

  /**
   * How big the fitted model is, so the camera can frame it rather than a guess.
   *
   * Defaults suit the empty room, which is what is on screen before anything loads.
   */
  private frameReach = 8;
  private frameHeight = 2.4;
  private elapsedSec = 0;
  private lastGpuMs = 0;
  private disposed = false;

  constructor(
    renderer: RendererApi,
    canvas: HTMLCanvasElement,
    options: DemoSceneOptions,
    exposure: number | undefined,
    budget: DemoBudget,
  ) {
    this.canvas = canvas;
    this.fills = wantsFill(options.fill);
    this.outline = outlineCells(options.outline);
    this.renderer = renderer;
    /*
     * Read in `mount` rather than here, because it is part of the quality the renderer is
     * built with and the renderer is now built before this constructor runs.
     */
    this.exposure = exposure;
    this.room = this.renderer.createMesh(buildRoom());
    this.progress = new LoadProgress(this.renderer);
    /*
     * The three things a scene knows and the engine must not: what a surface named `body` should
     * be painted, which surfaces are glass, and how sharp a tyre's tread has to stay at a grazing
     * angle. Everything else about the load is the loader's.
     */
    this.loader = new DrftLoader(this.renderer, {
      /*
       * Hold the states of the reveal, so a viewer can go back through them.
       *
       * Only at the full budget. It costs a second copy of the model's geometry — about seventy
       * megabytes on the car — which is a fair price for being able to study a load on a
       * machine that has the memory, and the wrong one on a device the `lean` budget exists for.
       * `steps` then reads 0 there and whatever mounted this shows no control at all.
       */
      keepReveal: budget === 'full',
      /* One switch for both halves of it: whether a source format is converted with an outline,
         and whether a container that carries one has it drawn. See `outlineCells`. */
      outline: this.outline !== undefined,
      transform: (mesh, material) => {
        const painted = paint(mesh, material);
        this.captureFill(painted, material);
        return painted;
      },
      surface: (material) => {
        const chosen = paintFor(material?.name ?? '');
        return chosen === undefined
          ? undefined
          : { opacity: chosen.opacity, reflectivity: chosen.reflectivity };
      },
      /* RENDERING.md §4's texture-filtering case, and this scene is the one that has it: tread on
         a tyre and a plate seen almost edge-on. */
      anisotropy: 8,
      /*
       * A small version of each image first, because this scene's images are the slowest thing in
       * the load: two of them are 2048 squares and a full decode of one is most of a second on
       * this machine, during which the tyre and the brake disc are flat colour. 256 is enough to
       * read as tread rather than as paint, and the real map replaces it in the same texture.
       */
      texturePreview: 256,
    });
    /* A getter rather than a copied number: the count is 0 until the load has finished holding
       its states, and whatever draws the control reads it every frame to find that out. */
    const loader = this.loader;
    this.reveal = {
      get steps(): number {
        return loader.revealSteps;
      },
      set: (step: number): void => {
        loader.replay(step);
        this.scrubbed = step;
      },
    };
    this.env = buildEnvironment();
    this.lights = buildLights();
    /* The buffer the selection writes into, bound once — see `selectPointLights`. */
    this.env.lightPositions = this.lightBuffer.positions;
    this.env.lightColors = this.lightBuffer.colors;
    this.env.lightRadii = this.lightBuffer.radii;
    /* The emitter's own size, which is what lets a highlight be as wide as the light is. */
    this.env.lightSourceRadii = this.lightBuffer.sourceRadii;
    this.env.lightWeights = this.lightBuffer.weights;
    this.env.activeLightWorldIndices = this.lightBuffer.sourceIndex;
    this.camera.fovYDeg = 50;
    this.camera.near = 0.35;
    this.camera.far = 180;
    /*
     * Keep a viewer inside the room while they are inside the room.
     *
     * The margin is a little over the near plane, so the wall is never clipped through: at 0.35 m
     * an eye exactly on the plaster would show the room beyond it. The ceiling is held to the
     * same rule. Zooming past the hall turns all of it off, so standing back to look at the
     * building is still possible: see `OrbitView.keepInside`.
     */
    this.view.keepInside(HALL_HALF - 0.9, HALL_HALF - 0.9, WALL_HEIGHT - 0.8);
    void this.loadCar();
  }

  /**
   * Fetch and upload the car, if one has been baked.
   *
   * Deliberately not awaited by `mount`: the contract is synchronous and the room is
   * complete without this, so the scene starts drawing on the first frame and the model
   * appears when it appears. A demo that showed nothing until sixty megabytes arrived
   * would be a worse demonstration of the engine than one that never loaded anything.
   */
  private async loadCar(): Promise<void> {
    /*
     * The engine does the loading. What is left here is what a *scene* knows and the engine must
     * not: how big this room's turntable is, what a surface called `body` should be painted, and
     * which of those surfaces is glass.
     *
     * It used to be two hundred lines in this file — a stream, an upload budget, a fade, a merge —
     * and none of it was about a showroom. See `DrftLoader`.
     */
    const fitTo = {
      footprint: TURNTABLE_RADIUS * 1.5,
      height: 2.4,
      /*
       * On the turntable rather than on the floor, which is two centimetres higher than the disc
       * so a tyre rests on it instead of intersecting it. Derived from the disc rather than typed,
       * because a number typed here goes stale the first time the turntable changes and the
       * symptom is wheels through the floor.
       */
      baseY: TURNTABLE_TOP_Y + 0.02,
    };

    const base = modelBase();
    const found = await findModel(base);
    if (found === null) {
      /*
       * Every supported name was asked for and none of them is there, which is a scene with no
       * model rather than a scene that failed. `DrftLoader` reports that state for a `.drft`, so
       * asking it for the one this scene leads with keeps the wording in one place.
       */
      await this.loader.load(`${base}.drft`, fitTo);
    } else if (found.endsWith('.drft')) {
      await this.loader.load(found, fitTo);
    } else {
      /*
       * A source format, converted off the main thread and then loaded exactly as a container is.
       *
       * The parse and the weld are seconds of work on a real model, so they never run here: see
       * `modelWorker.ts`, and docs/FORMAT.md §3.3 for the measurement behind that rule. What comes
       * back is a `.drft` in memory, which `consume` streams through the same path a fetched one
       * takes, so the reveal a viewer watches does not depend on what the file started as.
       */
      await this.convert(found, fitTo);
    }
    /* One call for every path, so a container and a converted source frame identically. */
    this.measure();
  }

  /**
   * Run one source file through the worker, then load what it returns.
   *
   * The worker is created for the job and terminated after it, rather than kept alive: this
   * happens once per mount, and a thread left running holds the parsed model's memory for the
   * lifetime of the page. A model that is tens of megabytes on disk is hundreds unwelded, which
   * is the whole reason `docs/FORMAT.md` argues for baking anything that ships.
   */
  private async convert(
    url: string,
    fitTo: { footprint: number; height: number; baseY: number },
  ): Promise<void> {
    /*
     * Say something before the first byte, because there is a real wait here that the container's
     * own phases cannot see. Without it the bar reads "opening the file" from the click until the
     * conversion finishes, which on a twenty megabyte model is the whole of the load.
     */
    this.conversion = { stage: 'downloading', received: 0, total: 0 };
    const worker = new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module' });
    try {
      const reply = await new Promise<ModelReply>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<ModelReply>) => {
          /*
           * Progress is a message like any other, and there are many of them before the one that
           * resolves. Held here rather than resolved on, so the frame loop can draw the download
           * and the parse: without it the bar sat at its first phase for the whole conversion and
           * then filled at once, which reported the shortest part of the work and none of the
           * longest.
           */
          if (isProgress(event.data)) {
            this.conversion = event.data.progress;
            return;
          }
          resolve(event.data);
        };
        worker.onerror = (event) => reject(new Error(event.message));
        /*
         * Absolute, and that is not a tidiness point.
         *
         * A relative URL inside a worker resolves against the *worker's* own location, not the
         * page's, so `car.obj` became a request for one sitting beside this module. The dev
         * server answered that with the page under a 200, the reader was handed HTML, and it
         * reported the only thing it could see: no vertices. Resolved here, against the document,
         * because this is the side that knows what the name was relative to.
         */
        const outline = this.outline;
        const request: ModelRequest = {
          url: new URL(url, location.href).href,
          exclude: NOT_THE_SUBJECT,
          ...(outline === undefined ? {} : { outline }),
        };
        worker.postMessage(request);
      });
      if (isProgress(reply)) throw new Error('the worker resolved on a progress message');
      if (!reply.ok) throw new Error(reply.message);
      this.conversion = null;
      /*
       * A `Response` over the buffer, because that is what the streaming reader already takes and
       * building one costs nothing: the bytes are not copied and no server is involved.
       */
      await this.loader.consume(new Response(reply.drft), fitTo);
    } finally {
      worker.terminate();
    }
  }

  /**
   * Keep a black copy of every opaque part, to be drawn inside the model as its fill.
   *
   * **Taken here because this is the only place the geometry exists as data.** By the time a part
   * is drawable it is a buffer on the GPU, and the renderer has no colour override, so a second
   * draw of the model would be the model's own colours: chrome and brightwork showing through the
   * grille, which is what it is meant to hide.
   *
   * `transform` sees model space, since the loader applies the fit when it merges, so the same
   * placement is applied here and the copy lands exactly where the real part does. The shrink is
   * left to the draw matrix rather than baked in, which keeps it one number to change.
   *
   * Only the opaque parts. A black copy of a lamp lens would be a second lens inside the first.
   */
  private captureFill(mesh: MeshData, material: DrftMaterial | undefined): void {
    /* Nothing is kept unless a viewer asked for a fill: this holds a second copy of the whole
       model, so building one nobody wants costs the memory as well as the draw. */
    if (!this.fills) return;
    const resolved = paintFor(material?.name ?? '');
    if ((resolved?.opacity ?? material?.opacity ?? 1) < 1) return;
    const place = this.loader.placement;
    if (place === null || mesh.positions.length === 0) return;
    const builder = this.fillBuilder ?? new MeshBuilder();
    this.fillBuilder = builder;
    builder.setRoughness(0.95);
    /*
     * `transform` sees model space, since the loader applies the fit when it merges, so the same
     * placement is applied here and the copy lands exactly where the real part does. The shrink is
     * left to the draw matrix rather than baked in, which keeps it one number to change.
     */
    builder.addMesh(shellSkin(mesh), place.x, place.y, place.z, place.scale);
  }

  /**
   * Read the fitted size of whatever landed, and fill its cabin.
   *
   * Shared by both load paths, because a container and a converted source format arrive at the
   * same place and the camera framing must not depend on which one it was.
   */
  private measure(): void {
    const bounds = this.loader.modelBounds;
    const placement = this.loader.placement;
    if (bounds.length !== 6 || placement === null) return;
    const spanY = (bounds[4] as number) - (bounds[1] as number);
    const spanX = (bounds[3] as number) - (bounds[0] as number);
    const spanZ = (bounds[5] as number) - (bounds[2] as number);
    this.frameHeight = (spanY || 1) * placement.scale;
    this.frameReach = Math.max((Math.max(spanX, spanZ) || 1) * placement.scale, this.frameHeight);
    this.fitted = {
      x: (spanX || 1) * placement.scale,
      y: (spanY || 1) * placement.scale,
      z: (spanZ || 1) * placement.scale,
    };
    shellFillMatrix(SKIN_SHRINK, TURNTABLE_TOP_Y + 0.02 + this.fitted.y / 2, this.fillMatrix);
  }

  /**
   * Swap one of the car's textures for another image, by the name its source gave it.
   *
   * This is the whole point of `TEXS` carrying a name and it is deliberately two lines: a
   * consumer holds a `TextureSet`, asks it for a texture, and hands that to the renderer.
   * There is no bespoke machinery, because `updateSurfaceTexture` re-uploads into the
   * existing GPU object, so the binding the draw loop already holds stays valid and this
   * costs nothing structural.
   *
   * `get` throws on a name the asset does not have, which is the behaviour worth keeping:
   * a caller asking for `Tire_05_DM.jpg` has one image in mind, and a silent miss is the
   * wrong-surface failure that addressing by index had in the first place.
   */
  replaceTexture(name: string, source: TexImageSource): void {
    const textures = this.loader.textures;
    if (textures === null) throw new Error('showroom: no model is loaded yet');
    this.renderer.updateSurfaceTexture(textures.get(name), source);
  }

  /** What this asset's textures are called, so a caller can discover rather than guess. */
  textureNames(): readonly string[] {
    return this.carTextureNames;
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    this.elapsedSec += dtSec;
    /*
     * The loader's own frame: it spends this frame's upload budget and advances the fades. Called
     * before anything is submitted, so a part that lands this frame is drawn this frame.
     */
    this.loader.update(dtSec);

    /* A slow circuit, low and close, which is how a car is filmed. */
    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      const angle = this.elapsedSec * 0.16;
      /*
       * Framed to the model rather than to a constant. 15 metres was tuned against a car and
       * left a person as a speck on an empty disc, which is the same mistake the fit had:
       * a number that happens to suit one shape reads as a bug on every other one.
       */
      const distance =
        this.frameReach * 1.9 + Math.sin(this.elapsedSec * 0.13) * this.frameReach * 0.3;
      camera.position[0] = Math.sin(angle) * distance;
      camera.position[1] =
        this.frameHeight * 1.1 + Math.sin(this.elapsedSec * 0.21) * this.frameHeight * 0.45;
      camera.position[2] = Math.cos(angle) * distance;
      camera.lookAt(0, this.frameHeight * 0.58, 0);
      /* Seeded *after* the automatic camera has moved, so a handover starts from where
         the eye is this frame rather than where it was last one. */
      this.view.follow(camera, 0, this.frameHeight * 0.58, 0);
    }
    renderer.resize();
    /*
     * The matrices, rebuilt from the position just written.
     *
     * Without this the camera is inert: `position` and `lookAt` only record intent, and
     * every pass reads the matrices. Its absence is invisible in a still frame and total
     * in a moving one — the scene renders perfectly and cannot be moved at all, which is
     * exactly how it was reported.
     */
    const bufferHeight = this.canvas.height;
    camera.updateMatrices(bufferHeight > 0 ? this.canvas.width / bufferHeight : 1);

    /*
     * The room, captured once, the first frame that has a car in it.
     *
     * Here rather than at mount for two reasons a comment is worth spending: the model arrives
     * over the network, so a probe baked at mount would capture an empty turntable and hold that
     * for ever; and the renderer needs a frame's worth of state before it can submit a scene at
     * all. Six submissions of a room that is a floor, four walls and four panels, once.
     */
    if (!this.probeBaked && this.loader.progress.phase === 'ready') {
      this.probeBaked = true;
      /*
       * The fill is built here rather than when the load resolves, and the difference is the bug
       * this had. `load` finishes when the last *byte* lands; the parts are transformed and
       * uploaded afterwards, a bounded number per frame, so at that moment nothing has passed
       * through `transform` and there is nothing to copy. Measured rather than reasoned about:
       * the draw count never moved and the diagnostic read "builder null, parts 0". `ready` is
       * the phase that means every part exists.
       */
      if (this.fillBuilder !== null && this.fillMesh === null) {
        this.fillMesh = this.renderer.createMesh(this.fillBuilder.build());
        /* It holds a second copy of the whole model, so let it go the moment it is uploaded. */
        this.fillBuilder = null;
      }
      /* Only for a viewer who said the model is hollow. A generated solid inside a car that has
         a cabin is a black box behind its glass, with the real seats in front of it. */
      if (this.fills && this.solidMesh === null && this.fitted.y > 0) {
        this.solidMesh = this.renderer.createMesh(
          buildShellFill(this.fitted, TURNTABLE_TOP_Y + 0.02, { profile: CAR_PROFILE }),
        );
      }
      renderer.bakeReflectionProbe(PROBE_ORIGIN, this.env.fogColor as Vec3, (probeCamera) => {
        renderer.bindMeshPass(probeCamera, this.env);
        renderer.setSurfaceTexture(null);
        renderer.setSurfaceGrain(1);
        renderer.drawMesh(this.room, IDENTITY);
      });
    }

    /* Set per frame rather than once, because that is what the dial is for: a caller ramps it
       as the light around the camera changes. Here it is a constant a viewer typed. */
    if (this.exposure !== undefined) renderer.setOutputExposure(this.exposure);
    renderer.beginFrame(this.env.fogColor as Vec3);
    renderer.gpuTimer.begin('rest');
    selectPointLights(
      this.lights,
      this.camera.position[0] ?? 0,
      this.camera.position[1] ?? 0,
      this.camera.position[2] ?? 0,
      this.lightBuffer,
      this.elapsedSec,
    );
    this.env.lightCount = this.lightBuffer.count;
    renderer.bindMeshPass(this.camera, this.env);
    renderer.setSurfaceTexture(null);
    /* Full strength on whatever the room declared, which is its concrete floor and
       nothing else. See buildRoom. */
    renderer.setSurfaceGrain(1);
    renderer.drawMesh(this.room, IDENTITY);
    this.stats.draws = 1;
    /*
     * The car is manufactured, and none of it is mineral. Paint, chrome and glass are all
     * smooth at this scale, so grain on them reads as dirt on a surface that should hold an
     * unbroken highlight, which is the one thing this scene exists to show.
     *
     * An imported model carries no grain attribute, so it would take none in any case. This
     * stays because that is a fact about today's importers rather than about the asset, and
     * this pass-level override is what a scene drawing an import is meant to state with.
     */
    renderer.setSurfaceGrain(0);
    const textures = this.loader.textures;
    /*
     * The fill first, so the real bodywork covers it wherever the bodywork is solid and it shows
     * only through the openings it exists to back.
     */
    if (this.fillMesh !== null || this.solidMesh !== null) {
      renderer.setSurfaceTexture(null);
      renderer.setSurfaceReflectivity(0);
      /* The generated solid first: it is the one with no holes in it. */
      if (this.solidMesh !== null) {
        renderer.drawMesh(this.solidMesh, IDENTITY);
        this.stats.draws++;
      }
      if (this.fillMesh !== null) {
        renderer.drawMesh(this.fillMesh, this.fillMatrix);
        this.stats.draws++;
      }
    }
    for (const part of this.loader.parts) {
      /*
       * Looked up by index rather than held, so a part drawn before its image arrived starts
       * wearing it the moment it does. That is the last stage of the reveal, and holding a
       * resolved handle instead would have meant a part could only ever be textured if its
       * image had already landed when it was created.
       */
      renderer.setSurfaceTexture(part.albedo >= 0 ? (textures?.at(part.albedo) ?? null) : null);
      renderer.setSurfaceReflectivity(part.reflectivity);
      /*
       * Faded in while it arrives, which is the loader's `reveal`, and drawn solid the instant it
       * has finished. A part that stayed translucent for ever would be the wrong picture; a part
       * that appeared at full strength is the pop this scene was rebuilt to remove.
       */
      const opacity = part.opacity * part.reveal;
      if (opacity < 1) renderer.drawTranslucentMesh(part.mesh, IDENTITY, opacity);
      else renderer.drawMesh(part.mesh, IDENTITY);
      this.stats.draws++;
    }
    renderer.setSurfaceTexture(null);
    renderer.setSurfaceGrain(1);
    renderer.setSurfaceReflectivity(0);
    /*
     * The loader, over the world and before the frame resolves, so the post chain treats it as
     * part of the image rather than as something pasted on afterwards.
     */
    this.progress.draw(
      renderer,
      this.loader.progress,
      dtSec,
      this.elapsedSec,
      convertingWords(this.conversion),
    );
    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.rest;
    this.stats.gpuMs = this.lastGpuMs;
    /*
     * Composed here from the loader's counts, because the engine reports numbers and a phase and
     * deliberately no prose: what to call a stage depends on who is reading it.
     */
    const load = this.loader.progress;
    this.stats.extra =
      /*
       * A viewer holding the reveal at a state is told which state, and nothing about a load that
       * finished a while ago. The number of parts on screen is the only figure that means
       * anything here, and it is the one the slider is standing on.
       */
      this.scrubbed >= 0
        ? this.scrubbed === 0
          ? 'nothing loaded yet'
          : this.scrubbed === this.reveal.steps - 1
            ? `all ${load.partsTotal} parts, merged`
            : /* State 1 is the outline where there is one and the first part where there is not,
                 so the count comes off what the loader actually holds rather than off the step. */
              this.loader.hasOutline && this.scrubbed === 1
              ? 'the outline, and no parts yet'
              : `${this.scrubbed - (this.loader.hasOutline ? 1 : 0)} of ${load.partsTotal} parts`
        : load.phase === 'ready'
          ? `${load.partsTotal} parts, ${load.imagesTotal} images, ` +
            `${(load.totalBytes / 1e6).toFixed(1)} MB streamed`
          : load.phase === 'absent' || load.phase === 'failed'
            ? load.message
            : `${load.phase}, ${Math.round(load.fraction * 100)}%`;
    return this.stats;
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
    this.progress.dispose();
    /* The loader owns every mesh and texture it made, including the ones a merge replaced. */
    this.loader.dispose();
    this.renderer.disposeMesh(this.room);
    if (this.fillMesh !== null) this.renderer.disposeMesh(this.fillMesh);
    if (this.solidMesh !== null) this.renderer.disposeMesh(this.solidMesh);
    this.renderer.dispose();
  }
}

const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  full: {
    /*
     * Four samples. The one place a demo deliberately asks for *more* than the engine
     * default, because the default is 1 only so that no scene written before multisampling
     * existed changes by a bit — not because 1 is the right look. These scenes are what the
     * engine is judged on, and a panel gap or a trim edge seen at a shallow angle is a
     * staircase without it.
     */
    sceneSamples: 4,
    ambientOcclusion: 0.5,
    ambientOcclusionRadius: 0.35,
    /*
     * 256 a face, which is 1.4 MB with its mip chain and is plenty: what it carries is four
     * soft panels, four walls and a floor, and it is read through a roughness blur. Detail
     * would be spent on an image nothing looks at directly.
     */
    reflectionProbeSize: 256,
  },
  lean: {
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
    directionalShadows: false,
    pointShadows: false,
    waterReflections: false,
    water: false,
    screenEffects: false,
  },
};

export const showroom: DemoScene = {
  id: 'showroom',
  title: 'Showroom',
  loadsModel: true,
  note: 'The room is built by the engine when the page opens. The car is not: it arrives over the network as a file and is read on the spot, in a worker, so the page never stalls while it lands. Watch the bar, because the order you see is the file rather than a script played over it. Every format this engine reads opens here like this one, and any of them can be converted once into the container the engine ships, which is what buys the streaming and the zero-copy. Reading FBX is a best effort rather than a promise, and the container is the part that is a promise.',
  async mount(
    canvas: HTMLCanvasElement,
    budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
    options: DemoSceneOptions = {},
  ): Promise<DemoHandle> {
    /*
     * The exposure override is part of the quality the renderer is built with, so it is
     * read here rather than in the handle: the renderer now exists before the handle does.
     */
    const exposure = askedExposure();
    const { renderer } = await createRenderer(
      canvas,
      {
        ...PROFILES[budget],
        ...(exposure === undefined
          ? {}
          : { outputTransform: 'aces' as const, outputExposure: exposure }),
        ...overrides,
      },
      DEMO_BACKEND,
    );
    /* Pipelines compiled before the first frame rather than inside it; on WebGPU
       `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
    await renderer.ready();
    return new ShowroomHandle(renderer, canvas, options, exposure, budget);
  },
};
