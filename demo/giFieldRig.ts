/**
 * The world's distance field, composed by the renderer and marched so it can be looked at.
 *
 * **A rig rather than a picture of the engine**, on the same terms the GPU-driven ones are: what it
 * exercises is that the renderer's own composition runs — that the dispatch produces the field the
 * TypeScript reference produces, in a frame, at a cost a timestamp can report.
 *
 * `scripts/gi-parity.mjs` already proves the *shaders* agree with the reference, sample for sample.
 * What a number cannot say is whether the pass wires them up right: whether every cascade lands
 * where `placeCascade` puts it, whether each writes its own region rather than the last one's, and
 * whether the fade between cascades is a fade. All three are visible. A cascade composed with the
 * wrong origin puts the geometry somewhere else; one writing the wrong region loses the innermost
 * detail entirely; a bad fade is a seam that sweeps as the camera moves.
 *
 * It stays in `DRAFT_SCENES` because a marched distance field is a diagnostic, not a material.
 */
import { Camera, GiFieldPass, createEnvironment, createRenderer } from '../packages/core/src/index';

import type {
  FieldSource,
  DistanceFieldInstance,
  RenderQualityOptions,
  SkyColors,
} from '../packages/core/src/index';
import type { DemoHandle, DemoStats } from './types';

/** A sphere's exact field on a grid. Analytic, because a bake would be a second thing to check. */
function sphereField(radius: number, half: number, resolution: number): FieldSource {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz += 1) {
    for (let iy = 0; iy < resolution; iy += 1) {
      for (let ix = 0; ix < resolution; ix += 1) {
        field[ix + resolution * (iy + resolution * iz)] =
          Math.hypot(-half + ix * step, -half + iy * step, -half + iz * step) - radius;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

/** A box's, so the picture has a shape a rotation can be seen in. A sphere cannot show one. */
function boxField(
  hx: number,
  hy: number,
  hz: number,
  half: number,
  resolution: number,
): FieldSource {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz += 1) {
    for (let iy = 0; iy < resolution; iy += 1) {
      for (let ix = 0; ix < resolution; ix += 1) {
        const p = [-half + ix * step, -half + iy * step, -half + iz * step];
        const gap = [
          Math.abs(p[0] as number) - hx,
          Math.abs(p[1] as number) - hy,
          Math.abs(p[2] as number) - hz,
        ];
        const outside = Math.hypot(
          Math.max(gap[0] as number, 0),
          Math.max(gap[1] as number, 0),
          Math.max(gap[2] as number, 0),
        );
        const inside = Math.min(Math.max(gap[0] as number, gap[1] as number, gap[2] as number), 0);
        field[ix + resolution * (iy + resolution * iz)] = outside + inside;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

const SKY: SkyColors = {
  top: [0.07, 0.11, 0.2],
  horizon: [0.3, 0.36, 0.44],
  deep: [0.02, 0.03, 0.06],
  sunDir: [0.4, 0.66, 0.35],
  sunColor: [1, 0.96, 0.88],
  sunAngularRadius: 0.005,
  moonDir: [-0.3, 0.6, -0.4],
  moonColor: [0.5, 0.55, 0.7],
  moonAngularRadius: 0.006,
  moonPhase: 0.5,
  nightFactor: 0,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

const ENV = createEnvironment({
  directionalDir: [0.4, 0.66, 0.35],
  directionalColor: [0.95, 0.9, 0.8],
  ambient: [0.22, 0.26, 0.34],
  ambientGround: [0.07, 0.06, 0.05],
  emissiveGain: 1,
  nightFactor: 0,
  fogColor: [0.3, 0.36, 0.44],
  fogDensity: 0,
  fogHeightFalloff: 0.05,
  fogBaseY: 0,
});

/**
 * A yaw, a uniform scale and a placement, column-major.
 *
 * **Written out rather than taken from `gl-matrix`**, because `demo/scenes.test.ts` holds a scene
 * to the engine's public barrel alone — a consumer has package exports and nothing else, so a demo
 * reaching past them is a demo doing something a consumer could not. Three lines of arithmetic is
 * the right price for that.
 */
function placement(yaw: number, x: number, y: number, z: number, scale: number): Float32Array {
  const c = Math.cos(yaw) * scale;
  const s = Math.sin(yaw) * scale;
  return new Float32Array([c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, z, 1]);
}

/** A ring of boxes and spheres, placed so cascade boundaries fall across geometry. */
function instances(): DistanceFieldInstance[] {
  const sphere = sphereField(0.55, 1.2, 25);
  /*
   * **Chunky on purpose, and the first version was not.** A slab 0.56 m thick is four samples
   * across in the innermost cascade and half a sample in the outermost, so it comes back as fins
   * and spikes — which is the field being coarse rather than wrong, and is exactly what a
   * trilinear read of an under-resolved distance field looks like. A rig that demonstrates the
   * architecture should be sized to what the architecture resolves; the limit belongs in the note.
   */
  const box = boxField(0.5, 0.45, 0.5, 1.2, 25);
  const out: DistanceFieldInstance[] = [];
  /*
   * **Six, well apart, and the first version was twelve nearly touching.** Objects 0.64 m across at
   * 1.26 m spacing merge into one mass, and a composed field is a *union* — so what came back was a
   * single blob with the cascades' resolution showing on it, which reads as the pass being broken.
   * Marching the same scene through `composeGlobalField` on the processor produced the same
   * picture, which is what said the scene was at fault rather than the shader.
   */
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    const radius = 2.6;
    out.push({
      /* A colour a shape, so a picture of the field says which instance is which. */
      albedo: Float32Array.from(i % 2 === 0 ? [0.85, 0.5, 0.25] : [0.3, 0.55, 0.85]),
      source: i % 2 === 0 ? sphere : box,
      /* A yaw that differs per instance, so a wrong inverse is a wrong orientation on screen. */
      transform: placement(
        angle * 1.7,
        Math.cos(angle) * radius,
        ((i % 4) - 1.5) * 0.9,
        Math.sin(angle) * radius,
        0.8,
      ),
    });
  }
  return out;
}

export async function mountGiField(
  canvas: HTMLCanvasElement,
  overrides: RenderQualityOptions = {},
): Promise<DemoHandle> {
  /*
   * **Asked for WebGPU at boot as well as at `registerPass`, and both are load-bearing.** A scene
   * that only registered the pass would fall back to a forward frame with nothing in it on WebGL2,
   * silently; `GiFieldPass.init` refuses there in words a consumer can act on. The gpu-driven rigs
   * make the same argument at the same length.
   */
  const { renderer, backend } = await createRenderer(
    canvas,
    /*
     * **`indirectLight` is what makes the renderer compose at all**, and an override may not turn
     * it off here: with it off there is no field, and this rig is a picture of the field. It is
     * spread after the overrides for that reason rather than before them.
     */
    { ...overrides, indirectLight: true },
    { splash: false, preferWebGpu: true },
  );
  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.1;
  camera.far = 200;

  const list = instances();
  /*
   * **Declared to the renderer rather than handed to the pass**, which is the change of
   * 2026-09-18. The renderer composes the world's field from what a frame declares — three
   * cascades of 49, which is `DEFAULT_FIELD_COMPOSE` and is where the 16.7 cm innermost step and
   * the 1.4 MB come from — and this pass marches what it composed. Before that the pass composed
   * a field of its own and the renderer had none, so the thing on the screen was not the thing
   * anything else could trace against.
   */
  const pass = new GiFieldPass();
  const handle = renderer.registerPass(pass);
  renderer.resize();

  /* Reused, because the frame path allocates nothing and `demo/scenes.test.ts` checks. */
  const eye: [number, number, number] = [0, 0, 0];
  const stats = {
    draws: 2,
    /* Filled from the pass's own timestamps, or left at zero where the device was not asked for
       `timestamp-query` — which is `gpuTimer.ts`'s rule about what unmeasured looks like. */
    gpuMs: 0,
    note: `${list.length} instances over 3 cascades of 49, composed by the renderer each frame`,
  } as DemoStats;
  let elapsed = 0;
  let disposed = false;

  return {
    frame(dtSec: number): DemoStats {
      if (disposed || renderer.contextLost) return stats;
      elapsed += dtSec;
      /*
       * **A slow orbit from *inside* the ring, and the distance is the whole point.** The cascades
       * are centred on the camera, which is what indirect light wants — detail where the viewer is
       * — and it means a camera standing well outside the geometry sees all of it through the
       * *outermost* cascade. The first capture of this rig was taken from nine metres out and came
       * back as spikes and sheets: cascade 2's step is a metre, and a trilinear read of a metre-wide
       * distance field is exactly that shape. It is the field being coarse, not the field being
       * wrong, and the way to see the difference is to stand where the detail is.
       */
      const angle = elapsed * 0.25;
      camera.position[0] = Math.cos(angle) * 4.4;
      camera.position[1] = 1.7;
      camera.position[2] = Math.sin(angle) * 4.4;
      camera.lookAt(0, 0, 0);
      camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

      /*
       * Before `beginFrame`, because that is when `prepare` records the composition.
       *
       * `invViewProjection` is the camera's own, kept in step by `updateMatrices` — inverting the
       * view-projection here would be a second inverse of one matrix, and the sky pass already
       * reads that field for the same reason.
       */
      eye[0] = camera.position[0] as number;
      eye[1] = camera.position[1] as number;
      eye[2] = camera.position[2] as number;
      pass.setView(eye, camera.invViewProjection);

      renderer.beginFrame([0.05, 0.07, 0.1]);
      renderer.bindMeshPass(camera, ENV);
      /*
       * Redeclared every frame, because the queue is emptied at every `beginFrame` — a field a
       * consumer stops declaring stops lighting, which is the same contract `addOccluder` has.
       */
      for (const instance of list) renderer.addDistanceField(instance.source, instance.transform);
      renderer.drawSky(camera, SKY, ENV);
      renderer.drawPass(handle);
      renderer.endFrame();

      renderer.readDistanceFieldTimings();
      stats.gpuMs = renderer.distanceFieldMs ?? 0;
      return stats;
    },
    backend,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      renderer.unregisterPass(handle);
      renderer.dispose();
    },
  };
}
