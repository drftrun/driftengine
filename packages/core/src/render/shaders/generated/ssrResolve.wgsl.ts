/*
 * Generated from ../ssrResolve.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SSR_RESOLVE_FRAG_WGSL = "var<private> fragColor: vec4<f32>;\n@group(0) @binding(32) \nvar uSsrReflection_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSsrReflection_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n\nfn main_1() {\n    let _e5 = vUv_1;\n    let _e6 = textureSampleLevel(uSsrReflection_t, uSsrReflection_s, _e5, 0f);\n    fragColor = _e6;\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SSRRESOLVE_BINDINGS = {
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
