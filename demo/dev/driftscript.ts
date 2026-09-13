/**
 * The first vertical slice, running in a browser.
 *
 * A `.drs` file is imported the way a consumer imports one, compiled by the bundler transform,
 * loaded through the runtime, driven from a frame loop, and edited live — with the state it
 * operates on surviving the edit. Those are §48's steps 1 and 5 through 8, and this page is where
 * they are true rather than tested.
 *
 * **The state object is created once, outside the reload path.** That is the whole demonstration:
 * editing `pulse.drs` swaps the function while `state` keeps the phase it had reached, so the
 * circle does not jump. A page that recreated state on reload would show the same picture and prove
 * nothing.
 */
import {
  type TaskBody,
  loadModule,
  on,
  patchModule,
  setClockSource,
  spawn,
  tickTasks,
} from 'driftscript';
import * as pulse from './pulse.drs';

interface PulseState {
  phase: number;
  rate: number;
}

/* Everything the panel prints about the record, so a field added by a hot reload shows up rather
   than having to be predicted here. */
const fieldsOf = (value: object): string =>
  Object.entries(value)
    .map(([key, held]) => `${key}=${typeof held === 'number' ? held.toFixed(2) : String(held)}`)
    .join(' ');

const out = document.getElementById('out') as HTMLElement;
const dot = document.getElementById('dot') as HTMLElement;

/*
 * The clock, before the module loads, because a spawn runs its task up to the first await — and an
 * await asks the clock what step it is on. A module loaded first would spawn against no clock and
 * the runtime would refuse in words rather than return a plausible zero.
 *
 * `fixedSteps` is a **count**, not a duration. Adding a sixtieth sixty times a second drifts, and a
 * task awaiting 500ms against an accumulated clock misses the step it named — 30 additions of 1/60
 * is 0.49999999999999994.
 */
let steps = 0;
let elapsed = 0;
const FIXED_STEP = 1 / 60;
setClockSource({
  fixedSteps: () => steps,
  fixedStep: () => FIXED_STEP,
  frame: () => elapsed,
  wall: () => elapsed,
});

const module = loadModule(pulse as unknown as Record<string, unknown>);
const state = (module.exports.createPulseState as () => PulseState)();

/*
 * The event side, listening from TypeScript.
 *
 * This is the same door the generated code uses — a host that wants to see a script's events calls
 * `on` with the module's scope, and disposing the module closes it. Nothing about the listener is
 * privileged for being written in TypeScript.
 */
let beats = 0;
on(
  'Trigger',
  () => {
    beats += 1;
  },
  module.scope,
);

spawn(module.exports.beat as TaskBody, module.scope);

let reloads = 0;
let lastReload = '';

/*
 * Vite's HMR types, declared locally, and **called in the shape Vite can see**.
 *
 * The types live in `viteHmr.d.ts` beside this file, for the reason stated there.
 *
 * **The call site's shape is load-bearing and this was got wrong first.** Vite finds accepted
 * dependencies by scanning source for a literal `import.meta.hot.accept(` — it is static analysis,
 * not a runtime registration. An earlier version here read the handle into a local first and called
 * `hot?.accept('./pulse.drs', …)`, which runs perfectly and which Vite cannot see: the module
 * looked as though it accepted nothing, so an edit propagated to the root with no accepting module
 * and Vite fell back to a **full page reload**. The page still worked and the state was destroyed
 * every time, which is precisely the failure hot reload exists to prevent.
 *
 * The cost is that this call may not be wrapped, aliased or generated. What would make it wrong is
 * a bundler that registers accepts at runtime, which Vite deliberately does not.
 */
if (import.meta.hot) {
  import.meta.hot.accept('./pulse.drs', (next) => {
    if (next === undefined) return;
    /*
     * The state goes with the patch, because the runtime holds no instances — a record is a plain
     * object this page owns. Add a field to `PulseState` and save: the field arrives with its
     * default and `phase` keeps the value it had reached.
     */
    const result = patchModule(module, next as Record<string, unknown>, { PulseState: [state] });
    reloads += 1;
    lastReload = result.patched ? 'patched, state preserved' : `refused: ${result.reason}`;
  });
}

/*
 * Two clocks, and the split is the whole point of the panel.
 *
 * The pulse is driven by the frame's own delta, which is right: presentation is outside the
 * determinism boundary, and `ARCHITECTURE.md` places audio and view-dependent work outside it for
 * the same reason. The **beat** is driven by the accumulator below, in whole sixtieths, so it lands
 * on the same step whatever the display is doing — which is what a `@deterministic` task is allowed
 * to wait on and what a replay reproduces.
 *
 * Watch them disagree: `steps` climbs at sixty a second regardless of refresh rate, and `beats`
 * climbs at two.
 */
let previous = performance.now();
let accumulator = 0;

function frame(now: number): void {
  const dt = Math.min((now - previous) / 1000, 0.1);
  previous = now;
  elapsed += dt;

  /*
   * The fixed step, run here rather than by `startLoop`, because this page has no engine in it —
   * it is the language's demo and imports `driftscript` alone. A consumer drives `tickTasks` from
   * `simulate` instead, which is the same call in the place the loop already provides.
   */
  accumulator += dt;
  while (accumulator >= FIXED_STEP) {
    steps += 1;
    accumulator -= FIXED_STEP;
    tickTasks();
  }

  const update = module.exports.update as ((s: PulseState, dt: number) => void) | undefined;
  update?.(state, dt);

  const intensity = 0.5 + 0.5 * Math.sin(state.phase * state.rate);
  dot.style.transform = `scale(${0.6 + intensity * 0.5})`;
  dot.style.opacity = String(0.35 + intensity * 0.65);

  out.textContent = [
    `module    ${module.info.module}`,
    `requires  ${module.info.requires.length === 0 ? '(nothing)' : module.info.requires.join(', ')}`,
    `phase     ${state.phase.toFixed(3)}`,
    `intensity ${intensity.toFixed(3)}`,
    `fields    ${fieldsOf(state)}`,
    `steps     ${steps}`,
    `beats     ${beats}`,
    `reloads   ${reloads}${lastReload === '' ? '' : ` — ${lastReload}`}`,
    '',
    'Edit demo/dev/pulse.drs and save. The phase keeps counting and the beat keeps its place.',
  ].join('\n');

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
