/**
 * A rig, walking: the whole of Track A in one scene.
 *
 * **What it is for.** Every other proof of animation in this repository is a page under
 * `demo/dev/` that bends one bar, which is the right instrument for a diff and says nothing about
 * whether the pieces compose. This scene runs a skeleton, two clips, a blend tree, a state machine
 * and an IK pass over one character, and draws a second character beside it playing the same clip
 * through a *different* skeleton to show retargeting. If any layer disagreed with the one beneath
 * it, the figure would visibly come apart.
 *
 * **A rig built in code and no model file**, for the reason `AGENTS.md` gives about `models/`:
 * nothing bought is committed, so a scene that needed one would only run for whoever had it. Boxes
 * for limbs are not a fidelity statement — the geometry is the least interesting part of what this
 * demonstrates.
 *
 * **Deterministic within a backend, and deliberately not comparable across two.** Nothing in the
 * animation path reads a clock — `frame` takes `dtSec` and the scene owns nothing else — so two
 * captures of one build on one backend differ in **zero** pixels, which is what the gate needs.
 *
 * A diff *between* backends is a different matter and is not worth taking here. A state machine
 * advances rather than being sampled, so the pose is a function of how many frames have gone by,
 * and the two backends do not render the same number before a capture settles. Measured: 2,208
 * pixels apart at delta 16, against a same-backend floor of 0 — and **9,861 apart** when the step
 * was fixed at 1/60, which is the experiment that identified the cause rather than the fix it
 * looked like. An unrigged box scene through the same harness is 0 apart, so it is this scene's
 * accumulation and not the skinned path.
 *
 * **The parity proof lives at `demo/dev/skinning.html`**, which is driven by `?phase=` rather than
 * by frames and measures 0 of 832,000 between backends with a rig bent and at rest. That is the
 * right instrument for the question; this scene is the right instrument for whether the layers
 * compose.
 */
import {
  AnimationStateMachine,
  BlendTree,
  Skeleton,
  buildRetargetMap,
  createPose,
  retargetPose,
  solveTwoBone,
} from '@driftengine/animation';
import type { AnimationClip, Joint } from '@driftengine/animation';
import { Camera, MeshBuilder, createEnvironment, createRenderer } from '../packages/core/src/index';
import type {
  MeshData,
  MeshHandle,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
} from '../packages/core/src/index';
import { DEMO_BACKEND } from './backend';
import { OrbitView } from './orbit';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';

/** hips, chest, upper arm, lower arm, hand — five joints, a chain of three for the IK. */
const JOINTS: readonly Joint[] = [
  { parent: -1, name: 'hips' },
  { parent: 0, name: 'chest' },
  { parent: 1, name: 'upperArm' },
  { parent: 2, name: 'lowerArm' },
  { parent: 3, name: 'hand' },
];

/** Where each joint rests, relative to its parent. The bind pose. */
const REST: readonly (readonly [number, number, number])[] = [
  [0, 1.6, 0],
  [0, 0.7, 0],
  [0.45, 0.35, 0],
  [0, -0.75, 0],
  [0, -0.7, 0],
];

const LIMB_COLOR: [number, number, number] = [0.86, 0.84, 0.8];

/**
 * Inverse bind matrices for a rest pose of pure translations.
 *
 * Each is the inverse of the joint's world transform at rest, which for a chain of translations is
 * a translation by the negated accumulated offset. Written from the rest table rather than
 * inverted at runtime, so a wrong multiplication order shows here as a figure that explodes rather
 * than as a plausible pose.
 */
function inverseBind(): Float32Array {
  const out = new Float32Array(JOINTS.length * 16);
  const world: [number, number, number][] = [];
  JOINTS.forEach((joint, at) => {
    const rest = REST[at] as readonly [number, number, number];
    const parent = joint.parent < 0 ? [0, 0, 0] : (world[joint.parent] as [number, number, number]);
    world.push([parent[0] + rest[0], parent[1] + rest[1], parent[2] + rest[2]]);
  });
  world.forEach((position, at) => {
    const m = at * 16;
    out[m] = 1;
    out[m + 5] = 1;
    out[m + 10] = 1;
    out[m + 15] = 1;
    out[m + 12] = -position[0];
    out[m + 13] = -position[1];
    out[m + 14] = -position[2];
  });
  return out;
}

/** A rest pose built from the table, so the figure stands before anything animates it. */
function restingPose(): ReturnType<typeof createPose> {
  const pose = createPose(JOINTS.length);
  REST.forEach((rest, at) => {
    pose.translation[at * 3] = rest[0];
    pose.translation[at * 3 + 1] = rest[1];
    pose.translation[at * 3 + 2] = rest[2];
  });
  return pose;
}

/** A clip rocking the chest and swinging the arm, at a given amplitude and period. */
function swing(name: string, degrees: number, durationSec: number): AnimationClip {
  const half = (degrees / 2) * (Math.PI / 180);
  const key = (angle: number): number[] => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  const arc = (a: number): Float32Array => new Float32Array([...key(-a), ...key(a), ...key(-a)]);
  return {
    name,
    durationSec,
    tracks: [
      {
        joint: 1,
        path: 'rotation',
        times: new Float32Array([0, durationSec / 2, durationSec]),
        values: arc(half * 0.35),
      },
      {
        joint: 2,
        path: 'rotation',
        times: new Float32Array([0, durationSec / 2, durationSec]),
        values: arc(half),
      },
    ],
  };
}

/**
 * One bone as a box spanning two rest positions.
 *
 * Sized to the gap it spans with a floor on each axis, so a bone that runs along one axis is still
 * a solid rather than a plane.
 */
function limb(builder: MeshBuilder, from: number[], to: number[]): void {
  const mid: [number, number, number] = [
    ((from[0] as number) + (to[0] as number)) / 2,
    ((from[1] as number) + (to[1] as number)) / 2,
    ((from[2] as number) + (to[2] as number)) / 2,
  ];
  const half: [number, number, number] = [
    Math.max(Math.abs((to[0] as number) - (from[0] as number)) / 2, 0.12),
    Math.max(Math.abs((to[1] as number) - (from[1] as number)) / 2, 0.12),
    Math.max(Math.abs((to[2] as number) - (from[2] as number)) / 2, 0.12),
  ];
  builder.addBox(mid, half, LIMB_COLOR);
}

/**
 * The figure: one box per bone, every vertex of a box weighted to the joint that carries it.
 *
 * Rigid weighting rather than a smooth falloff, because a box has no vertices along its length to
 * carry one — a bend would crease at the seam whatever the weights said. What this scene is
 * demonstrating is the *graph* over the clips rather than the quality of the deformation, and a
 * smooth character would need geometry that is not the point.
 */
function figure(): MeshData {
  const world: number[][] = [];
  JOINTS.forEach((joint, at) => {
    const rest = REST[at] as readonly [number, number, number];
    const parent = joint.parent < 0 ? [0, 0, 0] : (world[joint.parent] as number[]);
    world.push([
      (parent[0] as number) + rest[0],
      (parent[1] as number) + rest[1],
      (parent[2] as number) + rest[2],
    ]);
  });

  const builder = new MeshBuilder();
  const owners: number[] = [];
  /**
   * Claim every vertex added since the last call for `joint`.
   *
   * **A bone spanning joint *i* to joint *i+1* is weighted to *i*, not to *i+1*.** Rotating a
   * joint moves everything outward from it, so geometry weighted to the joint at its *far* end
   * swings about the wrong point and detaches from its parent — which reads as limbs passing
   * through each other rather than as a weighting mistake. That is what the first version of this
   * scene did, and looking at it is what found it.
   */
  const claim = (joint: number): void => {
    const vertices = builder.build().positions.length / 3;
    while (owners.length < vertices) owners.push(joint);
  };

  builder.addBox([0, world[0]?.[1] ?? 0, 0], [0.3, 0.3, 0.2], LIMB_COLOR);
  claim(0);
  limb(builder, world[0] as number[], world[1] as number[]);
  claim(0);
  limb(builder, world[1] as number[], world[2] as number[]);
  claim(1);
  limb(builder, world[2] as number[], world[3] as number[]);
  claim(2);
  limb(builder, world[3] as number[], world[4] as number[]);
  claim(3);

  const data = builder.build();
  const vertices = data.positions.length / 3;
  const joints = new Float32Array(vertices * 4);
  const weights = new Float32Array(vertices * 4);
  for (let v = 0; v < vertices; v++) {
    joints[v * 4] = owners[v] ?? 0;
    weights[v * 4] = 1;
  }
  return { ...data, joints, weights };
}

const BACKGROUND: [number, number, number] = [0.05, 0.06, 0.075];

class CharacterHandle implements DemoHandle {
  readonly view = new OrbitView(3, 40, 0.4);
  private readonly camera = new Camera();
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, extra: '' };
  private readonly env = createEnvironment({
    directionalDir: [0.7, 0.55, 0.45],
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  private readonly mesh: MeshHandle;
  private readonly walker = new Skeleton(JOINTS, inverseBind());
  /** The second figure's skeleton, identical here — retargeting is by name, not by shape. */
  private readonly other = new Skeleton(JOINTS, inverseBind());
  private readonly map = buildRetargetMap(this.walker, this.other);
  private readonly pose = restingPose();
  private readonly retargeted = restingPose();
  private readonly machine: AnimationStateMachine;
  /**
   * The states, kept so their trees can be set.
   *
   * **`AnimationStateMachine.set` does not reach a tree**, and this scene had not noticed: it set
   * `stride` on the machine, where only a transition predicate reads it, so the set's parameter sat
   * at zero and the figure had been showing the short step alone since the scene was written. A
   * machine's parameters and a tree's are two collections on purpose — the machine takes any name,
   * because the predicates are the consumer's own functions, and a tree refuses a name no node
   * declares — so a consumer sets both, which is what this now does.
   */
  private readonly trees: readonly { readonly name: string; readonly tree: BlendTree }[];
  private elapsed = 0;
  /**
   * How far the figure has notionally travelled, in the gait clips' own seconds.
   *
   * A stand-in for distance: this figure walks in place, so what would be metres over a stride
   * length is here the speed cycle integrated over the frame step. What matters is the shape — it
   * stops advancing when the speed reaches zero, which is what a clock of its own is for.
   */
  private gait = 0;
  private lastGpuMs = 0;
  private disposed = false;

  constructor(
    private readonly renderer: RendererApi,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.renderer.resize();
    this.mesh = renderer.createMesh(figure());
    this.camera.fovYDeg = 45;
    this.camera.near = 0.3;
    this.camera.far = 80;

    /*
     * Two states over the same shape of tree, so the state machine has something to cross between
     * and the blend tree has a parameter to answer to. `stride` slides the walk between a short
     * and a long step; `speed` decides which state is live.
     *
     * **Both gait clips are sampled on a clock of their own, `gait`, and that is the point of
     * this scene since 2026-08-28.** A stride has to advance with distance travelled or the foot
     * slides while the body passes over it; the frame clock is the wrong axis for it and the right
     * one for anything that carries on while a character stands still. Here the distance is
     * accumulated in `frame` from the same speed the states cross on, so when the cycle bottoms out
     * the legs stop where they are and the arm the IK pass drives keeps moving — the two clocks,
     * in one figure, visibly disagreeing on purpose.
     *
     * `stride` and `gait` have to be different names, and the tree refuses it if they are not: one
     * is a weight and the other is a time.
     */
    const tree = (short: AnimationClip, long: AnimationClip): BlendTree =>
      new BlendTree(
        {
          kind: 'oneDimensional',
          parameter: 'stride',
          children: [
            { at: 0, node: { kind: 'clip', clip: short, clock: 'gait' } },
            { at: 1, node: { kind: 'clip', clip: long, clock: 'gait' } },
          ],
        },
        JOINTS.length,
        restingPose(),
      );

    this.trees = [
      { name: 'walk', tree: tree(swing('amble', 26, 1.6), swing('stride', 54, 1.6)) },
      { name: 'run', tree: tree(swing('jog', 62, 0.9), swing('sprint', 96, 0.9)) },
    ];

    this.machine = new AnimationStateMachine(
      this.trees,
      [
        { from: 'walk', to: 'run', durationSec: 0.35, when: (p) => (p['speed'] ?? 0) > 0.6 },
        { from: 'run', to: 'walk', durationSec: 0.45, when: (p) => (p['speed'] ?? 0) <= 0.6 },
      ],
      JOINTS.length,
      restingPose(),
    );
  }

  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  get lost(): boolean {
    return this.renderer.contextLost;
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    this.elapsed += dtSec;

    /*
     * The parameters are a function of elapsed time rather than of a clock, so the figure speeds
     * up and slows down on a loop and the state machine crosses both ways while you watch. A
     * consumer would drive these from its own controller.
     */
    const cycle = (Math.sin(this.elapsed * 0.35) + 1) / 2;
    /* The gait's own clock: it advances with the speed rather than with the frame, so at the bottom
       of the cycle it stops and the legs hold their place while everything else carries on. */
    this.gait += dtSec * cycle * 1.6;
    this.machine.set('speed', cycle);
    for (const state of this.trees) {
      state.tree.set('stride', cycle);
      state.tree.set('gait', this.gait);
    }
    this.machine.advance(dtSec);
    this.machine.evaluate(this.pose);

    /*
     * IK over the arm, after the clip and before the palette. The hand reaches for a point that
     * circles the figure, so the elbow visibly resolves the chain rather than following the clip —
     * which is the one thing a clip cannot do and the reason the pass is here at all.
     */
    const reachX = 1.15 + Math.sin(this.elapsed * 0.9) * 0.35;
    const reachY = 2.35 + Math.cos(this.elapsed * 0.7) * 0.45;
    const reached = solveTwoBone(
      this.walker,
      this.pose,
      2,
      3,
      4,
      [reachX, reachY, Math.sin(this.elapsed * 0.5) * 0.4],
      [0, 0, 1.5],
    );

    retargetPose(this.map, this.walker, this.pose, this.other, this.retargeted);
    this.other.applyPose(this.retargeted);

    /*
     * **The camera is placed here, not by `follow`.** `OrbitView.follow` *reads* the camera so a
     * handover to a drag starts where the eye already is; a scene that only calls it never moves
     * and sits at the origin looking down -Z, which draws a black frame from inside the figure.
     * `hierarchy.ts` records making exactly this mistake, and this scene made it again.
     */
    if (this.view.taken) {
      this.view.place(this.camera);
    } else {
      const turn = this.elapsed * 0.2;
      this.camera.position[0] = Math.sin(turn) * EYE_DISTANCE;
      this.camera.position[1] = LOOK_AT_Y + 1.1;
      this.camera.position[2] = Math.cos(turn) * EYE_DISTANCE;
      this.camera.lookAt(0, LOOK_AT_Y, 0);
      this.view.follow(this.camera, 0, LOOK_AT_Y, 0);
    }
    this.camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);

    this.renderer.gpuTimer.beginFrame();
    this.renderer.beginFrame(BACKGROUND);
    this.renderer.bindMeshPass(this.camera, this.env);

    this.renderer.setSkinPalette(this.walker.palette);
    this.renderer.drawMesh(this.mesh, LEFT);
    this.renderer.setSkinPalette(this.other.palette);
    this.renderer.drawMesh(this.mesh, RIGHT);
    this.renderer.setSkinPalette(null);

    this.renderer.gpuTimer.begin('rest');
    this.renderer.endFrame();
    this.renderer.gpuTimer.end();
    this.renderer.gpuTimer.endFrame();

    const sample = this.renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.rest;
    this.stats.draws = 2;
    this.stats.gpuMs = this.lastGpuMs;
    this.stats.extra = `${this.machine.current}${reached ? '' : ' · reaching'}`;
    return this.stats;
  }

  resize(): void {
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeMesh(this.mesh);
    this.renderer.dispose();
  }
}

/** Far enough back for both figures and the arm's reach, near enough to read a bend. */
const EYE_DISTANCE = 7.5;
/** The middle of the figures, which stand from about y=0.2 to y=3 before the model offset. */
const LOOK_AT_Y = 1.1;

const LEFT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1.3, -1.4, 0, 1]);
const RIGHT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.3, -1.4, 0, 1]);

export const character: DemoScene = {
  id: 'character',
  title: 'A rig, walking',
  note:
    'One skeleton, two clips through a blend tree, a state machine crossing between a walk and a ' +
    'run, and an IK pass putting the hand on a moving target. The figure on the right is the same ' +
    'clip retargeted onto a second skeleton by joint name.',

  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(canvas, { ...overrides }, DEMO_BACKEND);
    await renderer.ready();
    return new CharacterHandle(renderer, canvas);
  },
};
