import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import { bindModule, engineRegistry, engineTarget } from '../host.ts';

/**
 * `drift/input`, called from a compiled script against stand-ins for an action map and a touch
 * screen. What this proves is the binding: the names, the handles, and that each capability
 * dispatches to the member it names. The devices themselves are `packages/core`'s suite.
 */

const compile = (source: string) =>
  compileDriftScript(source, {
    filename: 'a.drs',
    registry: engineRegistry(),
    manifest: engineTarget(),
    host: singleFileHost(),
    mode: 'development',
  });

const run = async (source: string) => {
  const result = compile(source);
  /* Any diagnostic fails, warnings included, as the examples' own compile test does. */
  if (result.diagnostics.length > 0) {
    throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  }
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
  )) as Record<string, unknown>;
  const module = loadModule(namespace);
  const bound = bindModule(module, {});
  if (!bound.bound) throw new Error(bound.reason);
  return module;
};

/** A touch screen with a thumb on the stick, one held on the action side, and one tap queued. */
const touchScreen = () => {
  let taps = 1;
  return {
    moveX: 0.5,
    moveY: -0.25,
    primaryHeld: true,
    secondaryHeld: false,
    consumePrimaryPress: () => {
      const tapped = taps > 0;
      taps = 0;
      return tapped;
    },
  };
};

describe('the input binding', () => {
  it('reads an action map: held, pressed, and a direction shortened to the rim', async () => {
    const module = await run(
      'import { axisX, down, pressed, rawAxisX } from "drift/input"\n' +
        '\n' +
        'fn steer(actions: Actions) -> f32 {\n' +
        '    if input.down(actions, "jump") && input.pressed(actions, "jump") {\n' +
        '        return input.axisX(actions, "move") + input.rawAxisX(actions, "move")\n' +
        '    }\n' +
        '    return 0\n' +
        '}\n',
    );
    const actions = {
      down: (action: string) => action === 'jump',
      pressed: (action: string) => action === 'jump',
      vector: (_action: string, out: { x: number; y: number }) => {
        out.x = 0.6;
        out.y = 0.8;
      },
      axis: () => 1,
    };
    expect((module.exports.steer as (a: unknown) => number)(actions)).toBeCloseTo(1.6, 6);
  });

  it('reads a touch screen: the stick, a hold, a slide, and a tap claimed once', async () => {
    const module = await run(
      'import { touchHeld, touchSlide, touchTap, touchX, touchY } from "drift/input"\n' +
        '\n' +
        'fn stick(touch: Touch) -> f32 {\n' +
        '    return input.touchX(touch) * 10 + input.touchY(touch)\n' +
        '}\n' +
        '\n' +
        'fn holding(touch: Touch) -> bool {\n' +
        '    return input.touchHeld(touch) && !input.touchSlide(touch)\n' +
        '}\n' +
        '\n' +
        'fn tapped(touch: Touch) -> bool {\n' +
        '    return input.touchTap(touch)\n' +
        '}\n',
    );
    const touch = touchScreen();
    expect((module.exports.stick as (t: unknown) => number)(touch)).toBeCloseTo(4.75, 6);
    expect((module.exports.holding as (t: unknown) => boolean)(touch)).toBe(true);
    const tapped = module.exports.tapped as (t: unknown) => boolean;
    expect(tapped(touch)).toBe(true);
    expect(tapped(touch)).toBe(false);
  });

  it('keeps touch out of a deterministic function, as it keeps every other device', () => {
    const result = compile(
      'import { touchX } from "drift/input"\n\n@deterministic\nfn lean(touch: Touch) -> f32 {\n    return input.touchX(touch)\n}\n',
    );
    expect(result.diagnostics.some((d) => d.code === 'DS0261')).toBe(true);
  });
});
