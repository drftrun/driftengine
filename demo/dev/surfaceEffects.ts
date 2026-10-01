/**
 * A street of facades wearing surface effects: rooms behind the windows, windows lit by night, wear,
 * a pulsing sign and rain — every layer of one texture array, every facade one draw.
 *
 *     /surfaceEffects.html                   night, the default backend
 *     /surfaceEffects.html?backend=webgl2    the other one
 *     /surfaceEffects.html?effects=0         the control: the same array with no effects table
 *     /surfaceEffects.html?lit=0.3&late=0.1  the share of windows lit, and the share that stays lit
 *     /surfaceEffects.html?wet=1             rain on everything that faces up, walkways excepted
 *     /surfaceEffects.html?day=1             daylight, where wear and the dim rooms show
 *     /surfaceEffects.html?t=2.5             seconds on the caller's clock, for the sign
 *     /surfaceEffects.html?tint=1            the right-hand facades' own window light, a cold one,
 *                                            named by their vertices' emissive colour
 *
 * Five layers drawn on canvases here: a facade whose windows are holes in its picture, a room in one
 * point perspective, a stone wall, a neon sign and asphalt. The effects table says the facade's
 * windows are a 4×6 grid of glass with that room behind them, the wall and the facade wear, the sign
 * pulses and scrolls, and the pavement stays dry under rain.
 *
 * **What a failure looks like**: windows showing the wall's colour or black (the glass mask read the
 * wrong way); a room that does not move against its window frame as the camera does (no parallax —
 * no tangents, or the ray not reaching the box); every window lit or none (the hash or the share);
 * the control and this page identical (no table bound); the two backends differing past their floor.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type {
  MeshData,
  RendererApi,
  SurfaceLayerEffect,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const SIZE = 256;
const FRAMES = 30;
/** Layers of the array, by what they picture. */
const FACADE = 0;
const ROOM = 1;
const STONE = 2;
const SIGN = 3;
const ASPHALT = 4;

function canvas(draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d');
  if (g === null) throw new Error('no 2d canvas');
  draw(g);
  return c;
}

function layers(): HTMLCanvasElement[] {
  const facade = canvas((g) => {
    g.fillStyle = '#b8ad9a';
    g.fillRect(0, 0, SIZE, SIZE);
    /* A 4×6 grid of windows, holes in the wall: glass where the picture is transparent. */
    const cw = SIZE / 4;
    const ch = SIZE / 6;
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 4; col++) {
        g.fillStyle = '#8a8070';
        g.fillRect(col * cw + 7, row * ch + 5, cw - 14, ch - 8);
        g.clearRect(col * cw + 10, row * ch + 8, cw - 20, ch - 14);
      }
    }
  });
  const room = canvas((g) => {
    /* One point perspective: the back wall is the centre half, the walls run in to it. */
    const a = SIZE * 0.25;
    const b = SIZE * 0.75;
    const quad = (points: number[], colour: string): void => {
      g.fillStyle = colour;
      g.beginPath();
      g.moveTo(points[0] ?? 0, points[1] ?? 0);
      for (let i = 2; i < points.length; i += 2) g.lineTo(points[i] ?? 0, points[i + 1] ?? 0);
      g.closePath();
      g.fill();
    };
    quad([0, 0, SIZE, 0, b, a, a, a], '#e9e2d0'); // ceiling
    quad([0, SIZE, SIZE, SIZE, b, b, a, b], '#6b4a30'); // floor
    quad([0, 0, a, a, a, b, 0, SIZE], '#c98f5a'); // left wall
    quad([SIZE, 0, b, a, b, b, SIZE, SIZE], '#b77f4c'); // right wall
    g.fillStyle = '#d9a46c';
    g.fillRect(a, a, b - a, b - a); // back wall
    g.fillStyle = '#3c5a7a';
    g.fillRect(a + 30, a + 25, 50, 34); // a picture on the back wall
    g.fillStyle = '#fff6d8';
    g.beginPath();
    g.arc(SIZE / 2, a * 0.55, 10, 0, Math.PI * 2);
    g.fill(); // the lamp
  });
  const stone = canvas((g) => {
    for (let y = 0; y < SIZE; y += 32) {
      for (let x = (y / 32) % 2 === 0 ? 0 : -32; x < SIZE; x += 64) {
        const shade = 110 + ((x * 7 + y * 13) % 30);
        g.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 10})`;
        g.fillRect(x + 2, y + 2, 60, 28);
      }
    }
  });
  const sign = canvas((g) => {
    g.fillStyle = '#140a18';
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = '#ff3fb0';
    g.font = 'bold 120px sans-serif';
    g.fillText('BAR', 20, 170);
  });
  const asphalt = canvas((g) => {
    g.fillStyle = '#3a3a3e';
    g.fillRect(0, 0, SIZE, SIZE);
    for (let i = 0; i < 900; i++) {
      const v = 40 + ((i * 37) % 40);
      g.fillStyle = `rgb(${v}, ${v}, ${v + 3})`;
      g.fillRect((i * 97) % SIZE, (i * 61) % SIZE, 3, 3);
    }
  });
  return [facade, room, stone, sign, asphalt];
}

const EFFECTS: (SurfaceLayerEffect | undefined)[] = [];
EFFECTS[FACADE] = {
  windows: { cells: [4, 6], glass: true, seed: 3, glow: 0.9 },
  interior: { roomLayer: ROOM, depth: 0.7, lit: 0.85 },
  wear: { dust: 0.3, grime: 0.5, streaks: 0.6 },
};
EFFECTS[STONE] = { wear: { dust: 0.6, grime: 0.7, streaks: 0.5, fade: 120 } };
EFFECTS[SIGN] = { animation: { pulse: [0.7, 0.6], scroll: [0.05, 0] } };
EFFECTS[ASPHALT] = { wear: { grime: 0.3 } };

/** A quad a–b–c–d, counter-clockwise from its front, wearing `layer` at `repeats` across and up. */
function quad(
  out: {
    p: number[];
    n: number[];
    t: number[];
    uv: number[];
    l: number[];
    e: number[];
    c: number[];
    i: number[];
  },
  a: Vec3,
  b: Vec3,
  d: Vec3,
  repeats: [number, number],
  layer: number,
  emissive = 0,
  light: Vec3 = [-1, -1, -1],
): void {
  const base = out.p.length / 3;
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const nx = u[1] * v[2] - u[2] * v[1];
  const ny = u[2] * v[0] - u[0] * v[2];
  const nz = u[0] * v[1] - u[1] * v[0];
  const nl = Math.hypot(nx, ny, nz);
  const ul = Math.hypot(u[0], u[1], u[2]);
  const corners: [Vec3, number, number][] = [
    [a, 0, 0],
    [b, repeats[0], 0],
    [[b[0] + v[0], b[1] + v[1], b[2] + v[2]], repeats[0], repeats[1]],
    [d, 0, repeats[1]],
  ];
  for (const [p, s, t] of corners) {
    out.p.push(p[0], p[1], p[2]);
    out.n.push(nx / nl, ny / nl, nz / nl);
    /* w = -1: v runs down the quad (see below), so the bitangent that follows it points down,
       which is cross(normal, tangent) turned over. */
    out.t.push(u[0] / ul, u[1] / ul, u[2] / ul, -1);
    /* Up the picture is down the canvas, so v runs from the top of the quad. */
    out.uv.push(s, repeats[1] - t);
    out.l.push(layer);
    out.e.push(emissive);
    out.c.push(light[0], light[1], light[2]);
  }
  out.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function street(tint: boolean): MeshData {
  const g = { p: [], n: [], t: [], uv: [], l: [], e: [], c: [], i: [] } as {
    p: number[];
    n: number[];
    t: number[];
    uv: number[];
    l: number[];
    e: number[];
    c: number[];
    i: number[];
  };
  /* A cold light at twice the table's strength, on the right-hand side only. */
  const cold: Vec3 = tint ? [0.7, 1.1, 2.8] : [-1, -1, -1];
  quad(g, [-8, 0, 60], [8, 0, 60], [-8, 0, -4], [4, 16], ASPHALT);
  for (let k = 0; k < 4; k++) {
    const z = k * 14;
    /* Left facades face +x, right facades face -x. */
    quad(g, [-8, 0, z + 12], [-8, 0, z], [-8, 18, z + 12], [2, 3], k === 1 ? STONE : FACADE);
    quad(g, [8, 0, z], [8, 0, z + 12], [8, 18, z], [2, 3], k === 2 ? STONE : FACADE, 0, cold);
  }
  quad(g, [7.9, 4, 18], [7.9, 4, 22], [7.9, 6, 18], [1, 1], SIGN, 1);
  const count = g.p.length / 3;
  return {
    positions: new Float32Array(g.p),
    normals: new Float32Array(g.n),
    colors: new Float32Array(count * 3).fill(1),
    emissive: new Float32Array(g.e),
    emissiveColor: new Float32Array(g.c),
    tangents: new Float32Array(g.t),
    uvs: new Float32Array(g.uv),
    layers: new Float32Array(g.l),
    indices: new Uint32Array(g.i),
  };
}

async function main(): Promise<void> {
  const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const query = new URLSearchParams(location.search);
  const created = await createRenderer(canvasEl, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  const withEffects = query.get('effects') !== '0';
  const day = query.get('day') === '1';

  const array = renderer.createSurfaceTextureArray(layers(), {
    colorSpace: 'srgb',
    ...(withEffects ? { effects: EFFECTS } : {}),
  });
  const mesh = renderer.createMesh(street(query.get('tint') === '1'));

  const env = createEnvironment();
  env.directionalDir = day ? [0.4, 0.8, 0.3] : [0.2, 0.9, 0.1];
  env.directionalColor = day ? [1.1, 1.05, 0.95] : [0.05, 0.06, 0.09];
  env.ambient = day ? [0.35, 0.37, 0.42] : [0.03, 0.035, 0.05];
  env.nightFactor = day ? 0 : 1;
  env.surfaceTime = Number(query.get('t') ?? '0');
  env.wetness = Number(query.get('wet') ?? '0');
  env.litWindows = day ? 0 : Number(query.get('lit') ?? '0.6');
  env.lateWindows = Number(query.get('late') ?? '0.1');

  const camera = new Camera();
  camera.fovYDeg = 60;
  camera.near = 0.2;
  camera.far = 200;
  camera.position[0] = -2.5;
  camera.position[1] = 1.7;
  camera.position[2] = -3;
  camera.lookAt(3, 6, 30);

  let frame = 0;
  const draw = (): void => {
    renderer.resize();
    camera.updateMatrices(canvasEl.height > 0 ? canvasEl.width / canvasEl.height : 1);
    renderer.beginFrame(day ? [0.55, 0.65, 0.8] : [0.02, 0.025, 0.04]);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ albedo: array });
    renderer.drawMesh(mesh, IDENTITY);
    renderer.endFrame();
    frame += 1;
    stats.textContent =
      `${created.backend} · effects ${withEffects ? 'on' : 'off'} · ${day ? 'day' : 'night'} · ` +
      `lit ${env.litWindows} late ${env.lateWindows} · wet ${env.wetness} · t ${env.surfaceTime}` +
      (query.get('tint') === '1' ? ' · tint' : '');
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
