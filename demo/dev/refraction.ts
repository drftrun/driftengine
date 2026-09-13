/**
 * A pane of glass over a pattern whose position is known, and a control beside every claim.
 *
 * Refraction is two unrelated things sharing one draw option — the *bending*, which is a sample
 * taken at an offset, and the *absorption*, which is Beer-Lambert over a path length that grows at
 * grazing angles. So this page draws one subject per load and publishes what the canvas holds.
 *
 *     /refraction.html?variant=none      the pattern alone, and the baseline every other reads against
 *     /refraction.html?variant=off       a pane at refraction 0, the control that must not displace
 *     /refraction.html?variant=clear     a pane that bends and absorbs nothing
 *     /refraction.html?variant=strong    the same pane at twice the strength
 *     /refraction.html?variant=tinted    a pane that absorbs red and blue
 *     /refraction.html?variant=face      the tinted pane face-on to the camera
 *     /refraction.html?variant=edge      the same pane turned toward edge-on
 *     /refraction.html?variant=ramp      thickness ramped across the pane by the channel's .w lane
 *     /refraction.html?variant=nolane    the same absorbing pane carrying no channel array at all
 *
 * **The pattern behind the pane is high-contrast vertical bars**, because a displacement is only
 * measurable against something whose position is known: a flat backdrop refracts to itself and
 * every assertion about bending would pass on a shader that does nothing.
 *
 * **`face` and `edge` are the pair that tests Beer-Lambert rather than a tint.** Same tint, same
 * thickness, different angle. A tint multiplied straight into the fragment gives the same colour in
 * both; a path length divided by `dot(N, V)` does not, and that difference is the whole reason the
 * absorption is not simply a colour on the draw.
 *
 * Nothing here reads a real clock, so two loads of one URL draw the same frame.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `vertexChannel.ts` and `decals.ts`.
 */

import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Dark, and nothing in the scene is near it, so a subject pixel is unambiguous. */
const CLEAR: Vec3 = [0.02, 0.03, 0.08];

/** How many bars the backdrop carries. Enough that a small displacement moves a measurable area. */
const BARS = 16;

type Variant = 'none' | 'off' | 'clear' | 'strong' | 'tinted' | 'face' | 'edge' | 'ramp' | 'nolane';

/** The absorbing colour: red and blue fall, green survives, so a tinted pane reads green. */
const GLASS: Vec3 = [0.15, 0.85, 0.25];

/**
 * The backdrop: vertical bars alternating bright and dark, filling the frame behind the pane.
 *
 * Emissive rather than lit, so its brightness is a constant of the scene and a change in what the
 * pane shows is the pane's doing rather than the lighting's.
 */
function backdrop(): MeshData {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const x0 = -4 + (8 * i) / BARS;
    const x1 = -4 + (8 * (i + 1)) / BARS;
    const bright = i % 2 === 0 ? 0.95 : 0.05;
    const base = positions.length / 3;
    positions.push(x0, -3, -2, x1, -3, -2, x1, 3, -2, x0, 3, -2);
    for (let c = 0; c < 4; c++) colors.push(bright, bright, bright);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(count * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    colors: new Float32Array(colors),
    /* Fully emissive, so the bars are the same brightness whatever the lighting does. */
    emissive: new Float32Array(count).fill(1),
    indices: new Uint32Array(indices),
  };
}

/**
 * The pane: a flat sheet, tilted about Y, and large enough to cover the measurement box at any tilt.
 *
 * **Tilted and not facing the camera, and that is a fact about refraction rather than a decorative
 * choice.** The sample is offset along the surface normal in screen space, so a sheet facing the
 * camera has a normal of (0, 0, 1), an xy of zero, and displaces nothing — which is correct, a flat
 * pane perpendicular to your eye really does not shift what is behind it. The first version of this
 * page was that pane and every bending assertion measured zero against a shader that was working.
 *
 * **Flat and not rippled**, which was the second version: a rippled sheet displaces by a different
 * amount at every x, which smears the bars instead of moving them and leaves the measurement
 * reporting noise. One tilt is one normal, so everything behind shifts by one amount, and the shift
 * is proportional to the strength — which is what makes "twice the strength moves it further" a
 * statement about the shader rather than about the geometry.
 *
 * **Large enough that the box never sees past it.** A tilted sheet covers less of the screen, and a
 * measurement box the background leaked into would read the absorption of a pane that was not
 * there.
 *
 * The `.w` lane of the per-vertex channel carries the thickness multiplier. `ramp` fills it 0 to 1
 * across the sheet; every other variant leaves it at 1 so the draw's own thickness stands.
 */
function pane(variant: Variant): MeshData {
  const CELLS = 16;
  const HALF = 5;
  const verts = (CELLS + 1) * (CELLS + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const emissive = new Float32Array(verts);
  const channel = new Float32Array(verts * 4);

  for (let iy = 0; iy <= CELLS; iy++) {
    for (let ix = 0; ix <= CELLS; ix++) {
      const i = iy * (CELLS + 1) + ix;
      const u = ix / CELLS;
      const v = iy / CELLS;
      positions[i * 3] = (u - 0.5) * 2 * HALF;
      positions[i * 3 + 1] = (v - 0.5) * 2 * HALF;
      positions[i * 3 + 2] = 0;
      /* Flat: one normal for the whole sheet, turned by the model matrix along with the geometry. */
      normals[i * 3 + 2] = 1;
      /* Mid grey, and it never shows: a refracting draw replaces its own shading with what is
         behind it. It is here so the `off` control has something to be opaque with. */
      colors[i * 3] = 0.5;
      colors[i * 3 + 1] = 0.5;
      colors[i * 3 + 2] = 0.5;
      channel[i * 4] = 0;
      channel[i * 4 + 1] = 1;
      channel[i * 4 + 2] = 1;
      /*
       * A step through the middle rather than a gentle ramp, because the measurement box sees only
       * the middle fifth of the sheet: a 0-to-1 ramp across the whole sheet varies by about a tenth
       * inside the box, which is a difference the frame's own noise can swallow. A step puts zero
       * thickness on one side of the box and full thickness on the other, which is the same claim
       * — the lane varies absorption within one draw — stated where it can be measured.
       */
      channel[i * 4 + 3] = variant === 'ramp' ? (u < 0.5 ? 0 : 1) : 1;
    }
  }

  const indices = new Uint32Array(CELLS * CELLS * 6);
  let w = 0;
  for (let iy = 0; iy < CELLS; iy++) {
    for (let ix = 0; ix < CELLS; ix++) {
      const a = iy * (CELLS + 1) + ix;
      const b = a + 1;
      const c = a + (CELLS + 1);
      const d = c + 1;
      /* Counter-clockwise seen from +Z, where the camera is; wound the other way the engine culls
         the whole sheet and every measurement comes back agreeing with a blank frame. */
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = d;
      indices[w++] = c;
    }
  }

  /*
   * **`nolane` carries no channel array at all**, which is the case every other variant hides: they
   * all supply one, so the absent value of the thickness lane was never what was being drawn. It
   * was 0 for a release, which makes the path length zero and absorption a multiply by one — a
   * pane that bends the scene and takes no colour out of it.
   */
  if (variant === 'nolane') return { positions, normals, colors, emissive, indices };
  return { positions, normals, colors, emissive, channel, indices };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The pane turned about Y, so `edge` presents a grazing angle and `face` does not. */
function turned(radians: number): Float32Array {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const variant = (asked.get('variant') ?? 'clear') as Variant;
  const frames = Number(asked.get('frames') ?? '3');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const bars = renderer.createMesh(backdrop());
  const glass = variant === 'none' ? null : renderer.createMesh(pane(variant));

  const env = createEnvironment();
  env.ambient = [0.3, 0.3, 0.3];
  env.ambientGround = [0.3, 0.3, 0.3];
  env.directionalColor = [0.5, 0.5, 0.5];
  env.directionalDir = [0, 0, 1];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.5;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 5;
  camera.lookAt(0, 0, 0);

  /*
   * The drawing buffer is sized here or it stays at the canvas element's default 300x150, and every
   * measurement comes back zero — which is the failure the subject-present assertion exists for and
   * which cost a debugging cycle on the row before this one.
   */
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  /** Where the pane is on screen, so a measurement can be scoped to it rather than to the frame. */
  const boxW = Math.floor(mirror.width * 0.22);
  const boxH = Math.floor(mirror.height * 0.22);
  const boxX = Math.floor(mirror.width / 2 - boxW / 2);
  const boxY = Math.floor(mirror.height / 2 - boxH / 2);

  let pixels = 0;
  let edges = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let leftLum = 0;
  let rightLum = 0;
  let digest = '';

  /**
   * What the frame holds, counted from the canvas rather than from a screenshot.
   *
   * From the canvas for the reason `oit.ts` records: a screenshot comparison there found 120
   * differing pixels that turned out to be the page's own caption.
   *
   * **`edges` is how displacement is measured.** Counting bright-to-dark transitions along one row
   * through the middle of the pane says where the bars are without needing to know where they
   * *should* be — a bent sample moves them, so the transition positions move, and summing their x
   * positions gives a number a shader that does nothing cannot change.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    const at = (x: number, y: number): number[] => {
      const i = (y * mirror.width + x) * 4;
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
    };

    let count = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let leftSum = 0;
    let leftCount = 0;
    let rightSum = 0;
    let rightCount = 0;
    for (let y = boxY; y < boxY + boxH; y++) {
      for (let x = boxX; x < boxX + boxW; x++) {
        const [r, g, b] = at(x, y) as [number, number, number];
        count += 1;
        sumR += r;
        sumG += g;
        sumB += b;
        const l = (r + g + b) / 3;
        if (x < boxX + boxW / 2) {
          leftSum += l;
          leftCount += 1;
        } else {
          rightSum += l;
          rightCount += 1;
        }
      }
    }
    pixels = count;
    red = count === 0 ? 0 : sumR / count;
    green = count === 0 ? 0 : sumG / count;
    blue = count === 0 ? 0 : sumB / count;
    leftLum = leftCount === 0 ? 0 : leftSum / leftCount;
    rightLum = rightCount === 0 ? 0 : rightSum / rightCount;

    /*
     * **Where the first bar boundary sits along the pane's middle row.**
     *
     * A uniform tilt displaces everything behind the sheet by one amount, so this position moves by
     * that amount and is monotonic in the strength — which is what lets "twice the strength moves it
     * further" be a statement about the shader.
     *
     * The first version of this summed the positions of *every* transition, and that number is not
     * monotonic: a transition entering or leaving the box jumps it by hundreds while the picture
     * barely moves. One boundary, one number.
     *
     * -1 where the row holds no boundary at all, which is what a pane that covers the bars in flat
     * paint looks like — the `off` control, and a real answer rather than a missing one.
     */
    let boundary = -1;
    const midY = boxY + Math.floor(boxH / 2);
    let previous = -1;
    for (let x = boxX; x < boxX + boxW; x++) {
      const [r, g, b] = at(x, midY) as [number, number, number];
      const bright = (r + g + b) / 3 > 90 ? 1 : 0;
      if (previous !== -1 && bright !== previous && boundary === -1) boundary = x - boxX;
      previous = bright;
    }
    edges = boundary;

    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    /* The backdrop is opaque and drawn first, which is what puts it in the snapshot the pane
       reads. Draw the world, then the glass. */
    renderer.drawMesh(bars, IDENTITY);
    if (glass !== null) {
      /*
       * One tilt for every variant that measures bending, so the displacement is the shader's; two
       * different tilts for the pair that measures absorption, because that is the whole claim —
       * same tint and same thickness at two angles.
       */
      const tilt = variant === 'face' ? 0.15 : variant === 'edge' ? 1.15 : 0.35;
      const model = turned(tilt);
      const strength = variant === 'off' ? 0 : variant === 'strong' ? 0.05 : 0.025;
      const absorbing =
        variant === 'tinted' ||
        variant === 'face' ||
        variant === 'edge' ||
        variant === 'ramp' ||
        variant === 'nolane';
      renderer.drawTranslucentMesh(glass, model, 1, {
        lit: false,
        fog: false,
        refraction: strength,
        refractTint: absorbing ? GLASS : undefined,
        thicknessM: absorbing ? 1.2 : 0,
      });
    }
    renderer.endFrame();
    measure();
  }

  let drawn = 0;
  await new Promise<void>((done) => {
    const tick = (): void => {
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

  stats.textContent =
    `${created.backend} · ${created.reason} · ${variant} · ${pixels} px · edges ${edges} · ` +
    `rgb ${red.toFixed(1)},${green.toFixed(1)},${blue.toFixed(1)} · ` +
    `L ${leftLum.toFixed(1)} R ${rightLum.toFixed(1)} · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__pixels'] = pixels;
  out['__edges'] = edges;
  out['__red'] = red;
  out['__green'] = green;
  out['__blue'] = blue;
  out['__leftLum'] = leftLum;
  out['__rightLum'] = rightLum;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
