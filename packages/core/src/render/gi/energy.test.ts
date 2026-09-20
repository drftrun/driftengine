import { expect, test } from 'vitest';

import { ProbeGrid } from '../probeGrid.ts';
import { newIndirectResult, traceIndirect } from './chain.ts';
import { createGlobalField, composeGlobalField } from './globalField.ts';
import { createProbeVisibility, bakeProbeVisibility } from './probeVolume.ts';

import type { GiResources } from './chain.ts';
import type { FieldSource } from './globalField.ts';

/** No rotation and no offset, for the one instance any of these furnaces holds. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * **The white furnace: a uniformly emitting enclosure with a white surface converges to the
 * radiance it emits, rather than brightening without bound.**
 *
 * This is the test a global illumination solution passes or fails silently. A path that gains one
 * per cent a bounce looks *better* than a correct one for the first few frames — brighter, warmer,
 * more filled in — and passes every visual check anybody thinks to run. On the tenth frame it
 * blows out, and by then the gain is spread across a blend, a renormalisation and an interpolation
 * and no single line looks wrong.
 *
 * **Bounced rather than sampled once**, because a single pass cannot see a gain of a per cent.
 * Thirty bounces multiply it by 1.35 and a loss by 0.74, both of which an assertion can hold.
 */

const BOUNCES = 30;

/** A sphere's exact field, for the object a furnace has to make disappear. */
function sphereField(radius: number, half: number, resolution: number): FieldSource {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        field[ix + resolution * (iy + resolution * iz)] =
          Math.hypot(-half + ix * step, -half + iy * step, -half + iz * step) - radius;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

/** The frame, for the furnace that is also on screen. Eye at the origin looking down `-z`. */
function project(x: number, y: number, z: number, uv: Float32Array): boolean {
  if (z >= -1e-4) return false;
  const u = 0.5 + x / (-z * 2);
  const v = 0.5 + y / (-z * 2);
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  uv[0] = u;
  uv[1] = v;
  return true;
}

interface FurnaceOptions {
  /** A white sphere in the middle, so the world-space level has something to answer with. */
  readonly occluder?: boolean;
  /** A frame, so the screen-space level answers too and all three shares are exercised. */
  readonly framed?: boolean;
}

function furnace(emitted: number, options: FurnaceOptions = {}): GiResources {
  const field = createGlobalField(17, 2);
  composeGlobalField(
    options.occluder === true ? [{ source: sphereField(1, 2, 17), transform: IDENTITY }] : [],
    [0, 0, 0],
    4,
    field,
  );

  const grid = new ProbeGrid({ origin: [-4, -4, -4], spacing: [4, 4, 4], counts: [3, 3, 3] });
  const visibility = createProbeVisibility(8, grid.layers);
  for (let layer = 0; layer < grid.layers; layer++) {
    /* Nothing is in the way anywhere, which is what an empty furnace means. */
    bakeProbeVisibility(visibility, layer, () => 50);
  }
  const probeValues = new Float32Array(grid.layers * 3).fill(emitted);

  return {
    eye: [0, 0, 0],
    project: options.framed === true ? project : () => false,
    sceneDistance:
      options.framed === true
        ? (u, v) => Math.hypot((u - 0.5) * 10, (v - 0.5) * 10, 5)
        : () => Infinity,
    screenRadiance: (_u, _v, out) => out.fill(emitted),
    field,
    fieldRadiance: (_x, _y, _z, out) => out.fill(emitted),
    grid,
    visibility,
    probeValues,
    probeChannels: 3,
  };
}

/** The mean radiance arriving at a point, over a deterministic fan of directions. */
function gathered(resources: GiResources, x: number, y: number, z: number, rays = 24): number {
  const out = newIndirectResult();
  let total = 0;
  for (let i = 0; i < rays; i++) {
    /* A spherical Fibonacci fan, so the directions do not clump on an axis. */
    const cosTheta = 1 - (2 * i + 1) / rays;
    const radius = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    traceIndirect(
      {
        point: [x, y, z],
        normal: [0, 1, 0],
        direction: [radius * Math.cos(phi), cosTheta, radius * Math.sin(phi)],
        coneAngle: 0,
      },
      resources,
      out,
    );
    total += out.radiance[0] as number;
  }
  return total / rays;
}

test('a ray in a uniform environment returns exactly what the environment holds', () => {
  /*
   * The single-pass statement, and it is the one the blend has to satisfy: three levels sharing
   * one unit of light mean a uniform environment comes back unchanged whatever share each took.
   * Anything else is energy created or lost by the *interpolation*, before any bounce.
   */
  const resources = furnace(1);
  for (const [x, y, z] of [
    [0, 0, 0],
    [1.7, -0.4, 2.3],
    [-3.9, 3.9, 0],
  ] as const) {
    expect(gathered(resources, x, y, z)).toBeCloseTo(1, 5);
  }
});

test('A WHITE OBJECT IN A WHITE FURNACE DISAPPEARS, which is the classic statement of this', () => {
  /*
   * **An empty furnace never asks the world-space level anything**, because every ray escapes and
   * the probes answer alone — so the share arithmetic between the three levels is untested by it,
   * and a chain that handed the probes a whole unit *on top of* whatever the field contributed
   * would pass. A sphere in the middle is what makes the field answer, and a white sphere in a
   * white furnace is invisible: every direction, occluded or not, carries the same radiance.
   *
   * With a frame as well, all three levels contribute to the same ray and the three shares have
   * to come to exactly one.
   */
  for (const options of [{ occluder: true }, { occluder: true, framed: true }]) {
    const resources = furnace(1, options);
    for (const [x, y, z] of [
      [0, 0, -3],
      [1.2, 0.4, -2.5],
      [-0.6, -1.1, -3.4],
    ] as const) {
      expect(gathered(resources, x, y, z), JSON.stringify(options)).toBeCloseTo(1, 4);
    }
  }
});

test('A WHITE FURNACE CONVERGES over thirty bounces rather than brightening without bound', () => {
  /*
   * Albedo one, emitted radiance one, and the enclosure is uniform — so every bounce has to return
   * the value it was handed. A gain of a per cent a bounce reaches 1.35 by the thirtieth and a loss
   * reaches 0.74; the tolerance below is a thousandth, which is two orders under either.
   */
  const resources = furnace(1);
  const probeValues = resources.probeValues;
  const probeAt: [number, number, number] = [0, 0, 0];
  const next = new Float32Array(probeValues.length);

  let worstStep = 0;
  for (let bounce = 0; bounce < BOUNCES; bounce++) {
    for (let layer = 0; layer < resources.grid.layers; layer++) {
      resources.grid.positionOf(layer, probeAt);
      const arriving = gathered(resources, probeAt[0], probeAt[1], probeAt[2], 16);
      /* Albedo one: a white surface returns everything it receives. */
      next[layer * 3] = arriving;
      next[layer * 3 + 1] = arriving;
      next[layer * 3 + 2] = arriving;
    }
    for (let i = 0; i < probeValues.length; i++) {
      worstStep = Math.max(worstStep, Math.abs((next[i] as number) - (probeValues[i] as number)));
      probeValues[i] = next[i] as number;
    }
  }

  /* It did not move, and it did not move in either direction. */
  expect(worstStep).toBeLessThan(1e-3);
  for (let i = 0; i < probeValues.length; i++) {
    expect(probeValues[i] as number).toBeCloseTo(1, 3);
  }
});

test('A GREY FURNACE CONVERGES TO THE SERIES IT IS, rather than to whatever it started at', () => {
  /*
   * **The white furnace alone cannot tell "returns what it was handed" from "returns one".** A
   * solution that clamped every answer to the emitted radiance would pass it perfectly. At albedo
   * 0.6 with an emitted 0.4 the closed form is `e / (1 - a)` — exactly one — and the sequence has
   * to *arrive* there from somewhere else rather than start there.
   */
  const albedo = 0.6;
  const emitted = 0.4;
  const resources = furnace(emitted);
  const probeValues = resources.probeValues;
  const probeAt: [number, number, number] = [0, 0, 0];
  const next = new Float32Array(probeValues.length);

  /* Start dark, so arriving at the answer is something that happened rather than something set. */
  probeValues.fill(0);

  for (let bounce = 0; bounce < BOUNCES; bounce++) {
    for (let layer = 0; layer < resources.grid.layers; layer++) {
      resources.grid.positionOf(layer, probeAt);
      const arriving =
        emitted + albedo * gathered(resources, probeAt[0], probeAt[1], probeAt[2], 16);
      next[layer * 3] = arriving;
      next[layer * 3 + 1] = arriving;
      next[layer * 3 + 2] = arriving;
    }
    probeValues.set(next);
  }

  for (let i = 0; i < probeValues.length; i++) {
    expect(probeValues[i] as number).toBeCloseTo(emitted / (1 - albedo), 3);
  }
});
