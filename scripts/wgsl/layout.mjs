/**
 * Where each uniform sits inside its block, in bytes.
 *
 * **The renderer has to write a value at exactly the offset the shader reads it from, and
 * nothing checks that at runtime.** A wrong offset is not an error: it is a picture that is
 * subtly and confidently wrong — a fog colour read out of a light direction, a matrix
 * shifted by four bytes. The one defence is for the offsets to come from the same place the
 * shader did, which is here.
 *
 * The rules are WGSL's for the uniform address space, which are stricter than a C struct's
 * and are the reason this cannot be eyeballed: **`vec3` occupies twelve bytes but aligns to
 * sixteen**, so two adjacent `vec3`s are 16 apart rather than 12, and a scalar following one
 * lands in the padding rather than after it.
 */

/** size and alignment, in bytes, for the types this corpus declares. */
const TYPES = {
  float: { size: 4, align: 4 },
  int: { size: 4, align: 4 },
  uint: { size: 4, align: 4 },
  bool: { size: 4, align: 4 },
  vec2: { size: 8, align: 8 },
  vec3: { size: 12, align: 16 },
  vec4: { size: 16, align: 16 },
  ivec2: { size: 8, align: 8 },
  ivec3: { size: 12, align: 16 },
  ivec4: { size: 16, align: 16 },
  uvec2: { size: 8, align: 8 },
  uvec3: { size: 12, align: 16 },
  uvec4: { size: 16, align: 16 },
  bvec4: { size: 16, align: 16 },
  mat2: { size: 16, align: 8 },
  mat3: { size: 48, align: 16 },
  mat4: { size: 64, align: 16 },
};

const roundUp = (value, to) => Math.ceil(value / to) * to;

/**
 * Resolve `#define NAME 8` so an array length is a number rather than a symbol.
 *
 * Only object-like defines with a literal integer, which is every one this corpus uses for a
 * length. Anything else is left alone and reported as unresolved rather than guessed at.
 */
export function numericDefines(source) {
  const defines = {};
  const re = /^\s*#define\s+(\w+)\s+(\d+)\s*$/gm;
  let match;
  while ((match = re.exec(source)) !== null) defines[match[1]] = Number(match[2]);
  return defines;
}

/**
 * The byte layout of one uniform block.
 *
 * `members` are the declarations as they appear inside the block, e.g. `mat4 uViewProj` or
 * `vec3 uLightPos[MAX_LIGHTS]`.
 *
 * **An array's element stride is at least sixteen, because the uniform address space says so.**
 * WGSL § Address Space Layout Constraints requires it, and a `vec3` array satisfies it already
 * since a `vec3` aligns to sixteen. `float`, `int` and `vec2` arrays do not, so
 * `padNarrowArrays` widens them before they ever reach a block and this rounding is what agrees
 * with the result.
 *
 * **This file said the opposite for a release, and the reason is worth keeping.** It once
 * rounded to sixteen, and was changed to pack after a measurement: every float of the block was
 * filled with its own index and the fragment stage was asked where it had read from. It
 * answered that `uLightSourceRadius[0]` sat at byte 648 and `uLightWeight[0]` at 688 — ten
 * floats apart, not forty — against the 768 and 928 computed here, and two whole arrays were
 * being written where nothing read them. The symptom was a night scene with no lamps in it,
 * because the light term is multiplied by `uLightWeight`.
 *
 * The measurement was sound and the conclusion was one browser wide. What it had actually found
 * is that naga cannot express a stride in WGSL — `@stride` was removed from the language — so
 * it drops SPIR-V's `ArrayStride 16` and emits a packed array, which Dawn then lays out packed.
 * Matching that made the CPU side agree with a shader that is not legal WGSL. WebKit enforces
 * the rule and refused every one of them, which is a black screen on every iPhone, and it
 * shipped in 1.0.0 unnoticed because Dawn never complains. See
 * the iOS black-screen investigation.
 *
 * So the stride is the language's again, and the shader is padded to match rather than the
 * layout bent to fit it. `src/render/shaders/uniformStride.test.ts` fails if one gets through.
 */
export function blockLayout(members, defines = {}) {
  const fields = {};
  let offset = 0;

  for (const member of members) {
    const parsed = /^\s*(\w+)\s+(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*;?\s*$/.exec(member);
    if (parsed === null) throw new Error(`layout: cannot parse member "${member}"`);
    const [, type, name, lengthToken] = parsed;

    const shape = TYPES[type];
    if (shape === undefined) throw new Error(`layout: unknown type "${type}" in "${member}"`);

    let length = null;
    if (lengthToken !== undefined) {
      const resolved = /^\d+$/.test(lengthToken) ? Number(lengthToken) : defines[lengthToken];
      if (resolved === undefined) {
        throw new Error(`layout: array length "${lengthToken}" is not a resolvable define`);
      }
      length = resolved;
    }

    /* An array element rounds to sixteen at least; a lone value keeps its own size. */
    const stride = length === null ? shape.size : roundUp(shape.size, Math.max(shape.align, 16));
    const align = shape.align;
    offset = roundUp(offset, align);
    fields[name] = {
      offset,
      size: length === null ? shape.size : stride * length,
      type,
      ...(length === null ? {} : { length, stride }),
    };
    offset += fields[name].size;
  }

  /* A uniform buffer's own size rounds to sixteen. */
  return { fields, size: Math.max(16, roundUp(offset, 16)) };
}
