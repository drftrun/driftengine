/*
 * Generated from ../arcane.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const ARCANE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uTint: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e59 = unnamed.uFogColor;\n    let _e61 = unnamed.uUnderwaterColor;\n    let _e63 = unnamed.uUnderwaterFactor;\n    return mix(_e59, _e61, vec3(_e63));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e68 = unnamed.uFogMode;\n    if (_e68 == 1i) {\n        let _e71 = unnamed.uFogFar;\n        let _e73 = unnamed.uFogNear;\n        span = max((_e71 - _e73), 0.0001f);\n        let _e76 = (*dist);\n        let _e78 = unnamed.uFogNear;\n        let _e80 = span;\n        ramp = clamp(((_e76 - _e78) / _e80), 0f, 1f);\n        let _e84 = unnamed.uUnderwaterFactor;\n        if (_e84 <= 0f) {\n            let _e86 = ramp;\n            return _e86;\n        }\n        let _e88 = unnamed.uUnderwaterFogDensity;\n        let _e89 = (*dist);\n        wetLinear = (_e88 * _e89);\n        let _e91 = ramp;\n        let _e92 = wetLinear;\n        let _e94 = wetLinear;\n        let _e100 = unnamed.uUnderwaterFactor;\n        return mix(_e91, (1f - exp2(((-(_e92) * _e94) * 1.442695f))), _e100);\n    }\n    let _e102 = (*pointY);\n    let _e104 = unnamed.uFogEyeY;\n    let _e107 = unnamed.uFogHeightFalloff;\n    t = ((_e102 - _e104) * _e107);\n    let _e109 = t;\n    let _e112 = t;\n    denom = select(_e112, 0.0001f, (abs(_e109) < 0.0001f));\n    let _e115 = unnamed.uFogDensity;\n    let _e117 = (*dist);\n    let _e119 = denom;\n    let _e124 = denom;\n    air = (1f - exp((((-(_e115) * _e117) * (1f - exp(-(_e119)))) / _e124)));\n    let _e129 = unnamed.uUnderwaterFactor;\n    if (_e129 <= 0f) {\n        let _e131 = air;\n        return _e131;\n    }\n    let _e133 = unnamed.uUnderwaterFogDensity;\n    let _e134 = (*dist);\n    wet = (_e133 * _e134);\n    let _e136 = air;\n    let _e137 = wet;\n    let _e139 = wet;\n    let _e145 = unnamed.uUnderwaterFactor;\n    return mix(_e136, (1f - exp2(((-(_e137) * _e139) * 1.442695f))), _e145);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e59 = (*p);\n    return fract((sin(dot(_e59, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param: vec2<f32>;\n    var param_1: vec2<f32>;\n    var param_2: vec2<f32>;\n    var param_3: vec2<f32>;\n\n    let _e66 = (*p_1);\n    i = floor(_e66);\n    let _e68 = (*p_1);\n    f = fract(_e68);\n    let _e70 = f;\n    let _e71 = f;\n    let _e73 = f;\n    u = ((_e70 * _e71) * (vec2(3f) - (_e73 * 2f)));\n    let _e78 = i;\n    param = _e78;\n    let _e79 = hash21_u0028_vf2_u003b((&param));\n    let _e80 = i;\n    param_1 = (_e80 + vec2<f32>(1f, 0f));\n    let _e82 = hash21_u0028_vf2_u003b((&param_1));\n    let _e84 = u[0u];\n    let _e86 = i;\n    param_2 = (_e86 + vec2<f32>(0f, 1f));\n    let _e88 = hash21_u0028_vf2_u003b((&param_2));\n    let _e89 = i;\n    param_3 = (_e89 + vec2<f32>(1f, 1f));\n    let _e91 = hash21_u0028_vf2_u003b((&param_3));\n    let _e93 = u[0u];\n    let _e96 = u[1u];\n    return mix(mix(_e79, _e82, _e84), mix(_e88, _e91, _e93), _e96);\n}\n\nfn main_1() {\n    var radius: f32;\n    var d: vec2<f32>;\n    var angle: f32;\n    var t_1: f32;\n    var inner: f32;\n    var param_4: vec2<f32>;\n    var outer: f32;\n    var param_5: vec2<f32>;\n    var swirl: f32;\n    var param_6: vec2<f32>;\n    var core: f32;\n    var corona: f32;\n    var body: f32;\n    var col: vec3<f32>;\n    var alpha: f32;\n    var fog: f32;\n    var param_7: f32;\n    var param_8: f32;\n    var phi_237_: bool;\n\n    let _e77 = unnamed.uClipEnabled;\n    let _e78 = (_e77 != 0i);\n    phi_237_ = _e78;\n    if _e78 {\n        let _e79 = vWorldPos_1;\n        let _e85 = unnamed.uClipPlane;\n        phi_237_ = (dot(vec4<f32>(_e79.x, _e79.y, _e79.z, 1f), _e85) < 0f);\n    }\n    let _e89 = phi_237_;\n    if _e89 {\n        discard;\n    }\n    let _e90 = vUv_1;\n    radius = (length((_e90 - vec2(0.5f))) * 2f);\n    let _e95 = radius;\n    if (_e95 >= 1f) {\n        discard;\n    }\n    let _e97 = vUv_1;\n    d = (_e97 - vec2(0.5f));\n    let _e101 = d[1u];\n    let _e103 = d[0u];\n    angle = atan2(_e101, _e103);\n    let _e106 = unnamed.uTime;\n    let _e107 = vSeed_1;\n    t_1 = (_e106 + (_e107 * 37f));\n    let _e110 = angle;\n    let _e112 = t_1;\n    let _e115 = radius;\n    param_4 = vec2<f32>(((_e110 * 1.9f) + (_e112 * 0.55f)), (_e115 * 4.2f));\n    let _e118 = valueNoise_u0028_vf2_u003b((&param_4));\n    inner = _e118;\n    let _e119 = angle;\n    let _e121 = t_1;\n    let _e124 = radius;\n    param_5 = vec2<f32>(((_e119 * 3.1f) - (_e121 * 0.34f)), (_e124 * 2.6f));\n    let _e127 = valueNoise_u0028_vf2_u003b((&param_5));\n    outer = _e127;\n    let _e128 = inner;\n    let _e130 = outer;\n    swirl = ((_e128 * 0.62f) + (_e130 * 0.38f));\n    let _e134 = unnamed.uNoiseOctaves;\n    if (_e134 > 1i) {\n        let _e136 = swirl;\n        let _e137 = swirl;\n        let _e138 = angle;\n        let _e140 = t_1;\n        let _e143 = radius;\n        param_6 = vec2<f32>(((_e138 * 6.3f) + (_e140 * 0.9f)), (_e143 * 8f));\n        let _e146 = valueNoise_u0028_vf2_u003b((&param_6));\n        swirl = mix(_e136, ((_e137 * _e146) * 2f), 0.35f);\n    }\n    let _e150 = radius;\n    core = (1f - smoothstep(0f, 0.28f, _e150));\n    let _e153 = radius;\n    let _e156 = swirl;\n    corona = ((1f - smoothstep(0.18f, 1f, _e153)) * (0.35f + (_e156 * 0.65f)));\n    let _e160 = core;\n    let _e162 = corona;\n    body = ((_e160 * 0.9f) + _e162);\n    let _e164 = body;\n    if (_e164 <= 0.02f) {\n        discard;\n    }\n    let _e167 = unnamed.uTint;\n    let _e170 = unnamed.uTint;\n    let _e171 = body;\n    col = mix((_e167 * 0.35f), _e170, vec3(smoothstep(0f, 0.55f, _e171)));\n    let _e175 = col;\n    let _e176 = body;\n    col = mix(_e175, vec3<f32>(1f, 1f, 1f), vec3(smoothstep(0.82f, 1.4f, _e176)));\n    let _e181 = unnamed.uTint;\n    let _e182 = col;\n    col = (_e182 * _e181);\n    let _e184 = body;\n    alpha = clamp((_e184 * 1.6f), 0f, 1f);\n    let _e187 = vDistance_1;\n    param_7 = _e187;\n    let _e189 = vWorldPos_1[1u];\n    param_8 = _e189;\n    let _e190 = mediumFog_u0028_f1_u003b_f1_u003b((&param_7), (&param_8));\n    fog = _e190;\n    let _e191 = col;\n    let _e192 = mediumColor_u0028_();\n    let _e193 = fog;\n    col = mix(_e191, _e192, vec3(_e193));\n    let _e196 = fog;\n    let _e198 = alpha;\n    alpha = (_e198 * (1f - _e196));\n    let _e200 = col;\n    let _e201 = alpha;\n    outColor = vec4<f32>(_e200.x, _e200.y, _e200.z, _e201);\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(0) vUv: vec2<f32>, @location(1) vSeed: f32, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const ARCANE_BINDINGS = {
  "ARCANE_FRAG": {
    "uniforms": 1,
    "uniformSize": 144,
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
      },
      "uTint": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      }
    },
    "textures": {}
  }
} as const;
