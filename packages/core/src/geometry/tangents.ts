/**
 * A tangent frame: which way is *along the texture*.
 *
 * **Every map in Phase 1.3 needs one and nothing in this engine had it.** A normal map stores its
 * directions in the surface's own space, and turning those into world directions takes three
 * axes: the normal, a tangent running with u, and a bitangent running with v. Two of the three
 * come from geometry the engine already has; this derives the third.
 *
 * **Four floats a vertex, and `w` is the interesting one.** The bitangent is
 * `cross(normal, tangent) * w`, and the sign is needed because a UV layout can mirror: an artist
 * mapping the left and right of a model onto one patch of texture gives one side a flipped frame,
 * and a bitangent computed without the sign lights that side inside out. Storing it costs a float
 * a vertex, and every format that has been through this — glTF included — settled on the same
 * four rather than storing the bitangent outright, which costs three.
 */

/** Scratch, so a build that derives many meshes does not allocate per mesh. */
const accumulated: { tangents: Float32Array; bitangents: Float32Array } = {
  tangents: new Float32Array(0),
  bitangents: new Float32Array(0),
};

function scratchFor(vertices: number): typeof accumulated {
  if (accumulated.tangents.length < vertices * 3) {
    accumulated.tangents = new Float32Array(vertices * 3);
    accumulated.bitangents = new Float32Array(vertices * 3);
  } else {
    accumulated.tangents.fill(0, 0, vertices * 3);
    accumulated.bitangents.fill(0, 0, vertices * 3);
  }
  return accumulated;
}

function accumulate(
  tangents: Float32Array,
  bitangents: Float32Array,
  v: number,
  tx: number,
  ty: number,
  tz: number,
  bx: number,
  by: number,
  bz: number,
): void {
  tangents[v * 3] = (tangents[v * 3] ?? 0) + tx;
  tangents[v * 3 + 1] = (tangents[v * 3 + 1] ?? 0) + ty;
  tangents[v * 3 + 2] = (tangents[v * 3 + 2] ?? 0) + tz;
  bitangents[v * 3] = (bitangents[v * 3] ?? 0) + bx;
  bitangents[v * 3 + 1] = (bitangents[v * 3 + 1] ?? 0) + by;
  bitangents[v * 3 + 2] = (bitangents[v * 3 + 2] ?? 0) + bz;
}

/**
 * Derive a tangent frame from positions, normals and texture coordinates.
 *
 * **Accumulated per triangle, then orthogonalised per vertex.** A vertex shared by two triangles
 * gets the sum of their tangents, which is what makes a smooth surface's frame smooth; the sum is
 * then no longer square to the interpolated normal, and Gram-Schmidt is what puts it back.
 * Dropping that step is a normal map that shears wherever the geometry curves.
 *
 * Never returns a NaN. A triangle whose three vertices share one texture coordinate has no
 * direction along the texture at all and the arithmetic divides by zero — which is the common
 * case in a bought asset rather than an edge case, and a NaN in a vertex buffer takes the whole
 * triangle off the screen. Those vertices get some unit vector perpendicular to their normal,
 * which is arbitrary and finite, and arbitrary is the honest answer to an unanswerable question.
 */
export function generateTangents(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array | Uint32Array,
  out?: Float32Array,
): Float32Array {
  const vertices = Math.floor(positions.length / 3);
  const result = out ?? new Float32Array(vertices * 4);
  const scratch = scratchFor(vertices);
  const { tangents, bitangents } = scratch;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] ?? 0;
    const b = indices[i + 1] ?? 0;
    const c = indices[i + 2] ?? 0;

    const x1 = (positions[b * 3] ?? 0) - (positions[a * 3] ?? 0);
    const y1 = (positions[b * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
    const z1 = (positions[b * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
    const x2 = (positions[c * 3] ?? 0) - (positions[a * 3] ?? 0);
    const y2 = (positions[c * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
    const z2 = (positions[c * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);

    const s1 = (uvs[b * 2] ?? 0) - (uvs[a * 2] ?? 0);
    const t1 = (uvs[b * 2 + 1] ?? 0) - (uvs[a * 2 + 1] ?? 0);
    const s2 = (uvs[c * 2] ?? 0) - (uvs[a * 2] ?? 0);
    const t2 = (uvs[c * 2 + 1] ?? 0) - (uvs[a * 2 + 1] ?? 0);

    /*
     * The area of the triangle in texture space. Zero means the three vertices share one
     * coordinate, so this triangle says nothing about direction and is skipped — leaving its
     * vertices to whatever their other triangles say, or to the fallback below if they have none.
     */
    const area = s1 * t2 - s2 * t1;
    if (Math.abs(area) < 1e-12) continue;
    const r = 1 / area;

    const tx = (t2 * x1 - t1 * x2) * r;
    const ty = (t2 * y1 - t1 * y2) * r;
    const tz = (t2 * z1 - t1 * z2) * r;
    const bx = (s1 * x2 - s2 * x1) * r;
    const by = (s1 * y2 - s2 * y1) * r;
    const bz = (s1 * z2 - s2 * z1) * r;

    /* Written out rather than looped over `[a, b, c]`, which allocates an array per triangle —
       and a large import has hundreds of thousands of them. */
    accumulate(tangents, bitangents, a, tx, ty, tz, bx, by, bz);
    accumulate(tangents, bitangents, b, tx, ty, tz, bx, by, bz);
    accumulate(tangents, bitangents, c, tx, ty, tz, bx, by, bz);
  }

  for (let v = 0; v < vertices; v += 1) {
    const nx = normals[v * 3] ?? 0;
    const ny = normals[v * 3 + 1] ?? 0;
    const nz = normals[v * 3 + 2] ?? 0;

    let tx = tangents[v * 3] ?? 0;
    let ty = tangents[v * 3 + 1] ?? 0;
    let tz = tangents[v * 3 + 2] ?? 0;

    /* Gram-Schmidt: take out whatever part of the tangent points along the normal. */
    const along = tx * nx + ty * ny + tz * nz;
    tx -= nx * along;
    ty -= ny * along;
    tz -= nz * along;

    let length = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (length < 1e-8) {
      /*
       * No usable direction: a vertex no triangle mentions, or one whose triangles all had no
       * area in texture space. Any unit vector perpendicular to the normal will do, and the
       * cross with whichever axis the normal points least along is the one that is never
       * degenerate.
       */
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      const px = ax <= ay && ax <= az ? 1 : 0;
      const py = ay < ax && ay <= az ? 1 : 0;
      const pz = px === 0 && py === 0 ? 1 : 0;
      tx = ny * pz - nz * py;
      ty = nz * px - nx * pz;
      tz = nx * py - ny * px;
      length = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    }

    const inv = 1 / length;
    result[v * 4] = tx * inv;
    result[v * 4 + 1] = ty * inv;
    result[v * 4 + 2] = tz * inv;

    /*
     * The handedness. `cross(normal, tangent)` is the bitangent the frame implies; if the one the
     * texture actually asks for points the other way, `w` is -1 and the shader flips it.
     */
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    const bx = bitangents[v * 3] ?? 0;
    const by = bitangents[v * 3 + 1] ?? 0;
    const bz = bitangents[v * 3 + 2] ?? 0;
    result[v * 4 + 3] = cx * bx + cy * by + cz * bz < 0 ? -1 : 1;
  }

  return result;
}
