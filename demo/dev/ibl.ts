/**
 * Irradiance from a baked probe, looked at on real hardware, on either backend.
 *
 * **This page is the term's only evidence and that is deliberate.** No published scene bakes a
 * probe into a room with a *direction* to it, so the gate on those proves the change is inert
 * where it should be and proves nothing about whether the term does anything. The proof lives here.
 *
 * A five by five grid of spheres inside a room with **one bright wall and one dark one**. That
 * asymmetry is the whole design: a grey room cannot show a directional irradiance term at all, and
 * a control that cannot separate its two states passes with the feature broken — which is the trap
 * `AGENTS.md` records against this very probe, where a matte sphere was compared with a polished
 * one and separated *reflective from not* rather than *baked from fallback*.
 *
 *     /ibl.html                    the default backend
 *     /ibl.html?backend=webgpu     the other one
 *     /ibl.html?sh=0               the term held off, which is the control every figure is against
 *
 * **What a failure looks like**, so it is recognised rather than rationalised:
 *
 *   - **Every sphere the same on both sides.** The coefficients are a constant: either the
 *     projection collapsed to its zeroth band or nothing filled it. The linear band is what carries
 *     direction, and it integrates to zero against a uniform environment, so a constant room is
 *     exactly the case that cannot tell these apart.
 *   - **The lit side facing the *dark* wall.** A sign in the basis, or faces handed to the
 *     projection in the wrong order. A mirrored face projects perfectly well onto a wrong answer.
 *   - **The room far brighter with `?sh=1` than with `?sh=0`.** The basis constants folded twice,
 *     or not at all: the shader evaluates a bare polynomial and every constant belongs in the
 *     coefficients. Missing them made a room saturate at `1 / 0.282095` too bright once already.
 *   - **Nothing changes between `?sh=0` and `?sh=1`.** The gate never opened. On WebGPU the
 *     coefficients land a frame or two after the bake, so a capture taken too early is this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
} from '@driftengine/core';
import type { MeshHandle, PointLightSource, RendererApi, Vec3 } from '@driftengine/core';

import { readRadianceHdr } from '@driftengine/assets';

import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.02, 0.024, 0.03];

/** Five across and five down, which is enough to read a trend and few enough to hold in view. */
const CELLS = 5;
const SPACING = 1.9;

/** The room's half-extent. Big enough that the probe sees walls rather than spheres. */
const ROOM = 9;

/**
 * The two walls that make this page work.
 *
 * One warm and bright, one nearly black, facing each other across the grid. A sphere between them
 * receives a different irradiance on each side, and *that difference* is the whole measurement —
 * a room of one colour would light every sphere identically however right or wrong the term is.
 */
const BRIGHT_WALL: Vec3 = [0.95, 0.72, 0.42];
const DARK_WALL: Vec3 = [0.03, 0.035, 0.045];
const NEUTRAL: Vec3 = [0.22, 0.23, 0.25];
const SPHERE_COLOR: Vec3 = [0.62, 0.62, 0.64];

function at(x: number, y: number, z: number): Float32Array {
  const model = new Float32Array(16);
  model[0] = 1;
  model[5] = 1;
  model[10] = 1;
  model[15] = 1;
  model[12] = x;
  model[13] = y;
  model[14] = z;
  return model;
}

/**
 * The room, as one merged mesh, drawn only into the probe.
 *
 * Its inward faces are what the probe photographs. It is never drawn into the frame: a viewer
 * would be inside a closed box and see nothing else, and the point of the page is the spheres.
 */
function buildRoom(uniform: boolean): ReturnType<MeshBuilder['build']> {
  const builder = new MeshBuilder();
  /*
   * **A room of one colour, which the paragraph below rightly calls useless for measuring
   * direction and which is the only room that can measure *energy*.**
   *
   * A perfect reflector in a uniform environment must return that environment's colour at every
   * roughness, because roughness scatters light and does not absorb it. So under `?uniform=1` a
   * metal ladder has to be flat across all seven rungs, and any falloff is energy the shading is
   * losing — with the room's own content held out of it, which is exactly what confounds the
   * measurement in the room below. The five-fold falloff a contrasty room produces is real and is
   * the room; a falloff here would be the term.
   */
  if (uniform) {
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        const center: Vec3 = [
          axis === 0 ? sign * ROOM : 0,
          axis === 1 ? sign * ROOM : 0,
          axis === 2 ? sign * ROOM : 0,
        ];
        const half: Vec3 = [
          axis === 0 ? 0.2 : ROOM,
          axis === 1 ? 0.2 : ROOM,
          axis === 2 ? 0.2 : ROOM,
        ];
        builder.addBox(center, half, BRIGHT_WALL, 1, 0);
      }
    }
    return builder.build({});
  }
  /*
   * +X bright, -X dark: the axis the grid is measured across.
   *
   * **The bright wall emits rather than merely being pale.** A pale wall is only as bright as
   * whatever lights it, which in a room lit by one dim lamp is not much — and the first run of this
   * page measured a direction of 4.1 levels out of 255, real but too close to the noise for a check
   * to stand on. A wall that is itself a source makes the room's light unambiguously one-sided,
   * which is the only property this page exists to measure.
   */
  builder.addBox([ROOM, 0, 0], [0.2, ROOM, ROOM], BRIGHT_WALL, 1, 0);
  builder.addBox([-ROOM, 0, 0], [0.2, ROOM, ROOM], DARK_WALL, 0, 0);
  builder.addBox([0, -ROOM, 0], [ROOM, 0.2, ROOM], NEUTRAL, 0, 0);
  builder.addBox([0, ROOM, 0], [ROOM, 0.2, ROOM], NEUTRAL, 0, 0);
  builder.addBox([0, 0, -ROOM], [ROOM, ROOM, 0.2], NEUTRAL, 0, 0);
  builder.addBox([0, 0, ROOM], [ROOM, ROOM, 0.2], NEUTRAL, 0, 0);
  return builder.build({});
}

function buildSphere(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addSphere([0, 0, 0], 0.8, SPHERE_COLOR, 0, 28, 16).build({});
}

/** How many rungs the roughness ladder has. Odd, so one sphere sits exactly at roughness 0.5. */
const LADDER = 7;

/**
 * One row of spheres from mirror to fully rough, as a single mesh.
 *
 * **This is the prefilter's own instrument and the grid above cannot be it.** The grid measures
 * *irradiance*, which is the diffuse half and is nine coefficients with no chain behind it. A GGX
 * prefilter changes what a *specular* surface reflects and changes it as a function of roughness,
 * so the only picture that can show it is a set of surfaces differing in exactly that.
 *
 * **What a failure looks like here**, written down so it is recognised rather than explained away:
 *
 *   - **Every rung identical.** The chain is being sampled at one level: either the roughness
 *     attribute is not reaching the shader or `uEnvironmentMaxLod` is 0.
 *   - **The rough end darker than the smooth end by a lot.** The convolution normalised by the
 *     sample count rather than by accumulated weight, so every sample below the horizon darkened
 *     the result. That is the exact artefact `uEnvironmentGain` was compensating for, so seeing it
 *     here means the prefilter reintroduced what it was built to remove.
 *   - **The mirror rung noisier than the room it reflects.** Roughness 0 went through the sum
 *     instead of the direct fetch: a delta distribution collapses every importance sample onto one
 *     direction, so the average is one sample's worth of noise.
 *   - **Bright speckle on the rough rungs.** Filtered importance sampling is reading too fine a
 *     source level, or the sample count is too low for a room this contrasty.
 */
function rungX(rung: number): number {
  return (rung - (LADDER - 1) / 2) * SPACING;
}

/**
 * One rung on its own, so a per-rung ORM map can be bound to it.
 *
 * **`?metal=1` needs this and the merged ladder cannot provide it.** `metal` reaches the lit pass
 * only through an ORM map's blue channel — there is no metallic vertex attribute and no setter —
 * and a map replaces the roughness attribute with its own green channel, so seven roughnesses mean
 * seven maps and therefore seven draws. Seven draws on a dev page is nothing; the alternative was
 * one map with the rungs' sphere UVs laid out to sample a texel each, which makes the measurement
 * depend on generated UVs rather than on the shading.
 */
function buildRung(rung: number): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .setRoughness(rung / (LADDER - 1))
    .addSphere([rungX(rung), 0, 0], 0.8, SPHERE_COLOR, 0, 28, 16)
    .build({});
}

/**
 * A single texel: no occlusion, this rung's roughness, fully metallic.
 *
 * One texel rather than a painted grid because nothing here varies across a surface — and a flat
 * map is the honest instrument for a term that is a function of roughness and view angle only.
 */
function paintMetalOrm(roughness: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(1, 1);
  image.data[0] = 255;
  image.data[1] = Math.round(Math.min(1, Math.max(0, roughness)) * 255);
  image.data[2] = 255;
  image.data[3] = 255;
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function buildLadder(): ReturnType<MeshBuilder['build']> {
  const builder = new MeshBuilder();
  for (let rung = 0; rung < LADDER; rung++) {
    /* Zero to one inclusive across the row, so both ends of the chain are actually shown. */
    builder.setRoughness(rung / (LADDER - 1));
    builder.addSphere([(rung - (LADDER - 1) / 2) * SPACING, 0, 0], 0.8, SPHERE_COLOR, 0, 28, 16);
  }
  builder.setRoughness(null);
  return builder.build({});
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (canvas === null || stats === null) return;

  /*
   * **The probe has to be asked for.** `reflectionProbeSize` defaults to 0, so a page that does not
   * name it gets no cube at all, `bakeReflectionProbe` answers false, and every measurement below
   * compares the control against itself — which is exactly how the first run of this page read: the
   * two states identical to the pixel and both checks reporting no direction.
   */
  /* `?probe=` because a consumer bakes at 512 and this page baked at 128, so every parity claim
     made here was about a chain three levels shorter than the one in the field. */
  const probeAsked = Number(new URLSearchParams(location.search).get('probe') ?? '128');
  const created = await createRenderer(
    canvas,
    {
      ...askedQuality(),
      reflectionProbeSize: Number.isFinite(probeAsked) && probeAsked > 0 ? probeAsked : 128,
    },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;

  /*
   * **Almost no analytic ambient, and that is what makes this page a measurement.**
   *
   * The hemispheric term is a sky-and-ground approximation with no room in it, and the irradiance
   * term replaces it where a probe exists. Leaving a large one here would put a floor under every
   * sphere that neither state can drop below, and the difference this page exists to show would be
   * a small perturbation on top of it.
   */
  const env = createEnvironment({
    directionalDir: [0.4, 0.85, 0.34],
    directionalColor: [0.05, 0.05, 0.06],
    ambient: [0.03, 0.032, 0.036],
    ambientGround: [0.02, 0.021, 0.024],
    /*
     * **`nightFactor` at 1, or the emissive wall emits nothing.** `emissiveGain` defaults to 1 and
     * reads like the switch; the multiplier that actually gates the term is this one, which
     * defaults to 0 — so the first run of this page built a room around a light source that was
     * off, and every check passed against a scene whose brightest sphere was 6 of 255.
     */
    emissiveGain: 1,
    nightFactor: 1,
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  /*
   * No lamps at all. The emissive wall is the room's only light, so every level a sphere shows
   * comes from the probe or from the small hemispheric floor — and a lamp would add its own
   * shading on top of the one axis being measured.
   */
  const lights: PointLightSource[] = [];
  const lightBuffer = createPointLightBuffer();
  selectPointLights(lights, 0, 0, 0, lightBuffer, 0);
  env.lightCount = lightBuffer.count;
  env.lightPositions = lightBuffer.positions;
  env.lightColors = lightBuffer.colors;
  env.lightRadii = lightBuffer.radii;
  env.lightSourceRadii = lightBuffer.sourceRadii;
  env.lightWeights = lightBuffer.weights;
  env.activeLightWorldIndices = lightBuffer.sourceIndex;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 13.5;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);
  camera.updateMatrices(aspect());

  const params = new URLSearchParams(location.search);
  /*
   * **`?uniform=1` paints every wall the same**, which makes this room useless for measuring
   * direction and is the only way to measure energy. See `buildRoom`.
   */
  const wantsUniform = params.get('uniform') === '1';
  /*
   * **`?metal=1` makes the ladder metallic, and it is the state the ladder could not reach.**
   *
   * `metal` arrives only through an ORM map's blue channel and this page bound none, so every rung
   * of the ladder that signed off `envBrdfApprox` was a dielectric at `f0` 0.04. The environment
   * BRDF's missing multiple-scattering energy is scaled by `f0`, so on a dielectric it is worth
   * about a thousandth of what it is worth on a metal — and the term shipped losing a metal 22% of
   * its reflection at roughness 0.4 and 44% at 0.8, reported from a consumer rather than caught
   * here. This is the switch that would have caught it.
   */
  const wantsMetal = params.get('metal') === '1';
  /*
   * **`?gain=` is what makes the metal ladder able to separate the two states**, and the first
   * version of this instrument could not.
   *
   * At `metal` 1 the lit pass computes `mix(lit, environment * albedo, weight)`. In a uniform
   * room the *diffuse* `lit` is about as bright as the reflection, so the mix is between two
   * near-equal values and the weight cannot be read off it at any value — measured: the ladder
   * came back identical, to a hundredth of a level, with the energy compensation in and with it
   * out. That is the "control that could not tell the two apart" failure written down in
   * `AGENTS.md`, reached from a new direction.
   *
   * `setEnvironmentGain` scales the reflection and not the diffuse, so a gain of 4 pulls the two
   * ends of the mix apart and the weight becomes the whole of what is being measured. It is also
   * the knob a consumer reaches for when metals read dull, which is how this defect was reported.
   */
  const environmentGain = Number(params.get('gain') ?? '1');

  const room = renderer.createMesh(buildRoom(wantsUniform));
  const sphereMesh = renderer.createMesh(buildSphere());
  const spheres: { mesh: MeshHandle; model: Float32Array; column: number; row: number }[] = [];
  for (let row = 0; row < CELLS; row++) {
    for (let column = 0; column < CELLS; column++) {
      spheres.push({
        mesh: sphereMesh,
        model: at((column - (CELLS - 1) / 2) * SPACING, ((CELLS - 1) / 2 - row) * SPACING, 0),
        column,
        row,
      });
    }
  }

  /*
   * The control, and it is a *quality* option rather than a uniform anybody can poke: with no probe
   * there are no coefficients, the shader's gate stays 0 and the hemispheric term is what lights
   * the spheres. That is exactly the state this page is measuring against, reached by the one
   * switch that produces it honestly.
   */
  const wantsProbe = params.get('sh') !== '0';
  /*
   * **`?grid=N` bakes N probes across the room instead of one at its centre**, which is the only
   * picture a probe *grid* can be judged on: one probe lights everything equally by construction,
   * so a page with one probe cannot tell a working grid from a broken one.
   *
   * The room already has a bright wall at +X and a dark one at -X, so probes spread along X see
   * genuinely different rooms — which is what makes the sphere grid's own columns the measurement.
   * `probegrid-check.mjs` reads them and asserts that the middle column lies strictly between the
   * two ends, which a nearest-probe selection cannot produce and a trilinear blend must.
   */
  const gridProbes = Math.max(1, Math.trunc(Number(params.get('grid') ?? '1')));
  /*
   * **The specular instrument, off by default so this page's existing measurement is untouched.**
   * `?ladder=1` swaps the diffuse grid for one row of reflective spheres from mirror to fully
   * rough, which is the only picture a prefilter can be judged on: the grid measures irradiance,
   * and irradiance has no chain behind it to prefilter.
   */
  const wantsLadder = params.get('ladder') === '1';
  /*
   * **`?env=<url>` loads an environment instead of photographing one.** The engine ships no image
   * and this page fetches whatever it is pointed at, which is the whole promise: a consumer that
   * never calls the loader fetches nothing and carries no decoder, exactly as one that never calls
   * `createSdfText` ships no font.
   */
  const environmentUrl = params.get('env');
  /*
   * Metal mode draws a mesh and a map per rung; the dielectric ladder stays one merged mesh, so
   * the measurement this page already had is reached by exactly the code that produced it.
   */
  const ladderMesh = wantsLadder && !wantsMetal ? renderer.createMesh(buildLadder()) : null;
  const metalRungs =
    wantsLadder && wantsMetal
      ? Array.from({ length: LADDER }, (_, rung) => ({
          mesh: renderer.createMesh(buildRung(rung)),
          orm: renderer.createSurfaceTexture(paintMetalOrm(rung / (LADDER - 1)), {
            colorSpace: 'linear',
            wrap: 'clamp',
          }),
        }))
      : null;

  /*
   * A loaded environment replaces the bake rather than joining it: the point of the flag is to show
   * a world lit by something it does not contain, and baking the room first would light it by both.
   */
  if (environmentUrl !== null) {
    const response = await fetch(environmentUrl);
    if (!response.ok) throw new Error(`ibl: ${environmentUrl} answered ${response.status}`);
    const image = readRadianceHdr(new Uint8Array(await response.arrayBuffer()));
    if (!renderer.setEnvironmentImage(image)) {
      throw new Error('ibl: the environment was refused, so this page can measure nothing');
    }
  } else if (wantsProbe) {
    const drawRoom = (probeCamera: Camera): void => {
      renderer.bindMeshPass(probeCamera, env);
      renderer.setMaterial(null);
      renderer.setSurfaceReflectivity(0);
      renderer.drawMesh(room, at(0, 0, 0));
    };
    /*
     * One probe is a grid of one, so there is one call here and not two paths. The spacing puts
     * the outermost probes near the walls they are meant to see rather than at the room's centre,
     * which is where a grid of one already stands.
     */
    const spacing = gridProbes > 1 ? (ROOM * 1.2) / (gridProbes - 1) : 1;
    const declared = renderer.setProbeGrid({
      origin: [gridProbes > 1 ? -(ROOM * 0.6) : 0, 0, 0],
      spacing: [spacing, spacing, spacing],
      counts: [gridProbes, 1, 1],
    });
    if (!declared)
      throw new Error('ibl: the probe grid was refused, so this page measures nothing');
    const baked = renderer.bakeProbeGrid(BACKGROUND, drawRoom);
    /* Said rather than assumed: a refused bake is a page measuring its own control twice, and
       nothing in the picture distinguishes that from a term that does nothing. */
    if (!baked) throw new Error('ibl: the probe was refused, so this page can measure nothing');
  }

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(null);
    if (metalRungs !== null) {
      /*
       * **The energy check.** Fully reflective and fully metallic, so `f0` is 1 and the environment
       * weight is the whole of what the surface shows. Against `?uniform=1` every rung must come
       * back the same brightness: a perfect reflector returns everything it is given at every
       * roughness, and a ladder that falls off is the shading losing light rather than the room
       * having less of it in the rough directions.
       */
      renderer.setSurfaceReflectivity(1);
      renderer.setEnvironmentGain(Number.isFinite(environmentGain) ? environmentGain : 1);
      for (const rung of metalRungs) {
        renderer.setMaterial({ orm: rung.orm });
        renderer.drawMesh(rung.mesh, at(0, 0, 0));
      }
      renderer.setMaterial(null);
    } else if (ladderMesh !== null) {
      /*
       * Fully reflective, which is the opposite of the grid's choice and is the point: what a
       * rung shows is the prefiltered chain sampled at its own roughness, with as little diffuse
       * term under it as this page can arrange.
       */
      renderer.setSurfaceReflectivity(1);
      renderer.drawMesh(ladderMesh, at(0, 0, 0));
    } else {
      /* Zero, so what a sphere shows is its diffuse term rather than a mirror of the room. This
         page is about irradiance; the reflection is the ladder's business. */
      renderer.setSurfaceReflectivity(0);
      for (const sphere of spheres) renderer.drawMesh(sphere.mesh, sphere.model);
    }
    renderer.endFrame();
  }

  renderFrame();
  stats.textContent =
    `${created.backend} · ${created.reason} · bright wall +X · dark wall -X · probe ${wantsProbe ? 'on' : 'off'}` +
    `${wantsLadder ? ` · roughness ladder, ${LADDER} rungs, mirror at -X${wantsMetal ? ', metallic' : ''}` : ''}` +
    `${wantsUniform ? ' · uniform room' : ''}` +
    `${environmentGain === 1 ? '' : ` · gain ${environmentGain}`}` +
    `${environmentUrl === null ? '' : ` · loaded ${environmentUrl}`}`;

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    renderFrame();
  });

  /*
   * Where each sphere landed, in CSS pixels, published for the measurement script — and re-read
   * every frame rather than once, because on WebGPU the coefficients arrive a frame or two after
   * the bake and the script keeps drawing until they have.
   */
  const out = new Float32Array(2);
  /*
   * In ladder mode the grid is not drawn, so publishing its cells would hand the measuring script
   * twenty-five points of empty room and a set of figures that look like data. The rungs are what
   * is on screen, so the rungs are what is published — each carrying the roughness it stands for,
   * because a check on a chain has to know which end it is looking at.
   */
  const cells: { column: number; row: number; roughness: number; x: number; y: number }[] = [];
  const publishLadder = (): void => {
    cells.length = 0;
    for (let rung = 0; rung < LADDER; rung++) {
      camera.project(out, rungX(rung), 0, 0, canvas.clientWidth, canvas.clientHeight);
      cells.push({
        column: rung,
        row: 0,
        roughness: rung / (LADDER - 1),
        x: out[0] ?? 0,
        y: out[1] ?? 0,
      });
    }
    (globalThis as unknown as { __cells?: unknown }).__cells = cells;
  };
  const publishGrid = (): void => {
    (globalThis as unknown as { __cells?: unknown }).__cells = spheres.map((sphere) => {
      camera.project(
        out,
        sphere.model[12] ?? 0,
        sphere.model[13] ?? 0,
        sphere.model[14] ?? 0,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      return { column: sphere.column, row: sphere.row, roughness: 0, x: out[0], y: out[1] };
    });
  };
  const publish = (): void => {
    if (wantsLadder) publishLadder();
    else publishGrid();
  };
  publish();

  /*
   * **Kept drawing, which this page needs and `orm.html` does not.** One backend fills the
   * coefficients synchronously inside the bake and the other when a readback resolves, a frame or
   * two later. A page that draws once photographs the state before that on WebGPU, which reads as
   * the term doing nothing at all.
   */
  let frames = 0;
  const tick = (): void => {
    renderFrame();
    frames++;
    if (frames === 8) {
      publish();
      (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
    }
    if (frames < 240) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = String(error);
  throw error;
});
