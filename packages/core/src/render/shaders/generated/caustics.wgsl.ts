/*
 * Generated from ../caustics.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const CAUSTICS_FRAG_WGSL = "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uWindDir: vec2<f32>,\n    uWaveGain: f32,\n    uTime: f32,\n    uLightDir: vec3<f32>,\n    uTint: vec3<f32>,\n    uStrength: f32,\n    uMaxDrop: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vParams_1: vec2<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vLocal_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e74 = unnamed.uFogMode;\n    if (_e74 == 1i) {\n        let _e77 = unnamed.uFogFar;\n        let _e79 = unnamed.uFogNear;\n        span = max((_e77 - _e79), 0.0001f);\n        let _e82 = (*dist);\n        let _e84 = unnamed.uFogNear;\n        let _e86 = span;\n        ramp = clamp(((_e82 - _e84) / _e86), 0f, 1f);\n        let _e90 = unnamed.uUnderwaterFactor;\n        if (_e90 <= 0f) {\n            let _e92 = ramp;\n            return _e92;\n        }\n        let _e94 = unnamed.uUnderwaterFogDensity;\n        let _e95 = (*dist);\n        wetLinear = (_e94 * _e95);\n        let _e97 = ramp;\n        let _e98 = wetLinear;\n        let _e100 = wetLinear;\n        let _e106 = unnamed.uUnderwaterFactor;\n        return mix(_e97, (1f - exp2(((-(_e98) * _e100) * 1.442695f))), _e106);\n    }\n    let _e108 = (*pointY);\n    let _e110 = unnamed.uFogEyeY;\n    let _e113 = unnamed.uFogHeightFalloff;\n    t = ((_e108 - _e110) * _e113);\n    let _e115 = t;\n    let _e118 = t;\n    denom = select(_e118, 0.0001f, (abs(_e115) < 0.0001f));\n    let _e121 = unnamed.uFogDensity;\n    let _e123 = (*dist);\n    let _e125 = denom;\n    let _e130 = denom;\n    air = (1f - exp((((-(_e121) * _e123) * (1f - exp(-(_e125)))) / _e130)));\n    let _e135 = unnamed.uUnderwaterFactor;\n    if (_e135 <= 0f) {\n        let _e137 = air;\n        return _e137;\n    }\n    let _e139 = unnamed.uUnderwaterFogDensity;\n    let _e140 = (*dist);\n    wet = (_e139 * _e140);\n    let _e142 = air;\n    let _e143 = wet;\n    let _e145 = wet;\n    let _e151 = unnamed.uUnderwaterFactor;\n    return mix(_e142, (1f - exp2(((-(_e143) * _e145) * 1.442695f))), _e151);\n}\n\nfn gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b(k: ptr<function, f32>, dir: ptr<function, vec2<f32>>, p: ptr<function, vec2<f32>>, time: ptr<function, f32>) -> f32 {\n    var c: f32;\n\n    let _e69 = (*k);\n    c = sqrt((9.81f / _e69));\n    let _e72 = (*k);\n    let _e73 = (*dir);\n    let _e74 = (*p);\n    let _e76 = c;\n    let _e77 = (*time);\n    return (_e72 * (dot(_e73, _e74) - (_e76 * _e77)));\n}\n\nfn gerstnerWavenumber_u0028_i1_u003b(i: ptr<function, i32>) -> f32 {\n    var indexable: array<vec4<f32>, 4>;\n\n    let _e66 = (*i);\n    indexable = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e69 = indexable[_e66][3u];\n    return (6.2831855f / _e69);\n}\n\nfn gerstnerDirection_u0028_i1_u003b_vf2_u003b(i_1: ptr<function, i32>, windDir: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var indexable_1: array<vec4<f32>, 4>;\n\n    let _e67 = (*i_1);\n    indexable_1 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e69 = indexable_1[_e67];\n    let _e72 = (*windDir);\n    return normalize(mix(normalize(_e69.xy), _e72, vec2(0.62f)));\n}\n\nfn gerstnerCurvature_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b(p_1: ptr<function, vec2<f32>>, time_1: ptr<function, f32>, windDir_1: ptr<function, vec2<f32>>, gain: ptr<function, f32>) -> vec3<f32> {\n    var h: vec3<f32>;\n    var i_2: i32;\n    var dir_1: vec2<f32>;\n    var param: i32;\n    var param_1: vec2<f32>;\n    var steepness: f32;\n    var indexable_2: array<vec4<f32>, 4>;\n    var k_1: f32;\n    var param_2: i32;\n    var f: f32;\n    var param_3: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n    var second: f32;\n\n    h = vec3<f32>(0f, 0f, 0f);\n    i_2 = 0i;\n    loop {\n        let _e83 = i_2;\n        if (_e83 < 4i) {\n            let _e85 = i_2;\n            param = _e85;\n            let _e86 = (*windDir_1);\n            param_1 = _e86;\n            let _e87 = gerstnerDirection_u0028_i1_u003b_vf2_u003b((&param), (&param_1));\n            dir_1 = _e87;\n            let _e88 = i_2;\n            indexable_2 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n            let _e91 = indexable_2[_e88][2u];\n            let _e92 = (*gain);\n            steepness = (_e91 * _e92);\n            let _e94 = i_2;\n            param_2 = _e94;\n            let _e95 = gerstnerWavenumber_u0028_i1_u003b((&param_2));\n            k_1 = _e95;\n            let _e96 = k_1;\n            param_3 = _e96;\n            let _e97 = dir_1;\n            param_4 = _e97;\n            let _e98 = (*p_1);\n            param_5 = _e98;\n            let _e99 = (*time_1);\n            param_6 = _e99;\n            let _e100 = gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b((&param_3), (&param_4), (&param_5), (&param_6));\n            f = _e100;\n            let _e101 = steepness;\n            let _e103 = k_1;\n            let _e105 = f;\n            second = ((-(_e101) * _e103) * sin(_e105));\n            let _e108 = second;\n            let _e110 = dir_1[0u];\n            let _e113 = dir_1[0u];\n            let _e116 = h[0u];\n            h[0u] = (_e116 + ((_e108 * _e110) * _e113));\n            let _e119 = second;\n            let _e121 = dir_1[1u];\n            let _e124 = dir_1[1u];\n            let _e127 = h[1u];\n            h[1u] = (_e127 + ((_e119 * _e121) * _e124));\n            let _e130 = second;\n            let _e132 = dir_1[0u];\n            let _e135 = dir_1[1u];\n            let _e138 = h[2u];\n            h[2u] = (_e138 + ((_e130 * _e132) * _e135));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e141 = i_2;\n            i_2 = (_e141 + 1i);\n        }\n    }\n    let _e143 = h;\n    return _e143;\n}\n\nfn main_1() {\n    var waterY: f32;\n    var drop: f32;\n    var distanceFromWater: f32;\n    var clear: f32;\n    var height: f32;\n    var rim: f32;\n    var edge: f32;\n    var reach: f32;\n    var elevation: f32;\n    var slant: f32;\n    var d: f32;\n    var water: vec2<f32>;\n    var h_1: vec3<f32>;\n    var param_7: vec2<f32>;\n    var param_8: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var a: f32;\n    var b: f32;\n    var c_1: f32;\n    var det: f32;\n    var soft: f32;\n    var lines: f32;\n    var sheen: f32;\n    var caustic: f32;\n    var fog: f32;\n    var param_11: f32;\n    var param_12: f32;\n\n    let _e93 = vParams_1[0u];\n    waterY = _e93;\n    let _e95 = vWorldPos_1[1u];\n    let _e96 = waterY;\n    drop = (_e95 - _e96);\n    let _e98 = drop;\n    distanceFromWater = abs(_e98);\n    let _e100 = distanceFromWater;\n    clear = step(0.02f, _e100);\n    let _e103 = unnamed.uMaxDrop;\n    let _e106 = unnamed.uMaxDrop;\n    let _e107 = distanceFromWater;\n    height = (1f - smoothstep((_e103 * 0.45f), _e106, _e107));\n    let _e111 = vLocal_1[0u];\n    let _e113 = vLocal_1[0u];\n    let _e117 = vLocal_1[1u];\n    let _e119 = vLocal_1[1u];\n    rim = min(min(_e111, (1f - _e113)), min(_e117, (1f - _e119)));\n    let _e123 = rim;\n    edge = smoothstep(0f, 0.12f, _e123);\n    let _e125 = clear;\n    let _e126 = height;\n    let _e128 = edge;\n    reach = ((_e125 * _e126) * _e128);\n    let _e132 = unnamed.uLightDir[1u];\n    elevation = max(_e132, 0.16f);\n    let _e134 = elevation;\n    slant = (1f / _e134);\n    let _e136 = drop;\n    let _e137 = slant;\n    d = (_e136 * _e137);\n    let _e139 = vWorldPos_1;\n    let _e142 = unnamed.uLightDir;\n    let _e144 = d;\n    water = (_e139.xz + (_e142.xz * _e144));\n    let _e147 = water;\n    param_7 = _e147;\n    let _e149 = unnamed.uTime;\n    param_8 = _e149;\n    let _e151 = unnamed.uWindDir;\n    param_9 = _e151;\n    let _e153 = unnamed.uWaveGain;\n    param_10 = _e153;\n    let _e154 = gerstnerCurvature_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b((&param_7), (&param_8), (&param_9), (&param_10));\n    h_1 = _e154;\n    let _e155 = d;\n    let _e158 = h_1[0u];\n    a = (1f - ((2f * _e155) * _e158));\n    let _e161 = d;\n    let _e164 = h_1[1u];\n    b = (1f - ((2f * _e161) * _e164));\n    let _e167 = d;\n    let _e170 = h_1[2u];\n    c_1 = ((2f * _e167) * _e170);\n    let _e172 = a;\n    let _e173 = b;\n    let _e175 = c_1;\n    let _e176 = c_1;\n    det = ((_e172 * _e173) - (_e175 * _e176));\n    let _e179 = det;\n    let _e180 = fwidth(_e179);\n    soft = max(0.05f, (_e180 * 1.6f));\n    let _e183 = soft;\n    let _e184 = det;\n    let _e186 = soft;\n    lines = (_e183 / max(abs(_e184), _e186));\n    let _e189 = det;\n    sheen = clamp(((1f / max(abs(_e189), 0.18f)) - 0.85f), 0f, 1f);\n    let _e195 = lines;\n    let _e197 = sheen;\n    caustic = clamp(((_e195 * 0.9f) + (_e197 * 0.09f)), 0f, 1.6f);\n    let _e201 = vWorldPos_1;\n    let _e203 = unnamed.uCameraPos;\n    param_11 = distance(_e201, _e203);\n    let _e206 = vWorldPos_1[1u];\n    param_12 = _e206;\n    let _e207 = mediumFog_u0028_f1_u003b_f1_u003b((&param_11), (&param_12));\n    fog = _e207;\n    let _e209 = unnamed.uTint;\n    let _e210 = caustic;\n    let _e212 = unnamed.uStrength;\n    let _e214 = reach;\n    let _e216 = fog;\n    let _e219 = (_e209 * (((_e210 * _e212) * _e214) * (1f - _e216)));\n    outColor = vec4<f32>(_e219.x, _e219.y, _e219.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(2) vParams: vec2<f32>, @location(0) vWorldPos: vec3<f32>, @location(1) vLocal: vec2<f32>) -> @location(0) vec4<f32> {\n    vParams_1 = vParams;\n    vWorldPos_1 = vWorldPos;\n    vLocal_1 = vLocal;\n    main_1();\n    let _e7 = outColor;\n    return _e7;\n}\n";

export const CAUSTICS_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: vec2<f32>,\n    @location(2) member_2: vec2<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vWorldPos: vec3<f32>;\nvar<private> aRest_1: vec3<f32>;\nvar<private> vLocal: vec2<f32>;\nvar<private> aLocal_1: vec2<f32>;\nvar<private> vParams: vec2<f32>;\nvar<private> aParams_1: vec2<f32>;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(0) \nvar<uniform> unnamed_1: Uniforms;\n\nfn main_1() {\n    let _e10 = aRest_1;\n    vWorldPos = _e10;\n    let _e11 = aLocal_1;\n    vLocal = _e11;\n    let _e12 = aParams_1;\n    vParams = _e12;\n    let _e14 = unnamed_1.uViewProj;\n    let _e15 = aRest_1;\n    unnamed.gl_Position = (_e14 * vec4<f32>(_e15.x, _e15.y, _e15.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aRest: vec3<f32>, @location(1) aLocal: vec2<f32>, @location(2) aParams: vec2<f32>) -> VertexOutput {\n    aRest_1 = aRest;\n    aLocal_1 = aLocal;\n    aParams_1 = aParams;\n    main_1();\n    let _e12 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e12);\n    let _e14 = vWorldPos;\n    let _e15 = vLocal;\n    let _e16 = vParams;\n    let _e17 = unnamed.gl_Position;\n    return VertexOutput(_e14, _e15, _e16, _e17);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const CAUSTICS_BINDINGS = {
  "CAUSTICS_FRAG": {
    "uniforms": 1,
    "uniformSize": 144,
    "fields": {
      "uCameraPos": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uWindDir": {
        "offset": 16,
        "size": 8,
        "type": "vec2"
      },
      "uWaveGain": {
        "offset": 24,
        "size": 4,
        "type": "float"
      },
      "uTime": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uLightDir": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uTint": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uStrength": {
        "offset": 60,
        "size": 4,
        "type": "float"
      },
      "uMaxDrop": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 96,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 100,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 132,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 140,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "CAUSTICS_VERT": {
    "uniforms": 0,
    "uniformSize": 64,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
