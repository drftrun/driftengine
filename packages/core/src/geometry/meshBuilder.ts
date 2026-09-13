import { GrowableF32, GrowableU32 } from './growable.ts';
import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * The emissive colour of a vertex that has not been given one: negative, which no real
 * colour can be, so "inherit the surface's albedo" is representable without a second
 * attribute or a flag. Black would have been ambiguous — a surface can legitimately want
 * to emit nothing — and this cannot be mistaken for anything.
 */
const INHERIT_ALBEDO = -1;

/** Same idea for roughness: negative means "whatever the engine defaults to". */
const INHERIT_ROUGHNESS = -1;

/** What the finished mesh should carry beyond position, normal, colour and emissive. */
export interface MeshBuildOptions {
  /**
   * Emit box-projected texture coordinates in metres.
   *
   * Off by default, because most geometry in this engine is coloured rather than
   * textured and two floats a vertex is a real upload for a world that will never
   * sample them. On, for a mesh that will be drawn with a `SurfaceTexture`.
   */
  planarUvs?: boolean;
}

/**
 * CPU-side accumulator that merges axis-aligned boxes into one static mesh —
 * the entire grey-box world becomes a single draw call.
 *
 * Faces are generated per-axis with cyclic tangents (a,b,c) so that U×V = N,
 * guaranteeing outward CCW winding for back-face culling.
 *
 * **Long on purpose, and this was measured rather than assumed** (2026-08-24). The file is 1,056
 * lines and the guideline is around 600, so it was examined for a seam and has none worth taking:
 * it is a fluent accumulator whose every method returns `this` and reads class state — 146 reads
 * of `this` across the class — and the genuinely pure code in it comes to 44 lines at the tail
 * (`assertOrthonormal`, `dot`, and the three constants they are made of). Extracting 44 lines
 * would leave the class exactly as long and add a file to follow.
 *
 * Carving the class itself is the alternative and it is worse: `addBox`, `addCapsule`, `addBlob`
 * and `addCylinder` all end in the same `addFace` and `addVertex`, so any cut runs straight
 * through the shared tail and produces modules that only make sense read together. An invented
 * seam costs more readability than the length it relieved, which is the rule
 * the render-graph design states — and this file is the
 * case that rule was written about, named in it by name.
 *
 * **What would make this wrong:** a second builder wanting the same face generation, which would
 * turn the shared tail from an internal detail into an interface. Nothing wants it today.
 */
export class MeshBuilder {
  private readonly positions = new GrowableF32();
  private readonly normals = new GrowableF32();
  private readonly colors = new GrowableF32();
  private readonly emissive = new GrowableF32();
  /**
   * Per-vertex specular, accumulated always and emitted only when something asked
   * for it — see `build`. Keeping the array unconditionally costs one push per
   * vertex at build time and keeps every code path below free of a branch.
   */
  private readonly specular = new GrowableF32(256, 0);
  /**
   * Per-vertex emissive *colour*, or the sentinel meaning "whatever this surface is made
   * of". Accumulated always and emitted only when something asked for one, exactly as
   * `specular` is.
   */
  private readonly emissiveColor = new GrowableF32(256, INHERIT_ALBEDO);
  /** What `setEmissiveColor` last named, applied to every vertex added after it. */
  private emissiveColorState: Vec3 | null = null;
  /** Per-vertex roughness, and what `setRoughness` last named. */
  private readonly roughness = new GrowableF32(256, INHERIT_ROUGHNESS);
  private roughnessState: number | null = null;
  /**
   * Per-vertex grain, and what `setGrain` last named. Zero until something asks otherwise,
   * because a surface that never says it is mineral is not mineral.
   */
  private readonly grain = new GrowableF32(256, 0);
  private grainState = 0;
  /**
   * Per-vertex relief, and what `setRelief` last named. Zero until something asks, because a
   * surface that never says it has texture is smooth.
   */
  private readonly relief = new GrowableF32(256, 0);
  private reliefState = 0;
  /**
   * Texture coordinates from anything that has real ones, and empty for geometry that does not.
   *
   * Two sources fill this and they are the same kind of thing: a merged mesh's own coordinates,
   * authored against its own maps, and `addBlob`'s surface parameters, which the primitive walks
   * to place every vertex and used to discard.
   *
   * Separate from `planarUvs()`, which *derives* coordinates from position at build time for a
   * wall or a floor. That derivation is a box projection, and on anything round it is three
   * projections meeting at seams with the poles smeared along an axis, which is why a sphere
   * needs its own and cannot borrow them.
   */
  private readonly uvs = new GrowableF32();

  private readonly indices = new GrowableU32();
  private vertexCount = 0;
  /**
   * Where each rigid joint binding starts, as a vertex index, and which joint it binds to.
   *
   * **Spans expanded at build, not four floats pushed at every vertex site.** Seven separate
   * places in this file push a colour and an emissive, and a binding pushed beside each of them
   * is seven chances for a geometry verb added later to forget one — whose symptom is a short
   * attribute buffer, which some drivers read past the end as zeroes and others answer by
   * dropping the draw, neither raising a GL error. `paddedUvs` already solved the same problem
   * the same way.
   *
   * **What it costs** is that a binding is resolved once per span rather than per vertex, which
   * is cheaper. **What would make it wrong** is a caller wanting two influences on one vertex:
   * this cannot express it, and a rigged import gives them that instead.
   */
  private readonly jointSpans: { from: number; joint: number }[] = [];
  /** Whether anything was ever bound, so `build` knows to emit at all. */
  private anyJoint = false;

  /**
   * Merge an existing mesh in at a position and uniform scale.
   *
   * For geometry that is built once and then stamped around the world — a tree
   * trunk, say. Merging keeps it inside the single static draw call rather than
   * adding one per copy, which is the whole reason the world is one mesh.
   *
   * Uniform scale only: a non-uniform one would need normals transformed by the
   * inverse transpose, and nothing here has wanted that yet.
   */
  addMesh(mesh: MeshData, x: number, y: number, z: number, scale = 1): this {
    const base = this.vertexCount;
    const count = mesh.positions.length / 3;
    for (let i = 0; i < count; i++) {
      this.positions.push(
        (mesh.positions[i * 3] ?? 0) * scale + x,
        (mesh.positions[i * 3 + 1] ?? 0) * scale + y,
        (mesh.positions[i * 3 + 2] ?? 0) * scale + z,
      );
      this.normals.push(
        mesh.normals[i * 3] ?? 0,
        mesh.normals[i * 3 + 1] ?? 0,
        mesh.normals[i * 3 + 2] ?? 0,
      );
      this.colors.push(
        mesh.colors[i * 3] ?? 0,
        mesh.colors[i * 3 + 1] ?? 0,
        mesh.colors[i * 3 + 2] ?? 0,
      );
      this.emissive.push(mesh.emissive[i] ?? 0);
      // Absent on almost every mesh, which is what `?? 0` is for: merging must not
      // invent a shine, and must not drop one the source had.
      this.specular.push(mesh.specular?.[i] ?? 0);
      this.emissiveColor.push(
        mesh.emissiveColor?.[i * 3] ?? INHERIT_ALBEDO,
        mesh.emissiveColor?.[i * 3 + 1] ?? INHERIT_ALBEDO,
        mesh.emissiveColor?.[i * 3 + 2] ?? INHERIT_ALBEDO,
      );
      /*
       * The merged mesh's own roughness, falling back to inherit — and its absence here
       * was the defect. Every other attribute was carried across and this one was not, so
       * merging a mesh left `roughness` shorter than the vertex count by exactly the
       * number of vertices merged. A short attribute buffer is not benign: a driver may
       * read zeroes, and it may drop the draw outright, which is what it did.
       */
      this.roughness.push(mesh.roughness?.[i] ?? this.roughnessState ?? INHERIT_ROUGHNESS);
      // The merged mesh's own grain, and the builder's current state for one that states none.
      this.grain.push(mesh.grain?.[i] ?? this.grainState);
      this.relief.push(mesh.relief?.[i] ?? this.reliefState);
    }
    this.mergeUvs(mesh, base, count);
    for (const index of mesh.indices) this.indices.push(base + index);
    this.vertexCount += count;
    return this;
  }

  /**
   * Merge an existing mesh under an orthonormal basis: rotated, then placed.
   *
   * `addMesh` translates and scales, which is enough for anything whose own
   * axes are the world's — a tree, a rock. It is not enough for anything that
   * has to *agree with a surface*: a marking on a banked deck, a sign facing
   * back along a curve, a letter standing on a slope. Until now the only way to
   * follow a surface was to be a ribbon built from the same curve, which works
   * beautifully for bands across a deck and cannot draw a glyph.
   *
   * The basis is assumed orthonormal and is checked, because that assumption is
   * what lets normals be rotated by the same three vectors as the positions: a
   * non-uniform or skewed basis needs the inverse transpose, and silently
   * getting that wrong produces geometry that is lit as if it were facing
   * somewhere else — which looks like a shading bug, not a maths one.
   *
   * @param scale uniform, applied in the local frame before the basis.
   */
  addOrientedMesh(
    mesh: MeshData,
    origin: Vec3,
    right: Vec3,
    up: Vec3,
    forward: Vec3,
    scale = 1,
  ): this {
    assertOrthonormal(right, up, forward);
    const base = this.vertexCount;
    const count = mesh.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const px = (mesh.positions[i * 3] ?? 0) * scale;
      const py = (mesh.positions[i * 3 + 1] ?? 0) * scale;
      const pz = (mesh.positions[i * 3 + 2] ?? 0) * scale;
      this.positions.push(
        origin[0] + right[0] * px + up[0] * py + forward[0] * pz,
        origin[1] + right[1] * px + up[1] * py + forward[1] * pz,
        origin[2] + right[2] * px + up[2] * py + forward[2] * pz,
      );
      const nx = mesh.normals[i * 3] ?? 0;
      const ny = mesh.normals[i * 3 + 1] ?? 0;
      const nz = mesh.normals[i * 3 + 2] ?? 0;
      this.normals.push(
        right[0] * nx + up[0] * ny + forward[0] * nz,
        right[1] * nx + up[1] * ny + forward[1] * nz,
        right[2] * nx + up[2] * ny + forward[2] * nz,
      );
      this.colors.push(
        mesh.colors[i * 3] ?? 0,
        mesh.colors[i * 3 + 1] ?? 0,
        mesh.colors[i * 3 + 2] ?? 0,
      );
      this.emissive.push(mesh.emissive[i] ?? 0);
      // Absent on almost every mesh, which is what `?? 0` is for: merging must not
      // invent a shine, and must not drop one the source had.
      this.specular.push(mesh.specular?.[i] ?? 0);
      this.emissiveColor.push(
        mesh.emissiveColor?.[i * 3] ?? INHERIT_ALBEDO,
        mesh.emissiveColor?.[i * 3 + 1] ?? INHERIT_ALBEDO,
        mesh.emissiveColor?.[i * 3 + 2] ?? INHERIT_ALBEDO,
      );
      /*
       * The merged mesh's own roughness, falling back to inherit — and its absence here
       * was the defect. Every other attribute was carried across and this one was not, so
       * merging a mesh left `roughness` shorter than the vertex count by exactly the
       * number of vertices merged. A short attribute buffer is not benign: a driver may
       * read zeroes, and it may drop the draw outright, which is what it did.
       */
      this.roughness.push(mesh.roughness?.[i] ?? this.roughnessState ?? INHERIT_ROUGHNESS);
      // The merged mesh's own grain, and the builder's current state for one that states none.
      this.grain.push(mesh.grain?.[i] ?? this.grainState);
      this.relief.push(mesh.relief?.[i] ?? this.reliefState);
    }
    this.mergeUvs(mesh, base, count);
    for (const index of mesh.indices) this.indices.push(base + index);
    this.vertexCount += count;
    return this;
  }

  /**
   * @param specular 0–1: how sharply this box takes a sun highlight. Zero, and
   * therefore free, for everything that is not meant to shine.
   */
  /**
   * What colour the following geometry emits, or `null` for its own albedo.
   *
   * State rather than a parameter, because `emissive` already reaches a dozen signatures
   * and a thirteenth argument on each of them is where a builder stops being readable.
   * It is also the honest shape: an emissive colour belongs to a *material*, and a
   * material covers many calls.
   *
   * The default — `null` — is the behaviour this builder has always had: the emissive term
   * is the surface's own colour scaled by its emissive amount, which is right for anything
   * that glows because it is hot or lit from within. It is wrong for a surface whose glow
   * is a different colour from its paint, and that is not a corner case: a ceiling tile
   * emitting a dull warm haze over a pale panel is how a strip-lit interior reads, and
   * approximating it by scaling the panel's own colour gets the brightness right and the
   * hue wrong every time.
   */
  /**
   * How rough the following geometry is, 0–1, or `null` for the engine's default.
   *
   * State for the same reason `setEmissiveColor` is, and it answers a different question
   * from `specular`: that one is how much light comes back, this is over how wide an angle.
   * A polished floor and a matte one can return the same energy and look nothing alike.
   */
  /**
   * Bind every vertex added from here on to one joint, at full weight, or `null` to stop.
   *
   * Rigid binding: one influence. A mesh assembled from solid pieces — a rig of boxes, a
   * chandelier, a tank's wheels — needs exactly this, and smooth skinning across a joint is a
   * different job belonging to a baker that reads a rigged source.
   *
   * Stopping binds what follows to joint 0 rather than to nothing, for the reason
   * `expandedJoints` gives: a zero-weight vertex collapses onto the origin.
   */
  setJoint(index: number | null): this {
    if (index !== null && (!Number.isInteger(index) || index < 0)) {
      throw new Error(`MeshBuilder: a joint index must be a non-negative integer, got ${index}`);
    }
    if (index !== null) this.anyJoint = true;
    this.jointSpans.push({ from: this.positions.length / 3, joint: index ?? 0 });
    return this;
  }

  setRoughness(roughness: number | null): this {
    this.roughnessState = roughness;
    return this;
  }

  /**
   * How much visible mineral structure the following geometry has, 0–1.
   *
   * State beside `setRoughness`, and deliberately **independent** of it. Roughness is how
   * widely a surface scatters a highlight; grain is whether it has structure you can see
   * at arm's length. Painted plaster is rough with no grain and polished granite is smooth
   * with a great deal, so neither can be derived from the other — which is exactly what the
   * two previous versions of this feature tried, first through `specular` and then through
   * `roughness`, and both were wrong in both directions.
   *
   * **Zero is the default and means none.** A scene says which of its surfaces are stone
   * while it is building them, and everything it does not mention stays smooth.
   */
  setGrain(grain: number): this {
    this.grainState = Math.min(1, Math.max(0, grain));
    return this;
  }

  /**
   * How much microscopic relief the surfaces built after this have, 0 to 1.
   *
   * **What it is for.** A road is not flat and neither is cast concrete, a plaster wall or a
   * hammered tray: each is covered in structure far too small to model and far too large to
   * ignore, and it is what makes them read as material rather than as coloured planes. This is
   * the general capability for that, so a scene states an amount here and the *material* decides
   * how coarse it is and how deep, through `Renderer.setSurfaceRelief`.
   *
   * **Distinct from `setGrain`, and both may apply.** Grain varies how much light a point takes,
   * so it mottles a face that stays flat. Relief varies which way the point faces, so it catches
   * a light from one side and shades on the other, and it survives being seen from a shallow
   * angle where a brightness mottle washes out. Stone wants both. Asphalt wants mostly this.
   *
   * **Zero is the default and means none**, so every surface a scene does not mention is smooth
   * and no world built before this existed moves.
   */
  setRelief(relief: number): this {
    this.reliefState = Math.min(1, Math.max(0, relief));
    return this;
  }

  setEmissiveColor(color: Vec3 | null): this {
    this.emissiveColorState = color;
    return this;
  }

  addBox(center: Vec3, halfExtents: Vec3, color: Vec3, emissive = 0, specular = 0): this {
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of SIGNS) {
        this.addFace(center, halfExtents, color, emissive, axis, sign, specular);
      }
    }
    return this;
  }

  /**
   * Add a single quad from four corners wound counter-clockwise as seen from the front.
   *
   * The escape hatch from `addBox` for geometry that is a *surface* rather than a solid.
   * Boxing every solid cell of a grid world emits the faces between two adjacent solids
   * as well — buried, invisible, and coplanar with each other, so at the edge where they
   * meet open space they z-fight into thin lines along every cell boundary. Reported as
   * walls that look like "blocks glued together". With this, a caller emits only the
   * faces that border something you can stand in, which removes the interior pairs
   * entirely and costs far fewer vertices than the boxes did.
   *
   * The normal is derived from the winding rather than taken as a parameter, so a quad
   * cannot be lit as if it faced a direction it does not.
   */
  /**
   * A flat quad, whose normal comes from `b - a` crossed with **`d - a`** rather than `c - a`.
   *
   * **That is not what anybody assumes, and it decides which side the face lights from.** Every
   * other winding convention in graphics walks consecutive vertices, so a horizontal quad wound
   * the obvious way round, `(x0,z0) (x1,z0) (x1,z1) (x0,z1)`, gives `+X` crossed with `+Z`,
   * which points at the floor. Reported from outside after every ground in an application faced
   * downward for four scenarios: they were lit by lamps near the floor, where a flipped normal
   * is a dimmer surface rather than an absent one, and it only became visible on the fifth world
   * when a directional lit it and the ground took nothing from the sun at all.
   *
   * Reverse the last two corners to flip it, or wind anticlockwise seen from the side the face
   * should light from.
   *
   * The normal is per *face*, so anything assembled from these is flat-shaded by construction.
   * A surface that has to be both curved and varied wants `addBlob`.
   */
  addQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: Vec3, emissive = 0, specular = 0): this {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) throw new Error('addQuad: degenerate corners have no normal');
    nx /= length;
    ny /= length;
    nz /= length;

    const base = this.vertexCount;
    for (const corner of [a, b, c, d]) {
      this.positions.push(corner[0], corner[1], corner[2]);
      this.normals.push(nx, ny, nz);
      this.colors.push(color[0], color[1], color[2]);
      this.emissive.push(emissive);
      this.specular.push(specular);
      this.pushEmissiveColor();
      this.roughness.push(this.roughnessState ?? INHERIT_ROUGHNESS);
      this.grain.push(this.grainState);
      this.relief.push(this.reliefState);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.vertexCount += 4;
    return this;
  }

  /**
   * A quad that faces **up**, whatever order its corners arrive in.
   *
   * **`addQuad`'s winding rule is the single most expensive trap in this class**, and its own note
   * says why: the normal is `(b − a) × (d − a)`, which is not the order a person walks around a
   * rectangle. Reading that note is not the same as remembering it at four in the morning. It cost
   * five scenes in one application before anybody saw it, and then four separate bugs in one
   * afternoon in another — one of which was every building in a village lit inside out, because a
   * wall is a quad too.
   *
   * So: a ground, a floor, a road, a tabletop, a roof plane seen from above. Pass the corners in
   * whichever order reads naturally and the face lights from the sky. What it costs is one cross
   * product and one comparison, at build time, once.
   *
   * A quad standing exactly vertical has no up and is refused rather than guessed at — a wall
   * passed to this by mistake is a caller error worth hearing about, and `addWallQuad` is the one
   * that wanted it.
   */
  addGroundQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: Vec3, emissive = 0, specular = 0): this {
    const up = quadNormal(a, b, d)[1];
    if (up === 0) {
      throw new Error('addGroundQuad: a vertical quad has no upward side; use addWallQuad');
    }
    return up > 0
      ? this.addQuad(a, b, c, d, color, emissive, specular)
      : this.addQuad(a, d, c, b, color, emissive, specular);
  }

  /**
   * A quad that faces **away from a point**, whatever order its corners arrive in.
   *
   * The other nine-tenths of what a consumer wants from `addQuad`: the outside of a wall, of a
   * chimney, of a crate, of anything hollow built from surfaces. `awayFrom` is usually the centre
   * of the room or the solid the face belongs to, and it need not be exact — only on the correct
   * side, which is a thing a caller knows without thinking. That is the whole difference from
   * winding, which is a thing a caller has to look up.
   *
   * A face whose centre *is* the reference point has no outward side, and that is refused: it means
   * the two were mixed up, and picking one silently is how a building ends up lighting its interior
   * while the outside takes nothing from the sun.
   */
  addWallQuad(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    awayFrom: Vec3,
    color: Vec3,
    emissive = 0,
    specular = 0,
  ): this {
    const normal = quadNormal(a, b, d);
    const outward =
      normal[0] * ((a[0] + b[0] + c[0] + d[0]) / 4 - awayFrom[0]) +
      normal[1] * ((a[1] + b[1] + c[1] + d[1]) / 4 - awayFrom[1]) +
      normal[2] * ((a[2] + b[2] + c[2] + d[2]) / 4 - awayFrom[2]);
    if (outward === 0) {
      throw new Error(
        'addWallQuad: the reference point lies in the face, so there is no outward side',
      );
    }
    return outward > 0
      ? this.addQuad(a, b, c, d, color, emissive, specular)
      : this.addQuad(a, d, c, b, color, emissive, specular);
  }

  /**
   * A box turned to lie along a direction, rather than square to the world axes.
   *
   * **`addBox` is world-axis only, and that is visible the moment anything follows a boundary.** A
   * hedge along a property line built from `addBox` is a row of detached slabs each facing a
   * different way; a window sill is square in plan and pokes out of three walls it does not belong
   * to. Both of those shipped in a consumer's world and both were reported by eye, and the wrapper
   * they wrote to fix it is this method.
   *
   * `halfExtents` are measured **along the box's own axes**: `x` across, `y` up, `z` along
   * `forward`. The other two axes are derived from world up, which is what makes this one argument
   * rather than three: a box that also has to tilt or roll wants `addOrientedMesh`, which takes the
   * full basis and is the reason this does not.
   *
   * Every face is emitted through `addWallQuad` against the box's own centre, so the six outward
   * normals are one argument rather than six windings to get right.
   */
  addOrientedBox(
    center: Vec3,
    halfExtents: Vec3,
    forward: Vec3,
    color: Vec3,
    emissive = 0,
    specular = 0,
  ): this {
    const length = Math.hypot(forward[0], forward[1], forward[2]);
    if (length === 0) throw new Error('addOrientedBox: forward has no direction');
    const fx = forward[0] / length;
    const fy = forward[1] / length;
    const fz = forward[2] / length;
    /* right = worldUp × forward, which is x = y × z in a right-handed basis: (0,1,0) × f is
       (fz, 0, −fx). Getting this backwards costs nothing visible on a box, which is symmetric
       about all three, and would be a mirrored world the day anything else reads the basis. */
    let rx = fz;
    const ry = 0;
    let rz = -fx;
    const across = Math.hypot(rx, rz);
    if (across === 0) {
      throw new Error(
        'addOrientedBox: forward is vertical, so world up cannot fix the other two axes; use addOrientedMesh',
      );
    }
    rx /= across;
    rz /= across;
    /* up = forward × right, orthonormal by construction because the two above are. */
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;

    const hx = halfExtents[0];
    const hy = halfExtents[1];
    const hz = halfExtents[2];
    const corner = (sx: number, sy: number, sz: number): Vec3 => [
      center[0] + rx * hx * sx + ux * hy * sy + fx * hz * sz,
      center[1] + ry * hx * sx + uy * hy * sy + fy * hz * sz,
      center[2] + rz * hx * sx + uz * hy * sy + fz * hz * sz,
    ];
    for (const [p, q, r, t] of BOX_FACES) {
      this.addWallQuad(
        corner(...p),
        corner(...q),
        corner(...r),
        corner(...t),
        center,
        color,
        emissive,
        specular,
      );
    }
    return this;
  }

  /**
   * A capsule aligned to Y: a cylindrical shaft with a hemispherical cap at each end.
   *
   * The shape almost every organic silhouette is roughed out with — a limb, a torso, a
   * creature seen through fog. A stack of boxes stands in for it badly: the corners read
   * as a *machine* at any distance, which is the wrong instinct entirely for something
   * meant to look alive. Reported as an entity looking "SQUARED".
   *
   * `halfLength` measures the cylindrical part only, so total height is
   * `2 * (halfLength + radius)` and a capsule with `halfLength` 0 is a sphere.
   */
  addCapsule(
    center: Vec3,
    radius: number,
    halfLength: number,
    color: Vec3,
    emissive = 0,
    segments = 12,
    rings = 6,
    specular = 0,
  ): this {
    if (radius <= 0) throw new Error('Capsule radius must be positive.');
    if (!Number.isInteger(segments) || segments < 3) {
      throw new Error('Capsule segments must be an integer of at least 3.');
    }
    if (!Number.isInteger(rings) || rings < 2) {
      throw new Error('Capsule rings must be an integer of at least 2.');
    }

    const base = this.vertexCount;
    /*
     * Two hemispheres of latitude rings, each offset to its own end of the shaft. The
     * bottom cap's last ring and the top cap's first ring are both at the equator radius
     * but at opposite ends, so the quad strip between them *is* the cylinder — the shaft
     * needs no separate geometry and there is no seam to crack.
     */
    const rows = (rings + 1) * 2;
    for (let row = 0; row < rows; row++) {
      const upper = row >= rings + 1;
      const capIndex = upper ? row - (rings + 1) : row;
      const phi = upper
        ? (capIndex / rings) * (Math.PI / 2)
        : (capIndex / rings) * (Math.PI / 2) - Math.PI / 2;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      const y = center[1] + (upper ? halfLength : -halfLength) + sinPhi * radius;

      for (let segment = 0; segment <= segments; segment++) {
        const theta = (segment / segments) * Math.PI * 2;
        const nx = cosPhi * Math.cos(theta);
        const nz = cosPhi * Math.sin(theta);
        this.positions.push(center[0] + nx * radius, y, center[2] + nz * radius);
        this.normals.push(nx, sinPhi, nz);
        this.colors.push(color[0], color[1], color[2]);
        this.emissive.push(emissive);
        this.specular.push(specular);
        this.pushEmissiveColor();
        this.roughness.push(this.roughnessState ?? INHERIT_ROUGHNESS);
        this.grain.push(this.grainState);
        this.relief.push(this.reliefState);
      }
    }
    this.vertexCount += rows * (segments + 1);

    const stride = segments + 1;
    for (let row = 0; row < rows - 1; row++) {
      for (let segment = 0; segment < segments; segment++) {
        const a = base + row * stride + segment;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        this.indices.push(a, c, b, b, c, d);
      }
    }
    return this;
  }

  /**
   * A smooth irregular solid: a sphere whose radius and colour are both asked for per point.
   *
   * **The gap this fills is "curved *and* varied", which nothing here could express.** Every
   * other generator takes one colour for the whole call, and the one primitive that could vary
   * it, `addQuad`, computes a *face* normal from its winding, so anything assembled from quads
   * is flat by construction. A consumer wanting a planet with latitude bands therefore had a
   * choice between a texture, in an engine whose whole argument is not needing images, and
   * geometry stuck onto a sphere. And a consumer wanting a rock went through four attempts,
   * each failing on a property of the primitive rather than on the shape: boxes gave right
   * angles, overlapping spheres gave cusps at every intersection and read as foam, a quad grid
   * gave a correct silhouette made of eighty flat plates, and a tube gave a water-worn pebble
   * because its cross-section is always a circle.
   *
   * `radiusAt` and `color` both take the surface parameters, `u` around and `v` from pole to
   * pole, each 0 to 1. A constant radius is `addSphere`; a few low-frequency waves is a boulder;
   * a signed step is a fracture; a constant radius with a varying colour is a banded planet.
   *
   * **A `radiusAt` built as a `min` of constraints has to place them inside the base radius.** A
   * cut plane at or above it removes nothing, so a set of them scattered around the radius
   * leaves a shape that is nearly round more often than not. Reported from outside, where nine
   * planes between 0.34 and 0.50 of a 0.5 radius gave a sphere about one seed in three.
   *
   * **The normal is derived from the surface rather than from the radius**, which is the part
   * that matters and the part a radial normal gets wrong. Where the radius varies, the surface
   * no longer faces along its own radius, so a radial normal lights a boulder as though it were
   * a sphere: the silhouette is lumpy and the shading is not. Each vertex takes the cross
   * product of the two parametric tangents, measured from the same callback, so a smooth radius
   * gives smooth shading and an abrupt one gives a genuine hard edge. That is what lets one
   * primitive be both a pebble and a fracture.
   */
  addBlob(
    center: Vec3,
    radiusAt: (u: number, v: number) => number,
    color: Vec3 | ((u: number, v: number) => Vec3),
    emissive = 0,
    segments = 24,
    rings = 16,
    specular = 0,
  ): this {
    if (!Number.isInteger(segments) || segments < 3) {
      throw new Error('Blob segments must be an integer of at least 3.');
    }
    if (!Number.isInteger(rings) || rings < 2) {
      throw new Error('Blob rings must be an integer of at least 2.');
    }

    /* One place that turns parameters into a point, so the tangents below are measured against
       exactly the surface the positions are on rather than against an idealised one. */
    const pointAt = (u: number, v: number, out: [number, number, number]): void => {
      const theta = u * Math.PI * 2;
      const phi = (v - 0.5) * Math.PI;
      const cosPhi = Math.cos(phi);
      const r = radiusAt(u, v);
      if (!Number.isFinite(r) || r <= 0)
        throw new Error('Blob radiusAt must return a positive number.');
      out[0] = center[0] + cosPhi * Math.cos(theta) * r;
      out[1] = center[1] + Math.sin(phi) * r;
      out[2] = center[2] + cosPhi * Math.sin(theta) * r;
    };

    const base = this.vertexCount;
    const here: [number, number, number] = [0, 0, 0];
    const uPlus: [number, number, number] = [0, 0, 0];
    const uMinus: [number, number, number] = [0, 0, 0];
    const vPlus: [number, number, number] = [0, 0, 0];
    const vMinus: [number, number, number] = [0, 0, 0];
    /* A step small against one cell, so the difference measures the surface rather than the
       grid, and large enough that a signed radius still reports its own jump. */
    const hu = 1 / (segments * 8);
    const hv = 1 / (rings * 8);

    /*
     * Everything this builder already holds gets a coordinate before the blob's own start, for
     * the reason `mergeUvs` states: a short attribute buffer is read past its end as zeroes by
     * some drivers and makes others drop the draw, and neither raises a GL error.
     */
    while (this.uvs.length < base * 2) this.uvs.push(0);

    for (let ring = 0; ring <= rings; ring++) {
      const v = ring / rings;
      for (let segment = 0; segment <= segments; segment++) {
        const u = segment / segments;
        pointAt(u, v, here);
        /* Wrapped in u, because the seam is one surface and a one-sided difference there would
           give the two edges of it different normals and draw a line down the object. */
        pointAt((u + hu) % 1, v, uPlus);
        pointAt((u - hu + 1) % 1, v, uMinus);
        /* Clamped in v: the poles have no other side. */
        pointAt(u, Math.min(1, v + hv), vPlus);
        pointAt(u, Math.max(0, v - hv), vMinus);

        const tu: [number, number, number] = [
          uPlus[0] - uMinus[0],
          uPlus[1] - uMinus[1],
          uPlus[2] - uMinus[2],
        ];
        const tv: [number, number, number] = [
          vPlus[0] - vMinus[0],
          vPlus[1] - vMinus[1],
          vPlus[2] - vMinus[2],
        ];
        let nx = tv[1] * tu[2] - tv[2] * tu[1];
        let ny = tv[2] * tu[0] - tv[0] * tu[2];
        let nz = tv[0] * tu[1] - tv[1] * tu[0];
        const length = Math.hypot(nx, ny, nz);
        if (length > 1e-9) {
          nx /= length;
          ny /= length;
          nz /= length;
        } else {
          /* Degenerate, which is the pole: the tangent around vanishes there. The radial
             direction is the honest answer and is what a sphere would have given anyway. */
          const rx = here[0] - center[0];
          const ry = here[1] - center[1];
          const rz = here[2] - center[2];
          const radial = Math.hypot(rx, ry, rz) || 1;
          nx = rx / radial;
          ny = ry / radial;
          nz = rz / radial;
        }

        const tint = typeof color === 'function' ? color(u, v) : color;
        /*
         * The surface parameters, kept rather than dropped, which is what lets a round thing
         * wear an authored image at all.
         *
         * They cost nothing to produce: the loop is already walking them to place the vertex,
         * and `planarUvs` is no substitute, being a box projection that meets itself at three
         * seams and smears the poles along an axis. What they cost is the buffer — two floats a
         * vertex, so a 240 by 130 sphere carries about 250 KB of them whether it is textured or
         * not. That is the same bargain `grain` and `relief` make, and it is why a mesh with no
         * blob in it still emits nothing.
         *
         * `u` runs 0 to 1 around and `v` 0 to 1 pole to pole, which is equirectangular and is
         * the parameterisation the primitive already had. The last column repeats the first at
         * `u = 1`, which exists here for the normals and is exactly what a wrapped image wants.
         */
        this.uvs.push(u, v);
        this.positions.push(here[0], here[1], here[2]);
        this.normals.push(nx, ny, nz);
        this.colors.push(tint[0], tint[1], tint[2]);
        this.emissive.push(emissive);
        this.specular.push(specular);
        this.pushEmissiveColor();
        this.roughness.push(this.roughnessState ?? INHERIT_ROUGHNESS);
        this.grain.push(this.grainState);
        this.relief.push(this.reliefState);
      }
    }
    this.vertexCount += (rings + 1) * (segments + 1);

    const stride = segments + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let segment = 0; segment < segments; segment++) {
        const a = base + ring * stride + segment;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        this.indices.push(a, c, b, b, c, d);
      }
    }
    return this;
  }

  /** A sphere, which is a capsule with no shaft. */
  addSphere(
    center: Vec3,
    radius: number,
    color: Vec3,
    emissive = 0,
    segments = 12,
    rings = 6,
  ): this {
    return this.addCapsule(center, radius, 0, color, emissive, segments, rings);
  }

  /** Add a faceted cylinder aligned to one principal axis. */
  addCylinder(
    center: Vec3,
    radius: number,
    halfLength: number,
    axis: 'x' | 'y' | 'z',
    color: Vec3,
    emissive = 0,
    segments = 12,
    specular = 0,
  ): this {
    if (radius <= 0 || halfLength <= 0) {
      throw new Error('Cylinder radius and half-length must be positive.');
    }
    if (!Number.isInteger(segments) || segments < 3) {
      throw new Error('Cylinder segments must be an integer of at least 3.');
    }

    const a = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const positiveCapNormal = [0, 0, 0] as Vec3;
    const negativeCapNormal = [0, 0, 0] as Vec3;
    const positiveCenter = [center[0], center[1], center[2]] as Vec3;
    const negativeCenter = [center[0], center[1], center[2]] as Vec3;
    positiveCapNormal[a] = 1;
    negativeCapNormal[a] = -1;
    positiveCenter[a] += halfLength;
    negativeCenter[a] -= halfLength;

    for (let segment = 0; segment < segments; segment++) {
      const angle0 = (segment / segments) * Math.PI * 2;
      const angle1 = ((segment + 1) / segments) * Math.PI * 2;
      const cos0 = Math.cos(angle0);
      const sin0 = Math.sin(angle0);
      const cos1 = Math.cos(angle1);
      const sin1 = Math.sin(angle1);
      const sideNormal = [0, 0, 0] as Vec3;
      const midAngle = (angle0 + angle1) * 0.5;
      sideNormal[b] = Math.cos(midAngle);
      sideNormal[c] = Math.sin(midAngle);

      const negative0 = [center[0], center[1], center[2]] as Vec3;
      const negative1 = [center[0], center[1], center[2]] as Vec3;
      const positive0 = [center[0], center[1], center[2]] as Vec3;
      const positive1 = [center[0], center[1], center[2]] as Vec3;
      negative0[a] -= halfLength;
      negative1[a] -= halfLength;
      positive0[a] += halfLength;
      positive1[a] += halfLength;
      negative0[b] += cos0 * radius;
      negative0[c] += sin0 * radius;
      negative1[b] += cos1 * radius;
      negative1[c] += sin1 * radius;
      positive0[b] += cos0 * radius;
      positive0[c] += sin0 * radius;
      positive1[b] += cos1 * radius;
      positive1[c] += sin1 * radius;

      let i = this.vertexCount;
      this.addVertex(negative0, sideNormal, color, emissive, specular);
      this.addVertex(negative1, sideNormal, color, emissive, specular);
      this.addVertex(positive1, sideNormal, color, emissive, specular);
      this.addVertex(positive0, sideNormal, color, emissive, specular);
      this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);

      i = this.vertexCount;
      this.addVertex(positiveCenter, positiveCapNormal, color, emissive, specular);
      this.addVertex(positive0, positiveCapNormal, color, emissive, specular);
      this.addVertex(positive1, positiveCapNormal, color, emissive, specular);
      this.indices.push(i, i + 1, i + 2);

      i = this.vertexCount;
      this.addVertex(negativeCenter, negativeCapNormal, color, emissive, specular);
      this.addVertex(negative1, negativeCapNormal, color, emissive, specular);
      this.addVertex(negative0, negativeCapNormal, color, emissive, specular);
      this.indices.push(i, i + 1, i + 2);
    }

    return this;
  }

  /**
   * Sweep a round tube of varying radius along an arbitrary path.
   *
   * The primitive a *curve* needs. `addCylinder` is axis-aligned and straight, and a
   * curve chained out of boxes — which is how every beam in this engine's consumers
   * has been built — has hard corners and only six distinct normals, so it reads as
   * a staircase however finely it is stepped. A tube carries a normal per ring
   * vertex, so the flat shader's interpolated `vNormal` shades it as the round thing
   * it is.
   *
   * The frame is **parallel-transported** rather than built from a fixed world up.
   * A frame derived from world up flips through 180 degrees wherever the path turns
   * vertical, which puts a visible twist in the tube at exactly the apex of an arch;
   * carrying the previous ring's frame forward and re-orthogonalising it against the
   * new tangent has no such singularity. It also has no preferred orientation to
   * disagree with, which matters when the path is planar and the plane is arbitrary.
   *
   * @param path Centreline as flattened x, y, z triples. At least two points.
   * @param radii One radius per path point, so a sweep can taper.
   * @param sides Vertices per ring. Eight is round enough to read as a cylinder at
   *   the distance a fixture is seen from, and cheap enough to put one on every gate.
   */
  /* Open at both ends: this draws a wall and no caps. Taper the end radii to almost nothing, or
   cap it yourself. A tube used as a solid shows a hole at one bearing per orbit, which survives
   a screenshot and fails in motion. */
  addTube(
    path: readonly number[],
    radii: readonly number[],
    color: Vec3,
    emissive = 0,
    sides = 8,
  ): this {
    const count = Math.floor(path.length / 3);
    if (count < 2) throw new Error(`A tube needs at least two path points, got ${count}.`);
    if (radii.length !== count) {
      throw new Error(`A tube needs one radius per path point: ${radii.length} for ${count}.`);
    }
    if (!Number.isInteger(sides) || sides < 3) {
      throw new Error(`Tube sides must be an integer of at least 3, got ${sides}.`);
    }

    const px = (i: number): number => path[i * 3] ?? 0;
    const py = (i: number): number => path[i * 3 + 1] ?? 0;
    const pz = (i: number): number => path[i * 3 + 2] ?? 0;

    const base = this.vertexCount;
    // Carried between rings: the transported reference axis.
    let ux = 0;
    let uy = 0;
    let uz = 0;
    let seeded = false;

    for (let i = 0; i < count; i++) {
      // Central difference inside, one-sided at the ends.
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, count - 1);
      let tx = px(b) - px(a);
      let ty = py(b) - py(a);
      let tz = pz(b) - pz(a);
      const tLength = Math.hypot(tx, ty, tz) || 1;
      tx /= tLength;
      ty /= tLength;
      tz /= tLength;

      if (!seeded) {
        // Any axis not parallel to the tangent will do for the first ring; every
        // later one is transported from it, so the choice never shows.
        const ax = Math.abs(tx) < 0.9 ? 1 : 0;
        const ay = Math.abs(tx) < 0.9 ? 0 : 1;
        ux = ay * tz - 0 * ty;
        uy = 0 * tx - ax * tz;
        uz = ax * ty - ay * tx;
        seeded = true;
      }

      // Re-orthogonalise against this ring's tangent: the minimal rotation, which is
      // what keeps the sweep from twisting along its own length.
      const drift = ux * tx + uy * ty + uz * tz;
      ux -= tx * drift;
      uy -= ty * drift;
      uz -= tz * drift;
      const uLength = Math.hypot(ux, uy, uz);
      if (uLength < 1e-6) {
        // The path doubled back on itself. Reseed rather than emit NaN.
        ux = Math.abs(tx) < 0.9 ? 1 - tx * tx : -tx * ty;
        uy = Math.abs(tx) < 0.9 ? -tx * ty : 1 - ty * ty;
        uz = Math.abs(tx) < 0.9 ? -tx * tz : -ty * tz;
        const reseeded = Math.hypot(ux, uy, uz) || 1;
        ux /= reseeded;
        uy /= reseeded;
        uz /= reseeded;
      } else {
        ux /= uLength;
        uy /= uLength;
        uz /= uLength;
      }

      // v completes the right-handed ring basis: u, v, tangent.
      const vx = ty * uz - tz * uy;
      const vy = tz * ux - tx * uz;
      const vz = tx * uy - ty * ux;

      const radius = radii[i] ?? 0;
      for (let j = 0; j < sides; j++) {
        const angle = (j / sides) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const nx = ux * cos + vx * sin;
        const ny = uy * cos + vy * sin;
        const nz = uz * cos + vz * sin;
        this.addVertex(
          [px(i) + nx * radius, py(i) + ny * radius, pz(i) + nz * radius],
          [nx, ny, nz],
          color,
          emissive,
        );
      }
    }

    /*
     * Stitched (i,j) → (i,j+1) → (i+1,j+1) → (i+1,j), which is the winding that comes
     * out facing *outward*: the other order yields `tangent x (tangent x u) = -u`,
     * an inward normal, and the whole tube is then culled away.
     */
    for (let i = 0; i + 1 < count; i++) {
      for (let j = 0; j < sides; j++) {
        const next = (j + 1) % sides;
        const near = base + i * sides;
        const far = base + (i + 1) * sides;
        this.indices.push(near + j, near + next, far + next);
        this.indices.push(near + j, far + next, far + j);
      }
    }

    return this;
  }

  /**
   * How much geometry is in here so far, without building it.
   *
   * **So a caller batching by size can ask instead of counting.** A consumer streaming a world caps
   * a batch at a triangle count and opens another when it is passed; without this the only way to
   * know was to tally what it had handed over, which means every geometry verb's triangle count
   * duplicated on the caller's side, and a batch that overshoots by whatever the last object was —
   * measured at 47,040 triangles against a cap of 32,000.
   *
   * Both are counters, not scans: asking costs nothing and may be asked between every object.
   */
  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Vertices written so far. The other half of the same question, for a memory budget. */
  get vertexCountSoFar(): number {
    return this.vertexCount;
  }

  build(options: MeshBuildOptions = {}): MeshData {
    /*
     * The specular array is emitted only when something in it is non-zero.
     *
     * That keeps the promise `MeshData.specular` makes: geometry that does not shine
     * produces exactly the mesh it produced before this attribute existed, uploads no
     * extra buffer, and reads the constant a disabled vertex attribute supplies.
     */
    /*
     * **Asked of the list rather than scanned for.** Each of these is "did anything differ from
     * the default", and each used to be a `some()` over every vertex — about 1.5 million predicate
     * calls for a mesh of a hundred thousand triangles, on the one call whose whole job is to be
     * cheap. The list knows at write time and answers in a field.
     */
    const shines = this.specular.hasOther;
    /* Same promise as `specular`: absent unless something actually named a colour. */
    const tinted = this.emissiveColor.hasOther;
    const rough = this.roughness.hasOther;
    /* Same promise again: a world with no mineral surfaces uploads no grain buffer. */
    const mineral = this.grain.hasOther;
    /* And again: a world with no textured surfaces uploads no relief buffer. */
    const textured = this.relief.hasOther;
    /* Same promise as `specular`: a mesh nothing bound uploads no skinning buffers, and
       `MeshData` requires both arrays or neither. */
    const skinned = this.anyJoint;
    return {
      positions: this.positions.toTyped(),
      normals: this.normals.toTyped(),
      colors: this.colors.toTyped(),
      emissive: this.emissive.toTyped(),
      ...(shines ? { specular: this.specular.toTyped() } : {}),
      ...(textured ? { relief: this.relief.toTyped() } : {}),
      ...(tinted ? { emissiveColor: this.emissiveColor.toTyped() } : {}),
      ...(rough ? { roughness: this.roughness.toTyped() } : {}),
      ...(mineral ? { grain: this.grain.toTyped() } : {}),
      ...(skinned ? { joints: this.expandedJoints(), weights: this.expandedWeights() } : {}),
      ...(options.planarUvs === true
        ? { uvs: this.planarUvs() }
        : this.uvs.length > 0
          ? { uvs: this.paddedUvs() }
          : {}),
      indices: this.indices.toTyped(),
    };
  }

  /**
   * Take a merged mesh's own texture coordinates, if it brought any.
   *
   * Padded to this mesh's own start first, because everything built before it — a box, a
   * cylinder, a mesh carrying no coordinates — contributed vertices and no UVs. Without the
   * padding the array is short, and every coordinate after the first gap belongs to the
   * wrong vertex, which draws as a texture sliding across a surface rather than as an error.
   *
   * It is the same defect `roughness` had here, and the reason it is worth stating twice: a
   * short attribute buffer is read past the end as zeroes by some drivers and causes others
   * to drop the draw outright, and neither raises a GL error.
   */
  private mergeUvs(mesh: MeshData, base: number, count: number): void {
    if (mesh.uvs === undefined) return;
    while (this.uvs.length < base * 2) this.uvs.push(0);
    for (let i = 0; i < count; i++) {
      this.uvs.push(mesh.uvs[i * 2] ?? 0, mesh.uvs[i * 2 + 1] ?? 0);
    }
  }

  /**
   * The rigid bindings, run out to cover every vertex the builder holds.
   *
   * A vertex before the first `setJoint` answers joint 0 at full weight rather than zero
   * weight, and the distinction is not pedantic: the shader sums four matrices by four
   * weights, so a zero-weight vertex is multiplied to the origin and the geometry reads as
   * exploding toward the rig's root. Following the root is what a rigid mesh under a skeleton
   * does, and it is the answer that degrades to something sensible.
   */
  private expandedJoints(): Float32Array {
    const total = this.positions.length / 3;
    const out = new Float32Array(total * 4);
    for (let v = 0, span = 0, joint = 0; v < total; v++) {
      while (span < this.jointSpans.length && (this.jointSpans[span]?.from ?? 0) <= v) {
        joint = this.jointSpans[span]?.joint ?? 0;
        span++;
      }
      out[v * 4] = joint;
    }
    return out;
  }

  /** One influence at full weight, per vertex. See `expandedJoints`. */
  private expandedWeights(): Float32Array {
    const total = this.positions.length / 3;
    const out = new Float32Array(total * 4);
    for (let v = 0; v < total; v++) out[v * 4] = 1;
    return out;
  }

  /** The merged coordinates, run out to cover every vertex the builder holds. */
  private paddedUvs(): Float32Array {
    const out = new Float32Array(this.vertexCount * 2);
    const merged = this.uvs;
    for (let i = 0; i < out.length && i < merged.length; i++) out[i] = merged.at(i);
    return out;
  }

  /**
   * Box-project every vertex onto the plane of the face it belongs to, in metres.
   *
   * Derived here rather than accumulated per vertex, and that is what keeps the cost
   * genuinely opt-in: UVs are a pure function of position and normal, so nothing
   * upstream — not `addBox`, not the cylinder, not a merged mesh — needs a second push
   * site or a branch, and a caller that never asks for UVs allocates nothing anywhere.
   *
   * The projection uses **world position** rather than a per-face 0–1 range, so a
   * surface assembled from many separate boxes tiles continuously across the joins
   * instead of restarting the pattern at each one. That is what a corridor built out of
   * wall segments actually needs, and it is why texture density is a repeats-per-metre
   * number at draw time rather than something baked in here.
   *
   * Axis choice mirrors `addFace`: for a face whose normal is dominant on axis `a`, U
   * runs along `(a+1)%3` and V along `(a+2)%3`. The two agree by construction rather
   * than by coincidence, which is what makes a box's UVs continuous with its
   * neighbours'.
   */
  private planarUvs(): Float32Array {
    const uvs = new Float32Array(this.vertexCount * 2);
    for (let i = 0; i < this.vertexCount; i++) {
      const nx = Math.abs(this.normals.at(i * 3));
      const ny = Math.abs(this.normals.at(i * 3 + 1));
      const nz = Math.abs(this.normals.at(i * 3 + 2));
      const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
      const x = this.positions.at(i * 3);
      const y = this.positions.at(i * 3 + 1);
      const z = this.positions.at(i * 3 + 2);
      /*
       * V is world *up* on anything vertical, and the two ground axes on anything flat.
       *
       * Rotating the axis index to pick the pair is the tidy-looking version and it is
       * wrong: it gives a wall facing X the pair (Y, Z) and a wall facing Z the pair
       * (X, Y), so U runs upward on one and along the floor on the other. Every texture
       * with an orientation — which is every wallpaper, every tile with a grain — then
       * appears rotated a quarter turn depending on which way the wall happens to face,
       * on adjacent walls of the same room. Reported exactly that way: one side of the
       * corridor right, the other "flipped by 90 degrees".
       */
      if (axis === 0) {
        uvs[i * 2] = z;
        uvs[i * 2 + 1] = y;
      } else if (axis === 1) {
        uvs[i * 2] = x;
        uvs[i * 2 + 1] = z;
      } else {
        uvs[i * 2] = x;
        uvs[i * 2 + 1] = y;
      }
    }
    return uvs;
  }

  private addFace(
    center: Vec3,
    half: Vec3,
    color: Vec3,
    emissive: number,
    axis: number,
    sign: number,
    specular = 0,
  ): void {
    const b = (axis + 1) % 3;
    const c = (axis + 2) % 3;

    // Face center offset along the normal; U along axis b, V along sign·axis c.
    const normal = [0, 0, 0];
    normal[axis] = sign;

    const base = [center[0], center[1], center[2]] as Vec3;
    base[axis] += sign * half[axis];

    for (const [du, dv] of CORNERS) {
      const point = [base[0], base[1], base[2]] as Vec3;
      point[b] += du * half[b];
      point[c] += sign * dv * half[c];
      this.positions.push(point[0], point[1], point[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.colors.push(color[0], color[1], color[2]);
      this.emissive.push(emissive);
      this.specular.push(specular);
      this.pushEmissiveColor();
      this.roughness.push(this.roughnessState ?? INHERIT_ROUGHNESS);
      this.grain.push(this.grainState);
      this.relief.push(this.reliefState);
    }

    const i = this.vertexCount;
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    this.vertexCount += 4;
  }

  private pushEmissiveColor(): void {
    const color = this.emissiveColorState;
    if (color === null) {
      this.emissiveColor.push(INHERIT_ALBEDO, INHERIT_ALBEDO, INHERIT_ALBEDO);
      return;
    }
    this.emissiveColor.push(color[0], color[1], color[2]);
  }

  private addVertex(
    position: Vec3,
    normal: Vec3,
    color: Vec3,
    emissive: number,
    specular = 0,
  ): void {
    this.positions.push(position[0], position[1], position[2]);
    this.normals.push(normal[0], normal[1], normal[2]);
    this.colors.push(color[0], color[1], color[2]);
    this.emissive.push(emissive);
    this.specular.push(specular);
    this.pushEmissiveColor();
    this.roughness.push(this.roughnessState ?? INHERIT_ROUGHNESS);
    this.grain.push(this.grainState);
    this.relief.push(this.reliefState);
    this.vertexCount++;
  }
}

/** Tolerance on each axis's length and on each pair's dot product. */
const BASIS_EPSILON = 1e-3;

function assertOrthonormal(right: Vec3, up: Vec3, forward: Vec3): void {
  const lengths =
    Math.abs(Math.hypot(right[0], right[1], right[2]) - 1) +
    Math.abs(Math.hypot(up[0], up[1], up[2]) - 1) +
    Math.abs(Math.hypot(forward[0], forward[1], forward[2]) - 1);
  const skew =
    Math.abs(dot(right, up)) + Math.abs(dot(up, forward)) + Math.abs(dot(forward, right));
  if (lengths > BASIS_EPSILON * 3 || skew > BASIS_EPSILON * 3) {
    throw new Error(
      `addOrientedMesh needs an orthonormal basis (length error ${lengths.toFixed(4)}, skew ${skew.toFixed(4)})`,
    );
  }
  /*
   * And a right-handed one. A mirror reverses winding, so every face of a
   * left-handed placement comes out back-facing and is culled: geometry that
   * renders with no GL error and no pixels, which is among the hardest things
   * there is to look at and diagnose. The text renderer's own cube carries a
   * comment about the same trap from the other side.
   */
  const handed =
    right[0] * (up[1] * forward[2] - up[2] * forward[1]) +
    right[1] * (up[2] * forward[0] - up[0] * forward[2]) +
    right[2] * (up[0] * forward[1] - up[1] * forward[0]);
  if (handed <= 0) {
    throw new Error(
      `addOrientedMesh needs a right-handed basis; this one mirrors (determinant ${handed.toFixed(4)}) and every face would be culled`,
    );
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const SIGNS = [1, -1] as const;

/**
 * The unnormalised face normal of a quad, by `addQuad`'s own rule so the wrappers cannot disagree
 * with the method they delegate to.
 *
 * Unnormalised because both callers only read its *sign* against a direction, and reused at module
 * scope because building a world calls this once per quad.
 */
const QUAD_NORMAL: Vec3 = [0, 0, 0];

function quadNormal(a: Vec3, b: Vec3, d: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = d[0] - a[0];
  const vy = d[1] - a[1];
  const vz = d[2] - a[2];
  QUAD_NORMAL[0] = uy * vz - uz * vy;
  QUAD_NORMAL[1] = uz * vx - ux * vz;
  QUAD_NORMAL[2] = ux * vy - uy * vx;
  if (QUAD_NORMAL[0] === 0 && QUAD_NORMAL[1] === 0 && QUAD_NORMAL[2] === 0) {
    throw new Error('degenerate corners have no normal');
  }
  return QUAD_NORMAL;
}

/**
 * The six faces of a box as corner signs, each ring walked in order.
 *
 * **The order within a ring is all that matters here and the direction is not**, because every one
 * of these goes through `addWallQuad` against the box's centre, which turns whichever way it was
 * given into the way that faces out. That is the reason this table is safe to read and the reason
 * `addOrientedBox` is short.
 */
type CornerSigns = readonly [number, number, number];
const BOX_FACES: readonly (readonly [CornerSigns, CornerSigns, CornerSigns, CornerSigns])[] = [
  [
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ],
  [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
  ],
  [
    [1, -1, -1],
    [1, -1, 1],
    [1, 1, 1],
    [1, 1, -1],
  ],
  [
    [-1, -1, -1],
    [-1, -1, 1],
    [-1, 1, 1],
    [-1, 1, -1],
  ],
  [
    [-1, 1, -1],
    [1, 1, -1],
    [1, 1, 1],
    [-1, 1, 1],
  ],
  [
    [-1, -1, -1],
    [1, -1, -1],
    [1, -1, 1],
    [-1, -1, 1],
  ],
];

/** Corner order (-U-V, +U-V, +U+V, -U+V) → two CCW triangles per face. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;
