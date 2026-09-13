import type { Aabb } from './aabb.ts';
import type { ColliderSet } from '../colliderSet.ts';
import type { Body } from './body.ts';

/**
 * Push a body out of solid geometry it has ended up **inside**.
 *
 * **This is not collision, and that distinction is the whole of why it exists.** `moveAxis`
 * resolves a move against what is in the way, and it is a *swept* test: it asks how far a body
 * may travel before it touches something. A body that is already interpenetrating has nothing
 * left to sweep against — both of the plain path's clamps test a face the body is already past,
 * so neither fires, and an overlapping body moves **freely**. That is the mechanism behind the
 * complaint that a character "sometimes passes through" a surface: one frame inside a column and
 * the column has stopped existing for as long as the body remains in it.
 *
 * It is also why such a body can stand in mid-air inside a slab and be told it is grounded:
 * nothing clamped the downward move, so `contactSupport` keeps the `true` it starts with, and
 * every backstop a consumer has — a wedge counter, a refused-move flag — is waiting for the
 * world to push back, which it has stopped doing.
 *
 * **Gated on the body's centre, not on overlap.** Overlap on its own is ordinary and expected:
 * a deck's hull sits a give below the surface a character rides, so a grounded body's feet are
 * inside it by design, and a pad's box is sunk under the pad. What none of those produce is a
 * *centre* inside the box — a standing body's centre is half its height above its feet. So the
 * centre test separates riding from burial exactly, and this can be run every tick without ever
 * firing on a body that is merely resting on something.
 *
 * **Hulls are skipped, deliberately.** A hull collider's box is its broad phase and its real
 * volume is the convex shape inside it, so a centre inside the box says nothing about whether
 * the body is inside the *hull*. Pushing on that evidence would move bodies that are simply
 * near a deck. What this covers is every plain collider — the columns, the props, the pads,
 * the arch feet — which is where the reported pass-throughs were captured.
 *
 * The push is the shortest way out and it is applied whole: half a resolution leaves the body
 * inside, which is the state this exists to end. Returns true when something moved, so a caller
 * can treat it as the event it is rather than polling.
 *
 * Allocation-free: the caller owns `scratch` and `probe`, as everywhere else in this module.
 */
export function ejectFromSolid(
  body: Body,
  colliders: ColliderSet,
  scratch: Int32Array,
  probe: Aabb,
): boolean {
  const found = colliders.query(
    body.x - body.hx,
    body.y - body.hy,
    body.z - body.hz,
    body.x + body.hx,
    body.y + body.hy,
    body.z + body.hz,
    scratch,
  );

  /*
   * How far each way out has to go to clear **everything** at once, which is the whole reason
   * this is two passes rather than a push per collider.
   *
   * Resolved one at a time it oscillates, and the case that shows it is the one this was
   * measured on: a body 0.70 m wide between two columns 0.41 m apart overlaps both, and each
   * one's own shortest exit is sideways into the other. It would be shoved back and forth for
   * ever and never leave. Asking every candidate direction how far it would have to go to clear
   * the lot, and then taking the cheapest, picks the way the body came in — the only way out
   * there actually is.
   */
  let outXPlus = 0;
  let outXMinus = 0;
  let outZPlus = 0;
  let outZMinus = 0;
  let outYPlus = 0;
  let buried = false;

  for (let k = 0; k < found; k++) {
    const index = scratch[k] as number;
    /* A hull's box is broad phase only. See the note above. */
    if (colliders.shapeAt(index) !== undefined) continue;
    colliders.bounds(index, probe);

    /*
     * Vertically inside, and horizontally overlapping. The vertical half is what separates
     * burial from the give every deck and pad is authored with: a collider is sunk under the
     * surface it draws, so a character standing on one has its feet in the box by design and its
     * centre half a body above the box's lid. A centre *between* the lid and the floor is a
     * body in the solid rather than on it.
     */
    if (body.y <= probe.minY || body.y >= probe.maxY) continue;
    if (body.x + body.hx <= probe.minX || body.x - body.hx >= probe.maxX) continue;
    if (body.z + body.hz <= probe.minZ || body.z - body.hz >= probe.maxZ) continue;

    /*
     * **Overlapping is not the same as being in it, and only the second arms this.**
     *
     * A skate corner clips the flank of a slab in passing, and a body falling past a ledge
     * shares a couple of centimetres with it for a tick. Ejecting on that fights gravity: the
     * upward preference below lifts the body back over whatever it was falling past, which is a
     * hover rather than a rescue. Measured on the rim capture as 1.77 s of it, against 0.20 s
     * with this gate in place.
     *
     * So a collider has to hold more than a quarter of the body's width on **both** horizontal
     * axes before it counts as one the body is inside. Expressed against the body's own extents
     * rather than in metres, because what "barely touching" means is a fact about the body.
     */
    const heldX = Math.min(body.x + body.hx, probe.maxX) - Math.max(body.x - body.hx, probe.minX);
    const heldZ = Math.min(body.z + body.hz, probe.maxZ) - Math.max(body.z - body.hz, probe.minZ);
    if (heldX > body.hx * 0.5 && heldZ > body.hz * 0.5) buried = true;

    outXPlus = Math.max(outXPlus, probe.maxX - (body.x - body.hx));
    outXMinus = Math.max(outXMinus, body.x + body.hx - probe.minX);
    outZPlus = Math.max(outZPlus, probe.maxZ - (body.z - body.hz));
    outZMinus = Math.max(outZMinus, body.z + body.hz - probe.minZ);
    outYPlus = Math.max(outYPlus, probe.maxY - (body.y - body.hy));
  }
  if (!buried) return false;

  /*
   * Up wins a tie and wins a near-tie, which is a decision about characters rather than about
   * geometry: a body pushed sideways out of a column arrives beside it in mid-air, and a body
   * pushed up arrives on top of it. Only when up is genuinely the long way round does a
   * sideways exit win.
   */
  let bestAxis = 1;
  let bestPush = outYPlus / UP_PREFERENCE;
  if (outXPlus < bestPush) {
    bestPush = outXPlus;
    bestAxis = 2;
  }
  if (outXMinus < bestPush) {
    bestPush = outXMinus;
    bestAxis = 3;
  }
  if (outZPlus < bestPush) {
    bestPush = outZPlus;
    bestAxis = 4;
  }
  if (outZMinus < bestPush) {
    bestPush = outZMinus;
    bestAxis = 5;
  }

  if (bestAxis === 1) body.y += outYPlus;
  else if (bestAxis === 2) body.x += outXPlus;
  else if (bestAxis === 3) body.x -= outXMinus;
  else if (bestAxis === 4) body.z += outZPlus;
  else body.z -= outZMinus;
  return true;
}

/**
 * How much longer the vertical exit may be than the shortest horizontal one and still be taken.
 *
 * A body ejected sideways out of a column lands beside it with nothing under it, which reads as
 * being spat into the void; ejected upward it lands on top, which reads as climbing out. Worth
 * up to twice the distance to get the second.
 */
const UP_PREFERENCE = 2;
