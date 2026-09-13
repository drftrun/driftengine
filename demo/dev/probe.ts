/**
 * One fixed frame with the camera *moving*, so the composite's last two effects can be compared.
 *
 * **This page exists because the two-capture gate and camera motion blur are structurally at
 * odds.** The gate works by freezing the clock — that is the whole reason a difference between
 * two captures means anything — and a frozen clock means the camera sits where it sat last
 * frame. `composite()` then reprojects through an identity matrix and the blur correctly draws
 * nothing, on both backends, so a comparison of the two says nothing at all. Measured: `?blur=1`
 * against baseline moved **exactly zero pixels** on WebGL2 across three scenes, which reads as a
 * missing effect and is a working one with nothing to do.
 *
 * The speed rush has the opposite problem and the same outcome. It is a per-frame dial —
 * `setSpeedRush`, not a quality option — and no scene in this repository calls it, so it had
 * never drawn a measured pixel either.
 *
 * So: two frames, a fixed camera step between them, and then **nothing further requested**. The
 * last frame drawn is the one photographed, its previous view really is one step behind, and
 * both dials are set from the query. Deterministic without the held clock, because it does not
 * read a clock at all — the step is a constant, not an elapsed time.
 *
 *     /probe.html?backend=webgpu&blur=1&rush=0.8
 *     /probe.html?backend=webgpu&dof=0.02&focus=18.2&focusrange=3
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * in the harness, beside `askedQuality` and the held clock.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi } from '../../packages/core/src/index';
import {
  DEV_RENDERER,
  askedColourGrade,
  askedCookie,
  askedIesAxis,
  askedIesProfile,
  askedQuality,
} from './askedQuality';

/** Nothing moves in this scene, so one matrix serves the only draw it makes. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A finite number at or above zero, or undefined. Zero is meaningful for a dial. */
function dial(search: URLSearchParams, key: string): number | undefined {
  const asked = search.get(key);
  if (asked === null || asked === '') return undefined;
  const value = Number(asked);
  if (Number.isFinite(value) && value >= 0) return value;
  console.warn(`${key}=${asked} is not a number, so it was ignored.`);
  return undefined;
}

/**
 * How far the camera travels between the two frames, in metres.
 *
 * Large enough that the reprojection is unmistakable at this focal length and small enough that
 * the two frames still see the same world — a step that flew past the lattice would compare a
 * blur against a different picture rather than against a blurred one.
 */
const CAMERA_STEP_M = 0.35;

/**
 * How many frames the probe draws before it stops.
 *
 * Two is the minimum that gives the composite anything to reproject through — the first frame
 * has no previous view and blurs nothing, by design on both backends — and more would only
 * travel further along the same straight path.
 */
const FRAMES = 2;

/**
 * Something with edges in every direction, because a blur is only visible across one.
 *
 * A flat wall would blur into itself and photograph as unchanged. The lattice gives vertical and
 * horizontal boundaries at several depths, which is what makes both a screen-space smear and a
 * reprojection through depth show up as something other than noise.
 */
/**
 * A polished sphere in the middle of the lattice, for the environment probe to appear in.
 *
 * Separate from the room so it can be drawn with a reflectivity the room does not have, and
 * **kept out of the bake** — a probe baked from the middle of a mirrored ball is a ball
 * mirroring its own inside surface.
 */
function buildMirror(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .setRoughness(0.03)
    .addSphere([0, 2.6, 0], 2.2, [0.5, 0.5, 0.52], 0, 32, 16)
    .build();
}

function buildLattice(): ReturnType<MeshBuilder['build']> {
  const builder = new MeshBuilder();
  builder.addBox([0, -0.5, 0], [14, 0.5, 14], [0.16, 0.17, 0.2]);
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      const height = 0.6 + ((x + z + 8) % 5) * 0.45;
      builder.addBox([x * 2.2, height, z * 2.2], [0.42, height, 0.42], [0.62, 0.6, 0.55]);
      /* A bright cap on every other pillar, so a bloom threshold in scene units has something
         above it and the rush has something to streak. */
      if ((x + z) % 2 === 0) {
        builder.addBox(
          [x * 2.2, height * 2 + 0.12, z * 2.2],
          [0.22, 0.12, 0.22],
          [1, 0.86, 0.6],
          1,
        );
      }
    }
  }
  return builder.build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);

  /*
   * `?probe=N` asks for a reflection probe at that face size, and it is the only way this
   * repository has to run one. Both scenes that ask for a probe gate their bake on a car model
   * that returns 404 in this checkout, so `bakeReflectionProbe` had never executed at all.
   */
  const probeSize = dial(asked, 'probe');
  const created = await createRenderer(
    canvas,
    {
      ...askedQuality(),
      ...(probeSize === undefined ? {} : { reflectionProbeSize: Math.round(probeSize) }),
    },
    DEV_RENDERER,
  );
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const mesh: MeshHandle = renderer.createMesh(buildLattice());
  const mirror: MeshHandle = renderer.createMesh(buildMirror());
  const env = createEnvironment();
  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.3;
  camera.far = 200;

  /* The dials this page exists for. Both default to *off*, so a capture with no query is the
     baseline the other captures are read against. */
  renderer.setSpeedRush(dial(asked, 'rush') ?? 0);
  renderer.setCameraMotionBlur(dial(asked, 'blur') === undefined ? 0 : 1);
  /*
   * `?focus=` and `?focusrange=`, in metres, beside `?dof=` which is the ceiling.
   *
   * **The pair is the point.** `?dof=` alone leaves the focus at its default of zero metres, which
   * is behind the camera, so every pixel comes back at full blur and the frame is one flat smear —
   * a result that looks like a broken effect and is a correctly-focused one aimed at nothing. So
   * the distance is set here, and the default puts the plane on the middle of the lattice: the
   * camera sits 18.2 m from what it is looking at, the near pillars are about 9 m away and the far
   * ones about 27, so a three-metre sharp zone leaves both ends of the room defocused and the
   * middle crisp. That is a picture where a capture can attribute the difference.
   */
  renderer.setDepthOfField(dial(asked, 'focus') ?? 18.2, dial(asked, 'focusrange') ?? 3);
  /*
   * `?grade=invert` and `?grade=swap`. Set once rather than per frame — a grade is held until it
   * is set again — which is also the shape a consumer uses, so the capture exercises the path
   * that ships rather than one this page invented.
   *
   * No scene in this repository calls `setColourGrade`, which is the same reason the rush and the
   * blur are here: an effect no scene turns on has not been looked at, and this page is where the
   * harness turns one on.
   */
  const grade = askedColourGrade();
  if (grade !== null) renderer.setColourGrade(grade.lut, grade.strength);

  /*
   * `?ies=wall` and `?ies=round`. A photometric profile has never been driven anywhere in this
   * repository — no scene loads one — so this is the first thing that has ever put one on screen,
   * which is also why the asymmetric row could be built and looked at at all.
   *
   * The light is aimed straight down from above the lattice, which is where a street light and a
   * wall washer point and is exactly the direction every derived azimuth reference is singular in.
   */
  /*
   * `?cookie=bars` and `?cookie=tint`, which need a spot to project through — so the light block
   * below is shared with `?ies=`, and either query lights it.
   */
  const cookie = askedCookie();
  if (cookie !== null) renderer.setSpotCookies([cookie]);

  const fixture = askedIesProfile();
  if (fixture !== null || cookie !== null) {
    if (fixture !== null) renderer.setIesProfiles([fixture]);
    const axis = askedIesAxis();
    env.lightCount = 1;
    env.lightPositions[0] = 0;
    env.lightPositions[1] = 9;
    env.lightPositions[2] = 0;
    env.lightColors[0] = 14;
    env.lightColors[1] = 13;
    env.lightColors[2] = 11;
    env.lightRadii[0] = 40;
    env.lightWeights[0] = 1;
    /* Straight down. */
    env.lightDirections[0] = 0;
    env.lightDirections[1] = -1;
    env.lightDirections[2] = 0;
    /*
     * `?cone=inner,outer` in degrees. Wide by default — 70 and 85 — so what shapes the pool is the
     * *profile* rather than the cone's own edge, which is what a photometric capture wants.
     *
     * **A cookie wants the opposite** and that is worth saying rather than leaving to be
     * rediscovered: the mask is scaled to fill the outer cone, so at 85 degrees it spans about
     * a hundred metres at this height and the whole lattice falls inside its centre few per cent.
     * A capture of a window frame at that angle photographs one bar and reads as an unlit scene.
     * `?cone=25,35` puts the pattern on the floor.
     */
    const cone = (asked.get('cone') ?? '70,85').split(',').map(Number);
    const inner = Number.isFinite(cone[0]) ? (cone[0] as number) : 70;
    const outer = Number.isFinite(cone[1]) ? (cone[1] as number) : 85;
    env.lightConeCos[0] = Math.cos((inner * Math.PI) / 180);
    env.lightConeCos[1] = Math.cos((outer * Math.PI) / 180);
    env.lightIesProfiles[0] = fixture === null ? -1 : 0;
    env.lightCookies[0] = cookie === null ? -1 : 0;
    env.lightIesAxes[0] = axis[0];
    env.lightIesAxes[1] = axis[1];
    env.lightIesAxes[2] = axis[2];
  }

  renderer.resize();

  /**
   * Draw at a given step along the camera's path.
   *
   * Two calls, one step apart, is the whole point: the renderer keeps the previous frame's
   * view-projection and the difference between them is what the blur reprojects through.
   */
  const draw = (step: number): void => {
    /* Across the lattice rather than into it, so the step is lateral: a camera moving along its
       own view direction reprojects almost nowhere, and the effect this page exists to show
       would be a handful of pixels at the edges. */
    camera.position[0] = step * CAMERA_STEP_M;
    camera.position[1] = 7.5;
    camera.position[2] = 17;
    camera.lookAt(0, 1, 0);
    const height = canvas.height;
    camera.updateMatrices(height > 0 ? canvas.width / height : 1);

    /*
     * The bake, before the frame that shows it and inside no pass of its own — it re-enters the
     * mesh pass six times, once per face. The lattice only: a mirror baked into its own probe is
     * a sphere reflecting the inside of itself.
     *
     * Re-baked every frame rather than once, because this page draws two and the second is the
     * one photographed. A cube filled on frame 0 and read on frame 1 would still be correct, and
     * baking both proves the path is re-entrant, which is the half a single bake cannot show.
     */
    if (probeSize !== undefined) {
      renderer.bakeReflectionProbe([0, 2.6, 0], [0.05, 0.06, 0.09], (probeCamera) => {
        renderer.bindMeshPass(probeCamera, env);
        renderer.drawMesh(mesh, IDENTITY);
      });
    }

    renderer.beginFrame([0.05, 0.06, 0.09]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, IDENTITY);
    /*
     * `?mirror=1` polishes the sphere, and it is deliberately *independent* of `?probe=`.
     *
     * Tying the two together makes the only available comparison "a matte sphere against a
     * shiny one", which cannot tell a baked cube from the sky-and-ground gradient the shader
     * falls back to — and those two look alike, because a room of pale floor under a dark sky
     * is roughly what the gradient approximates. Separated, `?mirror=1` against
     * `?mirror=1&probe=256` changes exactly one thing.
     */
    renderer.setSurfaceReflectivity(asked.get('mirror') === '1' ? 0.95 : 0);
    renderer.drawMesh(mirror, IDENTITY);
    renderer.setSurfaceReflectivity(0);
    renderer.endFrame();
  };

  for (let step = 0; step < FRAMES; step++) draw(step);

  /*
   * Nothing further is requested, deliberately. A third frame would find the camera where the
   * second left it, reset the previous view to the current one, and the blur would vanish from
   * the very frame the capture is about to photograph — which is exactly how the held clock
   * hides this effect. See the module comment.
   */
  /*
   * The harness's own contract for "this page has stopped moving", rather than a second signal
   * that means the same thing: `__heldFrame` and a draw count in the readout is what
   * `shots.mjs` waits on, and a page with its own spelling of ready is a page whose captures
   * agree with nobody. This page is held in the strict sense — it has drawn every frame it
   * will ever draw — so it says so in those words. Capture it with `--hold=2`.
   */
  stats.textContent =
    `${renderer.backend} · probe · 1 draws · ` +
    `rush ${asked.get('rush') ?? '0'} · blur ${asked.get('blur') ?? '0'} · ` +
    `dof ${asked.get('dof') ?? '0'} · focus ${asked.get('focus') ?? '18.2'} · ` +
    `grade ${asked.get('grade') ?? 'none'} · ies ${asked.get('ies') ?? 'none'} · ` +
    `cookie ${asked.get('cookie') ?? 'none'}`;
  (window as unknown as { __heldFrame?: number }).__heldFrame = FRAMES;
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = `probe failed:\n${String(error)}`;
});
