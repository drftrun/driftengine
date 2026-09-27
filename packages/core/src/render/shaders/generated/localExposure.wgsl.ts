/*
 * Generated from ../localExposure.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const EXPOSURE_LOCAL_FRAG_WGSL = "var<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\nvar<private> fragColor: vec2<f32>;\n\nfn main_1() {\n    var uvBlock: f32;\n    var band: f32;\n    var corner: vec2<f32>;\n    var sum: f32;\n    var count: f32;\n    var y: i32;\n    var x: i32;\n    var uv: vec2<f32>;\n    var c: vec3<f32>;\n    var level: f32;\n    var tapBand: f32;\n    var kept: f32;\n\n    let _e39 = vUv_1[0u];\n    uvBlock = (_e39 * 11f);\n    let _e41 = uvBlock;\n    band = floor(_e41);\n    let _e43 = uvBlock;\n    let _e46 = vUv_1[1u];\n    corner = (vec2<f32>(fract(_e43), _e46) - vec2<f32>(0.015625f, 0.015625f));\n    sum = 0f;\n    count = 0f;\n    y = 0i;\n    loop {\n        let _e49 = y;\n        if (_e49 < 8i) {\n            x = 0i;\n            loop {\n                let _e51 = x;\n                if (_e51 < 8i) {\n                    let _e53 = corner;\n                    let _e54 = x;\n                    let _e56 = y;\n                    uv = (_e53 + ((vec2<f32>(f32(_e54), f32(_e56)) + vec2(0.5f)) / vec2(256f)));\n                    let _e64 = uv;\n                    let _e65 = textureSampleLevel(uScene_t, uScene_s, _e64, 0f);\n                    c = _e65.xyz;\n                    let _e67 = c;\n                    level = clamp(log2(max(dot(_e67, vec3<f32>(0.2126f, 0.7152f, 0.0722f)), 0.00000001f)), -12f, 8f);\n                    let _e72 = level;\n                    tapBand = floor(clamp(((_e72 - -12f) / 2f), 0f, 9f));\n                    let _e77 = band;\n                    let _e79 = tapBand;\n                    let _e80 = band;\n                    kept = select(0f, 1f, ((_e77 > 9f) || (_e79 == _e80)));\n                    let _e84 = level;\n                    let _e85 = kept;\n                    let _e87 = sum;\n                    sum = (_e87 + (_e84 * _e85));\n                    let _e89 = kept;\n                    let _e90 = count;\n                    count = (_e90 + _e89);\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e92 = x;\n                    x = (_e92 + 1i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e94 = y;\n            y = (_e94 + 1i);\n        }\n    }\n    let _e96 = sum;\n    let _e97 = count;\n    fragColor = (vec2<f32>(_e96, _e97) / vec2(64f));\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec2<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const LOCALEXPOSURE_BINDINGS = {
  "EXPOSURE_LOCAL_FRAG": {
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
