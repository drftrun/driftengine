/*
 * Generated from ../bloom.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const BLOOM_DOWNSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uTexel: vec2<f32>,\n}\n\n@group(0) @binding(32) \nvar uSource_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSource_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn fetch_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> vec3<f32> {\n    let _e27 = (*uv);\n    let _e28 = textureSampleLevel(uSource_t, uSource_s, _e27, 0f);\n    return _e28.xyz;\n}\n\nfn main_1() {\n    var t: vec2<f32>;\n    var a: vec3<f32>;\n    var param: vec2<f32>;\n    var b: vec3<f32>;\n    var param_1: vec2<f32>;\n    var c: vec3<f32>;\n    var param_2: vec2<f32>;\n    var d: vec3<f32>;\n    var param_3: vec2<f32>;\n    var e: vec3<f32>;\n    var param_4: vec2<f32>;\n    var f: vec3<f32>;\n    var param_5: vec2<f32>;\n    var g: vec3<f32>;\n    var param_6: vec2<f32>;\n    var h: vec3<f32>;\n    var param_7: vec2<f32>;\n    var i: vec3<f32>;\n    var param_8: vec2<f32>;\n    var j: vec3<f32>;\n    var param_9: vec2<f32>;\n    var k: vec3<f32>;\n    var param_10: vec2<f32>;\n    var l: vec3<f32>;\n    var param_11: vec2<f32>;\n    var m: vec3<f32>;\n    var param_12: vec2<f32>;\n    var box0_: vec3<f32>;\n    var box1_: vec3<f32>;\n    var box2_: vec3<f32>;\n    var box3_: vec3<f32>;\n    var box4_: vec3<f32>;\n\n    let _e59 = unnamed.uTexel;\n    t = _e59;\n    let _e60 = vUv_1;\n    let _e61 = t;\n    param = (_e60 + (vec2<f32>(-2f, 2f) * _e61));\n    let _e64 = fetch_u0028_vf2_u003b((&param));\n    a = _e64;\n    let _e65 = vUv_1;\n    let _e66 = t;\n    param_1 = (_e65 + (vec2<f32>(0f, 2f) * _e66));\n    let _e69 = fetch_u0028_vf2_u003b((&param_1));\n    b = _e69;\n    let _e70 = vUv_1;\n    let _e71 = t;\n    param_2 = (_e70 + (vec2<f32>(2f, 2f) * _e71));\n    let _e74 = fetch_u0028_vf2_u003b((&param_2));\n    c = _e74;\n    let _e75 = vUv_1;\n    let _e76 = t;\n    param_3 = (_e75 + (vec2<f32>(-2f, 0f) * _e76));\n    let _e79 = fetch_u0028_vf2_u003b((&param_3));\n    d = _e79;\n    let _e80 = vUv_1;\n    param_4 = _e80;\n    let _e81 = fetch_u0028_vf2_u003b((&param_4));\n    e = _e81;\n    let _e82 = vUv_1;\n    let _e83 = t;\n    param_5 = (_e82 + (vec2<f32>(2f, 0f) * _e83));\n    let _e86 = fetch_u0028_vf2_u003b((&param_5));\n    f = _e86;\n    let _e87 = vUv_1;\n    let _e88 = t;\n    param_6 = (_e87 + (vec2<f32>(-2f, -2f) * _e88));\n    let _e91 = fetch_u0028_vf2_u003b((&param_6));\n    g = _e91;\n    let _e92 = vUv_1;\n    let _e93 = t;\n    param_7 = (_e92 + (vec2<f32>(0f, -2f) * _e93));\n    let _e96 = fetch_u0028_vf2_u003b((&param_7));\n    h = _e96;\n    let _e97 = vUv_1;\n    let _e98 = t;\n    param_8 = (_e97 + (vec2<f32>(2f, -2f) * _e98));\n    let _e101 = fetch_u0028_vf2_u003b((&param_8));\n    i = _e101;\n    let _e102 = vUv_1;\n    let _e103 = t;\n    param_9 = (_e102 + (vec2<f32>(-1f, 1f) * _e103));\n    let _e106 = fetch_u0028_vf2_u003b((&param_9));\n    j = _e106;\n    let _e107 = vUv_1;\n    let _e108 = t;\n    param_10 = (_e107 + (vec2<f32>(1f, 1f) * _e108));\n    let _e111 = fetch_u0028_vf2_u003b((&param_10));\n    k = _e111;\n    let _e112 = vUv_1;\n    let _e113 = t;\n    param_11 = (_e112 + (vec2<f32>(-1f, -1f) * _e113));\n    let _e116 = fetch_u0028_vf2_u003b((&param_11));\n    l = _e116;\n    let _e117 = vUv_1;\n    let _e118 = t;\n    param_12 = (_e117 + (vec2<f32>(1f, -1f) * _e118));\n    let _e121 = fetch_u0028_vf2_u003b((&param_12));\n    m = _e121;\n    let _e122 = a;\n    let _e123 = b;\n    let _e125 = d;\n    let _e127 = e;\n    box0_ = ((((_e122 + _e123) + _e125) + _e127) * 0.25f);\n    let _e130 = b;\n    let _e131 = c;\n    let _e133 = e;\n    let _e135 = f;\n    box1_ = ((((_e130 + _e131) + _e133) + _e135) * 0.25f);\n    let _e138 = d;\n    let _e139 = e;\n    let _e141 = g;\n    let _e143 = h;\n    box2_ = ((((_e138 + _e139) + _e141) + _e143) * 0.25f);\n    let _e146 = e;\n    let _e147 = f;\n    let _e149 = h;\n    let _e151 = i;\n    box3_ = ((((_e146 + _e147) + _e149) + _e151) * 0.25f);\n    let _e154 = j;\n    let _e155 = k;\n    let _e157 = l;\n    let _e159 = m;\n    box4_ = ((((_e154 + _e155) + _e157) + _e159) * 0.25f);\n    let _e162 = box4_;\n    let _e164 = box0_;\n    let _e165 = box1_;\n    let _e167 = box2_;\n    let _e169 = box3_;\n    let _e172 = ((_e162 * 0.5f) + ((((_e164 + _e165) + _e167) + _e169) * 0.125f));\n    fragColor = vec4<f32>(_e172.x, _e172.y, _e172.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

export const BLOOM_PREFILTER_FRAG_WGSL = "struct Uniforms {\n    uTexel: vec2<f32>,\n    uThreshold: f32,\n}\n\n@group(0) @binding(32) \nvar uSource_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSource_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn brightness_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> f32 {\n    let _e35 = (*c)[0u];\n    let _e37 = (*c)[1u];\n    let _e39 = (*c)[2u];\n    return max(_e35, max(_e37, _e39));\n}\n\nfn firefly_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> f32 {\n    var param: vec3<f32>;\n\n    let _e35 = (*c_1);\n    param = _e35;\n    let _e36 = brightness_u0028_vf3_u003b((&param));\n    return (1f / (1f + _e36));\n}\n\nfn fetch_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var c_2: vec3<f32>;\n    var bright: f32;\n    var param_1: vec3<f32>;\n\n    let _e37 = (*uv);\n    let _e38 = textureSampleLevel(uSource_t, uSource_s, _e37, 0f);\n    c_2 = min(_e38.xyz, vec3<f32>(256f, 256f, 256f));\n    let _e41 = c_2;\n    param_1 = _e41;\n    let _e42 = brightness_u0028_vf3_u003b((&param_1));\n    bright = _e42;\n    let _e43 = c_2;\n    let _e44 = bright;\n    let _e46 = unnamed.uThreshold;\n    let _e49 = bright;\n    return (_e43 * (max((_e44 - _e46), 0f) / max(_e49, 0.0001f)));\n}\n\nfn main_1() {\n    var t: vec2<f32>;\n    var a: vec3<f32>;\n    var param_2: vec2<f32>;\n    var b: vec3<f32>;\n    var param_3: vec2<f32>;\n    var c_3: vec3<f32>;\n    var param_4: vec2<f32>;\n    var d: vec3<f32>;\n    var param_5: vec2<f32>;\n    var e: vec3<f32>;\n    var param_6: vec2<f32>;\n    var f: vec3<f32>;\n    var param_7: vec2<f32>;\n    var g: vec3<f32>;\n    var param_8: vec2<f32>;\n    var h: vec3<f32>;\n    var param_9: vec2<f32>;\n    var i: vec3<f32>;\n    var param_10: vec2<f32>;\n    var j: vec3<f32>;\n    var param_11: vec2<f32>;\n    var k: vec3<f32>;\n    var param_12: vec2<f32>;\n    var l: vec3<f32>;\n    var param_13: vec2<f32>;\n    var m: vec3<f32>;\n    var param_14: vec2<f32>;\n    var box0_: vec3<f32>;\n    var box1_: vec3<f32>;\n    var box2_: vec3<f32>;\n    var box3_: vec3<f32>;\n    var box4_: vec3<f32>;\n    var w0_: f32;\n    var param_15: vec3<f32>;\n    var w1_: f32;\n    var param_16: vec3<f32>;\n    var w2_: f32;\n    var param_17: vec3<f32>;\n    var w3_: f32;\n    var param_18: vec3<f32>;\n    var w4_: f32;\n    var param_19: vec3<f32>;\n    var sum: vec3<f32>;\n\n    let _e77 = unnamed.uTexel;\n    t = _e77;\n    let _e78 = vUv_1;\n    let _e79 = t;\n    param_2 = (_e78 + (vec2<f32>(-2f, 2f) * _e79));\n    let _e82 = fetch_u0028_vf2_u003b((&param_2));\n    a = _e82;\n    let _e83 = vUv_1;\n    let _e84 = t;\n    param_3 = (_e83 + (vec2<f32>(0f, 2f) * _e84));\n    let _e87 = fetch_u0028_vf2_u003b((&param_3));\n    b = _e87;\n    let _e88 = vUv_1;\n    let _e89 = t;\n    param_4 = (_e88 + (vec2<f32>(2f, 2f) * _e89));\n    let _e92 = fetch_u0028_vf2_u003b((&param_4));\n    c_3 = _e92;\n    let _e93 = vUv_1;\n    let _e94 = t;\n    param_5 = (_e93 + (vec2<f32>(-2f, 0f) * _e94));\n    let _e97 = fetch_u0028_vf2_u003b((&param_5));\n    d = _e97;\n    let _e98 = vUv_1;\n    param_6 = _e98;\n    let _e99 = fetch_u0028_vf2_u003b((&param_6));\n    e = _e99;\n    let _e100 = vUv_1;\n    let _e101 = t;\n    param_7 = (_e100 + (vec2<f32>(2f, 0f) * _e101));\n    let _e104 = fetch_u0028_vf2_u003b((&param_7));\n    f = _e104;\n    let _e105 = vUv_1;\n    let _e106 = t;\n    param_8 = (_e105 + (vec2<f32>(-2f, -2f) * _e106));\n    let _e109 = fetch_u0028_vf2_u003b((&param_8));\n    g = _e109;\n    let _e110 = vUv_1;\n    let _e111 = t;\n    param_9 = (_e110 + (vec2<f32>(0f, -2f) * _e111));\n    let _e114 = fetch_u0028_vf2_u003b((&param_9));\n    h = _e114;\n    let _e115 = vUv_1;\n    let _e116 = t;\n    param_10 = (_e115 + (vec2<f32>(2f, -2f) * _e116));\n    let _e119 = fetch_u0028_vf2_u003b((&param_10));\n    i = _e119;\n    let _e120 = vUv_1;\n    let _e121 = t;\n    param_11 = (_e120 + (vec2<f32>(-1f, 1f) * _e121));\n    let _e124 = fetch_u0028_vf2_u003b((&param_11));\n    j = _e124;\n    let _e125 = vUv_1;\n    let _e126 = t;\n    param_12 = (_e125 + (vec2<f32>(1f, 1f) * _e126));\n    let _e129 = fetch_u0028_vf2_u003b((&param_12));\n    k = _e129;\n    let _e130 = vUv_1;\n    let _e131 = t;\n    param_13 = (_e130 + (vec2<f32>(-1f, -1f) * _e131));\n    let _e134 = fetch_u0028_vf2_u003b((&param_13));\n    l = _e134;\n    let _e135 = vUv_1;\n    let _e136 = t;\n    param_14 = (_e135 + (vec2<f32>(1f, -1f) * _e136));\n    let _e139 = fetch_u0028_vf2_u003b((&param_14));\n    m = _e139;\n    let _e140 = a;\n    let _e141 = b;\n    let _e143 = d;\n    let _e145 = e;\n    box0_ = ((((_e140 + _e141) + _e143) + _e145) * 0.25f);\n    let _e148 = b;\n    let _e149 = c_3;\n    let _e151 = e;\n    let _e153 = f;\n    box1_ = ((((_e148 + _e149) + _e151) + _e153) * 0.25f);\n    let _e156 = d;\n    let _e157 = e;\n    let _e159 = g;\n    let _e161 = h;\n    box2_ = ((((_e156 + _e157) + _e159) + _e161) * 0.25f);\n    let _e164 = e;\n    let _e165 = f;\n    let _e167 = h;\n    let _e169 = i;\n    box3_ = ((((_e164 + _e165) + _e167) + _e169) * 0.25f);\n    let _e172 = j;\n    let _e173 = k;\n    let _e175 = l;\n    let _e177 = m;\n    box4_ = ((((_e172 + _e173) + _e175) + _e177) * 0.25f);\n    let _e180 = box0_;\n    param_15 = _e180;\n    let _e181 = firefly_u0028_vf3_u003b((&param_15));\n    w0_ = (_e181 * 0.125f);\n    let _e183 = box1_;\n    param_16 = _e183;\n    let _e184 = firefly_u0028_vf3_u003b((&param_16));\n    w1_ = (_e184 * 0.125f);\n    let _e186 = box2_;\n    param_17 = _e186;\n    let _e187 = firefly_u0028_vf3_u003b((&param_17));\n    w2_ = (_e187 * 0.125f);\n    let _e189 = box3_;\n    param_18 = _e189;\n    let _e190 = firefly_u0028_vf3_u003b((&param_18));\n    w3_ = (_e190 * 0.125f);\n    let _e192 = box4_;\n    param_19 = _e192;\n    let _e193 = firefly_u0028_vf3_u003b((&param_19));\n    w4_ = (_e193 * 0.5f);\n    let _e195 = box0_;\n    let _e196 = w0_;\n    let _e198 = box1_;\n    let _e199 = w1_;\n    let _e202 = box2_;\n    let _e203 = w2_;\n    let _e206 = box3_;\n    let _e207 = w3_;\n    let _e210 = box4_;\n    let _e211 = w4_;\n    sum = (((((_e195 * _e196) + (_e198 * _e199)) + (_e202 * _e203)) + (_e206 * _e207)) + (_e210 * _e211));\n    let _e214 = sum;\n    let _e215 = w0_;\n    let _e216 = w1_;\n    let _e218 = w2_;\n    let _e220 = w3_;\n    let _e222 = w4_;\n    let _e226 = (_e214 / vec3(max(((((_e215 + _e216) + _e218) + _e220) + _e222), 0.0001f)));\n    fragColor = vec4<f32>(_e226.x, _e226.y, _e226.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

export const BLOOM_UPSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uRadius: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSource_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSource_s: sampler;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn main_1() {\n    var r: f32;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n    var c: vec3<f32>;\n    var d: vec3<f32>;\n    var e: vec3<f32>;\n    var f: vec3<f32>;\n    var g: vec3<f32>;\n    var h: vec3<f32>;\n    var i: vec3<f32>;\n    var sum: vec3<f32>;\n\n    let _e23 = unnamed.uRadius;\n    r = _e23;\n    let _e24 = vUv_1;\n    let _e25 = r;\n    let _e27 = r;\n    let _e30 = textureSampleLevel(uSource_t, uSource_s, (_e24 + vec2<f32>(-(_e25), _e27)), 0f);\n    a = _e30.xyz;\n    let _e32 = vUv_1;\n    let _e33 = r;\n    let _e36 = textureSampleLevel(uSource_t, uSource_s, (_e32 + vec2<f32>(0f, _e33)), 0f);\n    b = _e36.xyz;\n    let _e38 = vUv_1;\n    let _e39 = r;\n    let _e40 = r;\n    let _e43 = textureSampleLevel(uSource_t, uSource_s, (_e38 + vec2<f32>(_e39, _e40)), 0f);\n    c = _e43.xyz;\n    let _e45 = vUv_1;\n    let _e46 = r;\n    let _e50 = textureSampleLevel(uSource_t, uSource_s, (_e45 + vec2<f32>(-(_e46), 0f)), 0f);\n    d = _e50.xyz;\n    let _e52 = vUv_1;\n    let _e53 = textureSampleLevel(uSource_t, uSource_s, _e52, 0f);\n    e = _e53.xyz;\n    let _e55 = vUv_1;\n    let _e56 = r;\n    let _e59 = textureSampleLevel(uSource_t, uSource_s, (_e55 + vec2<f32>(_e56, 0f)), 0f);\n    f = _e59.xyz;\n    let _e61 = vUv_1;\n    let _e62 = r;\n    let _e64 = r;\n    let _e68 = textureSampleLevel(uSource_t, uSource_s, (_e61 + vec2<f32>(-(_e62), -(_e64))), 0f);\n    g = _e68.xyz;\n    let _e70 = vUv_1;\n    let _e71 = r;\n    let _e75 = textureSampleLevel(uSource_t, uSource_s, (_e70 + vec2<f32>(0f, -(_e71))), 0f);\n    h = _e75.xyz;\n    let _e77 = vUv_1;\n    let _e78 = r;\n    let _e79 = r;\n    let _e83 = textureSampleLevel(uSource_t, uSource_s, (_e77 + vec2<f32>(_e78, -(_e79))), 0f);\n    i = _e83.xyz;\n    let _e85 = e;\n    let _e87 = b;\n    let _e88 = d;\n    let _e90 = f;\n    let _e92 = h;\n    let _e96 = a;\n    let _e97 = c;\n    let _e99 = g;\n    let _e101 = i;\n    sum = (((_e85 * 4f) + ((((_e87 + _e88) + _e90) + _e92) * 2f)) + (((_e96 + _e97) + _e99) + _e101));\n    let _e104 = sum;\n    let _e105 = (_e104 * 0.0625f);\n    fragColor = vec4<f32>(_e105.x, _e105.y, _e105.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

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
      "uRadius": {
        "offset": 0,
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
