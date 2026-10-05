/*
 * Generated from ../bloom.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const BLOOM_DOWNSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uTexel: vec2<f32>,\n}\n\n@group(0) @binding(32) \nvar uSource_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSource_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn fetch_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> vec3<f32> {\n    let _e27 = (*uv);\n    let _e28 = textureSampleLevel(uSource_t, uSource_s, _e27, 0f);\n    return _e28.xyz;\n}\n\nfn main_1() {\n    var t: vec2<f32>;\n    var a: vec3<f32>;\n    var param: vec2<f32>;\n    var b: vec3<f32>;\n    var param_1: vec2<f32>;\n    var c: vec3<f32>;\n    var param_2: vec2<f32>;\n    var d: vec3<f32>;\n    var param_3: vec2<f32>;\n    var e: vec3<f32>;\n    var param_4: vec2<f32>;\n    var f: vec3<f32>;\n    var param_5: vec2<f32>;\n    var g: vec3<f32>;\n    var param_6: vec2<f32>;\n    var h: vec3<f32>;\n    var param_7: vec2<f32>;\n    var i: vec3<f32>;\n    var param_8: vec2<f32>;\n    var j: vec3<f32>;\n    var param_9: vec2<f32>;\n    var k: vec3<f32>;\n    var param_10: vec2<f32>;\n    var l: vec3<f32>;\n    var param_11: vec2<f32>;\n    var m: vec3<f32>;\n    var param_12: vec2<f32>;\n    var box0_: vec3<f32>;\n    var box1_: vec3<f32>;\n    var box2_: vec3<f32>;\n    var box3_: vec3<f32>;\n    var box4_: vec3<f32>;\n\n    let _e59 = unnamed.uTexel;\n    t = _e59;\n    let _e60 = vUv_1;\n    let _e61 = t;\n    param = (_e60 + (vec2<f32>(-2f, 2f) * _e61));\n    let _e64 = fetch_u0028_vf2_u003b((&param));\n    a = _e64;\n    let _e65 = vUv_1;\n    let _e66 = t;\n    param_1 = (_e65 + (vec2<f32>(0f, 2f) * _e66));\n    let _e69 = fetch_u0028_vf2_u003b((&param_1));\n    b = _e69;\n    let _e70 = vUv_1;\n    let _e71 = t;\n    param_2 = (_e70 + (vec2<f32>(2f, 2f) * _e71));\n    let _e74 = fetch_u0028_vf2_u003b((&param_2));\n    c = _e74;\n    let _e75 = vUv_1;\n    let _e76 = t;\n    param_3 = (_e75 + (vec2<f32>(-2f, 0f) * _e76));\n    let _e79 = fetch_u0028_vf2_u003b((&param_3));\n    d = _e79;\n    let _e80 = vUv_1;\n    param_4 = _e80;\n    let _e81 = fetch_u0028_vf2_u003b((&param_4));\n    e = _e81;\n    let _e82 = vUv_1;\n    let _e83 = t;\n    param_5 = (_e82 + (vec2<f32>(2f, 0f) * _e83));\n    let _e86 = fetch_u0028_vf2_u003b((&param_5));\n    f = _e86;\n    let _e87 = vUv_1;\n    let _e88 = t;\n    param_6 = (_e87 + (vec2<f32>(-2f, -2f) * _e88));\n    let _e91 = fetch_u0028_vf2_u003b((&param_6));\n    g = _e91;\n    let _e92 = vUv_1;\n    let _e93 = t;\n    param_7 = (_e92 + (vec2<f32>(0f, -2f) * _e93));\n    let _e96 = fetch_u0028_vf2_u003b((&param_7));\n    h = _e96;\n    let _e97 = vUv_1;\n    let _e98 = t;\n    param_8 = (_e97 + (vec2<f32>(2f, -2f) * _e98));\n    let _e101 = fetch_u0028_vf2_u003b((&param_8));\n    i = _e101;\n    let _e102 = vUv_1;\n    let _e103 = t;\n    param_9 = (_e102 + (vec2<f32>(-1f, 1f) * _e103));\n    let _e106 = fetch_u0028_vf2_u003b((&param_9));\n    j = _e106;\n    let _e107 = vUv_1;\n    let _e108 = t;\n    param_10 = (_e107 + (vec2<f32>(1f, 1f) * _e108));\n    let _e111 = fetch_u0028_vf2_u003b((&param_10));\n    k = _e111;\n    let _e112 = vUv_1;\n    let _e113 = t;\n    param_11 = (_e112 + (vec2<f32>(-1f, -1f) * _e113));\n    let _e116 = fetch_u0028_vf2_u003b((&param_11));\n    l = _e116;\n    let _e117 = vUv_1;\n    let _e118 = t;\n    param_12 = (_e117 + (vec2<f32>(1f, -1f) * _e118));\n    let _e121 = fetch_u0028_vf2_u003b((&param_12));\n    m = _e121;\n    let _e122 = a;\n    let _e123 = b;\n    let _e125 = d;\n    let _e127 = e;\n    box0_ = ((((_e122 + _e123) + _e125) + _e127) * 0.25f);\n    let _e130 = b;\n    let _e131 = c;\n    let _e133 = e;\n    let _e135 = f;\n    box1_ = ((((_e130 + _e131) + _e133) + _e135) * 0.25f);\n    let _e138 = d;\n    let _e139 = e;\n    let _e141 = g;\n    let _e143 = h;\n    box2_ = ((((_e138 + _e139) + _e141) + _e143) * 0.25f);\n    let _e146 = e;\n    let _e147 = f;\n    let _e149 = h;\n    let _e151 = i;\n    box3_ = ((((_e146 + _e147) + _e149) + _e151) * 0.25f);\n    let _e154 = j;\n    let _e155 = k;\n    let _e157 = l;\n    let _e159 = m;\n    box4_ = ((((_e154 + _e155) + _e157) + _e159) * 0.25f);\n    let _e162 = box4_;\n    let _e164 = box0_;\n    let _e165 = box1_;\n    let _e167 = box2_;\n    let _e169 = box3_;\n    let _e172 = ((_e162 * 0.5f) + ((((_e164 + _e165) + _e167) + _e169) * 0.125f));\n    fragColor = vec4<f32>(_e172.x, _e172.y, _e172.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

export const BLOOM_PREFILTER_FRAG_WGSL = "struct Uniforms {\n    uTexel: vec2<f32>,\n    uThreshold: f32,\n    uRamp: f32,\n}\n\n@group(0) @binding(32) \nvar uSource_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSource_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn brightness_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> f32 {\n    let _e36 = (*c)[0u];\n    let _e38 = (*c)[1u];\n    let _e40 = (*c)[2u];\n    return max(_e36, max(_e38, _e40));\n}\n\nfn firefly_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> f32 {\n    var param: vec3<f32>;\n\n    let _e36 = (*c_1);\n    param = _e36;\n    let _e37 = brightness_u0028_vf3_u003b((&param));\n    return (1f / (1f + _e37));\n}\n\nfn fetch_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var c_2: vec3<f32>;\n    var bright: f32;\n    var param_1: vec3<f32>;\n\n    let _e38 = (*uv);\n    let _e39 = textureSampleLevel(uSource_t, uSource_s, _e38, 0f);\n    c_2 = min(_e39.xyz, vec3<f32>(256f, 256f, 256f));\n    let _e42 = c_2;\n    param_1 = _e42;\n    let _e43 = brightness_u0028_vf3_u003b((&param_1));\n    bright = _e43;\n    let _e45 = unnamed.uRamp;\n    if (_e45 > 0f) {\n        let _e47 = c_2;\n        let _e48 = bright;\n        let _e50 = unnamed.uThreshold;\n        let _e53 = unnamed.uRamp;\n        return (_e47 * clamp(((_e48 - _e50) / _e53), 0f, 1f));\n    }\n    let _e57 = c_2;\n    let _e58 = bright;\n    let _e60 = unnamed.uThreshold;\n    let _e63 = bright;\n    return (_e57 * (max((_e58 - _e60), 0f) / max(_e63, 0.0001f)));\n}\n\nfn main_1() {\n    var t: vec2<f32>;\n    var a: vec3<f32>;\n    var param_2: vec2<f32>;\n    var b: vec3<f32>;\n    var param_3: vec2<f32>;\n    var c_3: vec3<f32>;\n    var param_4: vec2<f32>;\n    var d: vec3<f32>;\n    var param_5: vec2<f32>;\n    var e: vec3<f32>;\n    var param_6: vec2<f32>;\n    var f: vec3<f32>;\n    var param_7: vec2<f32>;\n    var g: vec3<f32>;\n    var param_8: vec2<f32>;\n    var h: vec3<f32>;\n    var param_9: vec2<f32>;\n    var i: vec3<f32>;\n    var param_10: vec2<f32>;\n    var j: vec3<f32>;\n    var param_11: vec2<f32>;\n    var k: vec3<f32>;\n    var param_12: vec2<f32>;\n    var l: vec3<f32>;\n    var param_13: vec2<f32>;\n    var m: vec3<f32>;\n    var param_14: vec2<f32>;\n    var box0_: vec3<f32>;\n    var box1_: vec3<f32>;\n    var box2_: vec3<f32>;\n    var box3_: vec3<f32>;\n    var box4_: vec3<f32>;\n    var w0_: f32;\n    var param_15: vec3<f32>;\n    var w1_: f32;\n    var param_16: vec3<f32>;\n    var w2_: f32;\n    var param_17: vec3<f32>;\n    var w3_: f32;\n    var param_18: vec3<f32>;\n    var w4_: f32;\n    var param_19: vec3<f32>;\n    var sum: vec3<f32>;\n\n    let _e78 = unnamed.uTexel;\n    t = _e78;\n    let _e79 = vUv_1;\n    let _e80 = t;\n    param_2 = (_e79 + (vec2<f32>(-2f, 2f) * _e80));\n    let _e83 = fetch_u0028_vf2_u003b((&param_2));\n    a = _e83;\n    let _e84 = vUv_1;\n    let _e85 = t;\n    param_3 = (_e84 + (vec2<f32>(0f, 2f) * _e85));\n    let _e88 = fetch_u0028_vf2_u003b((&param_3));\n    b = _e88;\n    let _e89 = vUv_1;\n    let _e90 = t;\n    param_4 = (_e89 + (vec2<f32>(2f, 2f) * _e90));\n    let _e93 = fetch_u0028_vf2_u003b((&param_4));\n    c_3 = _e93;\n    let _e94 = vUv_1;\n    let _e95 = t;\n    param_5 = (_e94 + (vec2<f32>(-2f, 0f) * _e95));\n    let _e98 = fetch_u0028_vf2_u003b((&param_5));\n    d = _e98;\n    let _e99 = vUv_1;\n    param_6 = _e99;\n    let _e100 = fetch_u0028_vf2_u003b((&param_6));\n    e = _e100;\n    let _e101 = vUv_1;\n    let _e102 = t;\n    param_7 = (_e101 + (vec2<f32>(2f, 0f) * _e102));\n    let _e105 = fetch_u0028_vf2_u003b((&param_7));\n    f = _e105;\n    let _e106 = vUv_1;\n    let _e107 = t;\n    param_8 = (_e106 + (vec2<f32>(-2f, -2f) * _e107));\n    let _e110 = fetch_u0028_vf2_u003b((&param_8));\n    g = _e110;\n    let _e111 = vUv_1;\n    let _e112 = t;\n    param_9 = (_e111 + (vec2<f32>(0f, -2f) * _e112));\n    let _e115 = fetch_u0028_vf2_u003b((&param_9));\n    h = _e115;\n    let _e116 = vUv_1;\n    let _e117 = t;\n    param_10 = (_e116 + (vec2<f32>(2f, -2f) * _e117));\n    let _e120 = fetch_u0028_vf2_u003b((&param_10));\n    i = _e120;\n    let _e121 = vUv_1;\n    let _e122 = t;\n    param_11 = (_e121 + (vec2<f32>(-1f, 1f) * _e122));\n    let _e125 = fetch_u0028_vf2_u003b((&param_11));\n    j = _e125;\n    let _e126 = vUv_1;\n    let _e127 = t;\n    param_12 = (_e126 + (vec2<f32>(1f, 1f) * _e127));\n    let _e130 = fetch_u0028_vf2_u003b((&param_12));\n    k = _e130;\n    let _e131 = vUv_1;\n    let _e132 = t;\n    param_13 = (_e131 + (vec2<f32>(-1f, -1f) * _e132));\n    let _e135 = fetch_u0028_vf2_u003b((&param_13));\n    l = _e135;\n    let _e136 = vUv_1;\n    let _e137 = t;\n    param_14 = (_e136 + (vec2<f32>(1f, -1f) * _e137));\n    let _e140 = fetch_u0028_vf2_u003b((&param_14));\n    m = _e140;\n    let _e141 = a;\n    let _e142 = b;\n    let _e144 = d;\n    let _e146 = e;\n    box0_ = ((((_e141 + _e142) + _e144) + _e146) * 0.25f);\n    let _e149 = b;\n    let _e150 = c_3;\n    let _e152 = e;\n    let _e154 = f;\n    box1_ = ((((_e149 + _e150) + _e152) + _e154) * 0.25f);\n    let _e157 = d;\n    let _e158 = e;\n    let _e160 = g;\n    let _e162 = h;\n    box2_ = ((((_e157 + _e158) + _e160) + _e162) * 0.25f);\n    let _e165 = e;\n    let _e166 = f;\n    let _e168 = h;\n    let _e170 = i;\n    box3_ = ((((_e165 + _e166) + _e168) + _e170) * 0.25f);\n    let _e173 = j;\n    let _e174 = k;\n    let _e176 = l;\n    let _e178 = m;\n    box4_ = ((((_e173 + _e174) + _e176) + _e178) * 0.25f);\n    let _e181 = box0_;\n    param_15 = _e181;\n    let _e182 = firefly_u0028_vf3_u003b((&param_15));\n    w0_ = (_e182 * 0.125f);\n    let _e184 = box1_;\n    param_16 = _e184;\n    let _e185 = firefly_u0028_vf3_u003b((&param_16));\n    w1_ = (_e185 * 0.125f);\n    let _e187 = box2_;\n    param_17 = _e187;\n    let _e188 = firefly_u0028_vf3_u003b((&param_17));\n    w2_ = (_e188 * 0.125f);\n    let _e190 = box3_;\n    param_18 = _e190;\n    let _e191 = firefly_u0028_vf3_u003b((&param_18));\n    w3_ = (_e191 * 0.125f);\n    let _e193 = box4_;\n    param_19 = _e193;\n    let _e194 = firefly_u0028_vf3_u003b((&param_19));\n    w4_ = (_e194 * 0.5f);\n    let _e196 = box0_;\n    let _e197 = w0_;\n    let _e199 = box1_;\n    let _e200 = w1_;\n    let _e203 = box2_;\n    let _e204 = w2_;\n    let _e207 = box3_;\n    let _e208 = w3_;\n    let _e211 = box4_;\n    let _e212 = w4_;\n    sum = (((((_e196 * _e197) + (_e199 * _e200)) + (_e203 * _e204)) + (_e207 * _e208)) + (_e211 * _e212));\n    let _e215 = sum;\n    let _e216 = w0_;\n    let _e217 = w1_;\n    let _e219 = w2_;\n    let _e221 = w3_;\n    let _e223 = w4_;\n    let _e227 = (_e215 / vec3(max(((((_e216 + _e217) + _e219) + _e221) + _e223), 0.0001f)));\n    fragColor = vec4<f32>(_e227.x, _e227.y, _e227.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

export const BLOOM_UPSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uScale: vec3<f32>,\n    uRadius: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSource_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSource_s: sampler;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn main_1() {\n    var r: f32;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n    var c: vec3<f32>;\n    var d: vec3<f32>;\n    var e: vec3<f32>;\n    var f: vec3<f32>;\n    var g: vec3<f32>;\n    var h: vec3<f32>;\n    var i: vec3<f32>;\n    var sum: vec3<f32>;\n\n    let _e24 = unnamed.uRadius;\n    r = _e24;\n    let _e25 = vUv_1;\n    let _e26 = r;\n    let _e28 = r;\n    let _e31 = textureSampleLevel(uSource_t, uSource_s, (_e25 + vec2<f32>(-(_e26), _e28)), 0f);\n    a = _e31.xyz;\n    let _e33 = vUv_1;\n    let _e34 = r;\n    let _e37 = textureSampleLevel(uSource_t, uSource_s, (_e33 + vec2<f32>(0f, _e34)), 0f);\n    b = _e37.xyz;\n    let _e39 = vUv_1;\n    let _e40 = r;\n    let _e41 = r;\n    let _e44 = textureSampleLevel(uSource_t, uSource_s, (_e39 + vec2<f32>(_e40, _e41)), 0f);\n    c = _e44.xyz;\n    let _e46 = vUv_1;\n    let _e47 = r;\n    let _e51 = textureSampleLevel(uSource_t, uSource_s, (_e46 + vec2<f32>(-(_e47), 0f)), 0f);\n    d = _e51.xyz;\n    let _e53 = vUv_1;\n    let _e54 = textureSampleLevel(uSource_t, uSource_s, _e53, 0f);\n    e = _e54.xyz;\n    let _e56 = vUv_1;\n    let _e57 = r;\n    let _e60 = textureSampleLevel(uSource_t, uSource_s, (_e56 + vec2<f32>(_e57, 0f)), 0f);\n    f = _e60.xyz;\n    let _e62 = vUv_1;\n    let _e63 = r;\n    let _e65 = r;\n    let _e69 = textureSampleLevel(uSource_t, uSource_s, (_e62 + vec2<f32>(-(_e63), -(_e65))), 0f);\n    g = _e69.xyz;\n    let _e71 = vUv_1;\n    let _e72 = r;\n    let _e76 = textureSampleLevel(uSource_t, uSource_s, (_e71 + vec2<f32>(0f, -(_e72))), 0f);\n    h = _e76.xyz;\n    let _e78 = vUv_1;\n    let _e79 = r;\n    let _e80 = r;\n    let _e84 = textureSampleLevel(uSource_t, uSource_s, (_e78 + vec2<f32>(_e79, -(_e80))), 0f);\n    i = _e84.xyz;\n    let _e86 = e;\n    let _e88 = b;\n    let _e89 = d;\n    let _e91 = f;\n    let _e93 = h;\n    let _e97 = a;\n    let _e98 = c;\n    let _e100 = g;\n    let _e102 = i;\n    sum = (((_e86 * 4f) + ((((_e88 + _e89) + _e91) + _e93) * 2f)) + (((_e97 + _e98) + _e100) + _e102));\n    let _e105 = sum;\n    let _e108 = unnamed.uScale;\n    let _e109 = ((_e105 * 0.0625f) * _e108);\n    fragColor = vec4<f32>(_e109.x, _e109.y, _e109.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const BLOOM_BINDINGS = {
  "BLOOM_DOWNSAMPLE_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uTexel": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      }
    },
    "textures": {
      "uSource": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "BLOOM_PREFILTER_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uTexel": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uThreshold": {
        "offset": 8,
        "size": 4,
        "type": "float"
      },
      "uRamp": {
        "offset": 12,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSource": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "BLOOM_UPSAMPLE_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uScale": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uRadius": {
        "offset": 12,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSource": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  }
} as const;
