/**
 * A bought PBR model, drawn by the engine alone, so a consumer's scene cannot be blamed for it.
 *
 * **What this page is for.** A model whose metal lives in a `metallicRoughnessTexture` has four
 * things that must all be true before it reads as metal, and getting any one of them wrong
 * produces the same flat, matte picture with nothing to point at. This page turns each of them
 * into a switch so the responsible one can be found in one reload rather than argued about:
 *
 *     /model.html?orm=0          bind the colour map alone, which is the "before"
 *     /model.html?normal=0       leave the surface to its geometry, with no normal map
 *     /model.html?emissivemap=0  drop the emissive map, leaving the glow the factor alone gives
 *     /model.html?probe=0        no reflection probe, so a metal mirrors a sky approximation
 *     /model.html?emissive=0     leave the model's own self-lit parts dark
 *     /model.html?room=grey      a uniform box instead of a lit studio
 *     /model.html?envambient=1   take the ambient from the baked room rather than the constants
 *     /model.html?exposure=1.4   the output transform's exposure
 *     /model.html?src=/car.drft  any other baked model
 *
 * **Drag to orbit.** That is not a convenience: a metal has no diffuse term, so what it shows *is*
 * its reflection, and a reflection only reads as one when it sweeps across a panel as the eye
 * moves. A still frame of a mirror is indistinguishable from a still frame of paint.
 *
 * **Four things this page had wrong before it worked, all of which produced confident wrong
 * conclusions about the engine:**
 *
 *   - **`reflectionProbeSize` defaults to 0.** Not asking for a probe and then judging a metal is
 *     judging a surface with no diffuse *and* no reflection, which is black by construction.
 *   - **The probe was baked from inside the model.** It sits at the subject's own centre, so
 *     drawing the subject into it captures the inside of its own chest and the metal mirrors that.
 *   - **`outputTransform` defaults to `none`**, which returns the shaded colour unencoded. A model
 *     whose colour maps are decoded on the way in and never re-encoded on the way out is dark
 *     everywhere, and it looks exactly like a shading bug.
 *   - **A uniform environment gives a uniform reflection.** A room that is one flat tone makes a
 *     metal one flat tone, correctly. `?room=grey` is kept so that is visible rather than assumed.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
} from '../../packages/core/src/index';
import type { PointLightSource } from '../../packages/core/src/index';
import { DrftLoader } from '../../packages/assets/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.05, 0.055, 0.065];

function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

async function main(): Promise<void> {
  const surface = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (surface === null || stats === null) return;
  const canvas: HTMLCanvasElement = surface;

  const query = new URLSearchParams(location.search);
  const useOrm = query.get('orm') !== '0';
  const useNormal = query.get('normal') !== '0';
  const useProbe = query.get('probe') !== '0';
  const useEmissive = query.get('emissive') !== '0';
  /*
   * A separate control from `?emissive`, deliberately. That one switches emission off altogether —
   * the gain and the night factor — and this one leaves the emission alone and drops only the map.
   * `askedQuality.ts` states the rule they both obey: every control is one thing, because an
   * instrument that changes two per query cannot attribute a difference to either.
   */
  const useEmissiveMap = query.get('emissivemap') !== '0';
  const studio = query.get('room') !== 'grey';
  const probeCheck = query.get('probecheck') === '1';
  /* Radiance of the studio's own panels. A real softbox is many times brighter than a lit wall,
     and a metal is its reflection — so this is what decides whether a highlight can be brighter
     than the albedo it sits on. It needs an HDR probe to survive the bake. */
  const roomGain = Number(query.get('roomgain') ?? '2.6');
  const envAmbient = Number(query.get('envambient') ?? '1');
  const source = query.get('src') ?? '/ironman.drft';

  /*
   * The probe and the output transform are asked for here rather than left to the defaults, and
   * both are load-bearing. See the header: without the first a metal has nothing to reflect, and
   * without the second the whole frame is unencoded and reads as a shading fault.
   */
  const created = await createRenderer(
    canvas,
    {
      outputTransform: 'aces' as const,
      outputExposure: Number(query.get('exposure') ?? '1.0'),
      /* Multisampled and mipped hard, because this page is looked at closely: a metal's reflection
       is a high-frequency signal and an aliased one reads as a dirty surface rather than a shiny
       one. `?samples=1` to see what it costs. */
      sceneSamples: 4,
      /*
       * **Full density and no area cap.** The defaults exist to keep a game inside a frame budget:
       * `maxDrawingBufferPixels` caps the *area* a frame may cost, and a large window silently
       * renders at a fraction of its own size. That is right for a game and wrong for a page whose
       * only job is to be looked at closely — the model came out soft and pixelated for it.
       */
      maxDevicePixelRatio: Number(query.get('dpr') ?? String(Math.min(2, devicePixelRatio || 1))),
      maxDrawingBufferPixels: 0,
      /*
       * **HDR, and it is the difference between a metal and a picture of one.** A metal shows
       * `environment * albedo` and nothing else, so an 8-bit probe caps its whole appearance at its
       * own albedo — a dark red suit can never show a highlight brighter than dark red. The probe
       * takes the pipeline's colour format, so asking for an HDR scene is what makes the cube carry
       * values above 1 and a light source stay a light source once reflected.
       */
      hdrScene: query.get('hdr') !== '0',
      ...askedQuality(),
      ...(useProbe ? { reflectionProbeSize: 1024 } : {}),
    },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment({
    directionalDir: [0.42, 0.66, 0.62],
    directionalColor: [1.25, 1.22, 1.15],
    ambient: [0.2, 0.21, 0.25],
    ambientGround: [0.08, 0.08, 0.085],
    fogColor: BACKGROUND,
    fogDensity: 0,
    /* Every emissive term is multiplied by this, so a model shown by day cannot show its
       self-lit parts at all whatever the gain is. */
    nightFactor: useEmissive ? 1 : 0,
  });

  /*
   * A lit studio: bright overall, with brighter panels and darker gaps.
   *
   * **The contrast is the point.** A metal is entirely its reflection, so what it looks like is
   * the average of what surrounds it — a uniformly bright room makes a uniformly bright metal,
   * which is flat, and a uniformly dark one makes it black. Panels give the mirror direction
   * something to cross as it sweeps, and crossing light and dark is what reads as polish.
   */
  const builder = new MeshBuilder();
  builder.addBox([0, -0.06, 0], [9, 0.06, 9], studio ? [0.4, 0.41, 0.44] : [0.3, 0.31, 0.34]);
  if (studio) {
    /*
     * **A dark field with bright emitters in it**, which is what a photographic studio is and what
     * an environment map of one contains.
     *
     * The field is ordinary lit geometry — no emissive at all — so it sits well under 1 and the
     * metal facing it goes dark. The panels emit at `roomGain`, several times over white, which
     * is the only way a reflection can be brighter than the albedo it lands on. Both halves are
     * needed: a uniformly bright room gives a flat metal and a uniformly dark one gives a black
     * one, and this page went through both before arriving here.
     */
    builder.addBox([0, 5, 0], [9, 0.06, 9], [0.42, 0.43, 0.47], 0.5);
    /*
     * **Strongly directional, because a symmetric room lights a metal flat.**
     *
     * A metal's diffuse is multiplied by (1 - metal) and vanishes, so the only thing that can
     * make one side of it brighter than the other is the environment differing in those two
     * directions. A box whose four walls are the same value differs in none of them, and the
     * model comes out evenly lit however good the shading is — which is exactly how this room
     * read before, and it was the room's fault rather than the renderer's.
     *
     * So: a wall of light on the left, a dark wall on the right, and the two ends between them.
     */
    builder.addBox([-9, 3, 0], [0.06, 3, 9], [1, 0.97, 0.92], 1);
    builder.addBox([9, 3, 0], [0.06, 3, 9], [0.05, 0.052, 0.06]);
    builder.addBox([0, 3, -9], [9, 3, 0.06], [0.3, 0.32, 0.38], 0.3);
    builder.addBox([0, 3, 9], [9, 3, 0.06], [0.1, 0.105, 0.12]);
    /* A cool kicker on the dark side, so the shadow edge is separated rather than black. */
    builder.addBox([8.6, 2.2, 1.0], [0.08, 1.5, 2.4], [0.55, 0.68, 1], 1);
    /* A ceiling strip, for the streak that runs down a curved plate as the eye moves. */
    builder.addBox([-1.4, 4.9, 0], [0.36, 0.05, 7.5], [1, 0.99, 0.97], 1);
    if (probeCheck) {
      builder.addBox([-4.6, 1.7, 0], [0.08, 1.7, 4.5], [1, 0.05, 0.05], 1);
      builder.addBox([4.6, 1.7, 0], [0.08, 1.7, 4.5], [0.05, 1, 0.1], 1);
      builder.addBox([0, 1.7, -4.6], [4.5, 1.7, 0.08], [0.1, 0.2, 1], 1);
      builder.addBox([0, 1.7, 4.6], [4.5, 1.7, 0.08], [1, 0.9, 0.05], 1);
    }
  } else {
    builder.addBox([0, 3, -9], [9, 3, 0.06], [0.55, 0.56, 0.6]);
    builder.addBox([-9, 3, 0], [0.06, 3, 9], [0.42, 0.43, 0.47]);
    builder.addBox([9, 3, 0], [0.06, 3, 9], [0.42, 0.43, 0.47]);
  }
  const room = renderer.createMesh(builder.build());

  /*
   * **One lamp directly over the head**, which is the simplest question this page can ask: does
   * anything on this model change when a light moves? A metal's diffuse is multiplied by
   * (1 - metal) and all but vanishes, so a lamp reaches it almost entirely through the highlight
   * — and if nothing brightens under a source hanging a metre above the helmet, the lighting is
   * not arriving at all and no amount of environment work is the answer.
   *
   * `?lamp=0` removes it, which is the comparison.
   */
  const lampOn = query.get('lamp') !== '0';
  const lights: PointLightSource[] = lampOn
    ? [
        {
          x: 0,
          y: 2.25,
          z: 0.55,
          /* Well over white, because a metal takes a lamp almost entirely through its highlight —
             the diffuse it would otherwise light is multiplied by (1 - metal) and vanishes. */
          r: 3.4,
          g: 3.15,
          b: 2.8,
          radius: 4.5,
          /* No flicker: this page is captured and diffed, and a clock makes two runs differ. */
          flicker: 0,
          shadowNear: 0.2,
          /* A real size, so `sphereLobe` runs and the highlight is as wide as the source is. */
          sourceRadius: 0.22,
        },
      ]
    : [];
  const lightBuffer = createPointLightBuffer();
  selectPointLights(lights, 0, 1.3, 0, lightBuffer, 0);
  env.lightCount = lightBuffer.count;
  env.lightPositions = lightBuffer.positions;
  env.lightColors = lightBuffer.colors;
  env.lightRadii = lightBuffer.radii;
  env.lightSourceRadii = lightBuffer.sourceRadii;
  env.lightWeights = lightBuffer.weights;
  env.activeLightWorldIndices = lightBuffer.sourceIndex;

  /* The bulb itself, so the source is visible rather than inferred from what it lights. */
  const bulb = renderer.createMesh(
    new MeshBuilder().addSphere([0, 2.25, 0.55], 0.075, [1, 0.95, 0.86], 1, 16, 10).build(),
  );

  const loader = new DrftLoader(renderer, {});
  await loader.load(source, { footprint: 1.4, height: 2.0, baseY: 0 });

  /*
   * **Sized before the first frame.** A canvas element defaults to 300x150 and CSS stretches it
   * to the window, so a page that never calls this renders a postage stamp and blows it up — and
   * every judgement made from it, including several made from this page, is a judgement about a
   * 300x150 image. The stats line prints the drawing buffer for that reason.
   */
  renderer.resize();

  const identity = at(0, 0, 0);
  const camera = new Camera();
  camera.fovYDeg = 32;
  camera.near = 0.05;
  camera.far = 80;

  /* Orbit state. Yaw and pitch in radians, distance in metres, around the model's middle. */
  /*
   * Openable at a stated camera, because this page takes `?src=` and a car is not a person. The
   * defaults frame a standing humanoid; a wide, low model fitted into the same box sits under the
   * bottom of the frame, and a capture of it is a photograph of the floor. `?yaw=`, `?pitch=`,
   * `?dist=` and `?ty=` are what a harness sets so two runs frame the same thing.
   */
  let yaw = Number(query.get('yaw') ?? '0.62');
  let pitch = Number(query.get('pitch') ?? '0.06');
  let distance = Number(query.get('dist') ?? '3.1');
  const target: Vec3 = [0, Number(query.get('ty') ?? '1.42'), 0];

  function placeCamera(): void {
    const cp = Math.cos(pitch);
    camera.position[0] = target[0] + Math.sin(yaw) * cp * distance;
    camera.position[1] = target[1] + Math.sin(pitch) * distance;
    camera.position[2] = target[2] + Math.cos(yaw) * cp * distance;
    camera.lookAt(target[0], target[1], target[2]);
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  }

  /* The room only. A probe that contains the subject reflects the subject in the subject — and
     this one sits at the subject's own centre, so it would capture the inside of its chest. */
  function bakeProbe(): void {
    renderer.bakeReflectionProbe(target, BACKGROUND, (probeCamera) => {
      renderer.bindMeshPass(probeCamera, env);
      renderer.setMaterial(null);
      renderer.setEmissiveGain(roomGain);
      renderer.drawMesh(room, identity);
    });
  }

  function drawFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setEnvironmentAmbient(Number.isFinite(envAmbient) ? envAmbient : 0);

    renderer.setEmissiveGain(roomGain);
    renderer.setMaterial(null);
    renderer.drawMesh(room, identity);
    if (lampOn) renderer.drawMesh(bulb, identity);

    renderer.setEmissiveGain(useEmissive ? 1 : 0);
    const textures = loader.textures;
    for (const part of loader.parts) {
      const albedo = part.albedo >= 0 ? (textures?.at(part.albedo) ?? null) : null;
      renderer.setMaterial(
        useOrm
          ? {
              albedo,
              orm: part.orm >= 0 ? (textures?.at(part.orm) ?? null) : null,
              /* The third map, and the one that puts a seam back into a panel the geometry
                 smoothed away. `?normal=0` is the comparison. */
              normal: useNormal && part.normal >= 0 ? (textures?.at(part.normal) ?? null) : null,
              /* The fourth and last map the container carries. `?emissive=0` is the comparison. */
              emissive:
                useEmissiveMap && part.emissive >= 0 ? (textures?.at(part.emissive) ?? null) : null,
              roughnessScale: part.roughnessScale,
              metallicScale: part.metallicScale,
              occlusionStrength: part.occlusionStrength,
            }
          : { albedo },
      );
      renderer.setSurfaceReflectivity(part.reflectivity);
      if (part.opacity >= 1) renderer.drawMesh(part.mesh, identity);
      else renderer.drawTranslucentMesh(part.mesh, identity, part.opacity);
    }
    renderer.setMaterial(null);
    renderer.setSurfaceReflectivity(0);
    renderer.endFrame();
  }

  let baked = false;
  function frame(): void {
    loader.update(1 / 60);
    if (useProbe && !baked && loader.progress.phase === 'ready') {
      baked = true;
      bakeProbe();
    }
    placeCamera();
    drawFrame();
  }

  /* The loader uploads a bounded number of parts per frame, so it takes several to arrive. */
  for (let i = 0; i < 400 && loader.progress.phase !== 'ready'; i++) {
    frame();
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  frame();

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    yaw -= (event.clientX - lastX) * 0.007;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + (event.clientY - lastY) * 0.005));
    lastX = event.clientX;
    lastY = event.clientY;
    frame();
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      distance = Math.max(1.4, Math.min(14, distance * (1 + Math.sign(event.deltaY) * 0.09)));
      frame();
    },
    { passive: false },
  );
  addEventListener('resize', () => {
    renderer.resize();
    frame();
  });

  const mapped = loader.parts.filter((part) => part.orm >= 0).length;
  const normalled = loader.parts.filter((part) => part.normal >= 0).length;
  stats.textContent =
    `${created.backend} · ${canvas.width}x${canvas.height}` +
    ` · ${loader.parts.length} parts, ${mapped} with an ORM map, ${normalled} with a normal map` +
    ` · orm ${useOrm ? 'on' : 'off'} · probe ${useProbe ? (baked ? 'baked' : 'ASKED, NOT BAKED') : 'off'}` +
    ` · envAmbient ${envAmbient} · emissive ${useEmissive ? 'on' : 'off'}` +
    ` · emissiveMap ${useEmissiveMap ? 'on' : 'off'}` +
    ` · lamp ${lampOn ? 'on' : 'off'}`;
  /*
   * The loader itself, for a harness that needs to ask what actually arrived rather than read it
   * off a stats line. A part count that does not match the file's material count is the tell that
   * something was dropped on the way in, and that is not visible in a picture of a model whose
   * missing parts are inside it.
   */
  (globalThis as unknown as { __loader?: unknown }).__loader = loader;
  /* The renderer too, for a harness that reads the probe cube back rather than judging it
     from the picture. Same argument as `__loader`: what the cube holds is not visible in a
     frame of a model whose reflection is the thing in question. */
  (globalThis as unknown as { __renderer?: unknown }).__renderer = renderer;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
