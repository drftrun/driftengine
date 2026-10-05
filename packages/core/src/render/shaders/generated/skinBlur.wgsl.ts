/*
 * Generated from ../skinBlur.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SKIN_BLUR_FRAG_WGSL = "struct Uniforms {\n    uStep: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n    uFocal: f32,\n    uProfiles: array<vec4<f32>, 8>,\n    uApplyAlbedo: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(36) \nvar uAlbedo_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uAlbedo_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uSkin_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSkin_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\n\nfn burleyMass_u0028_f1_u003b_vf3_u003b(x: ptr<function, f32>, d: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e54 = (*x);\n    let _e56 = (*d);\n    let _e60 = (*x);\n    let _e62 = (*d);\n    return (vec3(0.5f) - ((exp((vec3(-(_e54)) / _e56)) + (exp((vec3(-(_e60)) / (_e62 * 3f))) * 3f)) * 0.125f));\n}\n\nfn viewZ_u0028_f1_u003b(depth: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e54 = (*depth);\n    ndc = (1f - (_e54 * 2f));\n    let _e59 = unnamed.uDepthToViewZ[0u];\n    let _e60 = ndc;\n    let _e64 = unnamed.uDepthToViewZ[1u];\n    let _e68 = unnamed.uDepthToViewZ[2u];\n    let _e69 = ndc;\n    let _e73 = unnamed.uDepthToViewZ[3u];\n    return (((_e59 * _e60) + _e64) / ((_e68 * _e69) + _e73));\n}\n\nfn withAlbedo_u0028_vf3_u003b(light: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var albedo: vec4<f32>;\n\n    let _e55 = unnamed.uApplyAlbedo;\n    if (_e55 < 0.5f) {\n        let _e57 = (*light);\n        return _e57;\n    }\n    let _e58 = vUv_1;\n    let _e59 = textureSampleLevel(uAlbedo_t, uAlbedo_s, _e58, 0f);\n    albedo = _e59;\n    let _e60 = (*light);\n    let _e61 = albedo;\n    let _e65 = albedo[3u];\n    return ((_e60 * _e61.xyz) / vec3(max(_e65, 0.0001f)));\n}\n\nfn main_1() {\n    var own: vec4<f32>;\n    var depth_1: f32;\n    var param: vec3<f32>;\n    var profile: i32;\n    var d_1: vec3<f32>;\n    var widest: f32;\n    var z: f32;\n    var param_1: f32;\n    var pixels: f32;\n    var param_2: vec3<f32>;\n    var centre: vec3<f32>;\n    var param_3: f32;\n    var param_4: vec3<f32>;\n    var sum: vec3<f32>;\n    var weight: vec3<f32>;\n    var i: i32;\n    var outer: vec3<f32>;\n    var local: vec3<f32>;\n    var indexable: array<f32, 6>;\n    var param_5: f32;\n    var param_6: vec3<f32>;\n    var w: vec3<f32>;\n    var indexable_1: array<f32, 6>;\n    var param_7: f32;\n    var param_8: vec3<f32>;\n    var side: i32;\n    var uv: vec2<f32>;\n    var indexable_2: array<f32, 7>;\n    var tap: vec4<f32>;\n    var tapZ: f32;\n    var param_9: f32;\n    var keep: f32;\n    var cover: f32;\n    var param_10: vec3<f32>;\n\n    let _e86 = vUv_1;\n    let _e87 = textureSampleLevel(uSkin_t, uSkin_s, _e86, 0f);\n    own = _e87;\n    let _e89 = own[3u];\n    if (_e89 < 0.0001f) {\n        fragColor = vec4<f32>(0f, 0f, 0f, 0f);\n        return;\n    }\n    let _e91 = vUv_1;\n    let _e92 = textureSampleLevel(uDepth_t, uDepth_s, _e91, 0f);\n    depth_1 = _e92.x;\n    let _e94 = depth_1;\n    if (_e94 <= 0f) {\n        let _e96 = own;\n        param = _e96.xyz;\n        let _e98 = withAlbedo_u0028_vf3_u003b((&param));\n        let _e100 = own[3u];\n        fragColor = vec4<f32>(_e98.x, _e98.y, _e98.z, _e100);\n        return;\n    }\n    let _e106 = own[3u];\n    profile = clamp((i32(((_e106 * 8f) + 0.5f)) - 1i), 0i, 7i);\n    let _e112 = profile;\n    let _e115 = unnamed.uProfiles[_e112];\n    d_1 = max(_e115.xyz, vec3<f32>(0.000001f, 0.000001f, 0.000001f));\n    let _e119 = d_1[0u];\n    let _e121 = d_1[1u];\n    let _e123 = d_1[2u];\n    widest = max(_e119, max(_e121, _e123));\n    let _e126 = depth_1;\n    param_1 = _e126;\n    let _e127 = viewZ_u0028_f1_u003b((&param_1));\n    z = abs(_e127);\n    let _e129 = widest;\n    let _e131 = unnamed.uFocal;\n    let _e133 = z;\n    pixels = ((_e129 * _e131) / max(_e133, 0.0001f));\n    let _e136 = pixels;\n    if (_e136 < 0.5f) {\n        let _e138 = own;\n        param_2 = _e138.xyz;\n        let _e140 = withAlbedo_u0028_vf3_u003b((&param_2));\n        let _e142 = own[3u];\n        fragColor = vec4<f32>(_e140.x, _e140.y, _e140.z, _e142);\n        return;\n    }\n    let _e147 = widest;\n    param_3 = (0.2f * _e147);\n    let _e149 = d_1;\n    param_4 = _e149;\n    let _e150 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_3), (&param_4));\n    centre = (_e150 * 2f);\n    let _e152 = own;\n    let _e154 = centre;\n    sum = (_e152.xyz * _e154);\n    let _e156 = centre;\n    weight = _e156;\n    i = 1i;\n    loop {\n        let _e157 = i;\n        if (_e157 < 7i) {\n            let _e159 = i;\n            if (_e159 < 6i) {\n                let _e161 = i;\n                indexable = array<f32, 6>(0.2f, 0.75f, 1.6f, 2.8f, 4.55f, 7.3f);\n                let _e164 = indexable[min(_e161, 5i)];\n                let _e165 = widest;\n                param_5 = (_e164 * _e165);\n                let _e167 = d_1;\n                param_6 = _e167;\n                let _e168 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_5), (&param_6));\n                local = _e168;\n            } else {\n                local = vec3<f32>(0.5f, 0.5f, 0.5f);\n            }\n            let _e169 = local;\n            outer = _e169;\n            let _e170 = outer;\n            let _e171 = i;\n            indexable_1 = array<f32, 6>(0.2f, 0.75f, 1.6f, 2.8f, 4.55f, 7.3f);\n            let _e174 = indexable_1[(_e171 - 1i)];\n            let _e175 = widest;\n            param_7 = (_e174 * _e175);\n            let _e177 = d_1;\n            param_8 = _e177;\n            let _e178 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_7), (&param_8));\n            w = (_e170 - _e178);\n            side = -1i;\n            loop {\n                let _e180 = side;\n                if (_e180 <= 1i) {\n                    let _e182 = vUv_1;\n                    let _e184 = unnamed.uStep;\n                    let _e185 = side;\n                    let _e187 = i;\n                    indexable_2 = array<f32, 7>(0f, 0.4f, 1.1f, 2.1f, 3.5f, 5.6f, 9f);\n                    let _e189 = indexable_2[_e187];\n                    let _e191 = pixels;\n                    uv = (_e182 + (_e184 * ((f32(_e185) * _e189) * _e191)));\n                    let _e195 = uv;\n                    let _e196 = textureSampleLevel(uSkin_t, uSkin_s, _e195, 0f);\n                    tap = _e196;\n                    let _e197 = uv;\n                    let _e198 = textureSampleLevel(uDepth_t, uDepth_s, _e197, 0f);\n                    param_9 = _e198.x;\n                    let _e200 = viewZ_u0028_f1_u003b((&param_9));\n                    tapZ = abs(_e200);\n                    let _e202 = tapZ;\n                    let _e203 = z;\n                    let _e206 = widest;\n                    keep = clamp((1f - (abs((_e202 - _e203)) / (4f * _e206))), 0f, 1f);\n                    let _e212 = tap[3u];\n                    let _e214 = own[3u];\n                    cover = clamp((_e212 / _e214), 0f, 1f);\n                    let _e217 = tap;\n                    let _e219 = w;\n                    let _e221 = keep;\n                    let _e223 = sum;\n                    sum = (_e223 + ((_e217.xyz * _e219) * _e221));\n                    let _e225 = w;\n                    let _e226 = cover;\n                    let _e227 = keep;\n                    let _e230 = weight;\n                    weight = (_e230 + (_e225 * (_e226 * _e227)));\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e232 = side;\n                    side = (_e232 + 2i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e234 = i;\n            i = (_e234 + 1i);\n        }\n    }\n    let _e236 = sum;\n    let _e237 = weight;\n    param_10 = (_e236 / _e237);\n    let _e239 = withAlbedo_u0028_vf3_u003b((&param_10));\n    let _e241 = own[3u];\n    fragColor = vec4<f32>(_e239.x, _e239.y, _e239.z, _e241);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SKINBLUR_BINDINGS = {
  "SKIN_BLUR_FRAG": {
    "uniforms": 1,
    "uniformSize": 192,
    "fields": {
      "uStep": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToViewZ": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      },
      "uFocal": {
        "offset": 32,
        "size": 4,
        "type": "float"
      },
      "uProfiles": {
        "offset": 48,
        "size": 128,
        "type": "vec4",
        "length": 8,
        "stride": 16
      },
      "uApplyAlbedo": {
        "offset": 176,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSkin": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uAlbedo": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      }
    }
  }
} as const;
