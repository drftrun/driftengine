/**
 * A scene tree drawn as rows, an inspector that moves what it edits, and a world that goes back.
 *
 * Four unrelated claims, so this draws one subject per load and publishes what the canvas holds:
 *
 *     /editor.html?variant=tree        the hierarchy, every branch open
 *     /editor.html?variant=collapsed   one branch closed, which must draw fewer rows
 *     /editor.html?variant=select      a pointer on a row, which selects it and moves the gizmo
 *     /editor.html?variant=noselect    the same pointer on the panel's background, the control
 *     /editor.html?variant=edit        an inspector write, which must move the subject's pixels
 *     /editor.html?variant=noedit      the same frame without the write, the control
 *     /editor.html?variant=play        play, and a change made while playing
 *     /editor.html?variant=stopped     the same change, then stop, which must undo it
 *
 * **The panel's colours are set here and not by the builder**, which is the builder's whole point:
 * `buildTreePanel` produces nodes and `tree.rowOf(tree.selected)` says which one is selected, and
 * what a selected row *looks* like is a decision about a consumer's palette. So this page is also
 * the worked example of that seam.
 *
 * **The subject is three cubes at known places**, because "an edit moved something" is only
 * measurable against something whose position is known. A flat backdrop would let every assertion
 * pass on a build that writes nothing.
 *
 * Nothing here reads a real clock, so two loads of one URL draw the same frame.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `gizmo.ts` and `ui.ts`.
 */

import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import { SceneNode } from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { World, defineComponent } from '../../packages/entities/src/index';
import type { Entity } from '../../packages/entities/src/index';
import {
  EditorHost,
  TREE_ROW_PREFIX,
  buildInspectorPanel,
  buildTreePanel,
  rowIndexOf,
} from '../../packages/editor/src/index';
import {
  addUiChild,
  createAffine2D,
  createSpritePass,
  createUiInput,
  createUiNode,
  drawUiTree,
  layoutUiTree,
  routeUiPointer,
  screenToNdc,
} from '../../packages/ui2d/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Dark, and nothing in the scene is near it, so a subject pixel is unambiguous. */
const CLEAR: Vec3 = [0.02, 0.03, 0.08];

/** An ordinary row, a selected row, and the panel behind them. Nothing in the package names these. */
const ROW: Vec3 = [0.22, 0.24, 0.3];
const SELECTED: Vec3 = [0.95, 0.62, 0.15];
const PANEL: Vec3 = [0.08, 0.09, 0.12];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const Health = defineComponent('Health', { current: 'f32' });
const TYPES = [Health];

type Variant =
  'tree' | 'collapsed' | 'select' | 'noselect' | 'edit' | 'noedit' | 'play' | 'stopped';

/** A cube, emissive, so its brightness is a constant of the scene rather than of the lighting. */
function cube(size: number, colour: Vec3): MeshData {
  const h = size / 2;
  const corners = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const faces = [
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [4, 0, 3, 7],
    [1, 5, 6, 2],
    [3, 2, 6, 7],
    [4, 5, 1, 0],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const at of face) {
      const corner = corners[at] as number[];
      positions.push(corner[0] as number, corner[1] as number, corner[2] as number);
      normals.push(0, 0, 1);
      colors.push(colour[0], colour[1], colour[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    emissive: new Float32Array(count).fill(1),
    indices: new Uint32Array(indices),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const variant = (asked.get('variant') ?? 'tree') as Variant;
  const frames = Number(asked.get('frames') ?? '3');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Or the drawing buffer stays at the canvas element's default 300x150 and every measurement
     comes back zero, which has now cost a debugging cycle on four rows running. */
  renderer.resize();

  const cssWidth = canvas.width;
  const cssHeight = canvas.height;

  /* Three cubes: a root, one child, and one grandchild, at known places. */
  const root = new SceneNode();
  const child = new SceneNode();
  const grandchild = new SceneNode();
  root.attachChild(child);
  child.attachChild(grandchild);
  root.setPosition(-1.6, 0, 0);
  child.setPosition(1.6, 0, 0);
  grandchild.setPosition(1.6, 0, 0);

  const mesh = renderer.createMesh(cube(0.6, [0.35, 0.75, 0.95]));

  const world = new World();
  const entities = [world.create(), world.create()];
  entities.forEach((entity, at) => world.add(entity, Health, { current: 10 * (at + 1) }));

  const host = new EditorHost({ world, types: TYPES });
  host.tree.setName(root, 'root');
  host.tree.setName(child, 'child');
  host.tree.setName(grandchild, 'grandchild');
  if (variant === 'collapsed') host.tree.setExpanded(child, false);
  host.tree.rebuild(root);

  /* The panel: a column of rows down the left, which is where the measurement looks. */
  const ui = createUiNode({ direction: 'column', width: 'grow', height: 'grow' });
  const panel = addUiChild(
    ui,
    createUiNode({
      direction: 'column',
      width: 220,
      height: 'grow',
      padding: 8,
      gap: 4,
      background: PANEL,
      name: 'panel',
    }),
  );
  const rows = addUiChild(
    panel,
    createUiNode({ direction: 'column', width: 'grow', gap: 2, name: 'rows' }),
  );
  const fields = addUiChild(
    panel,
    createUiNode({ direction: 'column', width: 'grow', gap: 2, name: 'fields' }),
  );

  const input = createUiInput();
  const affine = createAffine2D();
  const pass = createSpritePass({ capacity: 256, slots: 1, label: 'dev.editor' });
  const passHandle = renderer.registerPass(pass);

  const env = createEnvironment();
  env.ambient = [0.3, 0.3, 0.3];
  env.ambientGround = [0.3, 0.3, 0.3];
  env.directionalColor = [0.5, 0.5, 0.5];
  env.directionalDir = [0, 0, 1];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.5;
  camera.far = 200;
  camera.position[0] = 1.6;
  camera.position[1] = 0;
  camera.position[2] = 9;
  camera.lookAt(1.6, 0, 0);
  camera.updateMatrices(cssHeight > 0 ? cssWidth / cssHeight : 1);

  /*
   * Play, and a change made while playing. `stopped` is the same run with a stop on the end, which
   * is what makes the pair a claim about restoring rather than about writing.
   */
  let livedThrough = 0;
  if (variant === 'play' || variant === 'stopped') {
    host.selectEntity(entities[1] as Entity);
    host.play();
    world.write(entities[0] as Entity, Health, 'current', 999);
    world.destroy(entities[1] as Entity);
    const spawned = world.create();
    world.add(spawned, Health, { current: 1 });
    if (variant === 'stopped') host.stop();
    livedThrough = world.store(Health).size;
  }

  /*
   * An inspector edit, and its control. The write is `position.x` on the grandchild, which moves a
   * cube whose pixels the measurement can find.
   *
   * **It is applied after a frame has drawn, and that is not a detail.** Applied during setup, no
   * world matrix has ever been computed, so the first `updateWorld` picks up a raw array write as
   * readily as a proper one and the assertion passes either way — which a mutation test found by
   * replacing `setPosition` with `node.position[axis] = value` and watching the check stay green.
   * With the matrix already built, only an invalidation makes it recompute, so this now fails for a
   * write that forgets `markMoved`.
   */
  if (variant === 'edit' || variant === 'noedit') host.select(grandchild);
  const applyEdit = (): void => {
    const at = host.inspector.fields.findIndex((field) => field.label === 'position.x');
    host.inspector.set(at, 3.4);
  };

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let rowPixels = 0;
  let selectedPixels = 0;
  let subjectRight = -1;
  let digest = '';

  /**
   * What the frame holds, counted from the canvas rather than from a screenshot — for the reason
   * `oit.ts` records, where a screenshot comparison found 120 differing pixels that turned out to
   * be the page's own caption.
   *
   * **The three subjects are separated by colour**, and each colour is chosen to be far from the
   * others: rows are grey, a selected row is orange, and the cubes are blue. A region test would
   * have to know where the panel ended, which is what the layout engine decides.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;

    let grey = 0;
    let orange = 0;
    let right = -1;
    for (let y = 0; y < mirror.height; y++) {
      for (let x = 0; x < mirror.width; x++) {
        const i = (y * mirror.width + x) * 4;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        if (r > 130 && g > 70 && g < 200 && b < 90) orange += 1;
        else if (b > 120 && b > r + 40 && g > r) {
          /* A cube. The rightmost one is the grandchild, and an edit moves it. */
          if (x > right) right = x;
        } else if (r > 40 && r < 110 && Math.abs(r - g) < 22 && b > g && b - r < 45) grey += 1;
      }
    }
    rowPixels = grey;
    selectedPixels = orange;
    subjectRight = right;

    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    host.tree.rebuild(root);
    buildTreePanel(host.tree, rows);
    buildInspectorPanel(host.inspector, fields);

    /* The palette, applied here because the package sets none: this is the seam's worked example. */
    const chosen = host.tree.selected === null ? -1 : host.tree.rowOf(host.tree.selected);
    for (let at = 0; at < rows.children.length; at++) {
      const node = rows.children[at]!;
      node.height = 18;
      node.background = new Float32Array([...(at === chosen ? SELECTED : ROW), 1]);
    }
    for (const node of fields.children) {
      node.height = 12;
      node.background = new Float32Array([...ROW, 0.55]);
    }

    layoutUiTree(ui, 0, 0, cssWidth, cssHeight);

    /* The pointer, placed by the query rather than by a mouse, so the page is reproducible. */
    if (variant === 'select' || variant === 'noselect') {
      const target = rows.children[2];
      const onRow = variant === 'select' && target !== undefined;
      const px = onRow ? target.rect.x + target.rect.w / 2 : panel.rect.x + 6;
      const py = onRow ? target.rect.y + target.rect.h / 2 : panel.rect.y + panel.rect.h - 6;
      const activated = routeUiPointer(input, ui, px, py, true);
      const at = rowIndexOf(activated, TREE_ROW_PREFIX);
      if (at >= 0) host.select(host.tree.rows[at]!.node);
      /* A press with no release activates nothing, so the release is what the second call is. */
      const released = routeUiPointer(input, ui, px, py, false);
      const then = rowIndexOf(released, TREE_ROW_PREFIX);
      if (then >= 0) host.select(host.tree.rows[then]!.node);
    }

    pass.reset();
    pass.setTransform(screenToNdc(cssWidth, cssHeight, affine));
    drawUiTree(pass.batch, ui, pass.white, null);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    for (const node of [root, child, grandchild]) {
      node.updateWorld();
      renderer.drawMesh(mesh, node.worldMatrix);
    }
    renderer.drawPass(passHandle);
    renderer.endFrame();
    measure();
  }

  let drawn = 0;
  await new Promise<void>((done) => {
    const tick = (): void => {
      /* After the first frame, so the world matrix already exists and only an invalidation moves it. */
      if (variant === 'edit' && drawn === 1) applyEdit();
      frame();
      drawn += 1;
      if (drawn >= frames) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const selectedRow = host.tree.selected === null ? -1 : host.tree.rowOf(host.tree.selected);
  stats.textContent =
    `${created.backend} · ${created.reason} · ${variant} · rows ${host.tree.rows.length} · ` +
    `grey ${rowPixels} · lit ${selectedPixels} · right ${subjectRight} · ` +
    `sel ${selectedRow} · live ${livedThrough} · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__rows'] = host.tree.rows.length;
  out['__rowPixels'] = rowPixels;
  out['__selectedPixels'] = selectedPixels;
  out['__subjectRight'] = subjectRight;
  out['__selectedRow'] = selectedRow;
  out['__fields'] = host.inspector.fields.length;
  out['__gizmoX'] = host.gizmo.position[0] ?? 0;
  out['__mode'] = host.mode;
  out['__live'] = livedThrough;
  out['__health0'] =
    world.store(Health).size > 0
      ? world.read(world.store(Health).dense[0] as Entity, Health, 'current')
      : -1;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
