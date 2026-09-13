/*
 * Generated from ../fire.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FIRE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e68 = unnamed.uFogColor;\n    let _e70 = unnamed.uUnderwaterColor;\n    let _e72 = unnamed.uUnderwaterFactor;\n    return mix(_e68, _e70, vec3(_e72));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e77 = unnamed.uFogMode;\n    if (_e77 == 1i) {\n        let _e80 = unnamed.uFogFar;\n        let _e82 = unnamed.uFogNear;\n        span = max((_e80 - _e82), 0.0001f);\n        let _e85 = (*dist);\n        let _e87 = unnamed.uFogNear;\n        let _e89 = span;\n        ramp = clamp(((_e85 - _e87) / _e89), 0f, 1f);\n        let _e93 = unnamed.uUnderwaterFactor;\n        if (_e93 <= 0f) {\n            let _e95 = ramp;\n            return _e95;\n        }\n        let _e97 = unnamed.uUnderwaterFogDensity;\n        let _e98 = (*dist);\n        wetLinear = (_e97 * _e98);\n        let _e100 = ramp;\n        let _e101 = wetLinear;\n        let _e103 = wetLinear;\n        let _e109 = unnamed.uUnderwaterFactor;\n        return mix(_e100, (1f - exp2(((-(_e101) * _e103) * 1.442695f))), _e109);\n    }\n    let _e111 = (*pointY);\n    let _e113 = unnamed.uFogEyeY;\n    let _e116 = unnamed.uFogHeightFalloff;\n    t = ((_e111 - _e113) * _e116);\n    let _e118 = t;\n    let _e121 = t;\n    denom = select(_e121, 0.0001f, (abs(_e118) < 0.0001f));\n    let _e124 = unnamed.uFogDensity;\n    let _e126 = (*dist);\n    let _e128 = denom;\n    let _e133 = denom;\n    air = (1f - exp((((-(_e124) * _e126) * (1f - exp(-(_e128)))) / _e133)));\n    let _e138 = unnamed.uUnderwaterFactor;\n    if (_e138 <= 0f) {\n        let _e140 = air;\n        return _e140;\n    }\n    let _e142 = unnamed.uUnderwaterFogDensity;\n    let _e143 = (*dist);\n    wet = (_e142 * _e143);\n    let _e145 = air;\n    let _e146 = wet;\n    let _e148 = wet;\n    let _e154 = unnamed.uUnderwaterFactor;\n    return mix(_e145, (1f - exp2(((-(_e146) * _e148) * 1.442695f))), _e154);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e68 = (*p);\n    return fract((sin(dot(_e68, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param: vec2<f32>;\n    var param_1: vec2<f32>;\n    var param_2: vec2<f32>;\n    var param_3: vec2<f32>;\n\n    let _e75 = (*p_1);\n    i = floor(_e75);\n    let _e77 = (*p_1);\n    f = fract(_e77);\n    let _e79 = f;\n    let _e80 = f;\n    let _e82 = f;\n    u = ((_e79 * _e80) * (vec2(3f) - (_e82 * 2f)));\n    let _e87 = i;\n    param = _e87;\n    let _e88 = hash21_u0028_vf2_u003b((&param));\n    let _e89 = i;\n    param_1 = (_e89 + vec2<f32>(1f, 0f));\n    let _e91 = hash21_u0028_vf2_u003b((&param_1));\n    let _e93 = u[0u];\n    let _e95 = i;\n    param_2 = (_e95 + vec2<f32>(0f, 1f));\n    let _e97 = hash21_u0028_vf2_u003b((&param_2));\n    let _e98 = i;\n    param_3 = (_e98 + vec2<f32>(1f, 1f));\n    let _e100 = hash21_u0028_vf2_u003b((&param_3));\n    let _e102 = u[0u];\n    let _e105 = u[1u];\n    return mix(mix(_e88, _e91, _e93), mix(_e97, _e100, _e102), _e105);\n}\n\nfn turbulence_u0028_vf2_u003b_f1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>) -> f32 {\n    var v: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n\n    let _e73 = (*p_2);\n    let _e75 = (*t_1);\n    param_4 = ((_e73 * 3f) + vec2<f32>(0f, (-(_e75) * 1.9f)));\n    let _e80 = valueNoise_u0028_vf2_u003b((&param_4));\n    v = (_e80 * 0.55f);\n    let _e83 = unnamed.uNoiseOctaves;\n    if (_e83 == 1i) {\n        let _e85 = v;\n        return (_e85 / 0.55f);\n    }\n    let _e87 = (*p_2);\n    let _e89 = (*t_1);\n    let _e91 = (*t_1);\n    param_5 = ((_e87 * 6.5f) + vec2<f32>((_e89 * 0.3f), (-(_e91) * 3.1f)));\n    let _e96 = valueNoise_u0028_vf2_u003b((&param_5));\n    let _e98 = v;\n    v = (_e98 + (_e96 * 0.28f));\n    let _e101 = unnamed.uNoiseOctaves;\n    if (_e101 == 2i) {\n        let _e103 = v;\n        return (_e103 / 0.83f);\n    }\n    let _e105 = v;\n    let _e106 = (*p_2);\n    let _e108 = (*t_1);\n    let _e111 = (*t_1);\n    param_6 = ((_e106 * 13f) + vec2<f32>((-(_e108) * 0.2f), (-(_e111) * 4.6f)));\n    let _e116 = valueNoise_u0028_vf2_u003b((&param_6));\n    return (_e105 + (_e116 * 0.17f));\n}\n\nfn main_1() {\n    var uv: vec2<f32>;\n    var t_2: f32;\n    var sides: f32;\n    var taper: f32;\n    var sway: f32;\n    var param_7: vec2<f32>;\n    var p_3: vec2<f32>;\n    var n: f32;\n    var param_8: vec2<f32>;\n    var param_9: f32;\n    var body: f32;\n    var heat: f32;\n    var col: vec3<f32>;\n    var alpha: f32;\n    var fog: f32;\n    var param_10: f32;\n    var param_11: f32;\n    var phi_312_: bool;\n\n    let _e85 = unnamed.uClipEnabled;\n    let _e86 = (_e85 != 0i);\n    phi_312_ = _e86;\n    if _e86 {\n        let _e87 = vWorldPos_1;\n        let _e93 = unnamed.uClipPlane;\n        phi_312_ = (dot(vec4<f32>(_e87.x, _e87.y, _e87.z, 1f), _e93) < 0f);\n    }\n    let _e97 = phi_312_;\n    if _e97 {\n        discard;\n    }\n    let _e98 = vUv_1;\n    uv = _e98;\n    let _e100 = unnamed.uTime;\n    let _e101 = vSeed_1;\n    t_2 = (_e100 + (_e101 * 37f));\n    let _e105 = uv[0u];\n    sides = (1f - (abs((_e105 - 0.5f)) * 2f));\n    let _e110 = sides;\n    let _e112 = uv[1u];\n    taper = (_e110 * (1f - (_e112 * 0.72f)));\n    let _e116 = taper;\n    if (_e116 <= 0f) {\n        discard;\n    }\n    let _e118 = t_2;\n    let _e120 = vSeed_1;\n    param_7 = vec2<f32>((_e118 * 0.55f), (_e120 * 11f));\n    let _e123 = valueNoise_u0028_vf2_u003b((&param_7));\n    let _e127 = uv[1u];\n    sway = (((_e123 - 0.5f) * 0.34f) * _e127);\n    let _e130 = uv[0u];\n    let _e131 = sway;\n    let _e134 = uv[1u];\n    p_3 = vec2<f32>((_e130 + _e131), _e134);\n    let _e136 = p_3;\n    param_8 = _e136;\n    let _e137 = t_2;\n    param_9 = _e137;\n    let _e138 = turbulence_u0028_vf2_u003b_f1_u003b((&param_8), (&param_9));\n    n = _e138;\n    let _e139 = n;\n    let _e140 = taper;\n    let _e144 = uv[1u];\n    body = (((_e139 * _e140) * 1.9f) - (_e144 * 0.55f));\n    let _e147 = body;\n    if (_e147 <= 0.02f) {\n        discard;\n    }\n    let _e149 = body;\n    heat = clamp((_e149 * 1.5f), 0f, 1f);\n    let _e152 = heat;\n    col = mix(vec3<f32>(0.62f, 0.06f, 0.02f), vec3<f32>(1f, 0.45f, 0.06f), vec3(smoothstep(0f, 0.45f, _e152)));\n    let _e156 = col;\n    let _e157 = heat;\n    col = mix(_e156, vec3<f32>(1f, 0.85f, 0.35f), vec3(smoothstep(0.45f, 0.75f, _e157)));\n    let _e161 = col;\n    let _e162 = heat;\n    col = mix(_e161, vec3<f32>(1f, 0.98f, 0.88f), vec3(smoothstep(0.78f, 1f, _e162)));\n    let _e166 = body;\n    let _e170 = uv[1u];\n    alpha = (clamp((_e166 * 2.2f), 0f, 1f) * (1f - smoothstep(0.72f, 1f, _e170)));\n    let _e174 = vDistance_1;\n    param_10 = _e174;\n    let _e176 = vWorldPos_1[1u];\n    param_11 = _e176;\n    let _e177 = mediumFog_u0028_f1_u003b_f1_u003b((&param_10), (&param_11));\n    fog = _e177;\n    let _e178 = col;\n    let _e179 = mediumColor_u0028_();\n    let _e180 = fog;\n    col = mix(_e178, _e179, vec3(_e180));\n    let _e183 = fog;\n    let _e185 = alpha;\n    alpha = (_e185 * (1f - _e183));\n    let _e187 = col;\n    let _e188 = alpha;\n    outColor = vec4<f32>(_e187.x, _e187.y, _e187.z, _e188);\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(0) vUv: vec2<f32>, @location(1) vSeed: f32, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

export const PLUME_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uSizePulse: f32,\n    uWind: vec2<f32>,\n    uOrigin: vec3<f32>,\n    uWindResponse: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: f32,\n    @location(2) member_2: f32,\n    @location(3) member_3: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCenter_1: vec3<f32>;\nvar<private> aSeed_1: f32;\nvar<private> aBlade_1: f32;\nvar<private> aSize_1: vec2<f32>;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vUv: vec2<f32>;\nvar<private> vSeed: f32;\nvar<private> vDistance: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn sizePulse_u0028_f1_u003b(seed: ptr<function, f32>) -> f32 {\n    let _e35 = unnamed.uSizePulse;\n    let _e37 = unnamed.uTime;\n    let _e39 = (*seed);\n    let _e45 = unnamed.uTime;\n    let _e47 = (*seed);\n    return (1f + (_e35 * ((sin(((_e37 * 1.7f) + (_e39 * 9.1f))) * 0.62f) + (sin(((_e45 * 3.3f) + (_e47 * 4.7f))) * 0.38f))));\n}\n\nfn main_1() {\n    var anchor: vec3<f32>;\n    var up: vec3<f32>;\n    var yaw: f32;\n    var right: vec3<f32>;\n    var pulse: f32;\n    var param: f32;\n    var size: vec2<f32>;\n    var rise: f32;\n    var world: vec3<f32>;\n\n    let _e42 = aCenter_1;\n    let _e44 = unnamed.uOrigin;\n    anchor = (_e42 + _e44);\n    up = vec3<f32>(0f, 1f, 0f);\n    let _e46 = aSeed_1;\n    let _e48 = aBlade_1;\n    yaw = ((_e46 * 6.2831855f) + (_e48 * 1.5707964f));\n    let _e51 = yaw;\n    let _e53 = yaw;\n    right = vec3<f32>(cos(_e51), 0f, sin(_e53));\n    let _e56 = aSeed_1;\n    param = _e56;\n    let _e57 = sizePulse_u0028_f1_u003b((&param));\n    pulse = _e57;\n    let _e59 = aSize_1[0u];\n    let _e60 = pulse;\n    let _e64 = aSize_1[1u];\n    let _e65 = pulse;\n    size = vec2<f32>((_e59 * mix(1f, _e60, 0.55f)), (_e64 * _e65));\n    let _e69 = aCorner_1[1u];\n    rise = ((_e69 * 0.5f) + 0.5f);\n    let _e72 = anchor;\n    let _e73 = right;\n    let _e75 = aCorner_1[0u];\n    let _e77 = size[0u];\n    let _e81 = up;\n    let _e82 = rise;\n    let _e84 = size[1u];\n    world = ((_e72 + (_e73 * (_e75 * _e77))) + (_e81 * (_e82 * _e84)));\n    let _e89 = unnamed.uWind;\n    let _e91 = unnamed.uWindResponse;\n    let _e92 = rise;\n    let _e94 = rise;\n    let _e97 = size[1u];\n    let _e100 = world;\n    let _e102 = (_e100.xz + (_e89 * (((_e91 * _e92) * _e94) * _e97)));\n    let _e103 = world;\n    world = vec3<f32>(_e102.x, _e103.y, _e102.y);\n    let _e109 = aCorner_1[0u];\n    let _e113 = aCorner_1[1u];\n    vUv = vec2<f32>(((_e109 * 0.5f) + 0.5f), ((_e113 * 0.5f) + 0.5f));\n    let _e117 = aSeed_1;\n    vSeed = _e117;\n    let _e118 = world;\n    let _e120 = unnamed.uCameraPos;\n    vDistance = distance(_e118, _e120);\n    let _e122 = world;\n    vWorldPos = _e122;\n    let _e124 = unnamed.uViewProj;\n    let _e125 = world;\n    unnamed_1.gl_Position = (_e124 * vec4<f32>(_e125.x, _e125.y, _e125.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aCenter: vec3<f32>, @location(3) aSeed: f32, @location(4) aBlade: f32, @location(2) aSize: vec2<f32>, @location(1) aCorner: vec2<f32>) -> VertexOutput {\n    aCenter_1 = aCenter;\n    aSeed_1 = aSeed;\n    aBlade_1 = aBlade;\n    aSize_1 = aSize;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e17 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e17);\n    let _e19 = vUv;\n    let _e20 = vSeed;\n    let _e21 = vDistance;\n    let _e22 = vWorldPos;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e19, _e20, _e21, _e22, _e23);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FIRE_BINDINGS = {
  "FIRE_FRAG": {
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
  },
  "PLUME_VERT": {
    "uniforms": 0,
    "uniformSize": 112,
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
      "uTime": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uSizePulse": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uWind": {
        "offset": 88,
        "size": 8,
        "type": "vec2"
      },
      "uOrigin": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uWindResponse": {
        "offset": 108,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
