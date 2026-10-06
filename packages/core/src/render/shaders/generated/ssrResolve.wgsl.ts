/*
 * Generated from ../ssrResolve.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SSR_MATERIAL_RESOLVE_FRAG_WGSL = "struct Uniforms {\n    uSsrBlur: vec3<f32>,\n}\n\n@group(0) @binding(34) \nvar uSsrProbeMap_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uSsrProbeMap_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(36) \nvar uSsrTintMap_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uSsrTintMap_s: sampler;\n@group(0) @binding(32) \nvar uSsrReflection_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSsrReflection_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> fragColor: vec4<f32>;\n\nfn main_1() {\n    var probe: vec4<f32>;\n    var tint: vec3<f32>;\n    var traced: vec4<f32>;\n    var radius: f32;\n    var sum: vec4<f32>;\n    var i: i32;\n    var angle: f32;\n    var reach: f32;\n    var local: f32;\n    var offset: vec2<f32>;\n\n    let _e31 = vUv_1;\n    let _e32 = textureSampleLevel(uSsrProbeMap_t, uSsrProbeMap_s, _e31, 0f);\n    probe = _e32;\n    let _e33 = vUv_1;\n    let _e34 = textureSampleLevel(uSsrTintMap_t, uSsrTintMap_s, _e33, 0f);\n    tint = _e34.xyz;\n    let _e36 = vUv_1;\n    let _e37 = textureSampleLevel(uSsrReflection_t, uSsrReflection_s, _e36, 0f);\n    traced = _e37;\n    let _e39 = probe[3u];\n    let _e42 = unnamed.uSsrBlur[2u];\n    radius = (_e39 * _e42);\n    let _e44 = radius;\n    if (_e44 >= 1f) {\n        let _e46 = traced;\n        sum = _e46;\n        i = 0i;\n        loop {\n            let _e47 = i;\n            if (_e47 < 12i) {\n                let _e49 = i;\n                let _e59 = i;\n                angle = ((f32((_e49 - (i32(floor((f32(_e49) / f32(6i)))) * 6i))) * 1.0471976f) + select(0.5235988f, 0f, (_e59 < 6i)));\n                let _e63 = i;\n                if (_e63 < 6i) {\n                    let _e65 = radius;\n                    local = _e65;\n                } else {\n                    let _e66 = radius;\n                    local = (_e66 * 0.5f);\n                }\n                let _e68 = local;\n                reach = _e68;\n                let _e69 = angle;\n                let _e71 = angle;\n                let _e74 = reach;\n                let _e77 = unnamed.uSsrBlur;\n                offset = ((vec2<f32>(cos(_e69), sin(_e71)) * _e74) * _e77.xy);\n                let _e80 = vUv_1;\n                let _e81 = offset;\n                let _e83 = textureSampleLevel(uSsrReflection_t, uSsrReflection_s, (_e80 + _e81), 0f);\n                let _e84 = sum;\n                sum = (_e84 + _e83);\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e86 = i;\n                i = (_e86 + 1i);\n            }\n        }\n        let _e88 = sum;\n        traced = (_e88 / vec4(13f));\n    }\n    let _e91 = traced;\n    let _e93 = tint;\n    let _e96 = traced[3u];\n    let _e97 = probe;\n    let _e100 = ((_e91.xyz * _e93) - (_e97.xyz * _e96));\n    fragColor = vec4<f32>(_e100.x, _e100.y, _e100.z, 0f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

export const SSR_RESOLVE_FRAG_WGSL = "var<private> fragColor: vec4<f32>;\n@group(0) @binding(32) \nvar uSsrReflection_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSsrReflection_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n\nfn main_1() {\n    let _e5 = vUv_1;\n    let _e6 = textureSampleLevel(uSsrReflection_t, uSsrReflection_s, _e5, 0f);\n    fragColor = _e6;\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SSRRESOLVE_BINDINGS = {
  "SSR_MATERIAL_RESOLVE_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uSsrBlur": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      }
    },
    "textures": {
      "uSsrReflection": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uSsrProbeMap": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uSsrTintMap": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      }
    }
  },
  "SSR_RESOLVE_FRAG": {
    "uniforms": null,
    "textures": {
      "uSsrReflection": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  }
} as const;
