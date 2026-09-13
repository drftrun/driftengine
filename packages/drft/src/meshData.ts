/**
 * A description of vertex data, and the check that it is coherent.
 *
 * It lives in the format package rather than the renderer because it is the boundary object
 * between them: the container's whole job is to carry one of these, and every import the
 * format code took from `render` was this type or its validator. Putting it here is what lets
 * the container be read and written by something that never draws.
 *
 * The renderer re-exports both, so nothing that consumed them from there has to move.
 */

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** One float per vertex: self-illumination, revealed only at night. */
  emissive: Float32Array;
  /**
   * One float per vertex, 0–1: how sharply this surface takes a sun highlight.
   *
   * Optional, and that is a cost decision rather than a convenience one. Seventeen
   * places build a `MeshData`, and only a handful of props shine — so rather than make every
   * producer fill an array of zeroes, an absent array leaves attribute 4 disabled and
   * the shader reads the constant WebGL supplies for it. A world with no shiny
   * geometry allocates nothing and uploads nothing.
   */
  specular?: Float32Array;
  /**
   * Four floats per vertex: a tangent, and the handedness of the bitangent in `w`.
   *
   * Optional for the same cost reason as `specular` and `uvs`, and the reason bites harder here:
   * four floats a vertex is the widest optional attribute in the format, and only geometry that
   * carries a normal map has any use for it. A world with none allocates nothing, uploads
   * nothing, and reads the constant its backend supplies.
   *
   * `w` is ±1. The bitangent is `cross(normal, tangent) * w`, and the sign is what keeps a
   * mirrored UV layout from lighting one side of a model inside out. See `generateTangents`.
   */
  tangents?: Float32Array;
  /**
   * Two floats per vertex: where this vertex sits in a surface texture.
   *
   * Optional for the same cost reason as `specular`, and the reason carries further
   * here because most geometry in this engine is coloured rather than textured. An
   * absent array leaves attribute 5 disabled and the shader reads the constant WebGL
   * supplies, so a world with no textured surfaces allocates nothing and uploads
   * nothing — and none of the existing `MeshData` producers had to change to gain a
   * coordinate they will never use.
   *
   * Only meaningful alongside a `SurfaceTexture` at draw time. Geometry carrying UVs
   * and drawn without a texture shades from its vertex colours exactly as before.
   */
  uvs?: Float32Array;
  /**
   * Three floats per vertex: the colour this vertex emits, independent of its albedo.
   *
   * Optional, and absent means what this engine always did — the emissive term is the
   * surface's own colour scaled by `emissive`, which is right for anything glowing because
   * it is hot or lit from within. It is wrong whenever the glow is a different colour from
   * the paint, and the approximation gets brightness right and hue wrong: a ceiling tile
   * emitting a dull warm haze over a pale panel cannot be expressed by scaling the panel.
   *
   * A negative component means "inherit the albedo", which is what an absent array supplies
   * for every vertex — so a mesh that names a colour for some of its geometry and not the
   * rest is one buffer rather than two meshes.
   */
  emissiveColor?: Float32Array;
  /**
   * One float per vertex, 0–1: how rough this surface is, which is the *shape* of its
   * highlight rather than its strength.
   *
   * Absent means the old constant, so nothing existing changes. It matters because a
   * highlight's width is not something intensity can express: a polished floor seen at a
   * grazing angle smears a lamp into a long streak down the view direction, and a tight
   * fixed lobe can only ever make a small round dot brighter. `specular` says how much
   * light comes back; this says over how wide an angle.
   */
  roughness?: Float32Array;
  /**
   * One float per vertex, 0–1: how much visible mineral structure this surface has.
   *
   * **Absent means none**, which is the one thing the previous two attempts could not say.
   * Grain was first gated on `specular > 0`, then weighted by `roughness`, and both are
   * proxies rather than statements: painted plaster is rough and has no grain, polished
   * granite is smooth and has a great deal of it. Deriving either property from the other
   * guesses, and the guess was wrong in both directions — a painted tower at roughness 0.55
   * took 55% grain and read as marble.
   *
   * So it is its own attribute, exactly as `specular` and `roughness` are, and a surface
   * states it while it is being built. This is the *material* half of the answer; how strong
   * the pattern is at a given amount belongs to the shader's constants.
   */
  grain?: Float32Array;
  /**
   * How much microscopic relief a surface has, 0 to 1. Absent means a perfectly smooth one.
   *
   * **The sibling of `grain`, and the difference between them is the whole point.** Grain says
   * how much *light* a point takes, so it varies brightness across a face that stays flat. This
   * says which way the surface is *facing*, so it varies the direction light leaves it. Only the
   * second gives a surface texture that survives a shallow angle and moves as you walk past:
   * asphalt aggregate, cast concrete, orange peel on paint, hammered metal, plaster stipple.
   * Neither stands in for the other, which is why it is a second attribute rather than a
   * weighting of the first.
   *
   * Absent means none, so every mesh built before this existed is unchanged. How coarse the
   * relief is and how strong belongs to the material rather than the geometry, since that is what
   * separates asphalt from plaster, and the pass states it: see `Renderer.setSurfaceRelief`.
   */
  relief?: Float32Array;
  /**
   * Four floats per vertex, and the only attribute whose lanes mean four different things.
   *
   * `.x` **sway**: how far the shared wind moves this vertex, along the wind's own direction.
   * `.y` **skyDirect**: how much of the directional term this vertex receives, 0 to 1.
   * `.z` **alpha**: multiplies the draw's own opacity and the texture's cutout coverage.
   * `.w` is reserved, declared and unread.
   *
   * **One attribute and not three, because locations are the scarce resource here.** WebGL2
   * guarantees sixteen vertex attribute locations, eleven are already spent, and an instanced
   * draw spends all sixteen. A `vec4` costs the same one location a `float` would, so the spare
   * lane is free and the next per-vertex question does not have to re-argue the budget.
   *
   * **`skyDirect` is a separate lane rather than a factor in `colors`, and that is the defect it
   * exists to fix.** The shader reads `albedo = vColor` and then `lit = albedo * (ambient + sun)`,
   * so a sky factor carried in the vertex colour scales both terms and an enclosed face is
   * darkened twice — once for having no sky, once for the ambient it should still have received.
   * A consumer reporting this raised a floor constant to 0.45 to compensate and measured what it
   * cost: 55% of a chunk's vertices sat between 0.10 and 0.20.
   *
   * Absent means `(0, 1, 1, 0)`: planted, fully sunlit, opaque. Every mesh built before this
   * existed is unchanged to the bit, which is what the absent-attribute constant buys.
   *
   * **Sway is authored, not derived.** `scatter.ts` squares its own falloff because it computes
   * one from height, where a linear response slides a whole plant sideways and reads as the
   * ground moving. Here the author writes the curve — 0 on a trunk, 1 at a leaf tip — so squaring
   * it would overrule a shape somebody had already chosen. What that costs is that a lane filled
   * linearly up a trunk gives a tree that slides at its base, and the fix is the curve.
   */
  channel?: Float32Array;
  /**
   * Four floats per vertex: which joints move this vertex, as indices into a skinning palette.
   *
   * Optional for the same cost reason as every attribute above it, and the reason is strongest
   * here: only a skinned character has any use for one, and a world of walls and props allocates
   * nothing and uploads nothing. Absent means unskinned, and an unskinned mesh takes exactly the
   * draw path it took before skinning existed.
   *
   * **Four influences and not eight.** Four is what glTF's `JOINTS_0` carries, what every DCC tool
   * exports without being asked, and what fits one attribute. Eight doubles the attribute cost of
   * every skinned vertex to serve a case that rarely survives an export.
   *
   * **`Float32Array` and not `Uint8Array`, which costs twelve bytes a vertex.** Every attribute in
   * this format is float32 and the absent-attribute mechanism depends on it: `mesh.ts` attaches
   * with `gl.FLOAT`, `ABSENT_ATTRIBUTE` is a number array, and `buffers.ts` interleaves floats and
   * writes float constants for what a mesh omits. An integer attribute needs `vertexAttribIPointer`
   * on one backend, a `uint8x4` entry on the other, and an integer arm through the constants buffer
   * — four places where one question starts being answered twice. Integers to 2^24 are exact in
   * float32, so an index is never rounded. What would make it wrong is a consumer whose payload is
   * dominated by skinned meshes; the fix is a `uint8x4` attribute and that fourth mechanism.
   */
  joints?: Float32Array;
  /**
   * Four floats per vertex: how much each of `joints`' four influences moves this vertex.
   *
   * Normalised by the importer rather than by the shader, because normalising per vertex per frame
   * costs a divide on every vertex to correct data that should have been fixed once. `gltfSkin.ts`
   * normalises on the way in and warns when a set does not sum to one.
   *
   * Absent means unskinned, and it must be absent exactly when `joints` is — one without the other
   * is refused below rather than drawn.
   */
  weights?: Float32Array;
  /**
   * Morph target position deltas: `morphTargetCount` targets, three floats a vertex each.
   *
   * Laid out **interleaved by vertex** — every target of one vertex adjacent — because the shader
   * reads all of a vertex's targets together and nothing reads one target across many vertices.
   * So the index of target `t` for vertex `v` is `(v * count + t) * 3`.
   *
   * A delta rather than an absolute position, which is what makes them additive: several targets
   * apply at once by weight, and a weight of zero contributes nothing rather than dragging the
   * vertex toward some other shape.
   *
   * **Positions only.** A target that also moved normals would double this array and add a second
   * fetch per target in the vertex stage; what it gives up is shading that lags a strongly morphed
   * surface. What would make it wrong is a face rig, where the lighting is most of the effect.
   */
  morphTargets?: Float32Array;
  /** How many targets `morphTargets` holds. Absent means none, whatever the array says. */
  morphTargetCount?: number;
  indices: Uint32Array;
}

/**
 * Every attribute covers every vertex, and every index names one that exists.
 *
 * **Why this is checked rather than assumed.** WebGL does not require a driver to survive
 * an attribute buffer that is too small for the draw: the implementation may read zeroes,
 * and it may equally **drop the draw entirely**. Desktop drivers clamp and carry on, which
 * means a mesh with one short array renders perfectly for the author and vanishes without
 * a word on hardware they do not own. There is no GL error either way, so nothing
 * downstream can tell the difference between a mesh that was rejected and a mesh that was
 * never submitted.
 *
 * Thrown rather than warned, because this is construction and not a frame: a mesh built
 * from inconsistent arrays is a bug in the caller with exactly one correct outcome, and
 * the engine's rule is that initialisation fails loudly so a running frame never has to.
 *
 * The message names the array, its length, and the length it should have had — everything
 * needed to fix it without a debugger, since the machine where this fires may not have one.
 */
export function validateMeshData(data: MeshData): void {
  if (data.positions.length % 3 !== 0) {
    throw new Error(`Mesh: positions has ${data.positions.length} floats, not a multiple of 3`);
  }
  const vertices = data.positions.length / 3;

  const check = (name: string, array: Float32Array | undefined, perVertex: number): void => {
    if (array === undefined) return;
    if (array.length !== vertices * perVertex) {
      throw new Error(
        `Mesh: ${name} has ${array.length} floats for ${vertices} vertices; ` +
          `expected ${vertices * perVertex} (${perVertex} per vertex). A short attribute ` +
          `buffer is not a harmless one — a driver may draw zeroes or drop the draw entirely.`,
      );
    }
  };
  check('normals', data.normals, 3);
  check('colors', data.colors, 3);
  check('emissive', data.emissive, 1);
  check('specular', data.specular, 1);
  check('uvs', data.uvs, 2);
  check('emissiveColor', data.emissiveColor, 3);
  check('roughness', data.roughness, 1);
  check('grain', data.grain, 1);
  check('relief', data.relief, 1);
  check('channel', data.channel, 4);
  /*
   * `tangents` was declared optional on 2026-08-22 and was not checked here until 2026-08-25, which
   * made the widest optional attribute in the format the one a short buffer could reach a driver
   * through — the exact hazard this function's header describes, unguarded, for three releases.
   */
  check('tangents', data.tangents, 4);
  check('joints', data.joints, 4);
  check('weights', data.weights, 4);

  /*
   * Both or neither. The shader multiplies four matrices by four weights, so a missing half means
   * either every weight or every index is the absent-attribute constant — and both collapse the
   * mesh onto joint zero at the origin, which draws a picture rather than raising anything.
   *
   * What it costs is that a caller cannot supply indices alone. What would make it wrong is a path
   * that skins from indices with implicit unit weights; nothing proposes one, and it would be a
   * different attribute rather than a relaxation of this rule.
   */
  /*
   * Morph deltas are checked against their own declared count rather than through `check`, because
   * they are the one attribute whose length is not a fixed multiple of the vertex count — it scales
   * with the targets too. A short array is the same hazard as any other: the tail reads as zero, so
   * the last targets silently never move anything.
   */
  if (data.morphTargets !== undefined || data.morphTargetCount !== undefined) {
    const count = data.morphTargetCount ?? 0;
    if (data.morphTargets === undefined || count < 1) {
      throw new Error(
        'Mesh: morphTargets and morphTargetCount go together — one without the other is a mesh ' +
          'that declares a deformation it cannot perform',
      );
    }
    const expected = vertices * count * 3;
    if (data.morphTargets.length !== expected) {
      throw new Error(
        `Mesh: morphTargets has ${data.morphTargets.length} floats for ${vertices} vertices and ` +
          `${count} targets; expected ${expected} (3 per vertex per target).`,
      );
    }
  }

  if ((data.joints === undefined) !== (data.weights === undefined)) {
    throw new Error(
      data.joints === undefined
        ? 'Mesh: weights without joints — a skinned mesh needs both, or every vertex collapses onto joint 0'
        : 'Mesh: joints without weights — a skinned mesh needs both, or every vertex collapses onto joint 0',
    );
  }

  /*
   * An index past the end is the same hazard from the other side, and the same latitude
   * applies: a driver may clamp it or refuse the draw. Scanned once at construction, which
   * is a cost paid when a mesh is built rather than when it is drawn.
   */
  for (let at = 0; at < data.indices.length; at++) {
    const index = data.indices[at] as number;
    if (index >= vertices) {
      throw new Error(
        `Mesh: index ${at} refers to vertex ${index}, but the mesh has ${vertices}. ` +
          `Out-of-range indices may be clamped on one driver and reject the draw on another.`,
      );
    }
  }
}
