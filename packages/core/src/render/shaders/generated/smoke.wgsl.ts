/*
 * Generated from ../smoke.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SMOKE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e76 = unnamed.uFogMode;\n    if (_e76 == 1i) {\n        let _e79 = unnamed.uFogFar;\n        let _e81 = unnamed.uFogNear;\n        span = max((_e79 - _e81), 0.0001f);\n        let _e84 = (*dist);\n        let _e86 = unnamed.uFogNear;\n        let _e88 = span;\n        ramp = clamp(((_e84 - _e86) / _e88), 0f, 1f);\n        let _e92 = unnamed.uUnderwaterFactor;\n        if (_e92 <= 0f) {\n            let _e94 = ramp;\n            return _e94;\n        }\n        let _e96 = unnamed.uUnderwaterFogDensity;\n        let _e97 = (*dist);\n        wetLinear = (_e96 * _e97);\n        let _e99 = ramp;\n        let _e100 = wetLinear;\n        let _e102 = wetLinear;\n        let _e108 = unnamed.uUnderwaterFactor;\n        return mix(_e99, (1f - exp2(((-(_e100) * _e102) * 1.442695f))), _e108);\n    }\n    let _e110 = (*pointY);\n    let _e112 = unnamed.uFogEyeY;\n    let _e115 = unnamed.uFogHeightFalloff;\n    t = ((_e110 - _e112) * _e115);\n    let _e117 = t;\n    let _e120 = t;\n    denom = select(_e120, 0.0001f, (abs(_e117) < 0.0001f));\n    let _e123 = unnamed.uFogDensity;\n    let _e125 = (*dist);\n    let _e127 = denom;\n    let _e132 = denom;\n    air = (1f - exp((((-(_e123) * _e125) * (1f - exp(-(_e127)))) / _e132)));\n    let _e137 = unnamed.uUnderwaterFactor;\n    if (_e137 <= 0f) {\n        let _e139 = air;\n        return _e139;\n    }\n    let _e141 = unnamed.uUnderwaterFogDensity;\n    let _e142 = (*dist);\n    wet = (_e141 * _e142);\n    let _e144 = air;\n    let _e145 = wet;\n    let _e147 = wet;\n    let _e153 = unnamed.uUnderwaterFactor;\n    return mix(_e144, (1f - exp2(((-(_e145) * _e147) * 1.442695f))), _e153);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e67 = unnamed.uFogColor;\n    let _e69 = unnamed.uUnderwaterColor;\n    let _e71 = unnamed.uUnderwaterFactor;\n    return mix(_e67, _e69, vec3(_e71));\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e67 = (*p);\n    return fract((sin(dot(_e67, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param: vec2<f32>;\n    var param_1: vec2<f32>;\n    var param_2: vec2<f32>;\n    var param_3: vec2<f32>;\n\n    let _e74 = (*p_1);\n    i = floor(_e74);\n    let _e76 = (*p_1);\n    f = fract(_e76);\n    let _e78 = f;\n    let _e79 = f;\n    let _e81 = f;\n    u = ((_e78 * _e79) * (vec2(3f) - (_e81 * 2f)));\n    let _e86 = i;\n    param = _e86;\n    let _e87 = hash21_u0028_vf2_u003b((&param));\n    let _e88 = i;\n    param_1 = (_e88 + vec2<f32>(1f, 0f));\n    let _e90 = hash21_u0028_vf2_u003b((&param_1));\n    let _e92 = u[0u];\n    let _e94 = i;\n    param_2 = (_e94 + vec2<f32>(0f, 1f));\n    let _e96 = hash21_u0028_vf2_u003b((&param_2));\n    let _e97 = i;\n    param_3 = (_e97 + vec2<f32>(1f, 1f));\n    let _e99 = hash21_u0028_vf2_u003b((&param_3));\n    let _e101 = u[0u];\n    let _e104 = u[1u];\n    return mix(mix(_e87, _e90, _e92), mix(_e96, _e99, _e101), _e104);\n}\n\nfn billow_u0028_vf2_u003b_f1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>) -> f32 {\n    var v: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n\n    let _e72 = (*p_2);\n    let _e74 = (*t_1);\n    param_4 = ((_e72 * 2.2f) + vec2<f32>(0f, (-(_e74) * 0.55f)));\n    let _e79 = valueNoise_u0028_vf2_u003b((&param_4));\n    v = (_e79 * 0.55f);\n    let _e82 = unnamed.uNoiseOctaves;\n    if (_e82 == 1i) {\n        let _e84 = v;\n        return (_e84 / 0.55f);\n    }\n    let _e86 = (*p_2);\n    let _e88 = (*t_1);\n    let _e90 = (*t_1);\n    param_5 = ((_e86 * 4.7f) + vec2<f32>((_e88 * 0.12f), (-(_e90) * 0.9f)));\n    let _e95 = valueNoise_u0028_vf2_u003b((&param_5));\n    let _e97 = v;\n    v = (_e97 + (_e95 * 0.29f));\n    let _e100 = unnamed.uNoiseOctaves;\n    if (_e100 == 2i) {\n        let _e102 = v;\n        return (_e102 / 0.84f);\n    }\n    let _e104 = v;\n    let _e105 = (*p_2);\n    let _e107 = (*t_1);\n    let _e110 = (*t_1);\n    param_6 = ((_e105 * 9.3f) + vec2<f32>((-(_e107) * 0.09f), (-(_e110) * 1.4f)));\n    let _e115 = valueNoise_u0028_vf2_u003b((&param_6));\n    return (_e104 + (_e115 * 0.16f));\n}\n\nfn main_1() {\n    var t_2: f32;\n    var height: f32;\n    var spread: f32;\n    var centred: f32;\n    var sides: f32;\n    var drift: f32;\n    var param_7: vec2<f32>;\n    var n: f32;\n    var param_8: vec2<f32>;\n    var param_9: f32;\n    var density: f32;\n    var col: vec3<f32>;\n    var atmosphereColor: vec3<f32>;\n    var emerge: f32;\n    var dissipate: f32;\n    var fog: f32;\n    var param_10: f32;\n    var param_11: f32;\n    var alpha: f32;\n    var phi_312_: bool;\n\n    let _e86 = unnamed.uClipEnabled;\n    let _e87 = (_e86 != 0i);\n    phi_312_ = _e87;\n    if _e87 {\n        let _e88 = vWorldPos_1;\n        let _e94 = unnamed.uClipPlane;\n        phi_312_ = (dot(vec4<f32>(_e88.x, _e88.y, _e88.z, 1f), _e94) < 0f);\n    }\n    let _e98 = phi_312_;\n    if _e98 {\n        discard;\n    }\n    let _e100 = unnamed.uTime;\n    let _e101 = vSeed_1;\n    t_2 = (_e100 + (_e101 * 53f));\n    let _e105 = vUv_1[1u];\n    height = _e105;\n    let _e106 = height;\n    spread = mix(0.5f, 1f, _e106);\n    let _e109 = vUv_1[0u];\n    let _e111 = spread;\n    centred = (((_e109 - 0.5f) / _e111) + 0.5f);\n    let _e114 = centred;\n    sides = smoothstep(0f, 0.55f, (1f - clamp((abs((_e114 - 0.5f)) * 2f), 0f, 1f)));\n    let _e121 = sides;\n    if (_e121 <= 0.001f) {\n        discard;\n    }\n    let _e123 = t_2;\n    let _e125 = vSeed_1;\n    param_7 = vec2<f32>((_e123 * 0.21f), (_e125 * 7f));\n    let _e128 = valueNoise_u0028_vf2_u003b((&param_7));\n    let _e131 = height;\n    let _e133 = height;\n    drift = ((((_e128 - 0.5f) * 0.6f) * _e131) * _e133);\n    let _e135 = centred;\n    let _e136 = drift;\n    let _e138 = height;\n    param_8 = vec2<f32>((_e135 + _e136), _e138);\n    let _e140 = t_2;\n    param_9 = _e140;\n    let _e141 = billow_u0028_vf2_u003b_f1_u003b((&param_8), (&param_9));\n    n = _e141;\n    let _e142 = n;\n    let _e143 = sides;\n    let _e146 = height;\n    density = (((_e142 * _e143) * 1.35f) - (_e146 * 0.88f));\n    let _e149 = density;\n    if (_e149 <= 0.02f) {\n        discard;\n    }\n    let _e151 = height;\n    col = mix(vec3<f32>(0.9f, 0.42f, 0.16f), vec3<f32>(0.11f, 0.1f, 0.1f), vec3(smoothstep(0f, 0.34f, _e151)));\n    let _e155 = mediumColor_u0028_();\n    atmosphereColor = _e155;\n    let _e156 = col;\n    let _e157 = atmosphereColor;\n    let _e158 = height;\n    col = mix(_e156, _e157, vec3(smoothstep(0.3f, 0.95f, _e158)));\n    let _e162 = height;\n    emerge = smoothstep(0f, 0.3f, _e162);\n    let _e164 = height;\n    dissipate = (1f - smoothstep(0.22f, 0.75f, _e164));\n    let _e167 = vDistance_1;\n    param_10 = _e167;\n    let _e169 = vWorldPos_1[1u];\n    param_11 = _e169;\n    let _e170 = mediumFog_u0028_f1_u003b_f1_u003b((&param_10), (&param_11));\n    fog = _e170;\n    let _e171 = col;\n    let _e172 = atmosphereColor;\n    let _e173 = fog;\n    col = mix(_e171, _e172, vec3(_e173));\n    let _e176 = density;\n    let _e179 = emerge;\n    let _e181 = dissipate;\n    alpha = (((clamp((_e176 * 0.95f), 0f, 1f) * _e179) * _e181) * 0.13f);\n    let _e184 = col;\n    let _e185 = alpha;\n    let _e186 = fog;\n    outColor = vec4<f32>(_e184.x, _e184.y, _e184.z, (_e185 * (1f - _e186)));\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(1) vSeed: f32, @location(0) vUv: vec2<f32>, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vSeed_1 = vSeed;\n    vUv_1 = vUv;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SMOKE_BINDINGS = {
  "SMOKE_FRAG": {
    "uniforms": 1,
    "uniformSize": 128,
    "fields": {
      "uTime": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 32,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 36,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 60,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 68,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 72,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uNoiseOctaves": {
        "offset": 80,
        "size": 4,
        "type": "int"
      },
      "uClipPlane": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uClipEnabled": {
        "offset": 112,
        "size": 4,
        "type": "int"
      }
    },
    "textures": {}
  }
} as const;
