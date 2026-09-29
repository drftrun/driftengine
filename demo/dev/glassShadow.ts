/**
 * Light through glass, and a control beside every claim: the page that turns glass shadows on.
 *
 *     /glassShadow.html?variant=sun-clear      sunlight through a three-colour pane onto a floor
 *     /glassShadow.html?variant=sun-frosted    the same pane frosted: the colour spreads, the light stays
 *     /glassShadow.html?variant=sun-moving     the pane sliding, cast in the movers' layer
 *     /glassShadow.html?variant=lamp-clear     the same panes lit by a lamp instead, the sun off
 *     /glassShadow.html?variant=lamp-frosted   ... frosted
 *     /glassShadow.html?variant=lamp-moving    ... sliding, in the lamp's live map
 *     /glassShadow.html?variant=area-clear     a small rectangle where the lamp was, facing the panes
 *     /glassShadow.html?variant=area-frosted   ... frosted
 *     /glassShadow.html?variant=gpu-clear      the sun variants' floor and panes, drawn by the
 *     /glassShadow.html?variant=gpu-frosted    GPU-driven renderer: its glass against the forward's
 *     &glassshadows=off|half                   the quality option; off is glass before this existed
 *     &lampcolour=0                            the lamp dark: the ambient a lamp's patch sits on
 *
 * **Three panes of known colour over a matte floor, lit by a sun at 45°**, so each coloured patch
 * lands at a place this page can compute and read back: `__patches` holds the mean colour of each,
 * `__lit` the same floor in full sun beside them, and `__sum` the light summed over a box enclosing
 * all three — the figure frost must not change. A clear pane's patch is `transmission × (1 − F) ×
 * tint` of the lit floor; a frosted pane's is wider and softer and sums to the same light.
 *
 * **`__control` is a small plate on the light's side of a fourth pane**, the case the tint's depth
 * test exists for: that plate's texel in the tint map holds the pane behind it, and it must read
 * exactly as it does with glass shadows off. The fourth pane's own patch is not measured; the
 * plate shades it.
 *
 * The camera stands behind the panes looking back at the patches, so no pane is between the eye
 * and what is measured. Nothing reads a real clock: a load draws `frames` frames and publishes.
 * Nothing here is engine API and nothing under `src/` may import it.
 */
import { vec4 } from 'gl-matrix';
import {
  Camera,
  computeLightMatrix,
  GpuDrivenPass,
  createAreaLightBuffer,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectAreaLights,
  selectPointLights,
  streamingScene,
} from '../../packages/core/src/index';
import type {
  AreaLightSource,
  GlassOptions,
  GlassShadows,
  GpuDrivenMaterial,
  GpuDrivenMesh,
  GpuDrivenView,
  MeshData,
  PointLightSource,
  RendererApi,
  SceneCasterMaterial,
  ShadowCasterSink,
  Vec3,
} from '../../packages/core/src/index';
import { clustered } from '../gpuDrivenRig';
import { DEV_RENDERER, askedQuality } from './askedQuality';

type Variant =
  | 'sun-clear'
  | 'sun-frosted'
  | 'sun-moving'
  | 'lamp-clear'
  | 'lamp-frosted'
  | 'lamp-moving'
  | 'area-clear'
  | 'area-frosted'
  | 'gpu-clear'
  | 'gpu-frosted';

const CLEAR: Vec3 = [0.02, 0.03, 0.05];
/** Toward the sun: up and toward +z at 45°, so light crosses the panes (z = 0) toward −z. */
const TO_SUN: Vec3 = [0, Math.SQRT1_2, Math.SQRT1_2];
/** The three measured panes: centre x, and the colour each lets through. */
const PANES: readonly { x: number; tint: Vec3 }[] = [
  { x: -1.1, tint: [1, 0.25, 0.25] },
  { x: 0, tint: [0.25, 1, 0.25] },
  { x: 1.1, tint: [0.25, 0.25, 1] },
];
const PANE_W = 1;
const PANE_BOTTOM = 1;
const PANE_TOP = 2.5;
/** The unmeasured fourth pane the control plate stands in front of, toward the sun. */
const SPARE = { x: 3, tint: [1, 0.3, 0.3] as Vec3, bottom: 1.5, top: 2.1 };
/** The lamp variants' light: above and behind the panes, so their patches land in view. */
const LAMP: Vec3 = [0, 4.5, 3.5];
const DT = 1 / 60;
const PLATE_HALF = 0.12;

/** The plate: 0.9 m from the spare pane's centre toward the light, and small. */
function plateAt(lamp: boolean): Vec3 {
  const centre: Vec3 = [SPARE.x, (SPARE.bottom + SPARE.top) / 2, 0];
  const toward: Vec3 = lamp
    ? [LAMP[0] - centre[0], LAMP[1] - centre[1], LAMP[2] - centre[2]]
    : TO_SUN;
  const length = Math.hypot(toward[0], toward[1], toward[2]);
  return [
    centre[0] + (0.9 * toward[0]) / length,
    centre[1] + (0.9 * toward[1]) / length,
    centre[2] + (0.9 * toward[2]) / length,
  ];
}

/** A flat quad from four corners, counter-clockwise seen from `normal`'s side. */
function quad(
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  normal: Vec3,
  colour: number,
  twoSided = false,
): MeshData {
  const positions = new Float32Array(corners.flat());
  const normals = new Float32Array([...normal, ...normal, ...normal, ...normal]);
  const colors = new Float32Array(12).fill(colour);
  const emissive = new Float32Array(4);
  const indices = twoSided
    ? new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2])
    : new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { positions, normals, colors, emissive, indices };
}

/**
 * A pane standing in the z = 0 plane, facing +z toward the sun and the camera's far side.
 *
 * **Both windings to be seen from behind, one to cast**: to a light a second copy of a pane's
 * triangles is a second pane, so what casts is one surface with a two-sided material.
 */
function paneMesh(x: number, bottom: number, top: number, twoSided: boolean): MeshData {
  const h = PANE_W / 2;
  return quad(
    [
      [x - h, bottom, 0],
      [x + h, bottom, 0],
      [x + h, top, 0],
      [x - h, top, 0],
    ],
    [0, 0, 1],
    0.05,
    twoSided,
  );
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A forward mesh as the GPU-driven renderer takes one: clustered, with its material's index. */
function drivenMesh(data: MeshData, material: number): GpuDrivenMesh {
  return {
    ...clustered({
      positions: data.positions,
      normals: data.normals,
      colours: data.colors,
      indices: data.indices,
      material,
    }),
    emissive: data.emissive,
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const variant = (asked.get('variant') ?? 'sun-clear') as Variant;
  /* A rectangle stands where the lamp would, and shares every lamp rule of this page but its kind. */
  const area = variant.startsWith('area');
  const lamp = variant.startsWith('lamp') || area;
  /* A lamp's maps bake a couple of faces a frame and then ramp in over a quarter second. */
  const frames = Number(asked.get('frames') ?? (lamp ? '40' : '4'));
  const glassShadows = (asked.get('glassshadows') ?? 'full') as GlassShadows;
  const frost = variant.endsWith('frosted') ? 0.8 : 0;
  const PLATE_AT = plateAt(lamp);
  /* `?lampcolour=0` leaves only the ambient term, which is what a patch's light is measured over. */
  const lampColour = Number(asked.get('lampcolour') ?? '1');

  /* The GPU-driven variants draw the same world through the second pipeline, and only that. */
  const gpu = variant.startsWith('gpu');
  const created = await createRenderer(
    canvas,
    { ...askedQuality(), glassShadows },
    gpu ? { ...DEV_RENDERER, pipeline: 'gpu-driven' } : DEV_RENDERER,
  );
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Published so a readback script can ask whether the lamp's array grew its glass. Dev pages
     only; nothing in the engine exposes a renderer this way and nothing should. */
  (globalThis as unknown as { __renderer?: unknown }).__renderer = renderer;

  const floorData = quad(
    [
      [-8, 0, -8],
      [-8, 0, 6],
      [8, 0, 6],
      [8, 0, -8],
    ],
    [0, 1, 0],
    0.8,
  );
  const floor = renderer.createMesh(floorData);
  const panes = PANES.map((pane) =>
    renderer.createMesh(paneMesh(pane.x, PANE_BOTTOM, PANE_TOP, true)),
  );
  const paneShapes = PANES.map((pane) =>
    renderer.createMesh(paneMesh(pane.x, PANE_BOTTOM, PANE_TOP, false)),
  );
  const spare = renderer.createMesh(paneMesh(SPARE.x, SPARE.bottom, SPARE.top, true));
  const spareShape = renderer.createMesh(paneMesh(SPARE.x, SPARE.bottom, SPARE.top, false));
  const plateData = quad(
    [
      [PLATE_AT[0] - PLATE_HALF, PLATE_AT[1], PLATE_AT[2] - PLATE_HALF],
      [PLATE_AT[0] - PLATE_HALF, PLATE_AT[1], PLATE_AT[2] + PLATE_HALF],
      [PLATE_AT[0] + PLATE_HALF, PLATE_AT[1], PLATE_AT[2] + PLATE_HALF],
      [PLATE_AT[0] + PLATE_HALF, PLATE_AT[1], PLATE_AT[2] - PLATE_HALF],
    ],
    [0, 1, 0],
    0.8,
    true,
  );
  const plate = renderer.createMesh(plateData);
  const glassOf = (tint: Vec3): GlassOptions => ({ transmission: 0.9, frost, tint });
  const paneGlass = PANES.map((pane) => glassOf(pane.tint));
  const spareGlass = glassOf(SPARE.tint);
  const paneCasters: SceneCasterMaterial[] = paneGlass.map((glass) => ({
    glass,
    doubleSided: true,
  }));
  const spareCaster: SceneCasterMaterial = { glass: spareGlass, doubleSided: true };

  /* The moving variant slides every pane along x; its casters go to the movers' layer. */
  const moving = variant.endsWith('moving');
  const model = new Float32Array(IDENTITY);
  let slide = 0;
  const staticCasters = (sink: ShadowCasterSink): void => {
    sink.mesh(plate, IDENTITY);
    sink.mesh(spareShape, IDENTITY, spareCaster);
    if (!moving)
      for (let i = 0; i < paneShapes.length; i++)
        sink.mesh(paneShapes[i] as never, IDENTITY, paneCasters[i]);
  };
  const movingCasters = (sink: ShadowCasterSink): void => {
    if (moving)
      for (let i = 0; i < paneShapes.length; i++)
        sink.mesh(paneShapes[i] as never, model, paneCasters[i]);
  };

  const env = createEnvironment();
  env.directionalDir = TO_SUN;
  env.directionalColor = lamp ? [0, 0, 0] : [1, 1, 1];
  env.ambient = [0.12, 0.12, 0.12];
  env.ambientGround = [0.12, 0.12, 0.12];
  env.shadowStrength = 1;

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.3;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 6;
  camera.position[2] = -7.5;
  camera.lookAt(0.6, 0, -1.2);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  /*
   * The same floor, plate and panes as GPU-driven meshes: the floor and plate opaque, each pane its
   * own glass material. One winding a pane — the blended raster culls nothing — so a light's tint
   * meets each pane once.
   */
  const driven = gpu
    ? (() => {
        const shapes = [
          drivenMesh(floorData, 0),
          drivenMesh(plateData, 0),
          ...PANES.map((pane, i) =>
            drivenMesh(paneMesh(pane.x, PANE_BOTTOM, PANE_TOP, false), i + 1),
          ),
          drivenMesh(paneMesh(SPARE.x, SPARE.bottom, SPARE.top, false), PANES.length + 1),
        ];
        const transforms = new Float32Array(shapes.length * 16);
        for (let m = 0; m < shapes.length; m++) transforms.set(IDENTITY, m * 16);
        const materials: GpuDrivenMaterial[] = [
          { tint: [1, 1, 1], emissive: 0 },
          /* The panes' own dark colour is their vertices', as the forward path draws them. */
          ...paneGlass.map((glass) => ({ tint: [1, 1, 1] as Vec3, emissive: 0, glass })),
          { tint: [1, 1, 1] as Vec3, emissive: 0, glass: spareGlass },
        ];
        /* The quality option, which a contributed pass is not handed and so takes here. */
        const pass = new GpuDrivenPass(streamingScene(shapes, transforms), materials, {
          glass: glassShadows,
        });
        return { pass, handle: renderer.registerPass(pass) };
      })()
    : null;
  /* And the second pipeline's pass, for the same readback. Dev pages only. */
  (globalThis as unknown as { __driven?: unknown }).__driven = driven?.pass;
  const drivenView: GpuDrivenView = {
    viewProj: camera.viewProjection,
    eye: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0],
    lightDir: TO_SUN,
    lightColour: [1, 1, 1],
    ambient: [0.12, 0.12, 0.12],
    ambientGround: [0.12, 0.12, 0.12],
    lodThreshold: 1.5,
    fovY: (camera.fovYDeg * Math.PI) / 180,
    shadowStrength: 1,
  };

  const lightMatrix = new Float32Array(16);
  env.shadowDepthSpan = computeLightMatrix(
    TO_SUN,
    0.6,
    1,
    -0.5,
    7,
    renderer.shadowMapSize,
    lightMatrix,
  );
  env.lightViewProj = lightMatrix;

  const drawGlass = (): void => {
    for (let i = 0; i < panes.length; i++) {
      renderer.drawTranslucentMesh(panes[i] as never, moving ? model : IDENTITY, 1, {
        depthWrite: false,
        glass: paneGlass[i],
      });
    }
    renderer.drawTranslucentMesh(spare, IDENTITY, 1, { depthWrite: false, glass: spareGlass });
  };

  /* The lamp, as a game hands one over: selected, shaded, and its maps kept by the renderer. */
  const lamps: PointLightSource[] =
    lamp && !area
      ? [
          {
            x: LAMP[0],
            y: LAMP[1],
            z: LAMP[2],
            r: lampColour,
            g: lampColour,
            b: lampColour,
            radius: 14,
            flicker: 0,
            shadowNear: 0.1,
            sourceRadius: 0.02,
            castsShadow: true,
          },
        ]
      : [];
  /* Facing the panes and the floor: right along +x, and up chosen so right × up points down the
     lamp's diagonal toward the patches. */
  const rectangles: AreaLightSource[] = area
    ? [
        {
          x: LAMP[0],
          y: LAMP[1],
          z: LAMP[2],
          /* A quarter metre a side lights a floor seven metres off about as the lamp does. */
          r: 200 * lampColour,
          g: 200 * lampColour,
          b: 200 * lampColour,
          rightX: 1,
          rightY: 0,
          rightZ: 0,
          upX: 0,
          upY: -Math.SQRT1_2,
          upZ: Math.SQRT1_2,
          halfWidth: 0.25,
          halfHeight: 0.25,
          castsShadow: true,
          shadowRange: 14,
          shadowNear: 0.1,
        },
      ]
    : [];
  const areaBuffer = createAreaLightBuffer();
  selectAreaLights(rectangles, areaBuffer);
  env.areaLights = area ? areaBuffer : null;
  const lightBuffer = createPointLightBuffer();
  if (lamp) renderer.prepareStaticPointShadows(lamps, rectangles);

  for (let frame = 0; frame < frames; frame++) {
    slide = moving ? 0.6 * Math.sin(frame * 0.9) : 0;
    model[12] = slide;
    if (lamp) {
      const middle = (PANE_BOTTOM + PANE_TOP) / 2;
      /* The live map centres on the sliding panes, which is what makes it theirs. */
      selectPointLights(lamps, slide, middle, 0, lightBuffer, 0, 100, slide, middle, 0);
      env.lightCount = lightBuffer.count;
      env.lightPositions = lightBuffer.positions;
      env.lightColors = lightBuffer.colors;
      env.lightRadii = lightBuffer.radii;
      env.lightSourceRadii = lightBuffer.sourceRadii;
      env.lightWeights = lightBuffer.weights;
      env.lightDirections = lightBuffer.directions;
      env.lightConeCos = lightBuffer.coneCos;
      env.lightIesProfiles = lightBuffer.iesProfiles;
      env.activeLightWorldIndices = lightBuffer.sourceIndex;
      renderer.updatePointShadows(
        lamps,
        lightBuffer.sourceIndex,
        lightBuffer.count,
        slide,
        middle,
        0,
        DT,
        staticCasters,
        movingCasters,
        lightBuffer.shadowIndex,
        lightBuffer.shadowCount,
        rectangles,
      );
    } else {
      renderer.beginShadowPass(lightMatrix, 'static');
      renderer.drawShadowCasters(staticCasters);
      renderer.endShadowPass();
      renderer.beginShadowPass(lightMatrix, 'dynamic');
      renderer.drawShadowCasters(movingCasters);
      renderer.endShadowPass();
    }
    if (driven !== null) {
      driven.pass.resize(renderer.sceneWidth, renderer.sceneHeight);
      driven.pass.setView(drivenView);
    }
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    if (driven !== null) {
      renderer.drawPass(driven.handle);
    } else {
      renderer.drawMesh(floor, IDENTITY);
      renderer.drawMesh(plate, IDENTITY);
      drawGlass();
    }
    renderer.endFrame();
    /* The second pipeline settles its pipelines and uploads between frames, as a game gives it. */
    if (driven !== null && frame < frames - 1)
      await new Promise((next) => requestAnimationFrame(() => next(undefined)));
  }

  /* Where a world point lands on the canvas, in canvas pixels. */
  const project = (p: Vec3): [number, number] => {
    const v = vec4.transformMat4(vec4.create(), [p[0], p[1], p[2], 1], camera.viewProjection);
    return [
      ((v[0] / v[3]) * 0.5 + 0.5) * canvas.width,
      (1 - ((v[1] / v[3]) * 0.5 + 0.5)) * canvas.height,
    ];
  };
  /* Where the light's ray through a pane's centre meets the floor. */
  const patchCentre = (x: number, y: number): Vec3 => {
    if (!lamp) return [x + slide, 0, -y];
    const t = LAMP[1] / (LAMP[1] - y);
    return [LAMP[0] + t * (x + slide - LAMP[0]), 0, LAMP[2] + t * (0 - LAMP[2])];
  };

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const ctx = mirror.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('glassShadow: no 2d context to read the frame with');
  ctx.drawImage(canvas, 0, 0);
  const box = (centre: Vec3, half: number): { r: number; g: number; b: number; lum: number } => {
    const [cx, cy] = project(centre);
    const x0 = Math.max(0, Math.round(cx - half));
    const y0 = Math.max(0, Math.round(cy - half));
    const w = Math.min(mirror.width - x0, Math.round(half * 2));
    const h = Math.min(mirror.height - y0, Math.round(half * 2));
    const data = ctx.getImageData(x0, y0, Math.max(1, w), Math.max(1, h)).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i] ?? 0;
      g += data[i + 1] ?? 0;
      b += data[i + 2] ?? 0;
    }
    return { r: r / n, g: g / n, b: b / n, lum: (r + g + b) / 3 };
  };
  const middle = (PANE_BOTTOM + PANE_TOP) / 2;
  const patches = PANES.map((pane) => box(patchCentre(pane.x, middle), 12));
  /* The panes themselves, seen from behind: what each shows of the floor through it. */
  const paneShots = PANES.map((pane) => box([pane.x + slide, middle, 0], 8));
  const lit = box([-3.4, 0, -1.75], 12);
  const control = box(PLATE_AT, 4);
  const all = box([slide, 0, -1.75], 150);
  const published = globalThis as unknown as Record<string, unknown>;
  published.__patches = patches;
  published.__panes = paneShots;
  published.__lit = lit;
  published.__control = control;
  published.__sum = all.lum * 300 * 300;
  published.__measured = true;
  stats.textContent = `${created.backend} · ${variant} · glass shadows ${glassShadows} · frost ${frost}`;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
