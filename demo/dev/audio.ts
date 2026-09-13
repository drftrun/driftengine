/**
 * The page for hearing what a screenshot cannot show.
 *
 * **Every other feature in this engine is checked by photographing it.** A mix cannot be, and
 * `scripts/audio-check.mjs` covers the half that is arithmetic — a level ratio, an interaural
 * delay, a tail length. What no number settles is whether a source behind you *sounds* behind you,
 * whether stepping behind a wall sounds like a wall rather than like a volume control, and whether
 * two rooms sound like two rooms. That is what this page is for, and it is a person's ears.
 *
 * Everything here is synthesised in the page. No asset, no request, nothing to go missing.
 *
 * Nothing on this page is engine API, and nothing under `packages/*​/src` may import it.
 */
import {
  MixConsole,
  addReverbZone,
  createListener,
  createSpatialSource,
  type MixBus,
  type SpatialSource,
} from '../../packages/audio/src/index';

/* ------------------------------------------------------------------- the world */

/** A wall to step behind, as a segment on the floor plan. */
const WALL = { ax: -3, az: -9, bx: 9, bz: -9 };

const ZONES = [
  { name: 'hall', x: -16, z: 0, radius: 9, blend: 3, seconds: 4.5, decay: 1.6, wet: 0.85 },
  { name: 'room', x: 16, z: 0, radius: 9, blend: 3, seconds: 0.6, decay: 3.2, wet: 0.6 },
];

/** Where the passing source runs, and how fast. Fast enough that the shift is unmistakable. */
const PASS = { z: -5, from: -60, to: 60, speed: 34 };

/* ------------------------------------------------------- synthesis, in the page */

/**
 * A short broadband click, repeating.
 *
 * **Clicks rather than a steady tone, and that is not decoration.** A head model localises by the
 * difference in arrival time and in spectrum between two ears, and a continuous sine gives the ear
 * almost nothing to compare — it is the one signal a listener genuinely cannot place. A transient
 * carries the whole spectrum at one instant, which is what makes "behind me" audible at all.
 */
function clickLoop(context: BaseAudioContext, periodSec: number, colour: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * periodSec);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const burst = Math.floor(context.sampleRate * 0.035);
  let previous = 0;
  for (let i = 0; i < burst; i++) {
    const white = Math.random() * 2 - 1;
    // A one-pole low-pass, so the two sources are distinguishable by colour rather than by level.
    previous = previous + (white - previous) * colour;
    data[i] = previous * (1 - i / burst) ** 2;
  }
  return buffer;
}

/** A two-partial tone, for something whose pitch is meant to be followed. */
function siren(context: BaseAudioContext, hz: number, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    data[i] = 0.5 * Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(2 * Math.PI * hz * 2 * t);
  }
  return buffer;
}

/* ------------------------------------------------------------------- geometry */

/**
 * Whether the straight line from the listener to a source crosses the wall.
 *
 * A plain segment intersection on the floor plan, in the page rather than in the engine — which is
 * the whole shape of the occlusion design: the consumer knows what a wall is and answers the
 * question, and the engine decides what the answer sounds like.
 */
function blockedByWall(
  ax: number,
  _ay: number,
  az: number,
  bx: number,
  _by: number,
  bz: number,
): number {
  const cross = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number =>
    (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = cross(WALL.ax, WALL.az, WALL.bx, WALL.bz, ax, az);
  const d2 = cross(WALL.ax, WALL.az, WALL.bx, WALL.bz, bx, bz);
  const d3 = cross(ax, az, bx, bz, WALL.ax, WALL.az);
  const d4 = cross(ax, az, bx, bz, WALL.bx, WALL.bz);
  return d1 * d2 < 0 && d3 * d4 < 0 ? 1 : 0;
}

/* ----------------------------------------------------------------------- page */

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const hint = document.getElementById('hint') as HTMLDivElement;
const guide = document.getElementById('guide') as HTMLParagraphElement;
const mixerEl = document.getElementById('mixer') as HTMLDivElement;
const sourcesEl = document.getElementById('sources') as HTMLDivElement;
const startEl = document.getElementById('start') as HTMLDivElement;

guide.textContent = [
  'Walk around the circling click with W A S D and turn with the mouse: it should stay where it is in the world, including behind you.',
  'Step across the wall from the click beyond it: it should go dull, not merely quiet.',
  'Walk into either room: one is long and dark, the other short and bright.',
  'The siren passes in front of you: its pitch should rise coming and fall going.',
].join('\n\n');

const listenerState = { x: 0, z: 6, yaw: 0 };
const keys = new Set<string>();
let last = 0;

addEventListener('keydown', (event) => keys.add(event.code));
addEventListener('keyup', (event) => keys.delete(event.code));
canvas.addEventListener('pointerdown', (event) => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', (event) => {
  if (event.buttons === 0) return;
  listenerState.yaw += event.movementX * 0.005;
});

startEl.querySelector('button')?.addEventListener('click', () => {
  startEl.remove();
  run();
});

function run(): void {
  const context = new AudioContext();
  /*
   * Attempted, never awaited, never fatal. A browser that rejects this is a browser applying its
   * autoplay policy, not one that has failed — `AudioGraph.create` carries the whole story, which
   * cost a session of silence on mobile: awaiting it threw a perfectly good graph into a catch and
   * reported no audio at all, permanently, with a wake() that had nothing left to wake.
   */
  void context.resume().catch(() => undefined);
  const mix = new MixConsole(context);
  const listener = createListener(mix);
  listener.probe = blockedByWall;

  const world = mix.bus('effects');
  const zones = ZONES.map((z) =>
    addReverbZone(
      listener,
      z.name,
      { x: z.x, y: 0, z: z.z, radius: z.radius, blend: z.blend },
      {
        seconds: z.seconds,
        decay: z.decay,
        wet: z.wet,
      },
    ),
  );

  const circling = createSpatialSource(listener, clickLoop(context, 0.9, 0.6), {
    loop: true,
    bus: world,
  });
  const behindWall = createSpatialSource(listener, clickLoop(context, 1.4, 0.12), {
    loop: true,
    bus: world,
  });
  const passing = createSpatialSource(listener, siren(context, 320, 8), {
    loop: true,
    bus: world,
    doppler: true,
    refDistance: 4,
  });
  for (const source of [circling, behindWall, passing]) source.start();

  const placed = {
    circling: { x: 5, z: 0 },
    behindWall: { x: 3, z: -16 },
    passing: { x: PASS.from },
  };

  buildMixer(mix, [mix.master, world, ...zones.map((z) => z.bus)]);
  buildSourceToggles({ circling, behindWall, passing });

  const frame = (nowMs: number): void => {
    const dt = last === 0 ? 1 / 60 : Math.min((nowMs - last) / 1000, 0.1);
    last = nowMs;
    step(dt);

    listener.set(listenerState.x, 1.6, listenerState.z, listenerState.yaw, 0, dt);
    circling.place(placed.circling.x, 1.6, placed.circling.z, dt);
    behindWall.place(placed.behindWall.x, 1.6, placed.behindWall.z, dt);

    placed.passing.x += PASS.speed * dt;
    if (placed.passing.x > PASS.to) {
      placed.passing.x = PASS.from;
      // A wrap is a teleport, and a teleport must not be heard as motion.
      passing.warp(placed.passing.x, 1.6, PASS.z);
    }
    passing.place(placed.passing.x, 1.6, PASS.z, dt);

    draw(
      placed,
      zones.map((z) => z.amountAt(listenerState.x, 1.6, listenerState.z)),
    );
    hint.textContent = `occlusion ${behindWall.occlusion.toFixed(2)}   doppler ${passing.detuneCents.toFixed(0)} cents`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function step(dt: number): void {
  const speed = 6 * dt;
  const forwardX = Math.sin(listenerState.yaw);
  const forwardZ = -Math.cos(listenerState.yaw);
  if (keys.has('KeyW')) {
    listenerState.x += forwardX * speed;
    listenerState.z += forwardZ * speed;
  }
  if (keys.has('KeyS')) {
    listenerState.x -= forwardX * speed;
    listenerState.z -= forwardZ * speed;
  }
  if (keys.has('KeyA')) {
    listenerState.x -= Math.cos(listenerState.yaw) * speed;
    listenerState.z -= Math.sin(listenerState.yaw) * speed;
  }
  if (keys.has('KeyD')) {
    listenerState.x += Math.cos(listenerState.yaw) * speed;
    listenerState.z += Math.sin(listenerState.yaw) * speed;
  }
}

function buildMixer(mix: MixConsole, buses: readonly MixBus[]): void {
  for (const bus of buses) {
    const strip = document.createElement('div');
    strip.className = 'strip';
    const name = document.createElement('span');
    name.textContent = bus.name;
    const fader = document.createElement('input');
    fader.type = 'range';
    fader.min = '0';
    fader.max = '1';
    fader.step = '0.01';
    fader.value = String(bus.level);
    fader.addEventListener('input', () => bus.setLevel(Number(fader.value)));
    const mute = toggle('M', (on) => bus.setMute(on));
    const solo = toggle('S', (on) => bus.setSolo(on));
    strip.append(name, fader, mute, solo);
    mixerEl.append(strip);
  }
  document
    .querySelector('[data-snapshot="take"]')
    ?.addEventListener('click', () => mix.snapshot('now'));
  document
    .querySelector('[data-snapshot="recall"]')
    ?.addEventListener('click', () => mix.recall('now', 2));
}

function buildSourceToggles(sources: Record<string, SpatialSource>): void {
  for (const [name, source] of Object.entries(sources)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `stop ${name}`;
    let running = true;
    button.addEventListener('click', () => {
      if (!running) return;
      running = false;
      source.stop();
      button.textContent = `${name} stopped`;
    });
    sourcesEl.append(button);
  }
}

function toggle(label: string, onChange: (on: boolean) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(next));
    onChange(next);
  });
  return button;
}

/** A plan view, so a person can see where they are while hearing it. */
function draw(
  placed: {
    circling: { x: number; z: number };
    behindWall: { x: number; z: number };
    passing: { x: number };
  },
  zoneAmounts: number[],
): void {
  const dpr = devicePixelRatio;
  const width = canvas.clientWidth * dpr;
  const height = canvas.clientHeight * dpr;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const scale = Math.min(width, height) / 70;
  ctx.setTransform(scale, 0, 0, scale, width / 2, height / 2);
  ctx.clearRect(-width, -height, width * 2, height * 2);
  ctx.lineWidth = 2 / scale;

  ZONES.forEach((zone, index) => {
    ctx.beginPath();
    ctx.arc(zone.x, zone.z, zone.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(110, 231, 168, ${0.05 + 0.18 * (zoneAmounts[index] ?? 0)})`;
    ctx.fill();
    ctx.strokeStyle = '#2f6f52';
    ctx.stroke();
  });

  ctx.beginPath();
  ctx.moveTo(WALL.ax, WALL.az);
  ctx.lineTo(WALL.bx, WALL.bz);
  ctx.strokeStyle = '#8899aa';
  ctx.lineWidth = 6 / scale;
  ctx.stroke();
  ctx.lineWidth = 2 / scale;

  for (const [x, z, colour] of [
    [placed.circling.x, placed.circling.z, '#6ee7a8'],
    [placed.behindWall.x, placed.behindWall.z, '#e7b26e'],
    [placed.passing.x, PASS.z, '#6eb6e7'],
  ] as [number, number, string][]) {
    ctx.beginPath();
    ctx.arc(x, z, 0.7, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  ctx.save();
  ctx.translate(listenerState.x, listenerState.z);
  ctx.rotate(listenerState.yaw);
  ctx.beginPath();
  ctx.moveTo(0, -1.6);
  ctx.lineTo(1.1, 1.1);
  ctx.lineTo(-1.1, 1.1);
  ctx.closePath();
  ctx.fillStyle = '#d7dde5';
  ctx.fill();
  ctx.restore();
}
