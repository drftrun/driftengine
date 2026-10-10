/**
 * What the lit stage shares between every glass tint it reads: whether it reads any, and
 * `glassShadow.ts`'s `unmixTint`, stated once for the sun's lookup and the lamps'. At depth zero,
 * outside every conditional, so each lookup can call it whichever shadows a permutation compiles.
 */
export function glassTintGlsl(glassShadows: boolean): string {
  return /* glsl */ `
/*
 * Whether this build reads glass at all, which every way into the lookups asks first — and as a
 * branch's own condition, never negated: see \`overridableConstants\` in scripts/wgsl/transform.mjs.
 */
const bool GLASS_SHADOWS = ${glassShadows ? 'true' : 'false'};  // wgsl:override
/*
 * A coarse level of a glass tint with the open ground's white taken back out, by how milky the pane
 * at the centre is: rgb the pane's colour, a its share of the texel (glassShadow.ts's unmixTint).
 * A clear centre is never read coarse, so it is returned as it stands.
 */
vec4 glassUnmix(vec4 mip, float centreClarity) {
  if (centreClarity >= 1.0) return vec4(mip.rgb, 1.0);
  float share = clamp((1.0 - mip.a) / (1.0 - centreClarity), 0.0, 1.0);
  if (share <= 0.0) return vec4(1.0, 1.0, 1.0, 0.0);
  return vec4(clamp((mip.rgb - vec3(1.0 - share)) / share, 0.0, 1.0), share);
}
`;
}

/**
 * The lit stage's switches, by the name of the constant each is: the decision both backends make
 * about which optional code a lit program carries. See `litSwitchesGlsl`.
 */
export type LitSwitch =
  | 'GLASS_SHADOWS'
  | 'CLUSTERED_LIGHTS'
  | 'LIGHT_FIXTURES'
  | 'SURFACE_EFFECTS'
  | 'DRIFT_LIGHT'
  | 'PHYSICAL_SPECULAR'
  | 'SURFACE_OVERLAY'
  | 'REFLECTION_MAPS'
  | 'WORLD_UVS'
  | 'MOVING_SUN'
  | 'LAYERED'
  | 'LAYER_LOOKS';

/** Every switch off: what a renderer starts from before its profile and its content say otherwise. */
export function noLitSwitches(): Record<LitSwitch, boolean> {
  return {
    GLASS_SHADOWS: false,
    CLUSTERED_LIGHTS: false,
    LIGHT_FIXTURES: false,
    SURFACE_EFFECTS: false,
    DRIFT_LIGHT: false,
    PHYSICAL_SPECULAR: false,
    SURFACE_OVERLAY: false,
    REFLECTION_MAPS: false,
    WORLD_UVS: false,
    MOVING_SUN: false,
    LAYERED: false,
    LAYER_LOOKS: false,
  };
}

/** Which of the lit stage's optional features a build reads. See `litSwitchesGlsl`. */
export interface LitSwitches {
  readonly clusteredLights: boolean;
  readonly lightFixtures: boolean;
  readonly surfaceEffects: boolean;
  readonly driftLight: boolean;
}

/**
 * The lit stage's other switches, declared after `GLASS_SHADOWS` so that one keeps the id 0 the
 * pipelines and their tests already name, each a pipeline-overridable constant on the generated
 * WGSL and a written-in value on WebGL2 — the arrangement `GLASS_SHADOWS` has, for its reason:
 * code a branch never runs still costs a shader its registers, and the device compiles it away
 * only where the switch is a constant.
 *
 * **Clustering is the profile's and fixed.** The other three are content, off until a consumer
 * first uses them — a measured profile or a cookie, a material with an effects table, a DriftLight
 * volume — and then on for good; see `PipelineCache.enable` and the WebGL2 renderer's rebuild.
 * Measured on RADV against the lit shader with glass already out: 6,852 instructions and 120
 * registers, 4,641 and 96 with all four out. `PHYSICAL_SPECULAR` is a sixth, declared with the
 * models so that theirs keep their ids (`modelsGlsl`).
 */
export function litSwitchesGlsl(switches: LitSwitches): string {
  return /* glsl */ `
const bool CLUSTERED_LIGHTS = ${switches.clusteredLights ? 'true' : 'false'};  // wgsl:override
const bool LIGHT_FIXTURES = ${switches.lightFixtures ? 'true' : 'false'};  // wgsl:override
const bool SURFACE_EFFECTS = ${switches.surfaceEffects ? 'true' : 'false'};  // wgsl:override
const bool DRIFT_LIGHT = ${switches.driftLight ? 'true' : 'false'};  // wgsl:override
`;
}
