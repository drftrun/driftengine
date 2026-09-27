/*
 * Generated from ../exposure.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const EXPOSURE_ADAPT_FRAG_WGSL = "struct Uniforms {\n    uBlend: f32,\n}\n\n@group(0) @binding(32) \nvar uMeter_t: texture_2d<f32>;\n@group(0) @binding(34) \nvar uHeld_t: texture_2d<f32>;\nvar<private> fragColor: f32;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(33) \nvar uMeter_s: sampler;\n@group(0) @binding(35) \nvar uHeld_s: sampler;\n\nfn main_1() {\n    var sum: f32;\n    var y: i32;\n    var x: i32;\n    var measured: f32;\n    var held: f32;\n\n    sum = 0f;\n    y = 0i;\n    loop {\n        let _e18 = y;\n        if (_e18 < 32i) {\n            x = 0i;\n            loop {\n                let _e20 = x;\n                if (_e20 < 32i) {\n                    let _e22 = x;\n                    let _e23 = y;\n                    let _e25 = textureLoad(uMeter_t, vec2<i32>(_e22, _e23), 0i);\n                    let _e27 = sum;\n                    sum = (_e27 + _e25.x);\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e29 = x;\n                    x = (_e29 + 1i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e31 = y;\n            y = (_e31 + 1i);\n        }\n    }\n    let _e33 = sum;\n    measured = (_e33 / 1024f);\n    let _e35 = textureLoad(uHeld_t, vec2<i32>(0i, 0i), 0i);\n    held = _e35.x;\n    let _e37 = held;\n    let _e38 = measured;\n    let _e40 = unnamed.uBlend;\n    fragColor = mix(_e37, _e38, _e40);\n    return;\n}\n\n@fragment \nfn main() -> @location(0) f32 {\n    main_1();\n    let _e1 = fragColor;\n    return _e1;\n}\n";

export const EXPOSURE_METER_FRAG_WGSL = "var<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\nvar<private> fragColor: f32;\n\nfn main_1() {\n    var corner: vec2<f32>;\n    var sum: f32;\n    var y: i32;\n    var x: i32;\n    var uv: vec2<f32>;\n    var c: vec3<f32>;\n    var luma: f32;\n\n    let _e27 = vUv_1;\n    corner = (_e27 - vec2<f32>(0.015625f, 0.015625f));\n    sum = 0f;\n    y = 0i;\n    loop {\n        let _e29 = y;\n        if (_e29 < 8i) {\n            x = 0i;\n            loop {\n                let _e31 = x;\n                if (_e31 < 8i) {\n                    let _e33 = corner;\n                    let _e34 = x;\n                    let _e36 = y;\n                    uv = (_e33 + ((vec2<f32>(f32(_e34), f32(_e36)) + vec2(0.5f)) / vec2(256f)));\n                    let _e44 = uv;\n                    let _e45 = textureSampleLevel(uScene_t, uScene_s, _e44, 0f);\n                    c = _e45.xyz;\n                    let _e47 = c;\n                    luma = dot(_e47, vec3<f32>(0.2126f, 0.7152f, 0.0722f));\n                    let _e49 = luma;\n                    let _e53 = sum;\n                    sum = (_e53 + clamp(log2(max(_e49, 0.00000001f)), -12f, 8f));\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e55 = x;\n                    x = (_e55 + 1i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e57 = y;\n            y = (_e57 + 1i);\n        }\n    }\n    let _e59 = sum;\n    fragColor = (_e59 / 64f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) f32 {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const EXPOSURE_BINDINGS = {
  "EXPOSURE_ADAPT_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uBlend": {
        "offset": 0,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uMeter": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uHeld": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      }
    }
  },
  "EXPOSURE_METER_FRAG": {
    "uniforms": null,
    "textures": {
      "uScene": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  }
} as const;
