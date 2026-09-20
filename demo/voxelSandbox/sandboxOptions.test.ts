import { describe, expect, test } from 'vitest';

import {
  MAX_RADIUS,
  PORT_SHADOW_RADIUS,
  sandboxEnvironment,
  sandboxOptions,
} from './sandboxOptions';

describe('what the page asks for', () => {
  test('WITH NO FLAGS THE SANDBOX IS WHAT IT WAS, to the last digit', () => {
    /*
     * The fog radii were two constants written against a radius of six, and the published capture
     * is the forward path at that radius. So the defaults are the old expressions verbatim —
     * `(RENDER_RADIUS - 1) * 16 * 0.6` and `RENDER_RADIUS * 16 * 0.95` — and the camera's far plane
     * is the 220 the constructor set.
     */
    expect(sandboxOptions('', 6)).toEqual({
      pipeline: 'forward',
      radius: 6,
      fogStart: (6 - 1) * 16 * 0.6,
      fogEnd: 6 * 16 * 0.95,
      far: 220,
      at: null,
      look: null,
      fly: null,
      portShadow: false,
    });
    /* The lean budget's radius, which the fog never followed until now. */
    const lean = sandboxOptions('', 4);
    expect(lean.fogStart).toBe((4 - 1) * 16 * 0.6);
    expect(lean.fogEnd).toBe(4 * 16 * 0.95);
  });

  test('A PIPELINE THE HOST ASKED FOR WINS OVER THE ADDRESS, which is the harness\u2019s', () => {
    /*
     * A consumer's demos page mounts from `SCENES` and chooses among the sandbox's `pipelines`; the
     * query is the harness's way in, and a page that chose should get what it chose.
     */
    expect(sandboxOptions('?pipeline=forward', 6, 'gpu-driven').pipeline).toBe('gpu-driven');
    expect(sandboxOptions('?pipeline=gpu-driven', 6, 'forward').pipeline).toBe('forward');
    expect(sandboxOptions('?pipeline=gpu-driven', 6).pipeline).toBe('gpu-driven');
  });

  test('?pipeline=gpu-driven selects the port, and anything else keeps the forward path', () => {
    expect(sandboxOptions('?pipeline=gpu-driven', 6).pipeline).toBe('gpu-driven');
    for (const other of ['', '?pipeline=forward', '?pipeline=GPU-DRIVEN', '?pipeline=']) {
      expect(sandboxOptions(other, 6).pipeline).toBe('forward');
    }
  });

  test('?RADIUS= MOVES THE WORLD AND ITS HAZE TOGETHER, on both pipelines', () => {
    /*
     * **One number, because two would drift.** A radius that moved without the fog leaves the
     * world ending at a hard circle past a haze that stopped short of it, or a haze that swallows
     * terrain the player is standing next to.
     */
    for (const search of ['?radius=10', '?radius=10&pipeline=gpu-driven']) {
      const asked = sandboxOptions(search, 6);
      expect(asked.radius).toBe(10);
      expect(asked.fogStart).toBe((10 - 1) * 16 * 0.6);
      expect(asked.fogEnd).toBe(10 * 16 * 0.95);
    }
  });

  test('and the far plane follows the haze once the haze would reach past it', () => {
    /* 220 m holds the world out to a radius of thirteen; past that the fog's far edge is clipped. */
    expect(sandboxOptions('?radius=13', 6).far).toBe(220);
    const wide = sandboxOptions('?radius=16', 6);
    expect(wide.far).toBeGreaterThan(wide.fogEnd);
    expect(wide.far).toBe(Math.ceil(16 * 16 * 0.95) + 16);
  });

  test('a radius that is not a whole number of chunks between one and the cap is ignored', () => {
    for (const nonsense of ['abc', '0', '-3', '2.5', `${MAX_RADIUS + 1}`, '']) {
      expect(sandboxOptions(`?radius=${nonsense}`, 6).radius).toBe(6);
    }
    expect(sandboxOptions(`?radius=${MAX_RADIUS}`, 6).radius).toBe(MAX_RADIUS);
  });
});

describe('where the page stands the player', () => {
  test('?AT= AND ?LOOK= PUT THE EYE WHERE A COMPARISON NEEDS IT, and nothing else moves it', () => {
    /*
     * **A capture sees one view, and the spawn's has no water in it.** The port's blended half —
     * water and glass — has to be photographed on both pipelines from one place, so the page can
     * be told where to stand and which way to look. Degrees, because that is what a person types.
     */
    const asked = sandboxOptions('?at=0,-30&look=0,-12', 6);
    expect(asked.at).toEqual({ x: 0, z: -30 });
    expect(asked.look).toEqual({ yaw: 0, pitch: -12 });
  });

  test('a place or a heading that is not two numbers is ignored', () => {
    for (const nonsense of ['?at=1', '?at=a,b', '?at=1,2,3', '?at=', '?look=5', '?look=x,1']) {
      const asked = sandboxOptions(nonsense, 6);
      expect(asked.at).toBeNull();
      expect(asked.look).toBeNull();
    }
  });
});

describe('a player the page moves', () => {
  test('?FLY= MOVES THE EYE AT A FIXED SPEED, so a measurement streams chunks as walking does', () => {
    /*
     * **Walked rather than idled**, which is what the comparison has to be: the forward path's
     * limit is draw submission and the port's is capacity, and neither shows on a camera that
     * stands still while the ring around it is already built. A fixed speed over a fixed path is
     * reproducible, where a person walking is not.
     */
    expect(sandboxOptions('?fly=8', 6).fly).toBe(8);
    for (const nonsense of ['?fly=', '?fly=fast', '?fly=0', '?fly=-3', '?fly=Infinity']) {
      expect(sandboxOptions(nonsense, 6).fly).toBeNull();
    }
  });
});

describe('a shadow the page can ask the port for', () => {
  test('?PORTSHADOW=1 TURNS THE SECOND PIPELINE\u2019S SUN SHADOW ON, for a measurement', () => {
    /*
     * **Off unless asked, because the forward sandbox draws none** and the two are compared doing
     * the same work. It exists to measure the second pipeline's shadow stage on a world, which is
     * where it was found drawing every slot of the scene's capacity; the published sandbox never
     * sets it.
     */
    expect(sandboxOptions('?portshadow=1', 6).portShadow).toBe(true);
    for (const other of ['', '?portshadow=0', '?portshadow=yes', '?portshadow=', '?portShadow=1']) {
      expect(sandboxOptions(other, 6).portShadow).toBe(false);
    }
  });

  test('its map follows the eye over a few chunks, rather than stretching over the world', () => {
    /* Three chunks either way: a 2048 map over 96 metres is texels of under five centimetres. */
    expect(PORT_SHADOW_RADIUS).toBe(3 * 16);
  });
});

describe('the environment the sandbox lights its world with', () => {
  test('THE HAZE IS THE REFERENCE’S LINEAR RAMP ON THE RADII THE PAGE ASKED FOR', () => {
    const asked = sandboxOptions('?radius=9', 6);
    const env = sandboxEnvironment(asked);
    expect(env.fogMode).toBe('linear');
    expect(env.fogNear).toBe(asked.fogStart);
    expect(env.fogFar).toBe(asked.fogEnd);
  });

  test('BLOCK LIGHT IS SCALED BY ONE, so the night factor alone decides when a torch shows', () => {
    /*
     * **It was zero, and every torch in the world was dark at every hour.** The mesher writes
     * block light into the vertex's emissive and says it is "gated on the environment's
     * nightFactor"; the forward shader multiplies it by `uEmissiveGain` as well, which this
     * environment set to 0 and nothing ever raised. On WebGPU that was invisible while the backend
     * hard-coded the gain to 1, and became total the day it started reading the environment.
     */
    expect(sandboxEnvironment(sandboxOptions('', 6)).emissiveGain).toBe(1);
  });
});
