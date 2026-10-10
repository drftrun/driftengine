/**
 * What a skinned cloth is made from: particles, their limits, the constraints between them and the
 * numbers the solver runs at — plain arrays, so a port decoding a middleware's cooked data hands it
 * over as it decoded it, and the GPU solver uploads the same arrays the CPU one reads.
 *
 * **Skinned** because its anchor is a skeleton rather than a world: a kinematic particle (inverse
 * mass 0) is placed by its joint influences every step, and every limit is measured from where
 * skinning would put a particle. `ClothBody` is the other kind — a sheet in a physics world — and
 * stays that.
 *
 * Validated at construction and refused by name: a cloth whose arrays disagree in length would read
 * past an end on the GPU, where nothing says so.
 */

/** Distance constraints: two particles, a rest length, a compliance (metres per newton). */
export interface DistanceConstraints {
  /** Two particle indices a constraint. */
  readonly pairs: Uint32Array;
  readonly rest: Float32Array;
  readonly compliance: Float32Array;
  /**
   * Graph-colour batches, as offsets into the constraints: batch `b` is constraints
   * `batches[b]` to `batches[b + 1]`, none of which moves a particle another in the batch moves.
   * Absent, the solver colours them itself. Given, they are checked and refused if they overlap.
   */
  readonly batches?: Uint32Array;
}

/** Dihedral bending: four particles — the shared edge, then each triangle's far corner. */
export interface BendingConstraints {
  readonly quads: Uint32Array;
  /** The angle between the two triangles' normals at rest, in radians: π is flat. */
  readonly rest: Float32Array;
  readonly compliance: Float32Array;
  readonly batches?: Uint32Array;
}

/** Long-range attachments: a particle may be no further than a length from a kinematic anchor. */
export interface TetherConstraints {
  readonly particles: Uint32Array;
  readonly anchors: Uint32Array;
  readonly lengths: Float32Array;
}

/**
 * Where a particle may not go, measured from where skinning puts it. Each optional, one entry a
 * particle (two for a stop), and `Infinity` is none — which is how cooked data says it.
 */
export interface ClothLimits {
  /** Metres from the skinned position a particle may not leave: a sphere around it. */
  readonly maxDistance?: Float32Array;
  /** A distance and a radius a particle: a sphere behind the skinned position, along its normal. */
  readonly backstop?: Float32Array;
  /** The same in front. */
  readonly frontstop?: Float32Array;
  /** Metres a particle keeps from a collider's surface. */
  readonly thickness?: Float32Array;
  /**
   * Which particles collide with each other, one flag each. **Accepted and not yet simulated**: a
   * garment held by its colliders and its backstops does not need it to look right, and the GPU
   * solver has no neighbour search yet. Carried so a set-up need not be rewritten when it arrives.
   */
  readonly selfCollision?: Uint8Array;
}

/**
 * A collider on a joint: a sphere, or a tapered capsule along its frame's +Z.
 *
 * Its frame is in the joint's own space, so it rides the joint whatever the animation does.
 */
export interface ClothCollider {
  readonly joint: number;
  readonly radius: number;
  /** The radius at the far end; the same as `radius` where absent. */
  readonly radius2?: number;
  /** Metres along the frame's +Z; zero or absent is a sphere. */
  readonly length?: number;
  /** Sixteen floats, column-major, in the joint's space; identity where absent. */
  readonly frame?: Float32Array;
}

/** What the solver runs at. Every field has a default; the defaults are a garment's, not a sheet's. */
export interface SkinnedClothParameters {
  /** The fixed step, in seconds. The solver runs whole steps whatever the frame. Default 1/60. */
  readonly step?: number;
  /**
   * The most whole steps one `advance` runs; the time past them is dropped, not owed to the next
   * frame. Default none, so `advance(1)` is a second of cloth. A caller handing it each frame's time
   * wants two to four: unbounded, a slow frame's steps make the next frame slower, which hands it
   * more time again. What it gives up: past the cap the cloth runs slower than the clock.
   */
  readonly maxSteps?: number;
  /** Substeps a step. Default 1. */
  readonly substeps?: number;
  /** Constraint passes a substep. Default 4. */
  readonly iterations?: number;
  /** Metres a second squared, world space. Default [0, −9.81, 0]. */
  readonly gravity?: readonly [number, number, number];
  /**
   * The log of the velocity kept after a second: `ln 0.25` keeps a quarter. Zero is none; it is
   * applied as `exp(damping · h)` a substep, so it means one thing at every step length.
   */
  readonly damping?: number;
  /** The same, of the velocity relative to the wind: how fast the air takes the cloth with it. */
  readonly drag?: number;
  /**
   * Metres a second, world space: the air the cloth starts in. Default still air. A garment in a
   * scene follows the scene's wind a frame at a time, through `setWind`.
   */
  readonly wind?: readonly [number, number, number];
  /**
   * How much of the character's own movement and turning the cloth keeps as its own, 0 to 1: 1 is
   * simulated wholly in the world, so a dash leaves the hem behind; 0 moves it with the character.
   * Default 1.
   */
  readonly linearInertia?: number;
  readonly angularInertia?: number;
  /** Scales every max distance, for a garment worn looser or tighter than cooked. Default 1. */
  readonly maxDistanceScale?: number;
  /** Metres added to every collider's radius, beyond a particle's own thickness. Default 0. */
  readonly margin?: number;
  /** A move of the character's origin past this, between two poses, resets the cloth. Default none. */
  readonly teleportDistance?: number;
  /** A turn past this many radians between two poses resets it too. Default none. */
  readonly teleportAngle?: number;
  /** Steps run at once when the cloth is reset, so it starts hanging rather than falling. */
  readonly settleSteps?: number;
  /** Steps over which a reset cloth blends from its skinned pose into its simulation. */
  readonly blendSteps?: number;
}

/** Everything a skinned cloth is made from. */
export interface SkinnedClothSetup {
  /** Rest positions, three floats a particle, in the space the skinning starts from. */
  readonly positions: Float32Array;
  /** One a particle: zero is kinematic, following its skinned position exactly. */
  readonly inverseMass: Float32Array;
  readonly distance: DistanceConstraints;
  readonly bending?: BendingConstraints;
  readonly tethers?: TetherConstraints;
  readonly parameters: SkinnedClothParameters;
  /** Rest normals, three floats a particle: what a backstop and a frontstop are measured along. */
  readonly normals?: Float32Array;
  /** Up to eight joint influences a particle, as `MeshData` carries them. Absent: not skinned. */
  readonly joints?: Float32Array;
  readonly weights?: Float32Array;
  readonly joints2?: Float32Array;
  readonly weights2?: Float32Array;
  /** Sixteen floats a joint: each joint's inverse bind matrix, column-major. */
  readonly inverseBind?: Float32Array;
  readonly limits?: ClothLimits;
  readonly colliders?: readonly ClothCollider[];
}

/** The parameters with every default filled in. */
export interface ResolvedClothParameters {
  readonly step: number;
  readonly maxSteps: number;
  readonly substeps: number;
  readonly iterations: number;
  readonly gravity: readonly [number, number, number];
  readonly damping: number;
  readonly drag: number;
  readonly wind: readonly [number, number, number];
  readonly linearInertia: number;
  readonly angularInertia: number;
  readonly maxDistanceScale: number;
  readonly margin: number;
  readonly teleportDistance: number;
  readonly teleportAngle: number;
  readonly settleSteps: number;
  readonly blendSteps: number;
}

export function resolveClothParameters(
  parameters: SkinnedClothParameters,
): ResolvedClothParameters {
  return {
    step: parameters.step ?? 1 / 60,
    maxSteps: Math.max(1, Math.floor(parameters.maxSteps ?? Infinity)),
    substeps: Math.max(1, Math.floor(parameters.substeps ?? 1)),
    iterations: Math.max(1, Math.floor(parameters.iterations ?? 4)),
    gravity: parameters.gravity ?? [0, -9.81, 0],
    damping: parameters.damping ?? 0,
    drag: parameters.drag ?? 0,
    wind: parameters.wind ?? [0, 0, 0],
    linearInertia: Math.min(1, Math.max(0, parameters.linearInertia ?? 1)),
    angularInertia: Math.min(1, Math.max(0, parameters.angularInertia ?? 1)),
    maxDistanceScale: parameters.maxDistanceScale ?? 1,
    margin: parameters.margin ?? 0,
    teleportDistance: parameters.teleportDistance ?? Infinity,
    teleportAngle: parameters.teleportAngle ?? Infinity,
    settleSteps: Math.max(0, Math.floor(parameters.settleSteps ?? 0)),
    blendSteps: Math.max(0, Math.floor(parameters.blendSteps ?? 0)),
  };
}

/** Refuse a set-up whose arrays disagree, naming the array and both lengths. */
export function validateClothSetup(setup: SkinnedClothSetup): void {
  const count = setup.positions.length / 3;
  const fail = (what: string): never => {
    throw new Error(`skinned cloth: ${what}`);
  };
  if (!Number.isInteger(count) || count === 0) {
    fail(
      `positions hold ${setup.positions.length} floats, which is not a whole number of particles`,
    );
  }
  if (setup.inverseMass.length !== count) {
    fail(`inverseMass has ${setup.inverseMass.length} entries for ${count} particles`);
  }
  const indices = (name: string, values: Uint32Array, arity: number, constraints: number): void => {
    if (values.length !== constraints * arity) {
      fail(`${name} has ${values.length} indices for ${constraints} constraints of ${arity}`);
    }
    for (let i = 0; i < values.length; i++) {
      if ((values[i] as number) >= count)
        fail(`${name}[${i}] names particle ${values[i]} of ${count}`);
    }
  };
  const { distance, bending, tethers, parameters } = setup;
  const links = distance.rest.length;
  if (distance.compliance.length !== links)
    fail(`distance compliance has ${distance.compliance.length} for ${links}`);
  indices('distance.pairs', distance.pairs, 2, links);
  if (bending !== undefined) {
    const quads = bending.rest.length;
    if (bending.compliance.length !== quads)
      fail(`bending compliance has ${bending.compliance.length} for ${quads}`);
    indices('bending.quads', bending.quads, 4, quads);
  }
  if (tethers !== undefined) {
    const n = tethers.lengths.length;
    indices('tethers.particles', tethers.particles, 1, n);
    indices('tethers.anchors', tethers.anchors, 1, n);
    for (let i = 0; i < n; i++) {
      if ((setup.inverseMass[tethers.anchors[i] as number] as number) !== 0) {
        fail(`tether ${i} is anchored to particle ${tethers.anchors[i]}, which is not kinematic`);
      }
    }
  }
  const step = parameters.step ?? 1 / 60;
  if (!(step > 0)) fail(`a step of ${step} seconds`);
  const per = (name: string, values: ArrayLike<number> | undefined, width: number): void => {
    if (values !== undefined && values.length !== count * width) {
      fail(`${name} has ${values.length} entries for ${count} particles of ${width}`);
    }
  };
  per('normals', setup.normals, 3);
  per('joints', setup.joints, 4);
  per('weights', setup.weights, 4);
  per('joints2', setup.joints2, 4);
  per('weights2', setup.weights2, 4);
  per('limits.maxDistance', setup.limits?.maxDistance, 1);
  per('limits.backstop', setup.limits?.backstop, 2);
  per('limits.frontstop', setup.limits?.frontstop, 2);
  per('limits.thickness', setup.limits?.thickness, 1);
  per('limits.selfCollision', setup.limits?.selfCollision, 1);
  if ((setup.joints === undefined) !== (setup.weights === undefined))
    fail('joints without weights, or weights without joints');
  if ((setup.joints2 === undefined) !== (setup.weights2 === undefined))
    fail('joints2 without weights2, or the reverse');
  if (setup.joints2 !== undefined && setup.joints === undefined)
    fail('a second set of influences without the first');
  const bones = (setup.inverseBind?.length ?? 0) / 16;
  if (!Number.isInteger(bones))
    fail(`inverseBind holds ${setup.inverseBind?.length} floats, not a whole number of matrices`);
  if (setup.joints !== undefined && bones === 0)
    fail('joints without inverseBind matrices to skin them by');
  for (const set of [setup.joints, setup.joints2]) {
    if (set === undefined) continue;
    for (let i = 0; i < set.length; i++) {
      if ((set[i] as number) >= bones) fail(`a particle names joint ${set[i]} of ${bones}`);
    }
  }
  (setup.colliders ?? []).forEach((collider, k) => {
    if (collider.joint >= bones) fail(`collider ${k} is on joint ${collider.joint} of ${bones}`);
    if (!(collider.radius > 0)) fail(`collider ${k} has radius ${collider.radius}`);
    if (collider.frame !== undefined && collider.frame.length !== 16)
      fail(`collider ${k}'s frame is not sixteen floats`);
  });
}
