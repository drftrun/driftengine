/*
 * Generated from ../decalProject.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const DECAL_PROJECT_FRAG_WGSL = "struct Uniforms {\n    uDecalDepthToWorld: mat4x4<f32>,\n    uWorldToDecal: mat4x4<f32>,\n    uDecalEye: vec3<f32>,\n    uDecalAxis: vec3<f32>,\n    uDecalColor: vec3<f32>,\n    uDecalOpacity: f32,\n    uDecalFacingCos: f32,\n    uDecalSoftness: f32,\n    uOutputTransform: i32,\n}\n\n@group(0) @binding(32) \nvar uDecalDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uDecalDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> fragColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e34 = (*c);\n    low = (_e34 * 12.92f);\n    let _e36 = (*c);\n    high = ((pow(max(_e36, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e42 = high;\n    let _e43 = low;\n    let _e44 = (*c);\n    return mix(_e42, _e43, step(_e44, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn main_1() {\n    var stored: f32;\n    var world: vec4<f32>;\n    var point: vec3<f32>;\n    var plane: vec3<f32>;\n    var span: f32;\n    var normal: vec3<f32>;\n    var local: vec3<f32>;\n    var box: vec3<f32>;\n    var inside: vec3<f32>;\n    var mark: f32;\n    var radius: f32;\n    var facing: f32;\n    var multiply: vec3<f32>;\n    var param: vec3<f32>;\n\n    let _e45 = vUv_1;\n    let _e46 = textureSampleLevel(uDecalDepth_t, uDecalDepth_s, _e45, 0f);\n    stored = _e46.x;\n    let _e49 = unnamed.uDecalDepthToWorld;\n    let _e50 = vUv_1;\n    let _e53 = ((_e50 * 2f) - vec2(1f));\n    let _e54 = stored;\n    world = (_e49 * vec4<f32>(_e53.x, _e53.y, _e54, 1f));\n    let _e59 = world;\n    let _e62 = world[3u];\n    point = (_e59.xyz / vec3(_e62));\n    let _e65 = point;\n    let _e66 = dpdx(_e65);\n    let _e67 = point;\n    let _e68 = dpdy(_e67);\n    plane = cross(_e66, _e68);\n    let _e70 = plane;\n    span = length(_e70);\n    let _e72 = span;\n    if (_e72 > 0f) {\n        let _e74 = plane;\n        let _e75 = span;\n        local = (_e74 / vec3(_e75));\n    } else {\n        let _e79 = unnamed.uDecalAxis;\n        local = _e79;\n    }\n    let _e80 = local;\n    normal = _e80;\n    let _e82 = unnamed.uDecalEye;\n    let _e83 = point;\n    let _e85 = normal;\n    let _e88 = normal;\n    normal = (_e88 * sign(dot((_e82 - _e83), _e85)));\n    let _e91 = unnamed.uWorldToDecal;\n    let _e92 = point;\n    box = (_e91 * vec4<f32>(_e92.x, _e92.y, _e92.z, 1f)).xyz;\n    let _e99 = box;\n    inside = step(abs(_e99), vec3<f32>(1f, 1f, 1f));\n    let _e103 = inside[0u];\n    let _e105 = inside[1u];\n    let _e108 = inside[2u];\n    mark = ((_e103 * _e105) * _e108);\n    let _e110 = box;\n    radius = length(_e110.xy);\n    let _e114 = unnamed.uDecalSoftness;\n    let _e116 = radius;\n    let _e119 = mark;\n    mark = (_e119 * (1f - smoothstep((1f - _e114), 1f, _e116)));\n    let _e121 = normal;\n    let _e123 = unnamed.uDecalAxis;\n    facing = dot(_e121, -(_e123));\n    let _e127 = unnamed.uDecalFacingCos;\n    let _e129 = unnamed.uDecalFacingCos;\n    let _e132 = facing;\n    let _e134 = mark;\n    mark = (_e134 * smoothstep(_e127, min(1f, (_e129 + 0.25f)), _e132));\n    let _e136 = stored;\n    let _e139 = mark;\n    mark = (_e139 * select(1f, 0f, (_e136 <= 0f)));\n    let _e142 = unnamed.uDecalColor;\n    let _e143 = mark;\n    let _e145 = unnamed.uDecalOpacity;\n    multiply = mix(vec3<f32>(1f, 1f, 1f), _e142, vec3((_e143 * _e145)));\n    let _e149 = multiply;\n    let _e150 = multiply;\n    param = _e150;\n    let _e151 = linearToSrgb_u0028_vf3_u003b((&param));\n    let _e153 = unnamed.uOutputTransform;\n    let _e157 = mix(_e149, _e151, vec3(select(0f, 1f, (_e153 != 0i))));\n    fragColor = vec4<f32>(_e157.x, _e157.y, _e157.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const DECALPROJECT_BINDINGS = {
  "DECAL_PROJECT_FRAG": {
    "uniforms": 1,
    "uniformSize": 192,
    "fields": {
      "uDecalDepthToWorld": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uWorldToDecal": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uDecalEye": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      },
      "uDecalAxis": {
        "offset": 144,
        "size": 12,
        "type": "vec3"
      },
      "uDecalColor": {
        "offset": 160,
        "size": 12,
        "type": "vec3"
      },
      "uDecalOpacity": {
        "offset": 172,
        "size": 4,
        "type": "float"
      },
      "uDecalFacingCos": {
        "offset": 176,
        "size": 4,
        "type": "float"
      },
      "uDecalSoftness": {
        "offset": 180,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 184,
        "size": 4,
        "type": "int"
      }
    },
    "textures": {
      "uDecalDepth": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  }
} as const;
