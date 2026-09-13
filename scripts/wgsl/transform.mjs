/**
 * GLSL ES 3.00 as this engine writes it, rewritten into the dialect glslang will hand to
 * SPIR-V.
 *
 * **Every rule here answers a specific compiler error, and none of them is taste.** The
 * errors are quoted on each function and reproduced in
 * the WGSL toolchain design., which is the record of the run
 * that found them. Delete any one rule and a real shader in this repository stops
 * compiling, so a rule that looks unnecessary should be tested rather than trimmed.
 *
 * Pure string-to-string, with no tool and no filesystem in it, so the rules can be unit
 * tested without a 1.7 MB wasm build and a cargo binary being present.
 */

/**
 * Sampler types this corpus uses, and the texture type each one splits into.
 *
 * **Longest name first, because this object's key order becomes a regex alternation.**
 * `SAMPLER_NAMES` joins these with `|` and the engine matches left to right, so `sampler2D`
 * placed above `sampler2DArray` wins on the shared prefix and then fails on the `A` where it
 * wanted whitespace. The declaration is not rewritten and no rule reports anything: a combined
 * image sampler simply survives into SPIR-V, and the complaint arrives three steps later from
 * a translator that cannot say which line produced it.
 */
const SAMPLER_TYPES = {
  sampler2DShadow: 'texture2D',
  sampler2DArray: 'texture2DArray',
  /*
   * An unsigned-integer texture, which the froxel table is.
   *
   * **Listed above `sampler2D` and the position is load-bearing** — but not for the shared-prefix
   * reason the note above gives, which is about one name being a prefix of another. This one is
   * about the *offset* the engine matches at: `usampler2D` contains `sampler2D` starting one
   * character in, so a scan that fails at the `u` advances and matches the tail, and the
   * declaration comes out named after a type it does not have. Every alternative is tried at each
   * position before the engine advances, so having this in the list at all is what prevents it.
   *
   * It splits into `utexture2D`, which is the Vulkan-GLSL spelling, and the constructor at a point
   * of use stays `usampler2D(tex, samp)`. Nothing in this corpus constructs one: an integer
   * texture cannot be filtered, so it is only ever read with `texelFetch`, which takes the texture
   * alone in both languages.
   */
  usampler2D: 'utexture2D',
  sampler2D: 'texture2D',
  samplerCube: 'textureCube',
  sampler3D: 'texture3D',
};

/** Anything of these types is an opaque handle and may not go inside a uniform block. */
const OPAQUE = /\b(sampler\w*|texture\w*|image\w*)\b/;

import { blockLayout, numericDefines } from './layout.mjs';

const PRECISION = '(?:highp\\s+|mediump\\s+|lowp\\s+)?';
const SAMPLER_NAMES = Object.keys(SAMPLER_TYPES).join('|');

/**
 * `#version 300 es` → `#version 310 es`.
 *
 * *"ES shaders for SPIR-V require version 310 or higher"*. The engine targets WebGL2, which
 * is ES 3.00, and nothing below 310 reaches SPIR-V at all. The two versions differ in what
 * they *add* rather than in what 300 already means, so raising the number does not change
 * the meaning of any line this corpus contains.
 */
export function raiseVersion(source) {
  return source.replace(/^#version\s+300\s+es/m, '#version 310 es');
}

/**
 * The vertex built-ins Vulkan spells differently.
 *
 * *"'gl_VertexID' : undeclared identifier (Did you mean gl_VertexIndex?)"*. The two differ
 * in that the Vulkan name counts from the draw's base vertex rather than from zero, which
 * is the same number for every draw this engine issues: nothing here draws with a non-zero
 * base vertex, and a fullscreen triangle built from the index is the only consumer.
 */
export function renameBuiltins(source) {
  return source
    .replace(/\bgl_VertexID\b/g, 'gl_VertexIndex')
    .replace(/\bgl_InstanceID\b/g, 'gl_InstanceIndex');
}

/**
 * Every unqualified `in` and `out` at global scope gains an explicit location.
 *
 * *"'location' : SPIR-V requires location for user input/output"*. GLSL ES assigns these
 * implicitly and SPIR-V will not. Inputs and outputs are numbered independently because
 * they are separate location spaces, and a location the source pinned itself is left alone
 * so that a shader which already cared keeps what it chose.
 */
export function mapLocations(source) {
  const counters = { in: 0, out: 0 };
  return source
    .split('\n')
    .map((line) => {
      const match = /^(\s*)(?:(?:flat|smooth|noperspective|centroid)\s+)*(in|out)\s+(.+;)\s*$/.exec(
        line.replace(/\/\/.*$/, ''),
      );
      if (match === null) return line;
      if (/^\s*layout\s*\(/.test(line)) return line;
      const [, indent, direction] = match;
      const location = counters[direction];
      counters[direction] += 1;
      return `${indent}layout(location=${location}) ${line.trim()}`;
    })
    .join('\n');
}

/**
 * Object-like `#define`s move to the top of the shader.
 *
 * *"'MAX_LIGHTS' : undeclared identifier"*. A uniform declared `vec3 uLightPos[MAX_LIGHTS]`
 * becomes a member of the block that `hoistUniformBlock` puts at the *first* uniform, which
 * in `flat` is 280 lines above where `MAX_LIGHTS` is defined. The size symbol has to be
 * above the block or the block cannot name it.
 */
export function hoistDefines(source) {
  const lines = source.split('\n');
  const defines = lines.filter((line) => line.trim().startsWith('#define'));
  if (defines.length === 0) return source;
  const rest = lines.filter((line) => !line.trim().startsWith('#define'));
  const after =
    Math.max(
      rest.findIndex((line) => line.trim().startsWith('precision')),
      rest.findIndex((line) => line.trim().startsWith('#version')),
    ) + 1;
  return [...rest.slice(0, after), ...defines, ...rest.slice(after)].join('\n');
}

/**
 * Loose uniforms move into one block; opaque handles stay where they are.
 *
 * *"'non-opaque uniforms outside a block' : not allowed when using GLSL for Vulkan"*. The
 * block is **anonymous**: with no instance name its members stay in global scope, so not one
 * reference in the body has to be rewritten and the entire class of rename bug never exists.
 *
 * It is placed at the first uniform rather than after the preamble, which is correct by
 * construction: everything that was above the first uniform stays above it.
 *
 * Returns the bindings it assigned as well as the source, because the renderer has to bind
 * the same numbers and the only way those two agree is for one of them to be told.
 */
export function hoistUniformBlock(source, binding = 0) {
  const members = [];
  const lines = source.split('\n');
  const rewritten = lines.map((line) => {
    const bare = line.replace(/\/\/.*$/, '').trim();
    const match = new RegExp(`^uniform\\s+${PRECISION}(.+);$`).exec(bare);
    if (match === null) return line;
    if (OPAQUE.test(match[1])) return line;
    members.push(`  ${match[1]};`);
    return `/*hoisted: ${match[1]}*/`;
  });

  if (members.length === 0) return { source, bindings: { uniforms: null } };

  /* A narrow array may not keep its natural stride in here. See `padNarrowArrays`. */
  const padded = padNarrowArrays(members, rewritten.join('\n'));
  members.length = 0;
  members.push(...padded.members);
  const body = padded.source.split('\n');

  /*
   * The byte layout goes out with the bindings, because the renderer has to write each value
   * at exactly the offset the shader reads it from and nothing checks that at runtime.
   */
  const layout = blockLayout(
    members.map((member) => member.trim().replace(/;$/, '')),
    numericDefines(source),
  );

  const at = Math.max(
    body.findIndex((line) => line.startsWith('/*hoisted:')),
    0,
  );
  const block = [`layout(binding=${binding}) uniform Uniforms {`, ...members, '};'];
  return {
    source: [...body.slice(0, at), ...block, ...body.slice(at)].join('\n'),
    bindings: { uniforms: binding, uniformSize: layout.size, fields: layout.fields },
  };
}

/**
 * A scalar array in a uniform block becomes a four-component one, read through `.x`.
 *
 * *"arrays in the uniform address space must have a stride multiple of 16 bytes, but has a
 * stride of 4 bytes"* — WebKit, on an iPhone, refusing every shader that draws geometry.
 *
 * **This rule answers a compiler error like every other one here; it just took a device to
 * hear it.** WGSL requires a sixteen-byte element stride in the uniform address space
 * (§ Address Space Layout Constraints). SPIR-V can express `ArrayStride 16` on a scalar
 * array and WGSL cannot — `@stride` was removed from the language — so naga drops the
 * decoration and emits `array<f32, 10>`, which strides by four and is not legal WGSL. Dawn
 * accepts it anyway, so it renders on every desktop browser and on no iPhone, and the
 * silence lasted from 1.0.0 until somebody opened the page on a phone.
 *
 * Promoting the declaration is what makes naga emit a conformant stride *by construction*
 * rather than by a fixup applied to its output: a `vec4` array is sixteen bytes an element in
 * SPIR-V and in WGSL and in std140, so there is no longer a stride for anything to drop.
 * `blockLayout` then computes the same sixteen for the CPU side without being told, which is
 * the property that matters — the two sides cannot disagree again, because only one of them
 * is choosing.
 *
 * **The GLSL the engine wrote is untouched, and that is the point.** This runs inside the
 * WGSL generator, so the WebGL2 path keeps its scalar arrays and its loose uniforms. Padding
 * them there would cost four times the fragment uniform vectors on exactly the devices with
 * the fewest.
 *
 * Only `.x` is ever written or read, so the other three components are never initialised.
 * That is deliberate: the renderer writes each element through `field.stride`, which is the
 * same number this padding produced.
 */
/**
 * Every type whose array stride would fall under sixteen, and what to widen it to.
 *
 * The swizzle is how the body reads it back, so widening a `vec2` keeps both components.
 * `mat2` is absent deliberately: sixteen bytes on an eight-byte alignment already rounds to a
 * sixteen-byte stride, so it is conformant as it stands.
 */
const PADDED = {
  float: ['vec4', 'x'],
  int: ['ivec4', 'x'],
  uint: ['uvec4', 'x'],
  bool: ['bvec4', 'x'],
  vec2: ['vec4', 'xy'],
  ivec2: ['ivec4', 'xy'],
  uvec2: ['uvec4', 'xy'],
};

export function padNarrowArrays(members, source) {
  let body = source;
  const padded = members.map((member) => {
    const parsed = /^(\s*)(\w+)(\s+)(\w+)\s*\[\s*(\w+)\s*\]\s*;$/.exec(member);
    if (parsed === null) return member;
    const [, indent, type, gap, name, length] = parsed;
    const widen = PADDED[type];
    if (widen === undefined) return member;
    const [wider, swizzle] = widen;
    body = readThroughSwizzle(body, name, swizzle);
    return `${indent}${wider}${gap}${name}[${length}];`;
  });
  return { members: padded, source: body };
}

/**
 * Every `name[…]` in the body becomes `name[…].x`, brackets matched rather than guessed.
 *
 * A regex for the closing bracket would be right for `uLightRadius[i]` and wrong the first
 * time an index is itself a subscript, which is the kind of thing that compiles into a
 * different shader rather than an error.
 */
function readThroughSwizzle(source, name, swizzle) {
  const at = new RegExp(`\\b${name}\\s*\\[`, 'g');
  let out = '';
  let from = 0;
  let match;
  while ((match = at.exec(source)) !== null) {
    let depth = 1;
    let scan = match.index + match[0].length;
    while (scan < source.length && depth > 0) {
      if (source[scan] === '[') depth += 1;
      else if (source[scan] === ']') depth -= 1;
      scan += 1;
    }
    if (depth !== 0) throw new Error(`padNarrowArrays: unclosed subscript on ${name}`);
    out += source.slice(from, scan) + `.${swizzle}`;
    from = scan;
    at.lastIndex = scan;
  }
  return out + source.slice(from);
}

/**
 * A combined image sampler becomes a texture and a sampler, at every point it appears.
 *
 * **WGSL has no combined image sampler and this is the language's rule rather than one
 * translator's gap.** naga answers a combined sampler with `invalid id %NNN`; Tint, given
 * the identical SPIR-V, answers *"WGSL does not support combined image-samplers"* and emits
 * a module with no entry point. Both were run. No third translator avoids it, so the split
 * happens here, once, in the input.
 *
 * Vulkan GLSL has separate `texture2D` and `sampler` objects combined at the point of use
 * with `sampler2D(tex, samp)`, which is exactly the shape WGSL itself has.
 *
 * Three rules, because a sampler appears in three positions:
 *
 * 1. **Declaration** splits into two, each with an explicit `highp` — ES declares no default
 *    precision for these types and glslang says so.
 * 2. **Built-in call** reconstructs at the point of use. `texelFetch` is left taking the
 *    texture alone, which is also true in WGSL.
 * 3. **Function parameter** splits into two parameters, and its call sites pass both
 *    through. This rule exists because Vulkan GLSL rejects a constructed sampler as an
 *    argument with *"sampler constructor must appear at point of use"*, so the split has to
 *    reach through the signature. One function in this corpus takes one: `pointShadow` in
 *    `flat`, which the ten-way cube shadow chain calls.
 *
 * **And one declaration may share another's sampler**, written `// wgsl:share <group>` on the
 * declaration itself. That marker is why the environment probe can exist at all: a device's
 * sampler ceiling is per shader stage, this project's adapter offers exactly sixteen, and the
 * widest permutation of `flat` declared **seventeen** — one albedo, three directional shadow
 * maps, twelve point-shadow cubes and the probe. The probe was the one that gave way, so
 * reflective surfaces kept a gradient on hardware that could have mirrored the room.
 *
 * Sharing is free here rather than a compromise, because the fifteen shadow bindings were
 * *already* one object: `webgpuRenderer.ts` hands every one of them the same `shadowSampler`,
 * and `flatPass.ts` declares every one of them `non-filtering`. Fifteen declarations of one
 * thing became one, and seventeen samplers became three.
 *
 * **Marked at the declaration rather than matched on the name**, and that is the whole design.
 * `flatPass.ts` records what a name rule cost once already: `uPointShadow0` does not end in
 * `ShadowMap`, and a pattern wide enough to catch it also caught `uEnvironment` — a colour cube
 * whose mip chain *is* its roughness, which needs a filtering sampler and cannot share a
 * non-filtering one. A marker on the line cannot capture the neighbour it was not written for.
 */
export function separateSamplers(source, firstBinding = 8) {
  const params = [];
  const withSplitParams = source.replace(
    /^(\w+\s+)(\w+)\(([^)]*)\)(\s*)\{/gm,
    (match, returnType, fn, args, space) => {
      const param = new RegExp(`${PRECISION}(${SAMPLER_NAMES})\\s+(\\w+)`);
      if (!param.test(args)) return match;
      const split = args
        .split(',')
        .map((arg) => {
          const found = param.exec(arg.trim());
          if (found === null) return arg.trim();
          params.push({ name: found[2], type: found[1] });
          return `highp ${SAMPLER_TYPES[found[1]]} ${found[2]}_t, highp sampler ${found[2]}_s`;
        })
        .join(', ');
      return `${returnType}${fn}(${split})${space}{`;
    },
  );

  /* Inside such a body the constructor is at the point of use, which is where it is legal. */
  let result = withSplitParams;
  for (const { name, type } of params) {
    result = result.replace(
      new RegExp(`\\b(texture|textureLod|textureProj|textureGrad)\\(\\s*${name}\\b(?!_[ts])`, 'g'),
      (_m, builtin) => `${builtin}(${type}(${name}_t, ${name}_s)`,
    );
  }

  const textures = {};
  /** Group name to the identifier and binding its one sampler was given. See `SHARE_MARKER`. */
  const groups = {};
  let binding = firstBinding;
  const declared = result.replace(
    new RegExp(
      `^(\\s*)(?:layout\\([^)]*\\)\\s*)?uniform\\s+${PRECISION}(${SAMPLER_NAMES})\\s+(\\w+)\\s*;` +
        `[ \\t]*(?://[ \\t]*wgsl:share[ \\t]+(\\w+))?`,
      'gm',
    ),
    (_match, indent, type, name, group) => {
      const lines = [
        `${indent}layout(binding=${binding}) uniform highp ${SAMPLER_TYPES[type]} ${name}_t;`,
      ];
      const texture = binding;
      binding += 1;
      if (group === undefined) {
        textures[name] = { texture, sampler: binding, type };
        lines.push(`${indent}layout(binding=${binding}) uniform highp sampler ${name}_s;`);
        binding += 1;
      } else {
        /* The group's sampler is declared by whichever member comes first and reused by the
           rest, so the declaration count falls by one per member after that. */
        const existing = groups[group];
        if (existing === undefined) {
          const shared = { ident: `uShared_${group}_s`, binding };
          groups[group] = shared;
          lines.push(`${indent}layout(binding=${binding}) uniform highp sampler ${shared.ident};`);
          binding += 1;
        }
        const shared = groups[group];
        textures[name] = { texture, sampler: shared.binding, type, share: group };
      }
      return lines.join('\n');
    },
  );

  /** What a name's sampler is called after the split: its own, or its group's one. */
  const samplerOf = (name) => {
    const share = textures[name]?.share;
    return share === undefined ? `${name}_s` : groups[share].ident;
  };

  let rewritten = declared;
  for (const [name, { type }] of Object.entries(textures)) {
    const sampler = samplerOf(name);
    /* The constructor names the *combined* type, `sampler2D(tex, samp)`, not the texture. */
    rewritten = rewritten.replace(
      new RegExp(`\\b(texture|textureLod|textureProj|textureGrad)\\(\\s*${name}\\b(?!_[ts])`, 'g'),
      (_m, builtin) => `${builtin}(${type}(${name}_t, ${sampler})`,
    );
    rewritten = rewritten.replace(
      new RegExp(`\\btextureSize\\(\\s*${name}\\b(?!_[ts])`, 'g'),
      `textureSize(${name}_t`,
    );
    rewritten = rewritten.replace(
      new RegExp(`\\btexelFetch\\(\\s*${name}\\b(?!_[ts])`, 'g'),
      `texelFetch(${name}_t`,
    );
    /*
     * Anything still naming the sampler is handing it to a function whose signature was
     * split above, so the two objects pass through rather than being recombined.
     */
    rewritten = rewritten.replace(
      new RegExp(`\\b${name}\\b(?!_[ts])`, 'g'),
      `${name}_t, ${sampler}`,
    );
  }

  return { source: rewritten, bindings: { textures } };
}

/**
 * A samplerless fetch on a separated texture needs an extension requested.
 *
 * *"'texelFetch' : required extension not requested: GL_EXT_samplerless_texture_functions"*.
 *
 * **This is a consequence of `separateSamplers` rather than of anything the author wrote.** In ES
 * 3.00 `texelFetch` takes a combined `sampler2D` and needs nothing; once the combined type has
 * been split, the same call takes a bare `texture2D`, and reading a texture without a sampler is
 * the thing this extension governs. So the rule that creates the need is the rule that has to pay
 * for it, and it was found the moment the first shader fetched from a split texture — the froxel
 * table, which is an integer texture and therefore can *only* be fetched.
 *
 * `textureSize` is in the same family and is rewritten by the same pass, so both are looked for.
 *
 * **Requested only when a samplerless call survives the rewrite**, rather than on every shader.
 * An unused request would be harmless to glslang and is still a line claiming a dependency the
 * shader does not have, which is the sort of thing a later reader deletes and a later shader then
 * needs.
 */
export function requestSamplerlessExtension(source) {
  if (!/\b(?:texelFetch|textureSize)\(\s*\w+_t\b/.test(source)) return source;
  if (source.includes('GL_EXT_samplerless_texture_functions')) return source;
  return source.replace(
    /^(#version[^\n]*\n)/m,
    '$1#extension GL_EXT_samplerless_texture_functions : require\n',
  );
}

/**
 * Where each stage's bindings start, so the two stages of one pipeline cannot collide.
 *
 * **The two stages are compiled separately and both would otherwise land on binding 0.** A
 * vertex shader's uniform block and a fragment shader's are different structs; a pipeline
 * binding both at `@group(0) @binding(0)` is asking for one buffer to be two things at once,
 * and no bind group layout can satisfy it. The stages are given disjoint ranges instead,
 * which costs nothing and is invisible to the shader author.
 *
 * The gaps are deliberately wide. A stage that grows a second uniform block, or a vertex
 * shader that starts sampling a texture — a displacement map, a bone palette — must not
 * silently walk into the range next door.
 */
const BINDING_BASE = {
  vertex: { uniforms: 0, samplers: 16 },
  fragment: { uniforms: 1, samplers: 32 },
};

/**
 * Every rule, in the one order that works, with the bindings reported once.
 *
 * Samplers separate *before* the uniform block is built, so that the block sees the split
 * declarations as the opaque handles they now are and leaves them outside where they belong.
 */
export function transform(source, stage = 'fragment') {
  const versioned = renameBuiltins(raiseVersion(source));
  const bases = BINDING_BASE[stage] ?? BINDING_BASE.fragment;
  const { source: separated, bindings: samplerBindings } = separateSamplers(
    versioned,
    bases.samplers,
  );
  const fetchable = requestSamplerlessExtension(separated);
  const defined = hoistDefines(fetchable);
  const { source: blocked, bindings: uniformBindings } = hoistUniformBlock(defined, bases.uniforms);
  return {
    source: mapLocations(blocked),
    bindings: { ...uniformBindings, ...samplerBindings },
  };
}
