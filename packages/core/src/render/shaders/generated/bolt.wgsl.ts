/*
 * Generated from ../bolt.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const BOLT_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uCoreColor: vec3<f32>,\n    uEdgeColor: vec3<f32>,\n    uCoreGain: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uCameraPos: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vSide_1: f32;\nvar<private> vSeed_1: f32;\nvar<private> vAlong_1: f32;\nvar<private> vFade_1: f32;\nvar<private> vGain_1: f32;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e48 = unnamed.uFogMode;\n    if (_e48 == 1i) {\n        let _e51 = unnamed.uFogFar;\n        let _e53 = unnamed.uFogNear;\n        span = max((_e51 - _e53), 0.0001f);\n        let _e56 = (*dist);\n        let _e58 = unnamed.uFogNear;\n        let _e60 = span;\n        ramp = clamp(((_e56 - _e58) / _e60), 0f, 1f);\n        let _e64 = unnamed.uUnderwaterFactor;\n        if (_e64 <= 0f) {\n            let _e66 = ramp;\n            return _e66;\n        }\n        let _e68 = unnamed.uUnderwaterFogDensity;\n        let _e69 = (*dist);\n        wetLinear = (_e68 * _e69);\n        let _e71 = ramp;\n        let _e72 = wetLinear;\n        let _e74 = wetLinear;\n        let _e80 = unnamed.uUnderwaterFactor;\n        return mix(_e71, (1f - exp2(((-(_e72) * _e74) * 1.442695f))), _e80);\n    }\n    let _e82 = (*pointY);\n    let _e84 = unnamed.uFogEyeY;\n    let _e87 = unnamed.uFogHeightFalloff;\n    t = ((_e82 - _e84) * _e87);\n    let _e89 = t;\n    let _e92 = t;\n    denom = select(_e92, 0.0001f, (abs(_e89) < 0.0001f));\n    let _e95 = unnamed.uFogDensity;\n    let _e97 = (*dist);\n    let _e99 = denom;\n    let _e104 = denom;\n    air = (1f - exp((((-(_e95) * _e97) * (1f - exp(-(_e99)))) / _e104)));\n    let _e109 = unnamed.uUnderwaterFactor;\n    if (_e109 <= 0f) {\n        let _e111 = air;\n        return _e111;\n    }\n    let _e113 = unnamed.uUnderwaterFogDensity;\n    let _e114 = (*dist);\n    wet = (_e113 * _e114);\n    let _e116 = air;\n    let _e117 = wet;\n    let _e119 = wet;\n    let _e125 = unnamed.uUnderwaterFactor;\n    return mix(_e116, (1f - exp2(((-(_e117) * _e119) * 1.442695f))), _e125);\n}\n\nfn hash11_u0028_f1_u003b(p: ptr<function, f32>) -> f32 {\n    let _e39 = (*p);\n    return fract((sin((_e39 * 12.9898f)) * 43758.547f));\n}\n\nfn main_1() {\n    var across: f32;\n    var core: f32;\n    var glow: f32;\n    var t_1: f32;\n    var stutter: f32;\n    var param: f32;\n    var param_1: f32;\n    var taper: f32;\n    var energy: f32;\n    var lit: vec3<f32>;\n    var fog: f32;\n    var param_2: f32;\n    var param_3: f32;\n\n    let _e51 = vSide_1;\n    across = (1f - abs(_e51));\n    let _e54 = across;\n    core = pow(_e54, 10f);\n    let _e56 = across;\n    glow = pow(_e56, 1.1f);\n    let _e59 = unnamed.uTime;\n    let _e61 = vSeed_1;\n    t_1 = ((_e59 * 47f) + (_e61 * 17f));\n    let _e64 = t_1;\n    param = floor(_e64);\n    let _e66 = hash11_u0028_f1_u003b((&param));\n    let _e68 = t_1;\n    param_1 = floor((_e68 * 2.37f));\n    let _e71 = hash11_u0028_f1_u003b((&param_1));\n    stutter = (0.78f + (0.22f * ((_e66 * 0.6f) + (_e71 * 0.4f))));\n    let _e76 = vAlong_1;\n    taper = (1f - (_e76 * 0.55f));\n    let _e79 = vFade_1;\n    let _e80 = stutter;\n    let _e82 = taper;\n    let _e84 = vGain_1;\n    energy = (((_e79 * _e80) * _e82) * _e84);\n    let _e87 = unnamed.uEdgeColor;\n    let _e88 = glow;\n    let _e91 = unnamed.uCoreColor;\n    let _e92 = core;\n    let _e95 = unnamed.uCoreGain;\n    lit = ((_e87 * _e88) + ((_e91 * _e92) * _e95));\n    let _e98 = vWorldPos_1;\n    let _e100 = unnamed.uCameraPos;\n    param_2 = distance(_e98, _e100);\n    let _e103 = vWorldPos_1[1u];\n    param_3 = _e103;\n    let _e104 = mediumFog_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n    fog = _e104;\n    let _e105 = lit;\n    let _e106 = energy;\n    let _e108 = fog;\n    let _e110 = ((_e105 * _e106) * (1f - _e108));\n    outColor = vec4<f32>(_e110.x, _e110.y, _e110.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vSide: f32, @location(3) vSeed: f32, @location(1) vAlong: f32, @location(2) vFade: f32, @location(4) vGain: f32, @location(5) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vSide_1 = vSide;\n    vSeed_1 = vSeed;\n    vAlong_1 = vAlong;\n    vFade_1 = vFade;\n    vGain_1 = vGain;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e13 = outColor;\n    return _e13;\n}\n";

export const BOLT_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uWidth: f32,\n    uMinWidthPerMetre: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: f32,\n    @location(1) member_1: f32,\n    @location(2) member_2: f32,\n    @location(3) member_3: f32,\n    @location(4) member_4: f32,\n    @location(5) member_5: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aFrom_1: vec3<f32>;\nvar<private> aTo_1: vec3<f32>;\nvar<private> aCorner_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> vSide: f32;\nvar<private> vAlong: f32;\nvar<private> aArc_1: vec4<f32>;\nvar<private> vFade: f32;\nvar<private> vSeed: f32;\nvar<private> vGain: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var mid: vec3<f32>;\n    var dir: vec3<f32>;\n    var len: f32;\n    var local: vec3<f32>;\n    var view: vec3<f32>;\n    var dist: f32;\n    var local_1: vec3<f32>;\n    var across: vec3<f32>;\n    var span: f32;\n    var local_2: vec3<f32>;\n    var halfWidth: f32;\n    var world: vec3<f32>;\n\n    let _e40 = aFrom_1;\n    let _e41 = aTo_1;\n    let _e43 = aCorner_1[0u];\n    mid = mix(_e40, _e41, vec3(_e43));\n    let _e46 = aTo_1;\n    let _e47 = aFrom_1;\n    dir = (_e46 - _e47);\n    let _e49 = dir;\n    len = length(_e49);\n    let _e51 = len;\n    if (_e51 > 0.000001f) {\n        let _e53 = dir;\n        let _e54 = len;\n        local = (_e53 / vec3(_e54));\n    } else {\n        local = vec3<f32>(0f, 1f, 0f);\n    }\n    let _e57 = local;\n    dir = _e57;\n    let _e58 = mid;\n    let _e60 = unnamed.uCameraPos;\n    view = (_e58 - _e60);\n    let _e62 = view;\n    dist = length(_e62);\n    let _e64 = dist;\n    if (_e64 > 0.000001f) {\n        let _e66 = view;\n        let _e67 = dist;\n        local_1 = (_e66 / vec3(_e67));\n    } else {\n        local_1 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e70 = local_1;\n    view = _e70;\n    let _e71 = dir;\n    let _e72 = view;\n    across = cross(_e71, _e72);\n    let _e74 = across;\n    span = length(_e74);\n    let _e76 = span;\n    if (_e76 > 0.0001f) {\n        let _e78 = across;\n        let _e79 = span;\n        local_2 = (_e78 / vec3(_e79));\n    } else {\n        let _e82 = dir;\n        local_2 = normalize((cross(_e82, vec3<f32>(0f, 1f, 0f)) + vec3<f32>(0.001f, 0.001f, 0.001f)));\n    }\n    let _e86 = local_2;\n    across = _e86;\n    let _e88 = unnamed.uWidth;\n    let _e89 = dist;\n    let _e91 = unnamed.uMinWidthPerMetre;\n    halfWidth = max(_e88, (_e89 * _e91));\n    let _e94 = mid;\n    let _e95 = across;\n    let _e97 = aCorner_1[1u];\n    let _e99 = halfWidth;\n    world = (_e94 + ((_e95 * _e97) * _e99));\n    let _e103 = aCorner_1[1u];\n    vSide = _e103;\n    let _e105 = aArc_1[0u];\n    vAlong = _e105;\n    let _e107 = aArc_1[1u];\n    vFade = _e107;\n    let _e109 = aArc_1[2u];\n    vSeed = _e109;\n    let _e111 = aArc_1[3u];\n    vGain = _e111;\n    let _e112 = world;\n    vWorldPos = _e112;\n    let _e114 = unnamed.uViewProj;\n    let _e115 = world;\n    unnamed_1.gl_Position = (_e114 * vec4<f32>(_e115.x, _e115.y, _e115.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aFrom: vec3<f32>, @location(1) aTo: vec3<f32>, @location(2) aCorner: vec2<f32>, @location(3) aArc: vec4<f32>) -> VertexOutput {\n    aFrom_1 = aFrom;\n    aTo_1 = aTo;\n    aCorner_1 = aCorner;\n    aArc_1 = aArc;\n    main_1();\n    let _e17 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e17);\n    let _e19 = vSide;\n    let _e20 = vAlong;\n    let _e21 = vFade;\n    let _e22 = vSeed;\n    let _e23 = vGain;\n    let _e24 = vWorldPos;\n    let _e25 = unnamed_1.gl_Position;\n    return VertexOutput(_e19, _e20, _e21, _e22, _e23, _e24, _e25);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const BOLT_BINDINGS = {
  "BOLT_FRAG": {
    "uniforms": 1,
    "uniformSize": 128,
    "fields": {
      "uTime": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uCoreColor": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uEdgeColor": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uCoreGain": {
        "offset": 44,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 60,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 68,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 96,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 100,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 104,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 108,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      }
    },
    "textures": {}
  },
  "BOLT_VERT": {
    "uniforms": 0,
    "uniformSize": 96,
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
      "uWidth": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uMinWidthPerMetre": {
        "offset": 80,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
