/** Reading a baked probe from a compute stage: the mapping, the levels, and the two lookups. */

/**
 * **`flat/probeGrid.ts` for one probe, and the "one" is the whole of the difference.**
 *
 * That file blends eight probes for the diffuse term and two for the reflection, because a grid is
 * what a large world wants and a single probe pops as a surface crosses a cell boundary. The
 * second pipeline reads **layer 0** and says so: it owns a fixed cluster set and its rigs are a few
 * metres across, which is one probe's worth of world. A pass handed a grid of more than one reads
 * the first of them, which is wrong in the way a single probe is always wrong — a smooth surface
 * crossing a cell shows the wrong room rather than a blend of two — and `PassEnvironment.layers`
 * is what a caller checks before deciding this pipeline suits their scene.
 *
 * **The mapping is not written again.** `shaders/octahedral.ts` carries `octEncode` and `octInsetUv`
 * in GLSL and in TypeScript with a test, and this is the third spelling rather than a second
 * design — `gpu-parity.mjs` runs it against that TypeScript over generated directions, which is
 * the only thing that keeps three copies of one mapping honest.
 *
 * **The texture read belongs to the including module**, as `shadow.wgsl.ts` does the same thing for
 * the same reason: the parity entry point reads a storage buffer, because that is what a compute
 * harness can be handed, and the shading pass reads a `texture_2d_array`. What must not differ is
 * the arithmetic around the read, so the arithmetic is here and the read is not.
 */
export const ENVIRONMENT_WGSL = /* wgsl */ `
/* shaders/octahedral.ts, transcribed. The direction need not be normalised: the L1 divide is. */
fn octEncode(d: vec3<f32>) -> vec2<f32> {
  let n = d / (abs(d.x) + abs(d.y) + abs(d.z));
  var p = n.xy;
  if (n.z < 0.0) {
    p = vec2<f32>(
      (1.0 - abs(n.y)) * select(-1.0, 1.0, n.x >= 0.0),
      (1.0 - abs(n.x)) * select(-1.0, 1.0, n.y >= 0.0),
    );
  }
  return p * 0.5 + 0.5;
}

/*
 * Where a direction lands in a map that is edge texels across and whose outer ring is a gutter.
 *
 * The inner region is edge - 2 texels offset by one, so a direction at the border of the
 * octahedral square lands on the last real texel and a bilinear tap past it reads the gutter —
 * which the bake filled with the folded direction rather than the other side of the map.
 */
fn octInsetUv(d: vec3<f32>, edge: f32) -> vec2<f32> {
  return (octEncode(d) * (edge - 2.0) + 1.0) / edge;
}

/*
 * A level's own edge, which is not the map's.
 *
 * The gutter is one texel at every level, so its share of the map doubles as the chain coarsens
 * and the inset has to be computed per level. Floored at four, which is where the chain stops.
 */
fn probeLevelEdge(edge: f32, level: f32) -> f32 {
  return max(edge / exp2(level), 4.0);
}

/* The diffuse half: the cosine convolution, which lives at one fixed level of the chain. */
fn probeIrradianceAt(dir: vec3<f32>, edge: f32, irradianceLevel: f32) -> vec3<f32> {
  let uv = octInsetUv(dir, probeLevelEdge(edge, irradianceLevel));
  return environmentSample(uv, irradianceLevel);
}

/*
 * The reflection at a roughness, as two levels mixed by hand.
 *
 * **By hand, and flat/probeGrid.ts records why**: a level's inset differs between levels, and
 * hardware trilinear applies one coordinate to both — so one of the two would be read at the wrong
 * inset, by a thirty-second of the map at the top of the chain, which is a visible slide in a
 * reflection as roughness rises. Two fetches at their own insets is the price of the fold.
 */
fn probeRadianceAt(dir: vec3<f32>, edge: f32, lod: f32, maxLod: f32) -> vec3<f32> {
  let lo = clamp(floor(lod), 0.0, maxLod);
  let hi = min(lo + 1.0, maxLod);
  let coarse = environmentSample(octInsetUv(dir, probeLevelEdge(edge, hi)), hi);
  let fine = environmentSample(octInsetUv(dir, probeLevelEdge(edge, lo)), lo);
  return mix(fine, coarse, clamp(lod - lo, 0.0, 1.0));
}
`;

/** Floats a case of the environment check: a direction, then the edge, the lod and the max. */
export const ENVIRONMENT_CASE_FLOATS = 6;

/**
 * Texels a side of the synthetic chain the check reads, and how many levels it holds.
 *
 * **A chain whose levels are constants, one value each**, so what comes back names the level it
 * was read from. That is what makes the two-level mix checkable without a texture: a result of
 * 3.25 is level 3 and level 4 mixed a quarter of the way, and no bilinear filter can produce it by
 * accident.
 */
export const ENVIRONMENT_CHECK_EDGE = 16;
export const ENVIRONMENT_CHECK_LEVELS = 4;

/**
 * The mapping and the level arithmetic alone, as a dispatch.
 *
 * `environmentSample` reads a flat array of levels rather than a texture, and returns the level's
 * own constant — so the uv it is handed is reported back as well, which is what lets one check
 * cover both halves: that a direction lands where `octahedral.ts` says, and that a roughness
 * reads the two levels either side of it in the right proportion.
 */
export const ENVIRONMENT_PARITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> cases: array<f32>;
@group(0) @binding(2) var<storage, read> levels: array<f32>;
@group(0) @binding(3) var<storage, read_write> results: array<f32>;

/* The level's own constant, and the coordinate it was asked for, so both can be compared. */
var<private> lastUv: vec2<f32>;

fn environmentSample(uv: vec2<f32>, level: f32) -> vec3<f32> {
  lastUv = uv;
  let index = u32(clamp(level, 0.0, ${ENVIRONMENT_CHECK_LEVELS}.0 - 1.0));
  return vec3<f32>(levels[index], levels[index], levels[index]);
}

${ENVIRONMENT_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(params[0])) {
    return;
  }
  let at = id.x * ${ENVIRONMENT_CASE_FLOATS}u;
  let dir = vec3<f32>(cases[at], cases[at + 1u], cases[at + 2u]);
  let edge = cases[at + 3u];
  let lod = cases[at + 4u];
  let maxLod = cases[at + 5u];

  let uv = octInsetUv(dir, edge);
  let radiance = probeRadianceAt(dir, edge, lod, maxLod);
  let out = id.x * 4u;
  results[out] = uv.x;
  results[out + 1u] = uv.y;
  results[out + 2u] = radiance.x;
  /* The last coordinate the mix asked for, which is the finer level's and carries its own inset. */
  results[out + 3u] = lastUv.x;
}
`;
