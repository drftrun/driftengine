/*
 * Generated from ../flock.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FLOCK_FRAG_WGSL = "struct Uniforms {\n    uTint: vec3<f32>,\n}\n\nvar<private> outColor: vec4<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vShade_1: f32;\n\nfn main_1() {\n    let _e6 = unnamed.uTint;\n    let _e7 = vShade_1;\n    let _e8 = (_e6 * _e7);\n    outColor = vec4<f32>(_e8.x, _e8.y, _e8.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vShade: f32) -> @location(0) vec4<f32> {\n    vShade_1 = vShade;\n    main_1();\n    let _e3 = outColor;\n    return _e3;\n}\n";

export const FLOCK_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCenter: vec3<f32>,\n    uRadius: f32,\n    uHeight: f32,\n    uSpeed: f32,\n    uTime: f32,\n    uCount: f32,\n    uScale: f32,\n    uWind: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: f32,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aIndex_1: f32;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aWing_1: f32;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vShade: f32;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var id: f32;\n    var seed: f32;\n    var spin: f32;\n    var lift: f32;\n    var radius: f32;\n    var rate: f32;\n    var angle: f32;\n    var heading: vec3<f32>;\n    var into: f32;\n    var driftAngle: f32;\n    var centre: vec3<f32>;\n    var forward: vec3<f32>;\n    var side: vec3<f32>;\n    var effort: f32;\n    var beat: f32;\n    var fold: f32;\n    var offset: vec3<f32>;\n    var world: vec3<f32>;\n\n    let _e59 = aIndex_1;\n    id = _e59;\n    let _e60 = id;\n    seed = (_e60 + 1f);\n    let _e62 = seed;\n    spin = fract((sin((_e62 * 12.9898f)) * 43758.547f));\n    let _e67 = seed;\n    lift = fract((sin((_e67 * 78.233f)) * 24634.635f));\n    let _e73 = unnamed.uRadius;\n    let _e74 = spin;\n    radius = (_e73 * (0.55f + (_e74 * 0.5f)));\n    let _e79 = unnamed.uSpeed;\n    let _e80 = lift;\n    let _e84 = radius;\n    rate = ((_e79 * (0.8f + (_e80 * 0.45f))) / max(_e84, 0.001f));\n    let _e88 = unnamed.uTime;\n    let _e89 = rate;\n    let _e91 = id;\n    let _e94 = unnamed.uCount;\n    angle = ((_e88 * _e89) + ((_e91 * 6.2831f) / max(_e94, 1f)));\n    let _e98 = angle;\n    let _e101 = angle;\n    heading = vec3<f32>(-(sin(_e98)), 0f, cos(_e101));\n    let _e104 = heading;\n    let _e109 = unnamed.uWind;\n    into = (-(dot(normalize((_e104.xz + vec2<f32>(0.00001f, 0.00001f))), _e109)) * 0.06f);\n    let _e113 = angle;\n    let _e114 = into;\n    driftAngle = (_e113 + _e114);\n    let _e117 = unnamed.uCenter;\n    let _e118 = driftAngle;\n    let _e120 = radius;\n    let _e124 = unnamed.uWind[0u];\n    let _e128 = unnamed.uHeight;\n    let _e129 = lift;\n    let _e134 = unnamed.uTime;\n    let _e136 = id;\n    let _e141 = driftAngle;\n    let _e143 = radius;\n    let _e147 = unnamed.uWind[1u];\n    centre = (_e117 + vec3<f32>(((cos(_e118) * _e120) + (_e124 * 1.1f)), ((_e128 * (0.7f + (_e129 * 0.6f))) + (sin(((_e134 * 0.6f) + _e136)) * 1.4f)), ((sin(_e141) * _e143) + (_e147 * 1.1f))));\n    let _e152 = driftAngle;\n    let _e155 = driftAngle;\n    forward = vec3<f32>(-(sin(_e152)), 0f, cos(_e155));\n    let _e158 = forward;\n    side = normalize(cross(_e158, vec3<f32>(0f, 1f, 0f)));\n    let _e161 = into;\n    effort = (1f + (max(_e161, 0f) * 22f));\n    let _e166 = unnamed.uTime;\n    let _e167 = spin;\n    let _e171 = effort;\n    let _e173 = id;\n    beat = ((sin((((_e166 * (9f + (_e167 * 4f))) * _e171) + _e173)) * 0.5f) + 0.5f);\n    let _e178 = aWing_1;\n    let _e179 = beat;\n    fold = ((_e178 * _e179) * 0.55f);\n    let _e182 = side;\n    let _e184 = aCorner_1[0u];\n    let _e186 = unnamed.uScale;\n    let _e189 = forward;\n    let _e191 = aCorner_1[1u];\n    let _e193 = unnamed.uScale;\n    let _e198 = fold;\n    let _e200 = unnamed.uScale;\n    offset = (((_e182 * (_e184 * _e186)) + (_e189 * ((_e191 * _e193) * 0.6f))) + vec3<f32>(0f, (_e198 * _e200), 0f));\n    let _e204 = centre;\n    let _e205 = offset;\n    world = (_e204 + _e205);\n    let _e207 = beat;\n    vShade = (0.55f + (_e207 * 0.25f));\n    let _e211 = unnamed.uViewProj;\n    let _e212 = world;\n    unnamed_1.gl_Position = (_e211 * vec4<f32>(_e212.x, _e212.y, _e212.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(2) aIndex: f32, @location(1) aWing: f32, @location(0) aCorner: vec2<f32>) -> VertexOutput {\n    aIndex_1 = aIndex;\n    aWing_1 = aWing;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e10 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e10);\n    let _e12 = vShade;\n    let _e13 = unnamed_1.gl_Position;\n    return VertexOutput(_e12, _e13);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FLOCK_BINDINGS = {
  "FLOCK_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uTint": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      }
    },
    "textures": {}
  },
  "FLOCK_VERT": {
    "uniforms": 0,
    "uniformSize": 112,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCenter": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uRadius": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uHeight": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uSpeed": {
        "offset": 84,
        "size": 4,
        "type": "float"
      },
      "uTime": {
        "offset": 88,
        "size": 4,
        "type": "float"
      },
      "uCount": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uScale": {
        "offset": 96,
        "size": 4,
        "type": "float"
      },
      "uWind": {
        "offset": 104,
        "size": 8,
        "type": "vec2"
      }
    },
    "textures": {}
  }
} as const;
