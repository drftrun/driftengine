/*
 * Generated from ../decalProject.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const DECAL_PROJECT_FRAG_WGSL = "struct Uniforms {\n    uDecalDepthToWorld: mat4x4<f32>,\n    uWorldToDecal: mat4x4<f32>,\n    uDecalEye: vec3<f32>,\n    uDecalAxis: vec3<f32>,\n    uDecalColor: vec3<f32>,\n    uDecalOpacity: f32,\n    uDecalFacingCos: f32,\n    uDecalSoftness: f32,\n}\n\n@group(0) @binding(32) \nvar uDecalDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uDecalDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> fragColor: vec4<f32>;\n\nfn main_1() {\n    var stored: f32;\n    var world: vec4<f32>;\n    var point: vec3<f32>;\n    var plane: vec3<f32>;\n    var span: f32;\n    var normal: vec3<f32>;\n    var local: vec3<f32>;\n    var box: vec3<f32>;\n    var inside: vec3<f32>;\n    var mark: f32;\n    var radius: f32;\n    var facing: f32;\n\n    let _e34 = vUv_1;\n    let _e35 = textureSampleLevel(uDecalDepth_t, uDecalDepth_s, _e34, 0f);\n    stored = _e35.x;\n    let _e38 = unnamed.uDecalDepthToWorld;\n    let _e39 = vUv_1;\n    let _e42 = ((_e39 * 2f) - vec2(1f));\n    let _e43 = stored;\n    world = (_e38 * vec4<f32>(_e42.x, _e42.y, _e43, 1f));\n    let _e48 = world;\n    let _e51 = world[3u];\n    point = (_e48.xyz / vec3(_e51));\n    let _e54 = point;\n    let _e55 = dpdx(_e54);\n    let _e56 = point;\n    let _e57 = dpdy(_e56);\n    plane = cross(_e55, _e57);\n    let _e59 = plane;\n    span = length(_e59);\n    let _e61 = span;\n    if (_e61 > 0f) {\n        let _e63 = plane;\n        let _e64 = span;\n        local = (_e63 / vec3(_e64));\n    } else {\n        let _e68 = unnamed.uDecalAxis;\n        local = _e68;\n    }\n    let _e69 = local;\n    normal = _e69;\n    let _e71 = unnamed.uDecalEye;\n    let _e72 = point;\n    let _e74 = normal;\n    let _e77 = normal;\n    normal = (_e77 * sign(dot((_e71 - _e72), _e74)));\n    let _e80 = unnamed.uWorldToDecal;\n    let _e81 = point;\n    box = (_e80 * vec4<f32>(_e81.x, _e81.y, _e81.z, 1f)).xyz;\n    let _e88 = box;\n    inside = step(abs(_e88), vec3<f32>(1f, 1f, 1f));\n    let _e92 = inside[0u];\n    let _e94 = inside[1u];\n    let _e97 = inside[2u];\n    mark = ((_e92 * _e94) * _e97);\n    let _e99 = box;\n    radius = length(_e99.xy);\n    let _e103 = unnamed.uDecalSoftness;\n    let _e105 = radius;\n    let _e108 = mark;\n    mark = (_e108 * (1f - smoothstep((1f - _e103), 1f, _e105)));\n    let _e110 = normal;\n    let _e112 = unnamed.uDecalAxis;\n    facing = dot(_e110, -(_e112));\n    let _e116 = unnamed.uDecalFacingCos;\n    let _e118 = unnamed.uDecalFacingCos;\n    let _e121 = facing;\n    let _e123 = mark;\n    mark = (_e123 * smoothstep(_e116, min(1f, (_e118 + 0.25f)), _e121));\n    let _e125 = stored;\n    let _e128 = mark;\n    mark = (_e128 * select(1f, 0f, (_e125 <= 0f)));\n    let _e131 = unnamed.uDecalColor;\n    let _e132 = mark;\n    let _e134 = unnamed.uDecalOpacity;\n    let _e137 = mix(vec3<f32>(1f, 1f, 1f), _e131, vec3((_e132 * _e134)));\n    fragColor = vec4<f32>(_e137.x, _e137.y, _e137.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

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
