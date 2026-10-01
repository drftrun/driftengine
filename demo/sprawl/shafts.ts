/**
 * The light standing in the city's air — the lamps' cones, the pylons' beams — drawn as volumes the
 * view ray walks through (`drawLightVolume`), by the city's night.
 *
 * **Light, not a surface.** The bake leaves these out of the geometry (`bake/mesh/volumes.ts`):
 * added as meshes they showed by day as lit, fogged solids, grey wherever the air was thick, and
 * at night as hard-edged shapes. A volume is unlit, unfogged and adds nothing at zero strength, so
 * by day it is simply not drawn, and at night it is a glow that thins toward its foot and its rim.
 *
 * **Each shaft's strength is the night's, times two fades by distance**: out past its far fade, as
 * the reference fades a cone's glow from 40 to 95 m, and out near the eye, so the camera walking
 * into a cone does not meet a wall of light; and times its pulse. Distance is to the shaft's axis,
 * the line its light stands along.
 *
 * **The nearest `MAX_SHAFTS` in view are drawn**: the engine takes that many volumes a frame, and
 * a volume's march is paid by every pixel it covers. The farthest of them is faint by then, which
 * is what keeps the choice from being seen. What would make it wrong is a view with more than that
 * many bright shafts close by — a boulevard seen end-on at night — where the farthest drop out.
 */
import { buildLightVolume, sphereInFrustum } from '../../packages/core/src/index';
import type { Camera, FrustumPlanes, MeshHandle, RendererApi } from '../../packages/core/src/index';

import type { ShaftData } from './scene';

/** How many a frame: the engine's light volumes per frame. */
export const MAX_SHAFTS = 32;
/** How far a shaft with no fade of its own is drawn. */
const FAR = 600;
/**
 * How bright one of the reference's units of shaft colour draws: its volumes are shaded by its own
 * falloffs, so the scale is chosen by eye against its night captures, like the lamps' exposure.
 */
const SHAFT_EXPOSURE = 20;
/** The floats a shaft keeps: apex, axis, near, length, spread, fades, pulse, hull, reach. */
const FLOATS = 16;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * A shaft's strength, 0 to 1: `night`, faded out between `fadeStart` and `fadeEnd` metres from the
 * eye where it has a fade, and in inside `nearFade` metres, and pulsed at `hz` by `depth` at `t`.
 */
export function shaftStrength(
  night: number,
  distance: number,
  fadeStart: number,
  fadeEnd: number,
  nearFade: number,
  hz: number,
  depth: number,
  t: number,
): number {
  const far = fadeEnd > 0 ? 1 - smooth(fadeStart, fadeEnd, distance) : 1;
  const near = nearFade > 0 ? smooth(0, nearFade, distance) : 1;
  const pulse = 1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * hz * t));
  return night * far * near * pulse;
}

/** How far (x, y, z) is from the segment `a` + s·`d` for s in [s0, s1], `d` a unit vector. */
export function segmentDistance(
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
  s0: number,
  s1: number,
): number {
  const s = Math.min(Math.max((x - ax) * dx + (y - ay) * dy + (z - az) * dz, s0), s1);
  return Math.hypot(x - ax - dx * s, y - ay - dy * s, z - az - dz * s);
}

export class CityShafts {
  private readonly records: Float32Array;
  private readonly hulls: MeshHandle[] = [];
  private readonly model = new Float32Array(16);
  private readonly chosen = new Int32Array(MAX_SHAFTS);
  private readonly nearness = new Float32Array(MAX_SHAFTS);
  /** How many were drawn last frame. */
  drawn = 0;

  constructor(
    private readonly renderer: RendererApi,
    shafts: readonly ShaftData[],
  ) {
    this.records = new Float32Array(shafts.length * FLOATS);
    /* One hull a shape and colour: a city's cones are a handful of kinds. */
    const hullOf = new Map<string, number>();
    shafts.forEach((s, i) => {
      const color = [s.r * SHAFT_EXPOSURE, s.g * SHAFT_EXPOSURE, s.b * SHAFT_EXPOSURE] as const;
      const key = [s.near, s.length, s.spread, ...color].map((v) => v.toFixed(4)).join(',');
      let hull = hullOf.get(key);
      if (hull === undefined) {
        hull = this.hulls.length;
        hullOf.set(key, hull);
        this.hulls.push(
          renderer.createMesh(
            buildLightVolume({
              lengthM: s.length,
              spread: s.spread,
              nearM: s.near,
              color: [color[0], color[1], color[2]],
            }),
          ),
        );
      }
      const r = this.records;
      const o = i * FLOATS;
      r.set([s.x, s.y, s.z, s.dx, s.dy, s.dz, s.near, s.length, s.spread], o);
      r.set([s.fadeStart, s.fadeEnd, s.nearFade, s.pulseHz, s.pulseDepth, hull], o + 9);
      /* Half its length and its foot's radius: a sphere about its middle holds it. */
      r[o + 15] = (s.length - s.near) / 2 + s.length * s.spread * 1.15;
    });
  }

  /** Draws the nearest shafts in view at `night`, seen from (x, y, z), at `t` seconds. */
  draw(
    camera: Camera,
    frustum: FrustumPlanes,
    night: number,
    t: number,
    x: number,
    y: number,
    z: number,
  ): void {
    this.drawn = 0;
    if (night <= 0) return;
    const r = this.records;
    let count = 0;
    for (let o = 0; o < r.length; o += FLOATS) {
      const ax = r[o] as number;
      const ay = r[o + 1] as number;
      const az = r[o + 2] as number;
      const dx = r[o + 3] as number;
      const dy = r[o + 4] as number;
      const dz = r[o + 5] as number;
      const near = r[o + 6] as number;
      const length = r[o + 7] as number;
      const distance = segmentDistance(x, y, z, ax, ay, az, dx, dy, dz, near, length);
      const fadeEnd = r[o + 10] as number;
      if (distance >= (fadeEnd > 0 ? fadeEnd : FAR)) continue;
      const mid = (near + length) / 2;
      const reach = r[o + 15] as number;
      if (!sphereInFrustum(frustum, ax + dx * mid, ay + dy * mid, az + dz * mid, reach)) continue;
      /* Kept nearest first; a farther one past a full list is dropped. */
      let at = count < MAX_SHAFTS ? count : MAX_SHAFTS - 1;
      if (count === MAX_SHAFTS && distance >= (this.nearness[at] as number)) continue;
      while (at > 0 && (this.nearness[at - 1] as number) > distance) {
        this.nearness[at] = this.nearness[at - 1] as number;
        this.chosen[at] = this.chosen[at - 1] as number;
        at -= 1;
      }
      this.nearness[at] = distance;
      this.chosen[at] = o;
      if (count < MAX_SHAFTS) count += 1;
    }
    for (let i = 0; i < count; i++) {
      const o = this.chosen[i] as number;
      const strength = shaftStrength(
        night,
        this.nearness[i] as number,
        r[o + 9] as number,
        r[o + 10] as number,
        r[o + 11] as number,
        r[o + 12] as number,
        r[o + 13] as number,
        t,
      );
      if (strength <= 0) continue;
      this.place(o);
      const hull = this.hulls[r[o + 14] as number];
      if (hull === undefined) continue;
      this.renderer.drawLightVolume(
        hull,
        this.model,
        camera,
        strength,
        r[o + 7] as number,
        r[o + 8] as number,
        {
          nearM: r[o + 6] as number,
        },
      );
      this.drawn += 1;
    }
  }

  /** The model matrix taking the hull's +z along the shaft's axis, its origin to the apex. */
  private place(o: number): void {
    const r = this.records;
    const m = this.model;
    const zx = r[o + 3] as number;
    const zy = r[o + 4] as number;
    const zz = r[o + 5] as number;
    /* Any direction off the axis makes the basis, the light being round about it: up, unless the
       axis is nearly up, then x. x = up × z, normalised; y = z × x. */
    const steep = Math.abs(zy) >= 0.99;
    let xx = steep ? 0 : zz;
    let xy = steep ? -zz : 0;
    let xz = steep ? zy : -zx;
    const n = Math.hypot(xx, xy, xz);
    xx /= n;
    xy /= n;
    xz /= n;
    m[0] = xx;
    m[1] = xy;
    m[2] = xz;
    m[3] = 0;
    m[4] = zy * xz - zz * xy;
    m[5] = zz * xx - zx * xz;
    m[6] = zx * xy - zy * xx;
    m[7] = 0;
    m[8] = zx;
    m[9] = zy;
    m[10] = zz;
    m[11] = 0;
    m[12] = r[o] as number;
    m[13] = r[o + 1] as number;
    m[14] = r[o + 2] as number;
    m[15] = 1;
  }
}
