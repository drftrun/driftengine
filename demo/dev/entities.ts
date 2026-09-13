/**
 * A `.drs` file's components and systems driving a real world, in a browser.
 *
 * Everything either side of this boundary has tests. What this page shows is the thing tests
 * cannot: the compiler's output loaded by a bundler, bound to a host, and run by the engine's own
 * schedule, frame after frame — with an edit landing on a world that keeps its entities.
 *
 * **The world is created once, outside the reload path.** That is the whole demonstration, and it
 * is the same shape `driftscript.ts` uses for its record: a page that rebuilt the world on reload
 * would show the same picture and prove nothing.
 */
import { World, buildSchedule, runSchedule } from '@driftengine/entities';
import { loadModule, patchModule } from 'driftscript';
import { bindModule, registerEntityModule } from '@driftengine/script';
import * as declared from './entities.drs';

const out = document.getElementById('out') as HTMLElement;
const field = document.getElementById('field') as HTMLElement;

const module = loadModule(declared as unknown as Record<string, unknown>);

/* Components are registered here and kept across reloads, so a patch lands on the world that
   already exists rather than on a second one nothing is drawing. */
const registry = new Map();
let registered = registerEntityModule(module, registry);
const bound = bindModule(module, { entities: { components: registry } });
if (!bound.bound) throw new Error(bound.reason);

const world = new World();
const Position = registry.get('Position');
const Velocity = registry.get('Velocity');
const Frozen = registry.get('Frozen');
if (Position === undefined || Velocity === undefined || Frozen === undefined) {
  throw new Error('the module declared no Position, Velocity or Frozen');
}

const MOVERS = 24;
const dots: HTMLElement[] = [];
for (let i = 0; i < MOVERS; i += 1) {
  const entity = world.create();
  world.add(entity, Position, { x: (i * 37) % 100, y: (i * 61) % 100 });
  world.add(entity, Velocity, { x: i % 2 === 0 ? 1 : -1, y: i % 3 === 0 ? 1 : -1 });
  /* A third of them frozen, so `.without<Frozen>()` is visibly doing something rather than
     asserted to be. They are drawn in a different colour and must not move. */
  if (i % 3 === 0) world.add(entity, Frozen, { since: 0 });

  const dot = document.createElement('div');
  dot.className = i % 3 === 0 ? 'mover frozen' : 'mover';
  field.appendChild(dot);
  dots.push(dot);
}

let schedule = buildSchedule(registered.systems);
let reloads = 0;
let lastReload = '';

/*
 * Vite finds this by scanning source for a literal `import.meta.hot.accept(`, so the call may not
 * be wrapped or aliased — the same rule `driftscript.ts` states at its own accept, and the same one
 * that cost a page reload per edit when it was got wrong there.
 */
if (import.meta.hot) {
  import.meta.hot.accept('./entities.drs', (next) => {
    if (next === undefined) return;
    const result = patchModule(module, next as Record<string, unknown>);
    /*
     * The schedule is rebuilt because a reload may have added, removed or reordered a system — but
     * the *world* is not, and the components are not: `registerEntityModule` hands back the store
     * it already made rather than a new one, so every entity above keeps its components.
     */
    registered = registerEntityModule(module, registry);
    schedule = buildSchedule(registered.systems);
    reloads += 1;
    lastReload = result.patched ? 'patched, world kept' : `refused: ${result.reason}`;
  });
}

let tick = 0;

/*
 * A snapshot on demand, for a probe driving this page over CDP.
 *
 * **The panel cannot serve that purpose**, because it is written from `requestAnimationFrame` and a
 * headless tab stops scheduling frames after the first second or so — a check that read the panel
 * saw `tick 98` before an edit and `tick 99` two and a half seconds after it, and concluded nothing
 * had reloaded when the reload had simply not been repainted.
 *
 * A function rather than a mutable object, so what a probe reads is the state at the moment it
 * asks rather than the last time a frame happened to run.
 */
(globalThis as { __drift?: unknown }).__drift = () => ({
  tick,
  reloads,
  lastReload,
  entities: world.liveCount,
  cursors: world.cursorsInUse,
  components: (module.info.components ?? []).map((c) => c.name),
  systems: (module.info.systems ?? []).map((s) => `${s.name}/${s.everyTicks}`),
});

function frame(): void {
  runSchedule(world, schedule, tick);
  tick += 1;

  /* Drawn by reading the store directly, which is what a renderer would do — the page is a host,
     and a host indexes columns rather than asking a script for them. */
  const view = world.view(Position);
  let at = 0;
  for (const entity of world.query(Position)) {
    const dot = dots[at];
    if (dot === undefined) break;
    const index = (view.sparse as Int32Array)[entity % 2 ** 26] as number;
    dot.style.left = `${(view.x as Float64Array)[index]}%`;
    dot.style.top = `${(view.y as Float64Array)[index]}%`;
    at += 1;
  }

  out.textContent = [
    `module     ${module.info.module}`,
    `requires   ${module.info.requires.join(', ')}`,
    `components ${(module.info.components ?? []).map((c) => c.name).join(', ')}`,
    `systems    ${(module.info.systems ?? []).map((s) => `${s.name}/${s.everyTicks}`).join(', ')}`,
    `entities   ${world.liveCount}`,
    `cursors    ${world.cursorsInUse} in use`,
    `tick       ${tick}`,
    `reloads    ${reloads}${lastReload === '' ? '' : ` — ${lastReload}`}`,
    '',
    'Edit demo/dev/entities.drs and save. The world keeps its entities.',
  ].join('\n');

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
