/**
 * A capture assembled into one `.drft` in the browser, opened by the loader, and walked.
 *
 * **The file is built here rather than fetched**, and that is the point of the page: nothing under
 * `demo/dev/public/` is committed, so a page that needed a captured room could not be run by
 * anybody who did not have one. The room is written analytically, marched, cleaned, voxelised into
 * a polygon mesh and segmented into proposals — five stages, in the browser, in about a second —
 * and then goes out through `captureFile` and comes back through `DrftLoader` as a thing on screen.
 * What is on screen is therefore the *file*, not the arrays the stages produced.
 *
 * **What to look for.** The room is drawn from the mesh the loader uploaded. The navigation mesh is
 * drawn as lines above the floor, so a polygon that is not where the floor is shows immediately.
 * Each proposal's bounds is a box. `?walk=1` steps a character along a path across the room, one
 * fixed step a frame, so two captures of frame N are identical — the clock is held by the harness
 * and nothing here reads it.
 *
 * ```sh
 * npm run shots -- capture one --urls=capture=/capture.html --hold=2
 * npm run shots -- capture two --urls=capture=/capture.html?walk=1 --hold=90
 * ```
 */
import { DrftLoader } from '../../packages/assets/src/index';
import {
  captureFile,
  collisionMesh,
  createVolume,
  marchVolume,
  proposeEntities,
  segmentGeometry,
  type Volume,
} from '../../packages/capture/src/index';
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';
import {
  buildContours,
  buildPolyMesh,
  buildRegions,
  NavMeshQuery,
  voxeliseWalkable,
} from '../../packages/nav/src/index';
import {
  BODY_STATIC,
  CharacterController,
  PhysicsWorld,
  meshShape,
} from '../../packages/physics/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';
import { askedHeldFrames, holdFrames, releaseHeldClock } from './heldFrame';

const BACKGROUND: Vec3 = [0.05, 0.055, 0.065];
const SPACING = 0.15;
const HALF = 2.8;
const HEIGHT = 2.6;

function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** A room with a step in one corner, as the distance to the nearest surface of an inside-out box. */
function room(): Volume {
  const side = Math.round((HALF * 2) / SPACING) + 1;
  const tall = Math.round((HEIGHT + 0.6) / SPACING) + 1;
  const volume = createVolume([side, tall, side], [-HALF, -0.6, -HALF], SPACING);
  for (let k = 0; k < side; k += 1) {
    for (let j = 0; j < tall; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = -HALF + i * SPACING;
        const y = -0.6 + j * SPACING;
        const z = -HALF + k * SPACING;
        const toWall = Math.min(HALF - 0.4 - Math.abs(x), HALF - 0.4 - Math.abs(z));
        const step = Math.max(
          Math.abs(x - 1.4) - 0.6,
          Math.abs(z - 1.4) - 0.6,
          Math.abs(y - 0.15) - 0.15,
        );
        const at = (k * tall + j) * side + i;
        volume.distance[at] = Math.min(toWall, y, HEIGHT - y, step);
        volume.weight[at] = 1;
      }
    }
  }
  return volume;
}

async function main(): Promise<void> {
  const surface = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (surface === null) return;
  const query = new URLSearchParams(location.search);
  /*
   * **Held before anything is built, released once the file is open.** Five stages and a device
   * request stand between the page loading and the first frame that means anything, and a clock
   * that ran through them would photograph two backends at different points of the walk.
   */
  const held = askedHeldFrames();
  if (held !== undefined) holdFrames(held);

  const started = Date.now();
  const drawn = marchVolume(room());
  const collision = collisionMesh(drawn);
  const field = voxeliseWalkable(
    { positions: collision.positions, indices: collision.indices },
    { cellSize: 0.15, cellHeight: 0.1, maxSlope: 45, agentHeight: 1.2, agentRadius: 0.2 },
  );
  const navigation = buildPolyMesh(
    buildContours(field, buildRegions(field, { minRegionSpans: 4, maxStep: 1 }), 0.5),
    6,
    field,
  );
  const proposals = proposeEntities(segmentGeometry(drawn, { creaseDegrees: 30 }));
  const bytes = new Uint8Array(captureFile({ mesh: drawn, navigation, proposals }));
  const built = Date.now() - started;

  const created = await createRenderer(
    surface,
    { maxDrawingBufferPixels: 0, ...askedQuality() },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const canvas = surface;

  /*
   * **Through the loader's own fetch seam**, rather than by handing the renderer the meshes this
   * page already has in hand. Those arrays are what the stages produced; what a player opens is
   * the file, and the difference between the two is the whole subject of this page.
   */
  const loader = new DrftLoader(renderer, {
    fetchImpl: () => Promise.resolve(new Response(bytes)),
  });
  await loader.load('capture.drft', { footprint: HALF * 2, height: HEIGHT, baseY: 0 });

  /*
   * The navigation mesh as a translucent sheet a little above the floor, and each proposal's
   * bounds as a wire box. **Both are drawn from the numbers the file carries**, so a polygon that
   * is not where the floor is, or a bound that is not around the thing it claims, shows at once.
   */
  const overlay = new MeshBuilder();
  const lift = 0.05;
  const metres = (vertex: number): [number, number] => [
    navigation.originX + (navigation.vertices[vertex * 2] as number) * navigation.cellSize,
    navigation.originZ + (navigation.vertices[vertex * 2 + 1] as number) * navigation.cellSize,
  ];
  for (let poly = 0; poly < navigation.polyCount; poly += 1) {
    const slots = navigation.maxVertsPerPoly;
    const corners: [number, number][] = [];
    for (let slot = 0; slot < slots; slot += 1) {
      const vertex = navigation.polys[poly * slots + slot] as number;
      if (vertex >= 0) corners.push(metres(vertex));
    }
    /* Fanned from the first corner, which is what makes a convex polygon a surface. */
    for (let at = 1; at + 1 < corners.length; at += 1) {
      const [ax, az] = corners[0] as [number, number];
      const [bx, bz] = corners[at] as [number, number];
      const [cx, cz] = corners[at + 1] as [number, number];
      overlay.addGroundQuad(
        [ax, lift, az],
        [bx, lift, bz],
        [cx, lift, cz],
        [cx, lift, cz],
        [0.15, 0.75, 0.95],
        0.25,
      );
    }
  }
  /** One thin bar along an edge of a box, so a proposal reads as an outline rather than a solid. */
  function bar(centre: Vec3, half: Vec3, colour: Vec3): void {
    overlay.addBox(centre, half, colour, 0.5);
  }
  for (const proposal of proposals) {
    if (proposal.walkable) continue;
    const b = proposal.bounds;
    const mid: Vec3 = [
      ((b[0] as number) + (b[3] as number)) / 2,
      ((b[1] as number) + (b[4] as number)) / 2,
      ((b[2] as number) + (b[5] as number)) / 2,
    ];
    const half: Vec3 = [
      Math.max(0.01, ((b[3] as number) - (b[0] as number)) / 2),
      Math.max(0.01, ((b[4] as number) - (b[1] as number)) / 2),
      Math.max(0.01, ((b[5] as number) - (b[2] as number)) / 2),
    ];
    const thin = 0.012;
    const colour: Vec3 = proposal.label === null ? [1, 0.55, 0.15] : [0.4, 1, 0.5];
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        bar([mid[0], mid[1] + sy * half[1], mid[2] + sz * half[2]], [half[0], thin, thin], colour);
      }
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        bar([mid[0] + sx * half[0], mid[1], mid[2] + sz * half[2]], [thin, half[1], thin], colour);
      }
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        bar([mid[0] + sx * half[0], mid[1] + sy * half[1], mid[2]], [thin, thin, half[2]], colour);
      }
    }
  }
  const overlayMesh = renderer.createMesh(overlay.build());

  /* A character, on the collision mesh the file's own geometry was cleaned into. */
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: meshShape(collision.positions, collision.indices) });
  const walker = new CharacterController();
  walker.teleport(-1.6, 1.2, -1.6);
  const walkerMesh = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.2, 0.8, 0.2], [1, 0.85, 0.4], 0.35).build(),
  );

  /*
   * A path along the near wall rather than across the diagonal: the step in the far corner is
   * 0.3 m and `maxStep` is one 0.1 m cell, so the floor on top of it is a region of its own with
   * nothing linking it — which is correct, and is why a route through it comes back empty.
   */
  const path = new Float64Array(256);
  const pathPoints = new NavMeshQuery(navigation).findPath(-1.6, -1.6, 1.8, -1.4, 0.6, path);
  let leg = 1;

  /*
   * A sun across the room and a little sky, so the walls read as walls. **The overlay is emissive
   * and the room is not**, which is what keeps the two apart in a photograph: the cyan sheet and
   * the orange outlines are drawn on top of a lit surface rather than replacing it.
   */
  const env = createEnvironment({
    directionalDir: [0.45, 0.72, 0.52],
    directionalColor: [1.15, 1.12, 1.05],
    ambient: [0.22, 0.24, 0.3],
    ambientGround: [0.1, 0.1, 0.11],
    fogColor: BACKGROUND,
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.05;
  camera.far = 60;
  const identity = at(0, 0, 0);
  const walking = query.get('walk') === '1';

  let frames = 0;
  function frame(): void {
    loader.update(1 / 60);
    if (walking && pathPoints > 1) {
      /* One fixed step a frame: a held clock freezes time, so the motion is counted, not timed. */
      const goalX = path[Math.min(leg, pathPoints - 1) * 2] as number;
      const goalZ = path[Math.min(leg, pathPoints - 1) * 2 + 1] as number;
      const dx = goalX - walker.x;
      const dz = goalZ - walker.z;
      const away = Math.hypot(dx, dz);
      if (away < 0.25 && leg < pathPoints - 1) leg += 1;
      walker.move(world, 1 / 60, {
        moveX: away > 0 ? dx / away : 0,
        moveZ: away > 0 ? dz / away : 0,
        jump: false,
      });
    } else {
      walker.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    }

    /* A fixed camera that frames the whole room, so two runs photograph the same thing. */
    const spin = Number(query.get('yaw') ?? '0.9');
    camera.position[0] = Math.sin(spin) * 7.5;
    camera.position[1] = 5.2;
    camera.position[2] = Math.cos(spin) * 7.5;
    camera.lookAt(0, 0.6, 0);
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    for (const part of loader.parts) renderer.drawMesh(part.mesh, identity);
    renderer.drawMesh(overlayMesh, identity);
    renderer.drawMesh(walkerMesh, at(walker.x, walker.y + 0.8, walker.z));
    renderer.endFrame();
    frames += 1;
  }

  for (let i = 0; i < 400 && loader.progress.phase !== 'ready'; i += 1) {
    frame();
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  releaseHeldClock();

  if (stats !== null) {
    /* `<n> draws` is what the capture harness waits for before it photographs a held frame. */
    stats.textContent =
      `${renderer.backend} · ${canvas.width}×${canvas.height} · ${loader.parts.length + 2} draws · ` +
      `${(bytes.byteLength / 1024).toFixed(1)} KB file · ${drawn.indices.length / 3} triangles · ` +
      `${navigation.polyCount} nav polys · ${proposals.length} proposals · ` +
      `${pathPoints} path points`;
    /*
     * **The build time goes to the console and not into the frame.** This readout is photographed,
     * and a number that changes between two runs of one build is a diff of that many pixels every
     * time — measured at 113 here before it was moved, which is the whole floor this page had.
     */
    console.log(`capture built in ${built} ms`);
  }

  function loop(): void {
    frame();
    requestAnimationFrame(loop);
  }
  loop();
  void frames;
}

void main();
