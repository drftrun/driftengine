/**
 * SDF text and mesh picking, looked at on real hardware, on either backend.
 *
 * **Everything this page draws had a unit test and neither renderer had ever built a frame
 * with it.** `SdfTextLayout` and `PickableSet` are pure arithmetic and both are well covered;
 * `SdfTextRenderer`, `sdfTextPass.ts` and the two backends' `registerPickable`/`pickAt` compile
 * against `RendererApi` and have never been asked to produce a pixel. A compiling shader is not
 * a correct one — see `AGENTS.md` on the four-gate problem — and `fwidth`-based antialiasing in
 * particular is the kind of thing that is either sharp or is not, and the only way to tell the
 * two apart is to look.
 *
 * So: a line of Latin text at three sizes, so the antialiasing band can be judged rather than
 * assumed; every `anchorX`/`anchorY` combination, so a caller can tell whether `left` really
 * means left; three overlapping quads registered with `registerPickable`, so `pickAt` can be
 * checked against real occlusion; and `MONTAGEM ABU (أبو)`, which is the one result this page
 * exists to be honest about — see the block above the Arabic run below.
 *
 *     /sdf-text.html                 the default backend, which is WebGL2
 *     /sdf-text.html?backend=webgpu  the other one
 *
 * **Two fonts, because no one face on the machine this was built on covers both scripts.** Both
 * atlases are baked by `npm run sdf-font` from a system font, with only the glyphs this page
 * actually draws — see `public/fonts/README.md` for the exact command, the two licences, and
 * what a baked run can and cannot do for a script this engine has no shaper for.
 *
 * Nothing here is engine API and nothing under `src/` may import it. The barrel carries every
 * symbol this page needs, `parseSdfFont` and `SdfTextStyle` included.
 */

import {
  Camera,
  DEFAULT_SDF_TEXT_STYLE,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  parseSdfFont,
} from '../../packages/core/src/index';
import type {
  MeshData,
  MeshHandle,
  PickHit,
  RendererApi,
  SdfFont,
  SdfTextHandle,
  SdfTextStyle,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];

/** A translation: every piece of geometry and every label on this page sits at a fixed pose. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * A run's width in world units, without laying it out.
 *
 * Chaining three runs of two different fonts into one visual line — the Latin prefix, the
 * Arabic middle, the Latin suffix below — needs to know where one ends and the next begins,
 * and `SdfTextHandle` is opaque on purpose (see `MeshHandle`'s comment: nothing to read on it).
 * `SdfFont` is not opaque, though, and `advance` plus `kerning` is exactly the arithmetic
 * `SdfTextLayout.set()` does to its own pen position — this mirrors that loop rather than
 * reimplementing layout, because summing a run's advances is the one part of it a caller
 * already has the pieces for.
 */
function measureWidth(font: SdfFont, text: string, size: number, letterSpacing = 0): number {
  const scale = size / font.unitsPerEm;
  const characters = [...text];
  let penX = 0;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] as string;
    const glyph = font.glyph(character);
    if (glyph === null) continue;
    penX += (glyph.advance + font.kerning(character, characters[index + 1] ?? '')) * scale;
    penX += letterSpacing * size;
  }
  return penX;
}

interface LoadedFont {
  readonly font: SdfFont;
  readonly atlas: SurfaceTextureHandle;
}

/** Fetch a metrics document and an atlas image from `public/fonts/`, and upload the atlas. */
async function loadSdfFont(renderer: RendererApi, dir: string): Promise<LoadedFont> {
  const metricsResponse = await fetch(`${dir}/metrics.json`);
  if (!metricsResponse.ok) {
    throw new Error(`sdf-text: ${dir}/metrics.json responded ${String(metricsResponse.status)}`);
  }
  const font = parseSdfFont(await metricsResponse.json());

  const atlasResponse = await fetch(`${dir}/atlas.png`);
  if (!atlasResponse.ok) {
    throw new Error(`sdf-text: ${dir}/atlas.png responded ${String(atlasResponse.status)}`);
  }
  const bitmap = await createImageBitmap(await atlasResponse.blob());
  /*
   * `linear`, because a distance field is data rather than a picture — sRGB decode would
   * warp the very distances `median()` compares against 0.5. `mipmap: false` because
   * `SDF_TEXT_FRAG` samples `textureLod(uAtlas, vUv, 0.0)` unconditionally (the alpha test
   * downstream is not uniform control flow, so every sampler in this engine that feeds one
   * pins its LOD) — a chain would be built and never read from.
   */
  const atlas = renderer.createSurfaceTexture(bitmap, { mipmap: false, wrap: 'clamp' });
  return { font, atlas };
}

function makeLabel(
  renderer: RendererApi,
  font: SdfFont,
  atlas: SurfaceTextureHandle,
  content: string,
  style: SdfTextStyle,
): SdfTextHandle {
  const label = renderer.createSdfText();
  renderer.setSdfText(label, font, atlas, content, style);
  return label;
}

/** A flat quad in the XY plane, facing +Z — toward the camera below. */
function buildQuadMesh(halfWidth: number, halfHeight: number, color: Vec3): MeshData {
  return new MeshBuilder()
    .addQuad(
      [-halfWidth, -halfHeight, 0],
      [halfWidth, -halfHeight, 0],
      [halfWidth, halfHeight, 0],
      [-halfWidth, halfHeight, 0],
      color,
      0.22,
    )
    .build();
}

interface QuadDef {
  readonly name: string;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly halfW: number;
  readonly halfH: number;
  readonly color: Vec3;
}

/**
 * Three quads, two of them overlapping.
 *
 * **A and B share real screen area, and are told apart by depth alone.** A sits at `cz=0.15`,
 * nearer the camera than B's `cz=0`, so inside the overlap `pickAt` has to return the nearer
 * one — exactly what a viewer sees, since A occludes B there. C shares no area with either, and
 * is the control: a quad with nothing to be confused with.
 */
const QUAD_DEFS: readonly QuadDef[] = [
  {
    name: 'A (front, overlaps B)',
    cx: 5.0,
    cy: 4.6,
    cz: 0.15,
    halfW: 1.15,
    halfH: 1.15,
    color: [0.62, 0.2, 0.18],
  },
  {
    name: 'B (behind A, overlaps A)',
    cx: 6.35,
    cy: 3.55,
    cz: 0,
    halfW: 1.15,
    halfH: 1.15,
    color: [0.18, 0.55, 0.24],
  },
  {
    name: 'C (separate)',
    cx: 5.4,
    cy: 0.75,
    cz: 0,
    halfW: 1.05,
    halfH: 1.05,
    color: [0.18, 0.3, 0.6],
  },
];

/** Multiplies a quad's own colour when the pointer is over it. Uniform, so it works on any base
 * colour rather than aiming at one hue. */
const HOVER_TINT: Vec3 = [2.5, 2.5, 2.5];

const LATIN_TEXT = 'Drift Engine';
const LATIN_COLOR: Vec3 = [0.93, 0.95, 1];
/** Three sizes with nothing tuned to make any of them special: if the smallest is not sharp,
 * this page's whole first claim was wrong. */
const LATIN_SIZES: readonly { readonly size: number; readonly y: number }[] = [
  { size: 0.42, y: 5.75 },
  { size: 0.8, y: 4.55 },
  { size: 1.45, y: 2.85 },
];
const LATIN_X = -8.6;

/** Anchor grid: one label per `anchorX`/`anchorY` combination, each on its own marker. A column
 * fixes `anchorX`, a row fixes `anchorY`, and the marker cube sits exactly at the point the
 * label was told to anchor to — so a wrong anchor reads as a label not touching its own dot. */
const ANCHOR_X: readonly {
  readonly key: SdfTextStyle['anchorX'];
  readonly abbrev: string;
  readonly x: number;
}[] = [
  { key: 'left', abbrev: 'L', x: -5.6 },
  { key: 'center', abbrev: 'C', x: 0 },
  { key: 'right', abbrev: 'R', x: 5.6 },
];
const ANCHOR_Y: readonly {
  readonly key: SdfTextStyle['anchorY'];
  readonly abbrev: string;
  readonly y: number;
}[] = [
  { key: 'top', abbrev: 'T', y: -0.75 },
  { key: 'middle', abbrev: 'M', y: -1.95 },
  { key: 'baseline', abbrev: 'BL', y: -3.15 },
  { key: 'bottom', abbrev: 'BO', y: -4.35 },
];
const ANCHOR_LABEL_SIZE = 0.4;
const ANCHOR_LABEL_COLOR: Vec3 = [0.8, 0.87, 1];
const MARKER_COLOR: Vec3 = [1, 0.42, 0.16];

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /*
   * **Read this back rather than trusting `?backend=`.** A browser with no usable WebGPU
   * adapter falls back to WebGL2 silently and draws a perfectly reasonable frame — see
   * `createRenderer`'s own comment on `choice.reason`. Printed to both the page (in the band a
   * capture harness excludes) and the console, so a headless run that only reads console text
   * still gets the true answer.
   */
  console.log(`[sdf-text] backend: ${created.backend} · ${created.reason}`);

  const [latin, arabic] = await Promise.all([
    loadSdfFont(renderer, '/fonts/latin'),
    loadSdfFont(renderer, '/fonts/arabic-run'),
  ]);

  /* Angled onto the quads' own +Z faces, rather than the default straight-up sun, so the three
     pickable quads catch real directional light instead of ambient alone. */
  const env = createEnvironment({
    directionalDir: [0.25, 0.55, 0.8],
    directionalColor: [1, 1, 0.96],
    ambient: [0.3, 0.32, 0.36],
  });
  const camera = new Camera();
  camera.fovYDeg = 42;
  camera.near = 1;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 0.5;
  camera.position[2] = 16;
  camera.lookAt(0, 0.5, 0);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  /* ---- Three sizes of one Latin line ---- */
  const latinLabels = LATIN_SIZES.map(({ size, y }) => ({
    model: at(LATIN_X, y, 0),
    label: makeLabel(renderer, latin.font, latin.atlas, LATIN_TEXT, {
      ...DEFAULT_SDF_TEXT_STYLE,
      size,
      anchorX: 'left',
      anchorY: 'baseline',
    }),
  }));

  /*
   * ---- `MONTAGEM ABU (أبو)`, as three runs chained left to right ----
   *
   * Still three runs, still two atlases. One `SdfTextHandle` takes one font, and the Latin and
   * Arabic halves of this string come from two different faces, so `measureWidth` positions
   * three labels end to end rather than one string handed to `setSdfText` with a font switch
   * partway through. That part was never the bug, and it has not changed.
   *
   * **`أبو` is one baked atlas cell now, not three isolated ones.** `scripts/sdf-font.ts --runs`
   * (Task A4) handed the whole string to the browser's own text stack at bake time; the browser
   * joined the letters into their contextual forms and set them right to left, and the result
   * was rasterised as a single cell with its own advance. Nothing below knew that was going to
   * happen — `arabicText` is still the same three-character string, still handed to
   * `makeLabel`/`setSdfText` exactly as before. What changed is which directory `loadSdfFont`
   * points `arabic` at, and what `SdfTextLayout.set()` finds sitting at the pen: the longest
   * matching key in the glyph table, not one code point at a time. A call site that knows
   * nothing about runs now draws a joined, correctly ordered word instead of three backwards
   * letters — that is the whole demonstration this page exists to run.
   *
   * The Arabic atlas still carries the three isolated letters too, deliberately, because this
   * page is the only place the two can be seen side by side — and seeing them side by side is
   * what makes the difference legible instead of asserted. `arabicLabel` below is the shaped
   * run; `unshapedLabel`, drawn directly under it, is the same three characters kept apart so
   * the longest-match layout cannot join them — see the comment above `unshapedText`.
   *
   * It is coloured differently from the Latin runs on either side of it so the boundary is
   * unmistakable rather than something to squint for.
   */
  const mixedSize = 0.62;
  const mixedY = 1.35;
  const mixedX = -8.6;
  const mixedStyle: SdfTextStyle = {
    ...DEFAULT_SDF_TEXT_STYLE,
    size: mixedSize,
    anchorX: 'left',
    anchorY: 'baseline',
  };
  const prefixText = 'MONTAGEM ABU (';
  const arabicText = 'أبو';
  const suffixText = ')';
  const prefixWidth = measureWidth(latin.font, prefixText, mixedSize);
  const arabicWidth = measureWidth(arabic.font, arabicText, mixedSize);
  const prefixColor: Vec3 = [1, 0.82, 0.32];
  const arabicColor: Vec3 = [0.4, 0.86, 1];
  const prefixLabel = makeLabel(renderer, latin.font, latin.atlas, prefixText, mixedStyle);
  const arabicLabel = makeLabel(renderer, arabic.font, arabic.atlas, arabicText, mixedStyle);
  const suffixLabel = makeLabel(renderer, latin.font, latin.atlas, suffixText, mixedStyle);
  const prefixModel = at(mixedX, mixedY, 0);
  const arabicModel = at(mixedX + prefixWidth, mixedY, 0);
  const suffixModel = at(mixedX + prefixWidth + arabicWidth, mixedY, 0);

  /**
   * The same three characters, forced apart so no run can match them, drawn directly below
   * the shaped word.
   *
   * This page exists to be honest about what the pipeline does, and one picture of the right
   * answer proves less than the two answers together: joined and right to left above,
   * isolated and left to right below. The zero-width space is what defeats the longest match,
   * and it draws nothing itself because the atlas has no cell for it.
   */
  const unshapedText = 'أ​ب​و';
  const unshapedY = mixedY - 1.1;
  const unshapedLabel = makeLabel(renderer, arabic.font, arabic.atlas, unshapedText, mixedStyle);
  const unshapedModel = at(mixedX + prefixWidth, unshapedY, 0);

  /* ---- The anchor grid ---- */
  const markerMesh: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.05, 0.05, 0.05], MARKER_COLOR, 0.55).build(),
  );
  interface AnchorLabel {
    readonly model: Float32Array;
    readonly label: SdfTextHandle;
  }
  const anchorLabels: AnchorLabel[] = [];
  for (const col of ANCHOR_X) {
    for (const row of ANCHOR_Y) {
      const model = at(col.x, row.y, 0);
      const label = makeLabel(renderer, latin.font, latin.atlas, `${col.abbrev}-${row.abbrev}`, {
        ...DEFAULT_SDF_TEXT_STYLE,
        size: ANCHOR_LABEL_SIZE,
        anchorX: col.key,
        anchorY: row.key,
      });
      anchorLabels.push({ model, label });
    }
  }

  /* ---- The three pickable quads ---- */
  interface PickQuad {
    readonly name: string;
    readonly mesh: MeshHandle;
    readonly model: Float32Array;
    readonly pickHandle: number;
  }
  const quads: PickQuad[] = QUAD_DEFS.map((def) => {
    const data = buildQuadMesh(def.halfW, def.halfH, def.color);
    const mesh = renderer.createMesh(data);
    const model = at(def.cx, def.cy, def.cz);
    /* The same local-space geometry `createMesh` just uploaded is handed to the picker too —
       `MeshData` already carries `positions`/`indices`, which is all `PickableSource` needs. */
    const pickHandle = renderer.registerPickable(data, model);
    return { name: def.name, mesh, model, pickHandle };
  });

  /* ---- Draw, and redraw whenever the hover state changes ---- */
  let hoveredHandle: number | null = null;

  function render(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);

    for (const quad of quads) {
      renderer.drawMesh(
        quad.mesh,
        quad.model,
        0,
        quad.pickHandle === hoveredHandle ? HOVER_TINT : null,
      );
    }
    for (const anchor of anchorLabels) renderer.drawMesh(markerMesh, anchor.model);

    for (const { model, label } of latinLabels) renderer.drawSdfText(label, model, LATIN_COLOR, 1);
    renderer.drawSdfText(prefixLabel, prefixModel, prefixColor, 1);
    renderer.drawSdfText(arabicLabel, arabicModel, arabicColor, 1);
    renderer.drawSdfText(suffixLabel, suffixModel, prefixColor, 1);
    renderer.drawSdfText(unshapedLabel, unshapedModel, arabicColor, 1);
    for (const anchor of anchorLabels)
      renderer.drawSdfText(anchor.label, anchor.model, ANCHOR_LABEL_COLOR, 1);

    renderer.endFrame();

    const hoveredName = quads.find((quad) => quad.pickHandle === hoveredHandle)?.name ?? 'none';
    stats.textContent = `${created.backend} · ${created.reason} · hovered quad: ${hoveredName}`;
  }

  function pickFromEvent(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const hit: PickHit | null = renderer.pickAt(
      camera,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    const next = hit?.handle ?? null;
    if (next !== hoveredHandle) {
      hoveredHandle = next;
      render();
    }
  }
  canvas.addEventListener('pointermove', pickFromEvent);
  canvas.addEventListener('pointerleave', () => {
    if (hoveredHandle !== null) {
      hoveredHandle = null;
      render();
    }
  });
  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    render();
  });

  render();

  /*
   * A verification hook, not engine API. `Camera.project` is exactly what a mouse-driven
   * check needs — the CSS-pixel position of a world point this page already knows the
   * coordinates of — and the alternative is reimplementing its projection maths in whatever
   * drives the pointer from outside the page.
   */
  interface SdfTextDemoDebug {
    project(x: number, y: number, z: number): readonly [number, number] | false;
  }
  const debugOut = new Float32Array(2);
  (window as unknown as { __sdfTextDemo?: SdfTextDemoDebug }).__sdfTextDemo = {
    project(x, y, z) {
      const ok = camera.project(debugOut, x, y, z, canvas.clientWidth, canvas.clientHeight);
      return ok ? [debugOut[0] as number, debugOut[1] as number] : false;
    },
  };
  (window as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
