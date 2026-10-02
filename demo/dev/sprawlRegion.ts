/**
 * A block of the night city, as the bake wrote it: nine regions of painted copies of a kit,
 * expanded where they are needed, wearing the texture arrays the plan sized.
 *
 *     /sprawlRegion.html                   from above, the default backend
 *     /sprawlRegion.html?backend=webgl2    the other one
 *     /sprawlRegion.html?view=street       at eye height in the middle of the block
 *     /sprawlRegion.html?view=top          straight down on the whole block
 *     /sprawlRegion.html?eye=x,y,z&look=x,y,z   anywhere, looking anywhere
 *     /sprawlRegion.html?hide=cutout,batches    classes switched off by name, to find a shape's
 *                                                draw: opaque, cutout, blend, additive, sway, batches
 *     /sprawlRegion.html?day=1             by day, where the pictures and wear show
 *     /sprawlRegion.html?additive=0        glows blended over rather than added: the control
 *     /sprawlRegion.html?level=1           the coarse level: buildings as boxes wearing their
 *                                          facades, and what is as broad as its error
 *     /sprawlRegion.html?collision=1       each region's collision laid over it in cyan
 *     /sprawlRegion.html?occluders=1       and its occluder boxes in magenta
 *
 * Needs `npm run sprawl:bake -- --region x,z` first, which writes `derived/region.drft` and
 * `region.json` into the data folder; without them the page says so. Every region's finest level
 * is paged in and drawn, each assembly with its class's array — opaque, leaves cut out, then
 * glows added and panes blended at the class's opacity. `?additive=0` blends the glows over
 * instead: the control, where a lamp's nearly black light cone paints a black cone.
 *
 * **What a failure looks like**: boxes in the right places painted white or black (the layer, the
 * array or the colour space); facades whose windows are the wall's colour (the glass mask); a
 * texture stretched along a wall rather than repeating (the copy's stretch); a region missing, or
 * drawn at the origin (paging, or the kit drawn as parts); the two backends differing.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { RendererApi } from '../../packages/core/src/index';
import { DrftLoader } from '../../packages/assets/src/index';
import type { LoadedRegion } from '../../packages/assets/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';
import { CityArrays } from '../sprawl/arrays';
import type { MaterialClass, PlanClass } from '../sprawl/arrays';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const DATA = './sprawl/derived/';
const FRAMES = 30;

interface RegionPlan {
  readonly classes: PlanClass[];
  readonly regions: {
    readonly id: number;
    /** Each level's classes, finest first, in the order the container lists its meshes. */
    readonly levels: MaterialClass[][];
    readonly groups: MaterialClass[];
  }[];
}

async function picture(url: string): Promise<ImageBitmap | null> {
  const response = await fetch(DATA + url);
  if (!response.ok) return null;
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const query = new URLSearchParams(location.search);
  const day = query.get('day') === '1';
  const street = query.get('view') === 'street';
  const top = query.get('view') === 'top';
  const additive = query.get('additive') !== '0';
  const shownLevel = query.get('level') === '1' ? 1 : 0;
  /* Classes switched off by name, to find which draw a shape belongs to before explaining it. */
  const hidden = new Set((query.get('hide') ?? '').split(',').filter((x) => x !== ''));
  const shown = (cls: MaterialClass | undefined, batch: boolean): boolean =>
    !(batch && hidden.has('batches')) &&
    !(cls !== undefined && (hidden.has(cls.blend) || (cls.sway === true && hidden.has('sway'))));

  const [planResponse, drftResponse] = await Promise.all([
    fetch(`${DATA}region.json`),
    fetch(`${DATA}region.drft`),
  ]);
  if (!planResponse.ok || !drftResponse.ok) {
    throw new Error(
      'No baked region here. Run `npm run sprawl:bake -- --region x,z`, which writes ' +
        'derived/region.drft and region.json into the data folder beside the source.',
    );
  }
  const plan = (await planResponse.json()) as RegionPlan;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* The arrays the plan sizes, every picture fetched by its path before the first frame. */
  const arrays = new CityArrays(renderer, plan.classes);
  await Promise.all(
    [...arrays.names()].map(async (name) => arrays.take(name, await picture(name))),
  );

  const loader = new DrftLoader(renderer, { revealSec: 0, uploadMsPerFrame: 1000 });
  await loader.consume(drftResponse, { fit: 'none' });
  const classes = new Map(plan.regions.map((r) => [r.id, r]));

  const env = createEnvironment();
  env.directionalDir = day ? [0.4, 0.8, 0.3] : [0.25, 0.9, 0.2];
  env.directionalColor = day ? [1.1, 1.05, 0.95] : [0.04, 0.05, 0.08];
  env.ambient = day ? [0.35, 0.37, 0.42] : [0.025, 0.03, 0.045];
  env.nightFactor = day ? 0 : 1;
  env.litWindows = day ? 0 : 0.6;
  env.lateWindows = 0.1;

  /* The middle of the block, from the regions the file holds. */
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const region of loader.regions.values()) {
    lo = [
      Math.min(lo[0] as number, region.bounds[0] as number),
      Math.min(lo[1] as number, region.bounds[2] as number),
    ];
    hi = [
      Math.max(hi[0] as number, region.bounds[3] as number),
      Math.max(hi[1] as number, region.bounds[5] as number),
    ];
  }
  const cx = ((lo[0] as number) + (hi[0] as number)) / 2;
  const cz = ((lo[1] as number) + (hi[1] as number)) / 2;
  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.3;
  camera.far = 3000;
  const eye = query.get('eye')?.split(',').map(Number);
  const look = query.get('look')?.split(',').map(Number);
  if (eye?.length === 3 && look?.length === 3) {
    camera.position[0] = eye[0] as number;
    camera.position[1] = eye[1] as number;
    camera.position[2] = eye[2] as number;
    camera.lookAt(look[0] as number, look[1] as number, look[2] as number);
  } else if (top) {
    camera.position[0] = cx;
    camera.position[1] = 520;
    camera.position[2] = cz - 1;
    camera.lookAt(cx, 0, cz);
  } else if (street) {
    camera.position[0] = cx - 20;
    camera.position[1] = 1.7;
    camera.position[2] = cz - 30;
    camera.lookAt(cx + 20, 12, cz + 40);
  } else {
    camera.position[0] = cx - 220;
    camera.position[1] = 190;
    camera.position[2] = cz - 220;
    camera.lookAt(cx, 0, cz);
  }

  const setClass = (cls: MaterialClass | undefined): void => {
    renderer.setMaterial(cls === undefined ? null : arrays.material(cls));
  };

  /* What the page lays over the city on request: each region's collision, and its occluders. */
  const overlayMeshes = new Map<string, ReturnType<RendererApi['createMesh']> | null>();
  const overlays: [
    boolean,
    string,
    (region: LoadedRegion) => ReturnType<typeof flatMesh> | null,
  ][] = [
    [
      query.get('collision') === '1',
      'collision',
      (region) =>
        region.collision === null
          ? null
          : flatMesh(region.collision.positions, region.collision.indices, [0.1, 0.9, 1]),
    ],
    [
      query.get('occluders') === '1',
      'occluders',
      (region) =>
        region.occluders.length === 0 ? null : boxesMesh(region.occluders, [1, 0.2, 0.9]),
    ],
  ];

  let frame = 0;
  let paged = false;
  const draw = (): void => {
    loader.update(1 / 60);
    const admitted =
      loader.progress.phase === 'ready' || loader.regions.size === plan.regions.length;
    if (admitted && !paged) {
      for (const region of loader.regions.values()) loader.pageRegion(region.id, shownLevel, true);
      paged = true;
    }
    renderer.resize();
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
    renderer.beginFrame(day ? [0.55, 0.65, 0.8] : [0.012, 0.016, 0.028]);
    renderer.bindMeshPass(camera, env);
    let resident = 0;
    let copies = 0;
    /* Glows and panes after everything opaque: an assembly, or a batch of a prototype. */
    const later: { part: (typeof loader.parts)[number]; cls: MaterialClass }[] = [];
    const glows = (cls: MaterialClass | undefined): cls is MaterialClass =>
      cls !== undefined && (cls.blend === 'blend' || cls.blend === 'additive');
    for (const region of loader.regions.values()) {
      const plan = classes.get(region.id);
      const level = region.levels[shownLevel];
      if (level?.resident === true) resident++;
      level?.parts.forEach((part, i) => {
        const cls = plan?.levels[shownLevel]?.[i];
        if (!shown(cls, false)) return;
        if (glows(cls)) {
          later.push({ part, cls });
          return;
        }
        setClass(cls);
        renderer.drawMesh(part.mesh, IDENTITY);
        copies++;
      });
      region.batches.forEach((part, i) => {
        /* Furniture is the finest level's alone. */
        if (part.instances === null || shownLevel > 0) return;
        /* Batches are built as their prototypes arrive: the group a batch is says its class. */
        const cls = plan?.groups[region.batchGroups[i] ?? -1];
        if (!shown(cls, true)) return;
        if (glows(cls)) {
          later.push({ part, cls });
          return;
        }
        setClass(cls);
        renderer.drawInstanced(part.instances.batch, part.instances.data);
      });
    }
    for (const { part, cls } of later) {
      setClass(cls);
      /* A glow adds its light; `?additive=0` is the control, blending it over as a pane would. */
      const adds = cls.blend === 'additive' && additive;
      const opacity = adds ? 1 : cls.blend === 'blend' ? cls.alpha : 0.6;
      const options = { additive: adds, depthWrite: false };
      if (part.instances !== null) {
        renderer.drawTranslucentInstanced(
          part.instances.batch,
          part.instances.data,
          opacity,
          options,
        );
      } else {
        renderer.drawTranslucentMesh(part.mesh, IDENTITY, opacity, options);
      }
    }
    renderer.setMaterial(null);
    for (const region of loader.regions.values()) {
      for (const [on, key, make] of overlays) {
        if (!on) continue;
        let mesh = overlayMeshes.get(`${key}|${region.id}`);
        if (mesh === undefined) {
          const data = make(region);
          mesh = data === null ? null : renderer.createMesh(data);
          overlayMeshes.set(`${key}|${region.id}`, mesh);
        }
        if (mesh !== null)
          renderer.drawTranslucentMesh(mesh, IDENTITY, 0.45, { depthWrite: false });
      }
    }
    renderer.endFrame();
    stats.textContent =
      `${created.backend} · ${day ? 'day' : 'night'} · ${street ? 'street' : 'above'} · level ${shownLevel} · ` +
      `${resident} of ${loader.regions.size} regions up · ${copies} opaque draws · ${later.length} blended`;
    frame += 1;
    if (frame < FRAMES || resident < loader.regions.size) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

/**
 * Triangles as a flat, faceted mesh in one colour, each its own three corners and its own normal,
 * lifted 5 cm so what collides as the city is drawn does not hide under it.
 */
function flatMesh(
  positions: Float32Array,
  indices: Uint32Array,
  colour: readonly [number, number, number],
) {
  const n = indices.length;
  const out = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let t = 0; t + 2 < n; t += 3) {
    const p = [0, 1, 2].map((v) => {
      const i = (indices[t + v] as number) * 3;
      return [positions[i] as number, positions[i + 1] as number, positions[i + 2] as number];
    }) as [number, number, number][];
    const [a, b, c] = p as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number);
    const ny = (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number);
    const nz = (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number);
    const l = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) {
      /* Lifted a little, or a slab collision shares with the city is hidden under it. */
      const [x, y, z] = p[k] as [number, number, number];
      out.set([x, y + 0.05, z], (t + k) * 3);
      normals.set([nx / l, ny / l, nz / l], (t + k) * 3);
      colors.set(colour, (t + k) * 3);
    }
  }
  return {
    positions: out,
    normals,
    colors,
    emissive: new Float32Array(n),
    indices: Uint32Array.from({ length: n }, (_, i) => i),
  };
}

/** Boxes, six floats each — min xyz then max — as one flat mesh. */
function boxesMesh(boxes: Float32Array, colour: readonly [number, number, number]) {
  const positions: number[] = [];
  const indices: number[] = [];
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  for (let b = 0; b + 5 < boxes.length; b += 6) {
    const base = positions.length / 3;
    for (let corner = 0; corner < 8; corner++) {
      positions.push(
        boxes[b + (corner & 1 ? 3 : 0)] as number,
        boxes[b + (corner & 2 ? 4 : 1)] as number,
        boxes[b + (corner & 4 ? 5 : 2)] as number,
      );
    }
    for (const [a, c, d, e] of faces as [number, number, number, number][])
      indices.push(base + a, base + c, base + d, base + a, base + d, base + e);
  }
  return flatMesh(new Float32Array(positions), new Uint32Array(indices), colour);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
