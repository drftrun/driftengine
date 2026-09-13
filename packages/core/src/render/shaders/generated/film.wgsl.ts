/*
 * Generated from ../film.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FILM_FRAG_WGSL = "struct Uniforms {\n    uReflectionEnabled: i32,\n    uReflectionStrength: f32,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uSheen: f32,\n    uFilmRoughness: f32,\n    uFilmRoughnessCycles: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorld_1: vec3<f32>;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vTint_1: vec3<f32>;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vCoverage_1: f32;\nvar<private> fragColor: vec4<f32>;\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e75 = unnamed.uFogColor;\n    let _e77 = unnamed.uUnderwaterColor;\n    let _e79 = unnamed.uUnderwaterFactor;\n    return mix(_e75, _e77, vec3(_e79));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e84 = unnamed.uFogMode;\n    if (_e84 == 1i) {\n        let _e87 = unnamed.uFogFar;\n        let _e89 = unnamed.uFogNear;\n        span = max((_e87 - _e89), 0.0001f);\n        let _e92 = (*dist);\n        let _e94 = unnamed.uFogNear;\n        let _e96 = span;\n        ramp = clamp(((_e92 - _e94) / _e96), 0f, 1f);\n        let _e100 = unnamed.uUnderwaterFactor;\n        if (_e100 <= 0f) {\n            let _e102 = ramp;\n            return _e102;\n        }\n        let _e104 = unnamed.uUnderwaterFogDensity;\n        let _e105 = (*dist);\n        wetLinear = (_e104 * _e105);\n        let _e107 = ramp;\n        let _e108 = wetLinear;\n        let _e110 = wetLinear;\n        let _e116 = unnamed.uUnderwaterFactor;\n        return mix(_e107, (1f - exp2(((-(_e108) * _e110) * 1.442695f))), _e116);\n    }\n    let _e118 = (*pointY);\n    let _e120 = unnamed.uFogEyeY;\n    let _e123 = unnamed.uFogHeightFalloff;\n    t = ((_e118 - _e120) * _e123);\n    let _e125 = t;\n    let _e128 = t;\n    denom = select(_e128, 0.0001f, (abs(_e125) < 0.0001f));\n    let _e131 = unnamed.uFogDensity;\n    let _e133 = (*dist);\n    let _e135 = denom;\n    let _e140 = denom;\n    air = (1f - exp((((-(_e131) * _e133) * (1f - exp(-(_e135)))) / _e140)));\n    let _e145 = unnamed.uUnderwaterFactor;\n    if (_e145 <= 0f) {\n        let _e147 = air;\n        return _e147;\n    }\n    let _e149 = unnamed.uUnderwaterFogDensity;\n    let _e150 = (*dist);\n    wet = (_e149 * _e150);\n    let _e152 = air;\n    let _e153 = wet;\n    let _e155 = wet;\n    let _e161 = unnamed.uUnderwaterFactor;\n    return mix(_e152, (1f - exp2(((-(_e153) * _e155) * 1.442695f))), _e161);\n}\n\nfn filmHash_u0028_vf3_u003b(p: ptr<function, vec3<f32>>) -> f32 {\n    let _e75 = (*p);\n    (*p) = fract((_e75 * 0.1031f));\n    let _e78 = (*p);\n    let _e79 = (*p);\n    let _e84 = (*p);\n    (*p) = (_e84 + vec3(dot(_e78, (_e79.zyx + vec3(31.32f)))));\n    let _e88 = (*p)[0u];\n    let _e90 = (*p)[1u];\n    let _e93 = (*p)[2u];\n    return fract(((_e88 + _e90) * _e93));\n}\n\nfn filmNoise_u0028_vf3_u003b(p_1: ptr<function, vec3<f32>>) -> f32 {\n    var i: vec3<f32>;\n    var f: vec3<f32>;\n    var u: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec3<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n\n    let _e86 = (*p_1);\n    i = floor(_e86);\n    let _e88 = (*p_1);\n    f = fract(_e88);\n    let _e90 = f;\n    let _e91 = f;\n    let _e93 = f;\n    u = ((_e90 * _e91) * (vec3(3f) - (_e93 * 2f)));\n    let _e98 = i;\n    param = (_e98 + vec3<f32>(0f, 0f, 0f));\n    let _e100 = filmHash_u0028_vf3_u003b((&param));\n    let _e101 = i;\n    param_1 = (_e101 + vec3<f32>(1f, 0f, 0f));\n    let _e103 = filmHash_u0028_vf3_u003b((&param_1));\n    let _e105 = u[0u];\n    let _e107 = i;\n    param_2 = (_e107 + vec3<f32>(0f, 1f, 0f));\n    let _e109 = filmHash_u0028_vf3_u003b((&param_2));\n    let _e110 = i;\n    param_3 = (_e110 + vec3<f32>(1f, 1f, 0f));\n    let _e112 = filmHash_u0028_vf3_u003b((&param_3));\n    let _e114 = u[0u];\n    let _e117 = u[1u];\n    let _e119 = i;\n    param_4 = (_e119 + vec3<f32>(0f, 0f, 1f));\n    let _e121 = filmHash_u0028_vf3_u003b((&param_4));\n    let _e122 = i;\n    param_5 = (_e122 + vec3<f32>(1f, 0f, 1f));\n    let _e124 = filmHash_u0028_vf3_u003b((&param_5));\n    let _e126 = u[0u];\n    let _e128 = i;\n    param_6 = (_e128 + vec3<f32>(0f, 1f, 1f));\n    let _e130 = filmHash_u0028_vf3_u003b((&param_6));\n    let _e131 = i;\n    param_7 = (_e131 + vec3<f32>(1f, 1f, 1f));\n    let _e133 = filmHash_u0028_vf3_u003b((&param_7));\n    let _e135 = u[0u];\n    let _e138 = u[1u];\n    let _e141 = u[2u];\n    return mix(mix(mix(_e100, _e103, _e105), mix(_e109, _e112, _e114), _e117), mix(mix(_e121, _e124, _e126), mix(_e130, _e133, _e135), _e138), _e141);\n}\n\nfn hue_u0028_f1_u003b(h: ptr<function, f32>) -> vec3<f32> {\n    var c: vec3<f32>;\n\n    let _e76 = (*h);\n    (*h) = (fract(_e76) * 6f);\n    let _e79 = (*h);\n    let _e83 = (*h);\n    let _e87 = (*h);\n    c = clamp(vec3<f32>((abs((_e79 - 3f)) - 1f), (2f - abs((_e83 - 2f))), (2f - abs((_e87 - 4f)))), vec3(0f), vec3(1f));\n    let _e95 = c;\n    return _e95;\n}\n\nfn main_1() {\n    var view: vec3<f32>;\n    var facing: f32;\n    var grazing: f32;\n    var ripple: f32;\n    var sheen: vec3<f32>;\n    var param_8: f32;\n    var base: vec3<f32>;\n    var color: vec3<f32>;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var valid: f32;\n    var at: vec3<f32>;\n    var here: f32;\n    var param_9: vec3<f32>;\n    var slope: vec2<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var along: vec2<f32>;\n    var smear: vec2<f32>;\n    var movedBorder: vec2<f32>;\n    var mirrored: vec3<f32>;\n    var fog: f32;\n    var param_12: f32;\n    var param_13: f32;\n    var coverage: f32;\n    var alpha: f32;\n    var phi_315_: bool;\n    var phi_409_: bool;\n    var phi_418_: bool;\n\n    let _e101 = unnamed.uClipEnabled;\n    let _e102 = (_e101 != 0i);\n    phi_315_ = _e102;\n    if _e102 {\n        let _e103 = vWorld_1;\n        let _e109 = unnamed.uClipPlane;\n        phi_315_ = (dot(vec4<f32>(_e103.x, _e103.y, _e103.z, 1f), _e109) < 0f);\n    }\n    let _e113 = phi_315_;\n    if _e113 {\n        discard;\n    }\n    let _e115 = unnamed.uCameraPos;\n    let _e116 = vWorld_1;\n    view = normalize((_e115 - _e116));\n    let _e119 = vNormal_1;\n    let _e121 = view;\n    facing = max(dot(normalize(_e119), _e121), 0f);\n    let _e124 = facing;\n    grazing = pow((1f - _e124), 3f);\n    let _e128 = vWorld_1[0u];\n    let _e131 = vWorld_1[2u];\n    let _e135 = unnamed.uTime;\n    let _e140 = vWorld_1[2u];\n    let _e143 = vWorld_1[0u];\n    let _e147 = unnamed.uTime;\n    ripple = (sin((((_e128 * 0.73f) + (_e131 * 0.41f)) + (_e135 * 0.55f))) * cos((((_e140 * 0.91f) - (_e143 * 0.29f)) - (_e147 * 0.37f))));\n    let _e152 = grazing;\n    let _e154 = ripple;\n    param_8 = (((_e152 * 1.35f) + (_e154 * 0.14f)) + 0.55f);\n    let _e158 = hue_u0028_f1_u003b((&param_8));\n    sheen = _e158;\n    let _e159 = vTint_1;\n    base = (_e159 * 0.9f);\n    let _e161 = base;\n    let _e162 = sheen;\n    let _e164 = unnamed.uSheen;\n    let _e166 = grazing;\n    color = (_e161 + ((_e162 * _e164) * (0.22f + (_e166 * 0.75f))));\n    let _e172 = unnamed.uReflectionEnabled;\n    let _e173 = (_e172 != 0i);\n    phi_409_ = _e173;\n    if _e173 {\n        let _e175 = unnamed.uReflectionStrength;\n        phi_409_ = (_e175 > 0f);\n    }\n    let _e178 = phi_409_;\n    phi_418_ = _e178;\n    if _e178 {\n        let _e180 = vReflectionClip_1[3u];\n        phi_418_ = (_e180 > 0f);\n    }\n    let _e183 = phi_418_;\n    if _e183 {\n        let _e184 = vReflectionClip_1;\n        let _e187 = vReflectionClip_1[3u];\n        reflectionUv = (((_e184.xy / vec2(_e187)) * 0.5f) + vec2(0.5f));\n        let _e193 = reflectionUv;\n        let _e194 = reflectionUv;\n        border = min(_e193, (vec2(1f) - _e194));\n        let _e199 = border[0u];\n        let _e201 = border[1u];\n        valid = smoothstep(0f, 0.025f, min(_e199, _e201));\n        let _e205 = unnamed.uFilmRoughness;\n        if (_e205 > 0f) {\n            let _e207 = vWorld_1;\n            let _e209 = unnamed.uFilmRoughnessCycles;\n            at = (_e207 * _e209);\n            let _e211 = at;\n            param_9 = _e211;\n            let _e212 = filmNoise_u0028_vf3_u003b((&param_9));\n            here = _e212;\n            let _e213 = at;\n            param_10 = (_e213 + vec3<f32>(0.5f, 0f, 0f));\n            let _e215 = filmNoise_u0028_vf3_u003b((&param_10));\n            let _e216 = here;\n            let _e218 = at;\n            param_11 = (_e218 + vec3<f32>(0f, 0f, 0.5f));\n            let _e220 = filmNoise_u0028_vf3_u003b((&param_11));\n            let _e221 = here;\n            slope = vec2<f32>((_e215 - _e216), (_e220 - _e221));\n            let _e225 = view[0u];\n            let _e227 = view[2u];\n            along = normalize((vec2<f32>(_e225, _e227) + vec2<f32>(0.00001f, 0f)));\n            let _e231 = along;\n            let _e232 = slope;\n            let _e233 = along;\n            let _e237 = slope;\n            smear = (((_e231 * dot(_e232, _e233)) * 3f) + (_e237 * 0.35f));\n            let _e240 = smear;\n            let _e242 = unnamed.uFilmRoughness;\n            let _e245 = grazing;\n            let _e249 = reflectionUv;\n            reflectionUv = (_e249 + (((_e240 * _e242) * 0.016f) * (0.2f + (_e245 * 0.8f))));\n            let _e251 = reflectionUv;\n            let _e252 = reflectionUv;\n            movedBorder = min(_e251, (vec2(1f) - _e252));\n            let _e256 = valid;\n            let _e258 = movedBorder[0u];\n            let _e260 = movedBorder[1u];\n            valid = min(_e256, smoothstep(0f, 0.025f, min(_e258, _e260)));\n        }\n        let _e264 = reflectionUv;\n        let _e268 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e264, vec2(0f), vec2(1f)), 0f);\n        mirrored = _e268.xyz;\n        let _e270 = color;\n        let _e271 = mirrored;\n        let _e272 = valid;\n        let _e274 = unnamed.uReflectionStrength;\n        let _e276 = grazing;\n        color = mix(_e270, _e271, vec3(((_e272 * _e274) * (0.25f + (_e276 * 0.75f)))));\n    }\n    let _e283 = unnamed.uCameraPos;\n    let _e284 = vWorld_1;\n    param_12 = length((_e283 - _e284));\n    let _e288 = vWorld_1[1u];\n    param_13 = _e288;\n    let _e289 = mediumFog_u0028_f1_u003b_f1_u003b((&param_12), (&param_13));\n    fog = _e289;\n    let _e290 = color;\n    let _e291 = mediumColor_u0028_();\n    let _e292 = fog;\n    color = mix(_e290, _e291, vec3(_e292));\n    let _e295 = vCoverage_1;\n    coverage = clamp(_e295, 0f, 1f);\n    let _e297 = coverage;\n    let _e298 = coverage;\n    let _e300 = coverage;\n    alpha = (mix((_e297 * _e298), _e300, 0.65f) * 0.92f);\n    let _e303 = color;\n    let _e304 = alpha;\n    fragColor = vec4<f32>(_e303.x, _e303.y, _e303.z, _e304);\n    return;\n}\n\n@fragment \nfn main(@location(0) vWorld: vec3<f32>, @location(1) vNormal: vec3<f32>, @location(2) vTint: vec3<f32>, @location(3) vReflectionClip: vec4<f32>, @location(4) vCoverage: f32) -> @location(0) vec4<f32> {\n    vWorld_1 = vWorld;\n    vNormal_1 = vNormal;\n    vTint_1 = vTint;\n    vReflectionClip_1 = vReflectionClip;\n    vCoverage_1 = vCoverage;\n    main_1();\n    let _e11 = fragColor;\n    return _e11;\n}\n";

export const FILM_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) member_2: vec3<f32>,\n    @location(4) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vWorld: vec3<f32>;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vTint: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vCoverage: f32;\nvar<private> aCoverage_1: f32;\nvar<private> vReflectionClip: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    let _e14 = aPosition_1;\n    vWorld = _e14;\n    let _e15 = aNormal_1;\n    vNormal = normalize(_e15);\n    let _e17 = aColor_1;\n    vTint = _e17;\n    let _e18 = aCoverage_1;\n    vCoverage = _e18;\n    let _e20 = unnamed.uReflectionViewProj;\n    let _e21 = aPosition_1;\n    vReflectionClip = (_e20 * vec4<f32>(_e21.x, _e21.y, _e21.z, 1f));\n    let _e28 = unnamed.uViewProj;\n    let _e29 = aPosition_1;\n    unnamed_1.gl_Position = (_e28 * vec4<f32>(_e29.x, _e29.y, _e29.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(1) aNormal: vec3<f32>, @location(2) aColor: vec3<f32>, @location(3) aCoverage: f32) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aNormal_1 = aNormal;\n    aColor_1 = aColor;\n    aCoverage_1 = aCoverage;\n    main_1();\n    let _e16 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e16);\n    let _e18 = vWorld;\n    let _e19 = vNormal;\n    let _e20 = vTint;\n    let _e21 = vCoverage;\n    let _e22 = vReflectionClip;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e18, _e19, _e20, _e21, _e22, _e23);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FILM_BINDINGS = {
  "FILM_FRAG": {
    "uniforms": 1,
    "uniformSize": 144,
    "fields": {
      "uReflectionEnabled": {
        "offset": 0,
        "size": 4,
        "type": "int"
      },
      "uReflectionStrength": {
        "offset": 4,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uTime": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uClipPlane": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uClipEnabled": {
        "offset": 48,
        "size": 4,
        "type": "int"
      },
      "uFogColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 84,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 108,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 112,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 116,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 120,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uSheen": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uFilmRoughness": {
        "offset": 132,
        "size": 4,
        "type": "float"
      },
      "uFilmRoughnessCycles": {
        "offset": 136,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uReflectionMap": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "FILM_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uReflectionViewProj": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
