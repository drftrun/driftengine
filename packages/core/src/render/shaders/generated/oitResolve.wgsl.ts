/*
 * Generated from ../oitResolve.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const OIT_RESOLVE_FRAG_WGSL = "@group(0) @binding(32) \nvar uOitAccum_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uOitAccum_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(34) \nvar uOitReveal_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uOitReveal_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn main_1() {\n    var accum: vec4<f32>;\n    var reveal: f32;\n    var average: vec3<f32>;\n\n    let _e13 = vUv_1;\n    let _e14 = textureSampleLevel(uOitAccum_t, uOitAccum_s, _e13, 0f);\n    accum = _e14;\n    let _e15 = vUv_1;\n    let _e16 = textureSampleLevel(uOitReveal_t, uOitReveal_s, _e15, 0f);\n    reveal = _e16.x;\n    let _e18 = accum;\n    let _e21 = accum[3u];\n    average = (_e18.xyz / vec3(max(_e21, 0.00001f)));\n    let _e25 = average;\n    let _e26 = reveal;\n    fragColor = vec4<f32>(_e25.x, _e25.y, _e25.z, _e26);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const OITRESOLVE_BINDINGS = {
  "OIT_RESOLVE_FRAG": {
    "uniforms": null,
    "textures": {
      "uOitAccum": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uOitReveal": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      }
    }
  }
} as const;
