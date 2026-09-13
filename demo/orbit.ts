/**
 * A camera a viewer can take hold of: drag to turn, wheel to zoom.
 *
 * Shared by every scene rather than written five times, because it is the same problem
 * five times: a demo runs an automatic camera, and the moment somebody wants to look at
 * something in particular, the automatic camera is in their way.
 *
 * **Pure state and arithmetic.** It reads no events and touches no DOM. Whatever mounts
 * a scene owns the pointer and the wheel, because that is where the element is; this
 * owns what those gestures *mean*, because that is the part every consumer would
 * otherwise get subtly differently.
 *
 * **The handover is the interesting part.** While nobody has touched it, the view
 * follows the scene's own camera every frame, so its yaw, pitch and distance are always
 * the automatic camera's. The instant a drag begins it takes over from exactly where
 * the eye already was, with no jump. That is the whole reason `follow` exists and is
 * called on frames where it appears to do nothing.
 */

import { TAU, clamp } from '../packages/core/src/index';
import type { Camera } from '../packages/core/src/index';

/** How far a drag turns the view: radians per pixel, at a typical canvas width. */
const YAW_PER_PIXEL = 0.0062;
const PITCH_PER_PIXEL = 0.0045;
/**
 * How much one wheel notch changes the distance, as a fraction.
 *
 * Multiplicative rather than additive, because zoom is perceived in ratios: a metre
 * closer means everything when you are two metres away and nothing when you are fifty.
 */
const ZOOM_PER_STEP = 0.12;

/** Never quite at the poles, where yaw stops meaning anything and the view rolls. */
const PITCH_LIMIT = TAU / 4 - 0.06;

export class OrbitView {
  /** Whether the viewer has taken over. Until then this follows the scene. */
  taken = false;

  private yaw = 0;
  private pitch = 0;
  private distance = 10;
  /**
   * The room the eye is kept inside, or zero for a world with no walls.
   *
   * Zero by default because most scenes here are unbounded — a sea to the horizon, a hillside, a
   * storm — and a containment box would be an invention in every one of them.
   */
  private boundsX = 0;
  private boundsZ = 0;
  private boundsY = Number.POSITIVE_INFINITY;
  private targetX = 0;
  private targetY = 0;
  private targetZ = 0;

  /** How close and how far a viewer may get, in metres. Scenes differ; both are set. */
  private readonly minDistance: number;
  private readonly maxDistance: number;
  /**
   * The lowest the eye may go, in world metres.
   *
   * A scene is built to be seen from above its own floor, and nothing is authored on the
   * other side of it: dragging under the paving shows the underside of a slab, and
   * dragging under the sea shows nothing at all, because a water surface is a surface.
   * Both are places a viewer can reach in one gesture and neither is a view of anything.
   *
   * Enforced as a floor on the *eye*, not as a pitch limit, because what matters is the
   * height it ends up at and that depends on how far out it is. Pitching down while
   * zoomed in is fine; the same pitch from forty metres is underground.
   */
  private readonly minHeight: number;

  constructor(minDistance = 2, maxDistance = 60, minHeight = 0.5) {
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.minHeight = minHeight;
  }

  /**
   * Track the scene's own camera, so a handover starts where the eye already is.
   *
   * Called every frame the automatic camera is driving. It is deliberately cheap and
   * deliberately unconditional: a version that only synced "when needed" would need to
   * know when a drag is about to start, which is a thing nothing can know.
   */
  follow(camera: Camera, targetX: number, targetY: number, targetZ: number): void {
    if (this.taken) return;
    const dx = (camera.position[0] ?? 0) - targetX;
    const dy = (camera.position[1] ?? 0) - targetY;
    const dz = (camera.position[2] ?? 0) - targetZ;
    this.distance = Math.hypot(dx, dy, dz) || this.distance;
    this.yaw = Math.atan2(dx, dz);
    this.pitch = Math.asin(clamp(dy / (this.distance || 1), -1, 1));
    this.targetX = targetX;
    this.targetY = targetY;
    this.targetZ = targetZ;
  }

  /** A drag, in pixels. The first one takes the camera off the scene for good. */
  drag(dxPixels: number, dyPixels: number): void {
    this.taken = true;
    this.yaw -= dxPixels * YAW_PER_PIXEL;
    // Inverted, so dragging down looks up: the gesture is grabbing the world and
    // moving it rather than aiming a camera, which is what every viewer expects.
    this.pitch = clamp(this.pitch + dyPixels * PITCH_PER_PIXEL, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Zoom by notches. Positive is closer.
   *
   * Taking the camera too, because a viewer who has zoomed in on something and then had
   * the automatic camera swing away from it has been given a control that does not work.
   */
  zoom(steps: number): void {
    this.taken = true;
    this.distance = clamp(
      this.distance * (1 - ZOOM_PER_STEP) ** steps,
      this.minDistance,
      this.maxDistance,
    );
  }

  /**
   * Multiply the distance, for a gesture that is already a ratio.
   *
   * A pinch reports a distance between two fingers, and what it means is "this much
   * closer" rather than "this many notches". Converting one into the other and back
   * loses the directness that makes a pinch feel attached to the fingers doing it.
   */
  scale(factor: number): void {
    if (!(factor > 0)) return;
    this.taken = true;
    this.distance = clamp(this.distance / factor, this.minDistance, this.maxDistance);
  }

  /** Hand the camera back to the scene, from wherever the viewer left it. */
  release(): void {
    this.taken = false;
  }

  /** Place a camera on the current orbit. The scene still owns roll and projection. */
  /**
   * Keep the eye inside a room, on every side, until somebody deliberately leaves it.
   *
   * The floor already had this: `minHeight` stops a low pitch putting the eye underground, which
   * is the same bug seen from one direction. The other five sides have it now, and for the same
   * reason — a viewer dragging round a room does not mean "take me through the wall", and what
   * they get if it happens is a frame of the outside of some boxes and no way to tell what went
   * wrong.
   *
   * **It switches itself off when the viewer zooms past the room**, which is the part that makes
   * it a help rather than a cage. Standing back to look at the whole building is a legitimate
   * thing to want, and a hard clamp would make the zoom silently stop working. The test is
   * whether the *orbit distance* has grown beyond the room: inside it, the walls hold; past it,
   * they are behind you anyway and holding the eye in would be the strange behaviour.
   *
   * `halfX` and `halfZ` are the inside faces, so a caller passes the wall positions less
   * whatever margin keeps the near plane out of the plaster.
   */
  keepInside(halfX: number, halfZ: number, ceilingY: number): void {
    this.boundsX = halfX;
    this.boundsZ = halfZ;
    this.boundsY = ceilingY;
  }

  place(camera: Camera): void {
    // The shallowest pitch that still leaves the eye above the floor, at this distance.
    const lowest = Math.asin(clamp((this.minHeight - this.targetY) / (this.distance || 1), -1, 1));
    const pitch = Math.max(this.pitch, lowest);
    const flat = Math.cos(pitch) * this.distance;
    let x = this.targetX + Math.sin(this.yaw) * flat;
    let y = this.targetY + Math.sin(pitch) * this.distance;
    let z = this.targetZ + Math.cos(this.yaw) * flat;

    /*
     * Clamped rather than blocked, and only while the viewer is still meant to be inside.
     *
     * Clamping the *position* rather than refusing the drag is what keeps the gesture feeling
     * attached: the eye slides along the wall instead of the scene stopping dead, and the yaw the
     * viewer asked for is still the yaw they get. Refusing the input instead reads as a broken
     * control, which is worse than a view that has run out of room.
     */
    const inside =
      this.boundsX > 0 &&
      this.distance <= Math.min(this.boundsX, this.boundsZ) &&
      this.targetY < this.boundsY;
    if (inside) {
      x = clamp(x, this.targetX - this.boundsX, this.targetX + this.boundsX);
      z = clamp(z, this.targetZ - this.boundsZ, this.targetZ + this.boundsZ);
      y = Math.min(y, this.boundsY);
      x = clamp(x, -this.boundsX, this.boundsX);
      z = clamp(z, -this.boundsZ, this.boundsZ);
    }

    camera.position[0] = x;
    camera.position[1] = y;
    camera.position[2] = z;
    camera.lookAt(this.targetX, this.targetY, this.targetZ);
  }
}
