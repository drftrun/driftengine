/**
 * Quality options typed at the address bar, so any scene can be looked at under any of them.
 *
 * **This is a harness instrument and it belongs to the harness rather than to a scene.** It was
 * written inside one scene first, which is the shape that guarantees the second scene needing it
 * grows a second copy with slightly different spellings. A scene decides what it *is*; how the
 * frame is presented is a question about the renderer, and the harness is what owns the renderer's
 * construction options here.
 *
 * Every control is one thing. Nothing bundles two options behind one name, because an instrument
 * that changes two things per query cannot be used to attribute a difference to either of them.
 * That matters most for the pair below: bloom asked for without the range is a real state a
 * consumer can be in, the renderer warns about it, and being able to reproduce it in one query is
 * how a warning stops being taken on trust.
 *
 *     ?bloom=0.35&bloomthreshold=0.2&hdr=1&exposure=1.9&blur=1&dof=0.02&recon=1.5&indirect=1
 *
 * Read once, at mount. `frame` may not allocate and a `URLSearchParams` is an allocation.
 *
 * Nothing here is engine API and nothing under `src/` may import it.
 */
import { identityGradeLut } from '../../packages/core/src/index';
import type {
  ColourGradeLut,
  CreateRendererOptions,
  PhotometricProfile,
  RenderPipeline,
  RenderQualityOptions,
} from '../../packages/core/src/index';

/**
 * What every page in this directory passes as construction options, which today is one thing.
 *
 * **No engine badge.** These pages are instruments: they exist to be photographed on one backend
 * and then the other, and several of the scripts beside them read a frame a fixed number of
 * milliseconds after load. A badge holds the loop frozen for three seconds after the first frame
 * — deliberately, so a game's opening is not spent behind black — and an instrument that inherits
 * that reads the first frame three seconds late or photographs the plate instead of the scene.
 *
 * **Declined here rather than page by page**, for the reason `demo/backend.ts` gives about the
 * backend: twenty-three copies of a choice is twenty-three places for them to stop agreeing, and
 * the page that forgets is the one whose capture nobody re-checks.
 *
 * `?splash=1` still shows it on any of these, which is how the badge itself is looked at.
 */
export const DEV_RENDERER: CreateRendererOptions = { splash: false, ...askedPipeline() };

/**
 * `?pipeline=gpu-driven`, which is a *construction* option rather than a quality one.
 *
 * It exists here because the one thing that cannot be checked from a unit test is that the refusal
 * is wired: nothing in a test environment resolves a renderer, so the check inside `createRenderer`
 * is reached by no test at all. Opening any of these pages with `?backend=webgl2&pipeline=gpu-driven`
 * reaches it, and what should come back is a loud failure rather than a forward frame.
 *
 * Read from `location.search` at module load, like everything else here.
 */
export function askedPipeline(
  search: string = typeof location === 'undefined' ? '' : location.search,
): { pipeline?: RenderPipeline } {
  const asked = new URLSearchParams(search).get('pipeline');
  if (asked === null || asked === '') return {};
  if (asked !== 'forward' && asked !== 'gpu-driven') {
    console.warn(`pipeline=${asked} is not a pipeline this engine has; try forward or gpu-driven.`);
    return {};
  }
  return { pipeline: asked };
}

/**
 * A colour grade named at the address bar, built here so a capture can be attributed to it.
 *
 * **Two looks, both chosen because they are unmistakable in a diff and checkable by arithmetic.**
 * A tasteful grade is the wrong instrument: a warm filter moves every pixel a little and a
 * capture of it cannot distinguish "applied faintly" from "applied to the wrong thing". These
 * two move every pixel a long way, in a direction anybody can verify by reading one out.
 *
 * - `invert` maps `c` to `1 - c`. Every channel of every pixel changes, and the sum of the two
 *   captures is white everywhere.
 * - `swap` maps `(r, g, b)` to `(b, r, g)`. It rotates the axes rather than moving along them,
 *   which is the look that catches a table packed with its axes transposed — a bug that filters
 *   correctly and draws a plausible picture.
 *
 * The lattice is 32, which is what grading tools export and what a consumer will actually hand
 * over; a smaller one would be a smoother test than the real case.
 *
 *     /probe.html?grade=invert
 *     /probe.html?grade=swap&gradestrength=0.5
 *
 * Nothing here is engine API. It builds a `ColourGradeLut`, which is.
 */
export function askedColourGrade(
  search: string = location.search,
): { lut: ColourGradeLut; strength: number } | null {
  const asked = new URLSearchParams(search);
  const name = asked.get('grade');
  if (name === null || name === '') return null;
  if (name !== 'invert' && name !== 'swap') {
    console.warn(`grade=${name} is not a look this page knows; try invert or swap.`);
    return null;
  }

  const size = 32;
  const lut = identityGradeLut(size);
  const data = lut.data;
  for (let at = 0; at < data.length; at += 4) {
    const r = data[at] as number;
    const g = data[at + 1] as number;
    const b = data[at + 2] as number;
    if (name === 'invert') {
      data[at] = 255 - r;
      data[at + 1] = 255 - g;
      data[at + 2] = 255 - b;
    } else {
      data[at] = b;
      data[at + 1] = r;
      data[at + 2] = g;
    }
  }
  const strength = positive(asked, 'gradestrength');
  return { lut, strength: strength === undefined ? 1 : Math.min(1, strength) };
}

/**
 * An asymmetric photometric profile named at the address bar, for a capture to be attributed to.
 *
 * **Synthetic, because this checkout has no `.ies` file and cannot have one**: a manufacturer's
 * photometric file is theirs to distribute, and nothing under `models/` or `demo/dev/public/` is
 * committed. What matters for the capture is that the distribution is *unmistakably* asymmetric,
 * which a real wall washer is only mildly.
 *
 * `?ies=wall` is a fixture that throws almost everything into one half turn of azimuth and almost
 * nothing into the other — so a light aimed down at a floor draws a bright lobe on one side and
 * near-darkness on the other, and a decoder that kept the first plane draws a disc.
 *
 * `?ies=round` is the control: the *same* fixture measured as one plane, which is what every
 * axially symmetric profile is. It must draw a disc, and the difference between the two is the
 * whole capability.
 *
 *     /probe.html?ies=wall&iesaxis=1,0,0
 *
 * Nothing here is engine API. It builds a `PhotometricProfile`, which is.
 */
export function askedIesProfile(search: string = location.search): PhotometricProfile | null {
  const asked = new URLSearchParams(search);
  const name = asked.get('ies');
  if (name === null || name === '') return null;
  if (name !== 'wall' && name !== 'round') {
    console.warn(`ies=${name} is not a fixture this page knows; try wall or round.`);
    return null;
  }

  /* A narrow beam vertically: full at the axis, gone by 60 degrees. Both fixtures share it, so the
     only thing that differs between the two captures is the horizontal distribution. */
  const vertical = [0, 20, 40, 60, 90];
  const beam = [1, 0.9, 0.55, 0.1, 0];

  if (name === 'round') {
    const candela = beam.map((v) => v * 1000);
    return {
      verticalAngles: new Float32Array(vertical),
      horizontalAngles: new Float32Array([0]),
      candela: new Float32Array(candela),
      maxCandela: 1000,
    };
  }

  /*
   * Eight planes across the turn, weighted by `cos` so one side is full and the opposite side is
   * a twentieth. Eight rather than four because the lobe's edge is what a capture reads, and at
   * four planes that edge is a quarter turn wide and looks like a square rather than a lobe.
   */
  const planes = 8;
  const horizontal: number[] = [];
  const candela: number[] = [];
  for (let plane = 0; plane < planes; plane++) {
    const azimuth = (plane / planes) * 360;
    horizontal.push(azimuth);
    const weight = 0.05 + 0.95 * ((Math.cos((azimuth * Math.PI) / 180) + 1) / 2) ** 2;
    for (const v of beam) candela.push(v * weight * 1000);
  }
  return {
    verticalAngles: new Float32Array(vertical),
    horizontalAngles: new Float32Array(horizontal),
    candela: new Float32Array(candela),
    maxCandela: 1000,
  };
}

/**
 * A cookie drawn into a canvas, so a capture can be attributed to it.
 *
 * **Synthetic and deliberately hard-edged**, which is the opposite of what a real gobo is: a soft
 * mask and a missing mask look alike in a capture, and a cross of bars does not. `?cookie=bars`
 * draws a window frame — two bands each way, sharp — so a projection that is rotated, mirrored or
 * scaled wrongly is visible at a glance rather than by arithmetic.
 *
 * `?cookie=tint` is the other half: three coloured quadrants, which is what says a cookie **tints**
 * rather than scales. A greyscale mask cannot tell those two apart.
 *
 *     /probe.html?ies=round&cookie=bars&iesaxis=1,0,0
 *
 * Nothing here is engine API.
 */
export function askedCookie(search: string = location.search): HTMLCanvasElement | null {
  const asked = new URLSearchParams(search).get('cookie');
  if (asked === null || asked === '') return null;
  if (asked !== 'bars' && asked !== 'tint') {
    console.warn(`cookie=${asked} is not a mask this page knows; try bars or tint.`);
    return null;
  }
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  if (asked === 'tint') {
    /* Four quadrants, three of them coloured: a scale could not produce this. */
    const quadrants = ['#ff2200', '#00ff44', '#2244ff', '#ffffff'];
    for (let q = 0; q < 4; q++) {
      ctx.fillStyle = quadrants[q] as string;
      ctx.fillRect((q % 2) * (size / 2), Math.floor(q / 2) * (size / 2), size / 2, size / 2);
    }
    return canvas;
  }

  /* A window frame: white panes, black bars, and an opaque border so the cone edge is unlit. */
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  const pane = size / 3;
  const bar = size / 16;
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      ctx.fillRect(
        size / 6 + column * (pane + bar),
        size / 6 + row * (pane + bar),
        pane - bar,
        pane - bar,
      );
    }
  }
  return canvas;
}

/** Where the fixture's azimuth zero points, as `x,y,z`. Defaults to world +x. */
export function askedIesAxis(search: string = location.search): [number, number, number] {
  const asked = new URLSearchParams(search).get('iesaxis');
  const parts = (asked ?? '1,0,0').split(',').map(Number);
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
    console.warn(`iesaxis=${asked} is not three numbers, so world +x was used.`);
    return [1, 0, 0];
  }
  return [parts[0] as number, parts[1] as number, parts[2] as number];
}

/** A finite number above zero, or undefined for absent, empty and malformed alike. */
/**
 * The same reading, admitting zero.
 *
 * **Zero is a real setting for a ceiling and `positive` warns it away**, which is right for a
 * radius or a sample count and wrong for a switch that happens to be spelled as a number. The
 * medium's step count is the second kind: `?steps=0` is the build where the pass does not exist,
 * and it is the control every claim about the effect is measured against — so it has to be
 * *sayable* rather than merely reachable by leaving the query out.
 */
function nonNegative(search: URLSearchParams, key: string): number | undefined {
  const asked = search.get(key);
  if (asked === null || asked === '') return undefined;
  const value = Number(asked);
  if (Number.isFinite(value) && value >= 0) return value;
  console.warn(`${key}=${asked} is not a number at or above zero, so it was ignored.`);
  return undefined;
}

function positive(search: URLSearchParams, key: string): number | undefined {
  const asked = search.get(key);
  if (asked === null || asked === '') return undefined;
  const value = Number(asked);
  if (Number.isFinite(value) && value > 0) return value;
  console.warn(`${key}=${asked} is not a positive number, so it was ignored.`);
  return undefined;
}

/**
 * What the query asks for, as options to hand `mount`.
 *
 * Absent means absent rather than a default: an empty object leaves every scene exactly as its
 * own profile wrote it, which is what makes the harness's ordinary picture the scene's own.
 */
export function askedQuality(search: string = location.search): RenderQualityOptions {
  const asked = new URLSearchParams(search);
  const bloom = positive(asked, 'bloom');
  const exposure = positive(asked, 'exposure');
  const samples = positive(asked, 'samples');
  const occlusion = positive(asked, 'ao');
  /*
   * The global medium's ceiling, which is construction-time and therefore belongs here rather
   * than in a page. The *dial* — how thick the air is — is `setGlobalMedium` and is a scene's
   * own, exactly as bloom's threshold is a profile's and `setBloom` is a frame's.
   *
   * `?steps=0` is the control every claim about the medium rests on: it is the build where the
   * pass does not exist, and a frame at density 0 has to be identical to it rather than close. It
   * reads through `nonNegative` for exactly that reason.
   */
  const mediumSteps = nonNegative(asked, 'steps');
  /*
   * The live cubemap budget, reachable from here because its whole point is a comparison: the
   * default is a whole cubemap a frame per live map, and what a lower one costs is a shadow
   * arriving a frame or two late. Neither half of that can be judged without switching between
   * them on one scene.
   */
  const liveFaces = positive(asked, 'livefaces');
  /*
   * The two bandwidth switches, reachable from the address bar because they are the only
   * changes in this engine that cannot be checked anywhere but on a tile-based GPU. A device
   * that flashes black is bisected with `?discard=0` and `?defer=0`, one reload each.
   */
  /* `?gputiming=1`. Off by default: it attaches a block to every render pass, so it is a
     risk a consumer takes deliberately while measuring, not one everybody carries. */
  const gpuTiming = asked.get('gputiming') === '1';
  /* `?graph=0`. **On by default since 2026-08-25**, so this exists to turn it *off* — the same
     shape as `discard` and `defer` below, and for the same reason: a switch whose default changed
     has to be bisectable in one reload, in whichever direction the reader needs. */
  const graph = asked.get('graph');
  /* Which scheduler groups the graph's records, and `?idgraph=0` against `?idgraph=1` is the pair
     Wave 1A's exit criterion is photographed with. */
  const identifierGraph = asked.get('idgraph');
  /* `?cull=1`. Skips a mesh draw whose bounds are outside the frame; see RenderQuality. */
  const cullDraws = asked.get('cull') === '1';
  const discard = asked.get('discard');
  const defer = asked.get('defer');
  /*
   * The threshold beside the strength, because `bloom=1` on its own is one of the settings that
   * is silently nothing: the default threshold is 1 in *scene units*, and a world whose brightest
   * pixel sits under white has nothing above it to bloom. Asking for the strength without being
   * able to move the threshold is a control that cannot be shown to do anything.
   */
  const bloomThreshold = positive(asked, 'bloomthreshold');
  /* The motion-blur ceiling. `setCameraMotionBlur` scales it and defaults to 1, so this alone
     is enough to make the effect draw — which is the whole reason it is reachable from here. */
  const blur = positive(asked, 'blur');
  /*
   * The depth-of-field ceiling: how far a defocused point may spread, as a fraction of the frame's
   * height. `setDepthOfField`'s scale defaults to 1, so this alone is enough to make the effect
   * draw — but **it is one of the pairs that means nothing alone**, like bloom and its threshold:
   * the focus distance defaults to 0 metres, which is behind the camera, so every pixel is at
   * full blur and the picture is a uniform smear. `probe.html` takes `?focus=` and `?focusrange=`
   * beside this, which is where a per-frame dial belongs.
   */
  const dof = positive(asked, 'dof');
  /*
   * The reconstruction ratio, and **`nonNegative` rather than `positive` because zero is the
   * control**: "reconstruction on" against "off" is what every claim about DriftTR rests on, and
   * `positive` would drop the off case and leave the default standing, which reads as a knob that
   * does nothing. The renderer clamps anything inside `(0, 1.3)` up to 1.3, so this passes the
   * number through rather than deciding the range twice.
   */
  const recon = nonNegative(asked, 'recon');
  /* Light the world from what bounces. One option, like every other here: the comparison is a query. */
  const indirect = asked.get('indirect');
  /*
   * The reflection probe's face size, and **it exists to be set to zero**. A probe is the one
   * feature a scene turns on for itself rather than taking from the engine's default, so a scene
   * that bakes one cannot be looked at without one — and "with a probe" against "without" is the
   * control every claim about the environment term rests on. `nonNegative` rather than `positive`
   * for exactly that reason: zero is the interesting value here and `positive` would drop it.
   */
  const probeSize = nonNegative(asked, 'probesize');
  /*
   * The two shadow permutations, reachable so a scene can be captured under each of the sixteen
   * shaders the lit pass compiles to. A backend difference that appears only when three flags are
   * on at once cannot be attributed to any of them without turning each off in turn, and these
   * two are the only ones a published scene does not already expose from the address bar.
   */
  const directionalShadows = asked.get('dirshadows');
  const pointShadows = asked.get('pointshadows');
  /*
   * **How many samples the probe's convolution takes, and it is a diagnostic as much as a dial.**
   * Each sample's source level comes from `1 / (count * pdf)`, so raising the count *lowers* the
   * level every sample reads: at 16 the diffuse level is integrated from the coarsest end of the
   * source chain and at 1024 from a much finer one. A difference that shrinks as this rises is a
   * difference in the coarse levels of that chain; one that does not is somewhere else.
   */
  const prefilterSamples = positive(asked, 'prefiltersamples');
  /* Whether the reflection chain is the GGX convolution rather than the box filter it defaults to. */
  const prefilter = asked.get('prefilter');
  return {
    ...(probeSize === undefined ? {} : { reflectionProbeSize: Math.round(probeSize) }),
    ...(directionalShadows === null ? {} : { directionalShadows: directionalShadows === '1' }),
    ...(pointShadows === null ? {} : { pointShadows: pointShadows === '1' }),
    ...(prefilterSamples === undefined
      ? {}
      : { environmentPrefilterSamples: Math.round(prefilterSamples) }),
    ...(prefilter === null ? {} : { environmentPrefilter: prefilter === '1' }),
    ...(bloom === undefined ? {} : { bloom: Math.min(1, bloom) }),
    ...(bloomThreshold === undefined ? {} : { bloomThreshold }),
    ...(blur === undefined ? {} : { cameraMotionBlur: Math.min(1, blur) }),
    ...(dof === undefined ? {} : { depthOfField: Math.min(1, dof) }),
    ...(recon === undefined ? {} : { reconstruction: recon }),
    ...(indirect === null ? {} : { indirectLight: indirect === '1' }),
    ...(graph === null ? {} : { frameGraph: graph === '1' }),
    ...(identifierGraph === null ? {} : { identifierGraph: identifierGraph === '1' }),
    /*
     * Light the world from a froxel table. One option, like every other here: a comparison
     * between clustered and not is a query rather than an edit, which is the whole point of this
     * file — and the pair `?clustered=0` / `?clustered=1` is the control this feature needs,
     * because a froxel table that is wrong and a froxel table that is empty draw the same picture.
     */
    ...(asked.get('clustered') === '1' ? { clusteredLights: true } : {}),
    /*
     * Temporal antialiasing, and the pair `?taa=0` / `?taa=1` is the control it needs: an edge
     * that is soft because it was resolved and one that is soft because the scene is blurry look
     * the same in a single capture.
     */
    ...(asked.get('taa') === '1' ? { temporalAa: true } : {}),
    /*
     * Order-independent transparency, and `?oit=0` against `?oit=1` is the control it needs: the
     * whole claim is that the frame stops depending on submission order, which cannot be seen in
     * one capture.
     */
    ...(asked.get('oit') === '1' ? { orderIndependent: true } : {}),
    /*
     * The off-screen target itself, and this exists to be turned *off*. Four capabilities are
     * documented as needing it — `hdrScene`, the colour grade, the temporal resolve, drawn decals
     * — and each of them says so on the console and then draws nothing. A refusal nobody can
     * reproduce in one reload is a refusal taken on trust, which is the argument this file's
     * header already makes about bloom and its threshold.
     */
    ...(asked.get('fx') === '0' ? { screenEffects: false } : {}),
    ...(cullDraws ? { cullDraws } : {}),
    ...(asked.get('hdr') === '1' ? { hdrScene: true } : {}),
    /* Compiles the night-side emissive term in. The amount is a scene's own, on `Environment`. */
    ...(asked.get('nightem') === '1' ? { nightEmissive: true } : {}),
    ...(asked.get('hdr') === '0' ? { hdrScene: false } : {}),
    /* A tone curve and how far into it, which only mean anything together: an exposure with no
       curve to be exposed into is one of the settings that is silently nothing. */
    ...(exposure === undefined
      ? {}
      : { outputTransform: 'aces' as const, outputExposure: exposure }),
    ...(samples === undefined ? {} : { sceneSamples: Math.round(samples) }),
    ...(occlusion === undefined ? {} : { ambientOcclusion: Math.min(1, occlusion) }),
    ...(mediumSteps === undefined ? {} : { globalMediumSteps: Math.round(mediumSteps) }),
    /* Off by `?half=0`, which is how a capture rules the upsample out as the cause of something. */
    ...(asked.get('half') === '0' ? { globalMediumHalfResolution: false } : {}),
    ...(liveFaces === undefined ? {} : { liveShadowFacesPerFrame: Math.round(liveFaces) }),
    /* Two-way: both default off since the iOS report, so bisecting means turning them back *on*
       one at a time as well as off. `?discard=1`, `?defer=1`. */
    ...(gpuTiming ? { gpuTiming: true } : {}),
    ...(discard === null ? {} : { discardResolvedAttachments: discard === '1' }),
    ...(defer === null ? {} : { deferFramePass: defer === '1' }),
  };
}
