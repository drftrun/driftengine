import type { ReadonlyMat4, ReadonlyVec3 } from 'gl-matrix';

import { decalToWorldMatrix, worldToDecalMatrix } from './decalProjector.ts';
import type { DecalBox } from './decalProjector.ts';

/**
 * Screen-space reflection: the frame reflected in a surface, by marching against its own depth.
 *
 * **What a planar reflection cannot reach is the whole reason this exists.** `PlanarReflection`
 * re-renders the world from a mirrored camera for one *horizontal plane at one height*, which is
 * exactly right for a lake and gives nothing for anything else: a floor that undulates, a bonnet,
 * a tilted pane, a wet cobbled street. It also costs a second pass over the scene. This costs one
 * fullscreen pass over the pixels a caller says are reflective, follows the surface per pixel
 * whatever shape it is, and is exact about contact — the point where an object meets the floor,
 * which is the part a viewer reads first and the part a reduced-resolution mirror plane loses.
 *
 * **What it cannot do is see anything the frame did not draw.** A reflection of something behind
 * the camera, or hidden behind the reflecting surface itself, is not in the colour buffer and
 * cannot be recovered from it. That is the honest limit of every screen-space method, and the
 * fades below are what keep it from being an obvious one: a ray that leaves the frame, that points
 * back toward the eye, or that runs a long way before hitting anything is faded out rather than
 * being allowed to answer with the wrong pixel.
 *
 * **Reflective is a region rather than a material, and that is a fact about a forward renderer.**
 * There is no G-buffer, so by the time this pass runs nothing on screen records which surface was
 * polished — that would be a second colour attachment written by every draw path in the engine,
 * which is the same price the temporal row declined for a velocity buffer. A caller declares a
 * `ReflectiveSurface` instead: a box, and a facing rule for which surfaces inside it reflect. It is
 * the shape `DecalProjector` already has, for the same reason.
 */

/**
 * Clip Y negated, for a backend whose framebuffer rows run downward.
 *
 * **Premultiplied into the matrix the shader is handed rather than branched on inside it**, so one
 * expression serves both backends and the convention lives in exactly one place. That is the lesson
 * `DEPTH_01_TO_CLIP_Y_DOWN` records at length, arriving from the other direction: that constant
 * turns a screen position into the world, this turns the world back into a screen position, and a
 * pass that got one of them wrong would march along the mirror image of its own ray.
 *
 * The identity on WebGL2, whose framebuffer origin is the bottom left, so nothing is multiplied
 * there at all.
 */
export const CLIP_Y_FLIP: ReadonlyMat4 = new Float32Array([
  1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/**
 * A world point to a screen position, or false where the frame cannot show it.
 *
 * **False rather than a clamped answer, on both counts.** A point behind the eye has a negative
 * `w`, and dividing by it mirrors the point through the origin — so it comes back as a perfectly
 * ordinary screen position somewhere else in the frame, and a march that believed it would read a
 * depth belonging to a place the ray never went. A point outside the frame has no pixel at all, and
 * sampling for one anyway takes the clamped border texel: a reflection acquires a smear of whatever
 * is at the edge of the screen and drags it as the camera turns.
 *
 * `viewProjection` carries the framebuffer's Y sense already. See `CLIP_Y_FLIP`.
 */
export function projectToUv(
  viewProjection: ReadonlyMat4,
  x: number,
  y: number,
  z: number,
  uv: Float32Array,
): boolean {
  const clipX =
    (viewProjection[0] ?? 0) * x +
    (viewProjection[4] ?? 0) * y +
    (viewProjection[8] ?? 0) * z +
    (viewProjection[12] ?? 0);
  const clipY =
    (viewProjection[1] ?? 0) * x +
    (viewProjection[5] ?? 0) * y +
    (viewProjection[9] ?? 0) * z +
    (viewProjection[13] ?? 0);
  const clipW =
    (viewProjection[3] ?? 0) * x +
    (viewProjection[7] ?? 0) * y +
    (viewProjection[11] ?? 0) * z +
    (viewProjection[15] ?? 0);
  if (clipW <= 0) return false;
  const u = (clipX / clipW) * 0.5 + 0.5;
  const v = (clipY / clipW) * 0.5 + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  uv[0] = u;
  uv[1] = v;
  return true;
}

/** How a march is walked. */
export interface ScreenSpaceMarch {
  /** How many samples along the ray. More is a more accurate hit and a slower pass. */
  readonly steps: number;
  /** How far the ray travels in world metres before it gives up. */
  readonly reachM: number;
  /**
   * How deep a depth sample is treated as being, world metres.
   *
   * **A depth buffer holds one distance per pixel and says nothing about how thick the thing at
   * that distance is.** A march that treats it as an infinitely deep wall reports a hit for every
   * ray that ends up behind anything at all, so a reflection acquires a copy of whatever lies
   * between it and the far plane. This is the number that says how far behind a surface a crossing
   * may land and still be believed.
   */
  readonly thicknessM: number;
}

/** Where a march ended. Reused rather than returned, because the pass runs per pixel. */
export interface ScreenSpaceHit {
  hit: boolean;
  /** Screen position of the hit, 0 to 1. */
  u: number;
  v: number;
  /** How far along the ray it was found, world metres. */
  distanceM: number;
}

export function newScreenSpaceHit(): ScreenSpaceHit {
  return { hit: false, u: 0, v: 0, distanceM: 0 };
}

/**
 * How many times a bracketed crossing is halved.
 *
 * Six, and it was four until the samples stopped being evenly spaced: the brackets at the far end
 * of a quadratic march are several metres wide, and four halvings of one of those is a hit a
 * quarter of a metre out.
 */
const REFINE_STEPS = 6;

/**
 * Where the `i`th of `steps` samples falls along a ray of length `reach`.
 *
 * **Quadratic rather than even, and the difference is the contact seam.** A reflection is read
 * first at the line where an object meets the floor, and that is exactly where an evenly spaced
 * march is worst: the first sample is a whole step out, so every pixel within a step of the contact
 * finds its crossing already behind the object and reports nothing. Measured on
 * `demo/dev/ssr.html`, evenly spaced: a ten-metre reach in 24 steps leaves a visible dark band
 * along the contact and 11,826 reflected pixels, and shortening the reach to four — which is the
 * same thing as a smaller step — closes most of the band and gives 13,184.
 *
 * Spacing the samples by the square of their index buys both: a first step of a few centimetres
 * and a last one of nearly a metre, out where a reflection is faint and about to leave the frame
 * anyway.
 */
export function marchDistance(index: number, steps: number, reachM: number): number {
  const at = index / steps;
  return reachM * at * at;
}

/** Scratch for a projected sample, so a march allocates nothing. */
const UV = new Float32Array(2);

/**
 * March a reflected ray against the depth the frame has already drawn.
 *
 * **This is the arithmetic the shader runs, written where it can be tested.** No GPU is needed to
 * decide when a crossing is a hit, how far off the coarse answer is, or what happens at the edge
 * of the frame — and each of those is a defect that draws a plausible picture rather than failing.
 * `orderIndependent.ts` and `temporalAa.ts` are the same split, and the shader beside this file
 * mirrors it line for line.
 *
 * `project` turns a world point into a screen position and answers false where it lands outside
 * the frame. `sceneDistance` says how far the eye is from whatever the frame drew at a screen
 * position, and `Infinity` where it drew nothing — the sky, which is not a surface and must not be
 * reflected as one.
 *
 * **A hit is a crossing and not a comparison.** The ray has to be in front of the scene at one
 * sample and behind it at the next; a ray that is behind from the start never crossed anything and
 * is looking at the back of the world. That is also what keeps a grazing ray off its own surface:
 * the first sample is a whole step along, and at zero the comparison is a coin toss on rounding
 * taken by every pixel of a reflective floor at once.
 */
export function traceScreenSpaceRay(
  origin: ReadonlyVec3,
  direction: ReadonlyVec3,
  eye: ReadonlyVec3,
  march: ScreenSpaceMarch,
  project: (x: number, y: number, z: number, uv: Float32Array) => boolean,
  sceneDistance: (u: number, v: number) => number,
  out: ScreenSpaceHit,
): boolean {
  out.hit = false;
  out.u = 0;
  out.v = 0;
  out.distanceM = 0;

  const steps = Math.max(1, Math.round(march.steps));
  const ox = origin[0] ?? 0;
  const oy = origin[1] ?? 0;
  const oz = origin[2] ?? 0;
  const dx = direction[0] ?? 0;
  const dy = direction[1] ?? 0;
  const dz = direction[2] ?? 0;
  const ex = eye[0] ?? 0;
  const ey = eye[1] ?? 0;
  const ez = eye[2] ?? 0;

  /*
   * How far behind the scene the previous sample was; negative is in front of it.
   *
   * **Zero to begin with, because the ray starts on the surface it is reflecting off.** A crossing
   * needs the previous sample strictly in front, so the first step cannot form one on its own —
   * which is exactly the self-intersection guard a screen-space march needs. A ray leaving a
   * surface at any angle moves in front of the scene immediately and earns its crossing on the
   * step after; a ray hugging the surface never does, and a floor full of pixels taking that
   * comparison on rounding is the speckle this effect is remembered for.
   */
  let behind = 0;
  let previous = 0;

  for (let i = 1; i <= steps; i++) {
    const t = marchDistance(i, steps, march.reachM);
    const x = ox + dx * t;
    const y = oy + dy * t;
    const z = oz + dz * t;
    if (!project(x, y, z, UV)) return false;

    const scene = sceneDistance(UV[0] ?? 0, UV[1] ?? 0);
    /* Nothing was drawn here, so there is no surface to cross. Carried rather than treated as a
       miss so a ray may pass over a gap in the geometry and hit what is beyond it. */
    if (!Number.isFinite(scene)) {
      /* In front of nothing, which is true and is what lets a ray cross a gap in the geometry —
         a skyline, a doorway — and land on what is beyond it. */
      behind = -Infinity;
      previous = t;
      continue;
    }

    const ray = Math.hypot(x - ex, y - ey, z - ez);
    const gap = ray - scene;

    if (behind < 0 && gap >= 0) {
      /*
       * A crossing, bracketed between `previous` and `t`. Halved rather than reported: the coarse
       * answer is a whole step out, which puts a reflection visibly beside the thing reflected.
       */
      let near = previous;
      let far = t;
      let hitU = UV[0] ?? 0;
      let hitV = UV[1] ?? 0;
      let hitGap = gap;
      for (let refine = 0; refine < REFINE_STEPS; refine++) {
        const mid = (near + far) / 2;
        const mx = ox + dx * mid;
        const my = oy + dy * mid;
        const mz = oz + dz * mid;
        if (!project(mx, my, mz, UV)) break;
        const midScene = sceneDistance(UV[0] ?? 0, UV[1] ?? 0);
        if (!Number.isFinite(midScene)) break;
        const midGap = Math.hypot(mx - ex, my - ey, mz - ez) - midScene;
        if (midGap > 0) {
          far = mid;
          hitU = UV[0] ?? 0;
          hitV = UV[1] ?? 0;
          hitGap = midGap;
        } else {
          near = mid;
        }
      }

      /* Believed only if the refined crossing landed within the thickness. Further behind than
         that and the ray flew past a thin surface rather than landing on it. */
      if (hitGap > march.thicknessM) return false;
      out.hit = true;
      out.u = hitU;
      out.v = hitV;
      out.distanceM = far;
      return true;
    }

    behind = gap;
    previous = t;
  }

  return false;
}

/**
 * How much of a hit survives its distance from the edge of the frame.
 *
 * **A sample off the edge of the frame clamps to the border texel**, so a reflection acquires a
 * smear of whatever is at the edge of the screen and drags it as the camera turns — the failure
 * that looks most like the effect working. The march refuses to sample outside the frame at all;
 * this is the other half, fading a hit *near* the edge so a reflection leaves rather than being
 * cut off along a line.
 *
 * `band` is how much of the frame each side is fade, as a fraction.
 */
export function screenEdgeFade(u: number, v: number, band: number): number {
  if (band <= 0) return u < 0 || u > 1 || v < 0 || v > 1 ? 0 : 1;
  const nearest = Math.min(u, 1 - u, v, 1 - v);
  return Math.min(1, Math.max(0, nearest / band));
}

/**
 * How much of a reflection survives its ray pointing back toward the eye.
 *
 * A ray coming back at the viewer can only find what is between the surface and the camera, which
 * is usually nothing and occasionally the viewer's own geometry — the artefact that reads as a
 * smear of the foreground pasted onto a floor. One at a ray running directly away from the eye,
 * nothing at one running directly into it.
 */
export function towardCameraFade(direction: ReadonlyVec3, viewDirection: ReadonlyVec3): number {
  const dx = direction[0] ?? 0;
  const dy = direction[1] ?? 0;
  const dz = direction[2] ?? 0;
  const vx = viewDirection[0] ?? 0;
  const vy = viewDirection[1] ?? 0;
  const vz = viewDirection[2] ?? 0;
  const dLength = Math.hypot(dx, dy, dz);
  const vLength = Math.hypot(vx, vy, vz);
  if (dLength === 0 || vLength === 0) return 0;
  const along = (dx * vx + dy * vy + dz * vz) / (dLength * vLength);
  return Math.min(1, Math.max(0, (along + 1) / 2));
}

export interface ReflectiveSurfaceOptions extends DecalBox {
  /** How much of what the ray finds lands on the surface, 0 to 1. */
  readonly strength?: number;
  /** How far a ray may travel, world metres. */
  readonly reachM?: number;
  /** How deep a depth sample is treated as being. See `ScreenSpaceMarch.thicknessM`. */
  readonly thicknessM?: number;
  /** How many samples along a ray. */
  readonly steps?: number;
  /** How far from facing the box's own axis a surface may be turned and still reflect. */
  readonly facingCos?: number;
  /** What the reflection is multiplied by, for a tinted mirror. */
  readonly tint?: ReadonlyVec3;
}

/**
 * A box a consumer declares, inside which surfaces reflect what the frame drew.
 *
 * Held and moved, like `DecalProjector` and for the same reason: a wet patch follows the rain and
 * a polished floor does not move at all, and rebuilding two matrices from four vectors is the whole
 * of a pose. Both matrices live in the object and are rewritten in place.
 */
export class ReflectiveSurface {
  /** World space into the box, `[-1, 1]` on each axis. */
  readonly worldToSurface = new Float32Array(16);
  /** The box back into the world, for the scissor bound. */
  readonly surfaceToWorld = new Float32Array(16);
  /** Which way the reflective surfaces inside the box face, normalised and pointing *into* them. */
  readonly axis = new Float32Array(3);
  readonly tint = new Float32Array(3);

  strength: number;
  reachM: number;
  thicknessM: number;
  steps: number;
  facingCos: number;

  private readonly box: {
    center: Float32Array;
    halfExtents: Float32Array;
    forward: Float32Array;
    up: Float32Array;
  };

  constructor(options: ReflectiveSurfaceOptions) {
    this.box = {
      center: Float32Array.from(options.center as ArrayLike<number>),
      halfExtents: Float32Array.from(options.halfExtents as ArrayLike<number>),
      forward: Float32Array.from(options.forward as ArrayLike<number>),
      up: Float32Array.from(options.up as ArrayLike<number>),
    };
    this.tint.set(options.tint === undefined ? [1, 1, 1] : (options.tint as ArrayLike<number>));
    /* Half, because a mirror is the rare case: a wet floor, polished stone and a car bonnet all
       return a fraction of what lands on them, and a consumer who wants a mirror asks for one. */
    this.strength = options.strength ?? 0.5;
    /* Eight metres covers a room and a street corner. Further costs steps rather than accuracy,
       since the step is the reach divided by them. */
    this.reachM = options.reachM ?? 8;
    /* A quarter of a metre. Thinner rejects a real hit on a coarsely stepped ray; thicker starts
       reflecting what is behind a wall. */
    this.thicknessM = options.thicknessM ?? 0.25;
    this.steps = options.steps ?? 24;
    /* The same 0.1 `projectDecal` and `DecalProjector` default to, and for the same reason. */
    this.facingCos = options.facingCos ?? 0.1;
    this.rebuild();
  }

  /** Move the box. Allocation-free, so a wet patch may follow the weather every frame. */
  setPose(center: ReadonlyVec3, forward: ReadonlyVec3, up: ReadonlyVec3): void {
    this.box.center.set(center as ArrayLike<number>);
    this.box.forward.set(forward as ArrayLike<number>);
    this.box.up.set(up as ArrayLike<number>);
    this.rebuild();
  }

  setSize(halfExtents: ReadonlyVec3): void {
    this.box.halfExtents.set(halfExtents as ArrayLike<number>);
    this.rebuild();
  }

  private rebuild(): void {
    worldToDecalMatrix(this.worldToSurface, this.box);
    decalToWorldMatrix(this.surfaceToWorld, this.box);
    const f = this.box.forward;
    const length = Math.hypot(f[0] ?? 0, f[1] ?? 0, f[2] ?? 0);
    this.axis[0] = (f[0] ?? 0) / length;
    this.axis[1] = (f[1] ?? 0) / length;
    this.axis[2] = (f[2] ?? 0) / length;
  }
}

/**
 * How many reflective surfaces one frame may draw.
 *
 * **A cap rather than an open number**, for the reason `MAX_DRAWN_DECALS` gives: each is a
 * scissored pass with a uniform slot behind it, and the slots are one buffer written before the
 * passes are recorded. Eight is lower than the decal cap on purpose — a mark costs a texture fetch
 * per pixel and a reflection costs a march, so a scene wanting dozens of reflective regions is
 * asking for something a screen-space method should refuse rather than deliver slowly.
 */
export const MAX_REFLECTIVE_SURFACES = 8;

/**
 * How much of the frame each side fades a hit out, as a fraction.
 *
 * **One number for both backends**, because it decides where a reflection stops and two copies of
 * it is a reflection that ends in a different place on each — the 2026-08-13 rule in `AGENTS.md`
 * applied to a fade. A tenth is wide enough that a reflection leaving the frame reads as leaving
 * rather than as being cut off, and narrow enough that the middle of the picture is untouched.
 */
export const REFLECTION_EDGE_FADE = 0.1;

/** One recorded surface. Every field is a copy of what it held when it was submitted. */
export interface RecordedReflection {
  readonly worldToSurface: Float32Array;
  readonly surfaceToWorld: Float32Array;
  readonly axis: Float32Array;
  readonly tint: Float32Array;
  strength: number;
  reachM: number;
  thicknessM: number;
  steps: number;
  facingCos: number;
}

function newRecord(): RecordedReflection {
  return {
    worldToSurface: new Float32Array(16),
    surfaceToWorld: new Float32Array(16),
    axis: new Float32Array(3),
    tint: new Float32Array(3),
    strength: 0.5,
    reachM: 8,
    thicknessM: 0.25,
    steps: 24,
    facingCos: 0.1,
  };
}

/**
 * The frame's reflective surfaces, held until the pass that reads the finished picture can run.
 *
 * **Here rather than in a file of its own**, unlike `DecalQueue`: it is the same twenty lines of
 * pooling around a different record, and this row adds a shader as well as a pass, so the module
 * that would hold it is one more entry in every consumer's bundle for no reader's benefit.
 *
 * Everything is copied, for the reason `TranslucentQueue` states: a surface is an object a consumer
 * keeps and moves, so a queue holding the reference would replay every one of them wearing the last
 * pose written.
 */
export class ReflectionQueue {
  private readonly pool: RecordedReflection[] = [];
  private count = 0;
  private warned = false;

  get length(): number {
    return this.count;
  }

  /** How many records are pooled, which a test uses to assert a steady scene stops allocating. */
  get capacity(): number {
    return this.pool.length;
  }

  record(surface: ReflectiveSurface): void {
    if (this.count >= MAX_REFLECTIVE_SURFACES) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `driftengine: more than ${MAX_REFLECTIVE_SURFACES} reflective surfaces in one frame, so ` +
            'the rest are dropped. Each one marches a ray per covered pixel, which is not a cost ' +
            'to pay for a region nobody is looking at — cull them, or widen one box instead.',
        );
      }
      return;
    }

    let record = this.pool[this.count];
    if (record === undefined) {
      record = newRecord();
      this.pool.push(record);
    }
    record.worldToSurface.set(surface.worldToSurface);
    record.surfaceToWorld.set(surface.surfaceToWorld);
    record.axis.set(surface.axis);
    record.tint.set(surface.tint);
    record.strength = Math.min(1, Math.max(0, surface.strength));
    record.reachM = Math.max(0, surface.reachM);
    record.thicknessM = Math.max(0, surface.thicknessM);
    record.steps = Math.min(32, Math.max(1, Math.round(surface.steps)));
    record.facingCos = surface.facingCos;
    this.count++;
  }

  replay(each: (surface: RecordedReflection) => void): void {
    for (let i = 0; i < this.count; i++) {
      const record = this.pool[i];
      if (record !== undefined) each(record);
    }
  }

  /** Empty it for the next frame, keeping the storage. */
  reset(): void {
    this.count = 0;
  }
}
