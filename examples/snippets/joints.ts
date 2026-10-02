/**
 * A hip: a six-degree-of-freedom joint that lets a thigh swing forward and back within a limit and
 * holds every other axis.
 *
 * A snippet, typechecked with the examples and quoted by the manual's joints chapter.
 */
import {
  BODY_DYNAMIC,
  DOF_FREE,
  DOF_LIMITED,
  DOF_LOCKED,
  JOINT_SIX_DOF,
  PhysicsWorld,
  boxShape,
} from '@driftengine/physics';

const world = new PhysicsWorld();
const hips = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.2, 0.1, 0.15), y: 1 });
const thigh = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.08, 0.22, 0.08), y: 0.65 });

// #region six
/** Linear x, y, z then angular x, y, z, in the hips' own frame. Bounds are sines of half angles. */
export const hip = world.addJoint({
  type: JOINT_SIX_DOF,
  bodyA: hips,
  bodyB: thigh,
  anchorAY: -0.1,
  anchorBY: 0.22,
  dof: [DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LIMITED, DOF_FREE, DOF_LOCKED],
  dofLower: [0, 0, 0, -Math.sin(Math.PI / 8), 0, 0],
  dofUpper: [0, 0, 0, Math.sin(Math.PI / 8), 0, 0],
});
// #endregion
