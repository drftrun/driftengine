/*
 * Generated from ../windStreaks.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const WIND_STREAK_FRAG_WGSL = "struct Uniforms {\n    uTint: vec3<f32>,\n}\n\nvar<private> vAlong_1: f32;\nvar<private> vFade_1: f32;\nvar<private> outColor: vec4<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n\nfn main_1() {\n    var taper: f32;\n    var alpha: f32;\n\n    let _e10 = vAlong_1;\n    taper = sin((_e10 * 3.14159f));\n    let _e13 = vFade_1;\n    let _e14 = taper;\n    let _e16 = taper;\n    alpha = (((_e13 * _e14) * _e16) * 0.13f);\n    let _e19 = alpha;\n    if (_e19 <= 0.002f) {\n        discard;\n    }\n    let _e22 = unnamed.uTint;\n    let _e23 = alpha;\n    outColor = vec4<f32>(_e22.x, _e22.y, _e22.z, _e23);\n    return;\n}\n\n@fragment \nfn main(@location(1) vAlong: f32, @location(0) vFade: f32) -> @location(0) vec4<f32> {\n    vAlong_1 = vAlong;\n    vFade_1 = vFade;\n    main_1();\n    let _e5 = outColor;\n    return _e5;\n}\n";

export const WIND_STREAK_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uWind: vec2<f32>,\n    uDrift: vec2<f32>,\n    uSpeed: f32,\n    uStrength: f32,\n    uCount: f32,\n    uCellSize: f32,\n    uTime: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: f32,\n    @location(1) member_1: f32,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aIndex_1: f32;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vFade: f32;\nvar<private> vAlong: f32;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var id: f32;\n    var rx: f32;\n    var ry: f32;\n    var rz: f32;\n    var lowBias: f32;\n    var cell: vec3<f32>;\n    var base: vec3<f32>;\n    var rel: vec3<f32>;\n    var centre: vec3<f32>;\n    var alongXZ: vec2<f32>;\n    var local: vec2<f32>;\n    var along: vec3<f32>;\n    var across: vec3<f32>;\n    var curl: f32;\n    var length_: f32;\n    var world: vec3<f32>;\n    var dist: f32;\n    var far: f32;\n    var near: f32;\n    var weight: f32;\n\n    let _e62 = aIndex_1;\n    id = _e62;\n    let _e63 = id;\n    rx = fract((sin((_e63 * 12.9898f)) * 43758.547f));\n    let _e68 = id;\n    ry = fract((sin((_e68 * 39.3467f)) * 24634.635f));\n    let _e73 = id;\n    rz = fract((sin((_e73 * 78.233f)) * 12934.123f));\n    let _e78 = ry;\n    let _e79 = ry;\n    lowBias = (_e78 * _e79);\n    let _e81 = rx;\n    let _e83 = unnamed.uCellSize;\n    let _e85 = lowBias;\n    let _e87 = unnamed.uCellSize;\n    let _e90 = rz;\n    let _e92 = unnamed.uCellSize;\n    cell = vec3<f32>((_e81 * _e83), ((_e85 * _e87) * 0.42f), (_e90 * _e92));\n    let _e97 = unnamed.uCameraPos[0u];\n    let _e99 = cell[0u];\n    let _e102 = unnamed.uCellSize;\n    let _e107 = unnamed.uDrift[0u];\n    let _e111 = unnamed.uCameraPos[1u];\n    let _e113 = cell[1u];\n    let _e116 = unnamed.uCellSize;\n    let _e121 = unnamed.uCameraPos[2u];\n    let _e123 = cell[2u];\n    let _e126 = unnamed.uCellSize;\n    let _e131 = unnamed.uDrift[1u];\n    base = vec3<f32>((((_e97 + _e99) - (_e102 * 0.5f)) - _e107), ((_e111 + _e113) - (_e116 * 0.3f)), (((_e121 + _e123) - (_e126 * 0.5f)) - _e131));\n    let _e134 = base;\n    let _e136 = unnamed.uCameraPos;\n    rel = (_e134 - _e136);\n    let _e139 = rel[0u];\n    let _e141 = unnamed.uCellSize;\n    let _e143 = (_e139 + (_e141 * 0.5f));\n    let _e145 = unnamed.uCellSize;\n    let _e151 = unnamed.uCellSize;\n    rel[0u] = ((_e143 - (floor((_e143 / _e145)) * _e145)) - (_e151 * 0.5f));\n    let _e156 = rel[2u];\n    let _e158 = unnamed.uCellSize;\n    let _e160 = (_e156 + (_e158 * 0.5f));\n    let _e162 = unnamed.uCellSize;\n    let _e168 = unnamed.uCellSize;\n    rel[2u] = ((_e160 - (floor((_e160 / _e162)) * _e162)) - (_e168 * 0.5f));\n    let _e173 = unnamed.uCameraPos;\n    let _e174 = rel;\n    centre = (_e173 + _e174);\n    let _e177 = unnamed.uSpeed;\n    if (_e177 > 0.001f) {\n        let _e180 = unnamed.uWind;\n        let _e182 = unnamed.uSpeed;\n        local = (_e180 / vec2(_e182));\n    } else {\n        local = vec2<f32>(1f, 0f);\n    }\n    let _e185 = local;\n    alongXZ = _e185;\n    let _e187 = alongXZ[0u];\n    let _e189 = alongXZ[1u];\n    along = vec3<f32>(_e187, 0f, _e189);\n    let _e191 = along;\n    across = normalize(cross(_e191, vec3<f32>(0f, 1f, 0f)));\n    let _e195 = unnamed.uTime;\n    let _e197 = id;\n    let _e203 = unnamed.uTime;\n    let _e205 = id;\n    curl = ((sin(((_e195 * 1.7f) + (_e197 * 2.3f))) * 0.35f) + (sin(((_e203 * 0.9f) + _e205)) * 0.2f));\n    let _e211 = unnamed.uSpeed;\n    let _e214 = rz;\n    length_ = ((0.18f + (_e211 * 0.09f)) * (0.5f + _e214));\n    let _e217 = centre;\n    let _e218 = along;\n    let _e220 = aCorner_1[1u];\n    let _e221 = length_;\n    let _e225 = across;\n    let _e227 = aCorner_1[0u];\n    let _e230 = aCorner_1[1u];\n    let _e231 = curl;\n    let _e233 = length_;\n    world = ((_e217 + (_e218 * (_e220 * _e221))) + (_e225 * ((_e227 * 0.012f) + (((_e230 * _e231) * _e233) * 0.35f))));\n    let _e239 = centre;\n    let _e241 = unnamed.uCameraPos;\n    dist = distance(_e239, _e241);\n    let _e244 = unnamed.uCellSize;\n    let _e247 = unnamed.uCellSize;\n    let _e249 = dist;\n    far = (1f - smoothstep((_e244 * 0.12f), (_e247 * 0.5f), _e249));\n    let _e252 = dist;\n    near = smoothstep(2f, 16f, _e252);\n    let _e254 = rx;\n    let _e255 = rx;\n    let _e257 = rx;\n    weight = ((_e254 * _e255) * _e257);\n    let _e260 = unnamed.uStrength;\n    let _e261 = far;\n    let _e263 = near;\n    let _e265 = weight;\n    vFade = (((_e260 * _e261) * _e263) * _e265);\n    let _e268 = aCorner_1[1u];\n    vAlong = ((_e268 * 0.5f) + 0.5f);\n    let _e272 = unnamed.uViewProj;\n    let _e273 = world;\n    unnamed_1.gl_Position = (_e272 * vec4<f32>(_e273.x, _e273.y, _e273.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(1) aIndex: f32, @location(0) aCorner: vec2<f32>) -> VertexOutput {\n    aIndex_1 = aIndex;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e9 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e9);\n    let _e11 = vFade;\n    let _e12 = vAlong;\n    let _e13 = unnamed_1.gl_Position;\n    return VertexOutput(_e11, _e12, _e13);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const WINDSTREAKS_BINDINGS = {
  "WIND_STREAK_FRAG": {
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
  "WIND_STREAK_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uWind": {
        "offset": 80,
        "size": 8,
        "type": "vec2"
      },
      "uDrift": {
        "offset": 88,
        "size": 8,
        "type": "vec2"
      },
      "uSpeed": {
        "offset": 96,
        "size": 4,
        "type": "float"
      },
      "uStrength": {
        "offset": 100,
        "size": 4,
        "type": "float"
      },
      "uCount": {
        "offset": 104,
        "size": 4,
        "type": "float"
      },
      "uCellSize": {
        "offset": 108,
        "size": 4,
        "type": "float"
      },
      "uTime": {
        "offset": 112,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
