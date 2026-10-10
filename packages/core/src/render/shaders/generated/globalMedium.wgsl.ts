/*
 * Generated from ../globalMedium.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const MEDIUM_FRAG_WGSL = "struct Uniforms {\n    uDepthToWorld: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uSunDir: vec3<f32>,\n    uSunColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uDensity: f32,\n    uAlbedo: f32,\n    uAnisotropy: f32,\n    uMaxDistance: f32,\n    uSteps: i32,\n    uSunShadow: f32,\n    uLightViewProj: mat4x4<f32>,\n    uMovingLightViewProj: mat4x4<f32>,\n    uPeeledShadowEnabled: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uSunShadows_t: texture_2d_array<f32>;\n@group(0) @binding(35) \nvar uSunShadows_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn occlusion_u0028_f1_u003b_f1_u003b(stored: ptr<function, f32>, compare: ptr<function, f32>) -> f32 {\n    let _e49 = (*compare);\n    let _e50 = (*stored);\n    return smoothstep(-0.0025f, 0.0025f, (_e49 - _e50));\n}\n\nfn sunReach_u0028_vf3_u003b(worldPos: ptr<function, vec3<f32>>) -> f32 {\n    var lightPos: vec4<f32>;\n    var p: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var edgeFade: f32;\n    var compare_1: f32;\n    var blocked: f32;\n    var param: f32;\n    var param_1: f32;\n    var param_2: f32;\n    var param_3: f32;\n    var movingPos: vec4<f32>;\n    var pm: vec3<f32>;\n    var param_4: f32;\n    var param_5: f32;\n    var phi_99_: bool;\n    var phi_106_: bool;\n    var phi_114_: bool;\n    var phi_121_: bool;\n    var phi_234_: bool;\n    var phi_240_: bool;\n    var phi_246_: bool;\n    var phi_252_: bool;\n    var phi_258_: bool;\n\n    let _e63 = unnamed.uLightViewProj;\n    let _e64 = (*worldPos);\n    lightPos = (_e63 * vec4<f32>(_e64.x, _e64.y, _e64.z, 1f));\n    let _e71 = lightPos[3u];\n    if (_e71 <= 0f) {\n        return 1f;\n    }\n    let _e73 = lightPos;\n    let _e76 = lightPos[3u];\n    p = (((_e73.xyz / vec3(_e76)) * 0.5f) + vec3(0.5f));\n    let _e83 = p[2u];\n    let _e84 = (_e83 > 1f);\n    phi_99_ = _e84;\n    if !(_e84) {\n        let _e87 = p[0u];\n        phi_99_ = (_e87 < 0f);\n    }\n    let _e90 = phi_99_;\n    phi_106_ = _e90;\n    if !(_e90) {\n        let _e93 = p[0u];\n        phi_106_ = (_e93 > 1f);\n    }\n    let _e96 = phi_106_;\n    phi_114_ = _e96;\n    if !(_e96) {\n        let _e99 = p[1u];\n        phi_114_ = (_e99 < 0f);\n    }\n    let _e102 = phi_114_;\n    phi_121_ = _e102;\n    if !(_e102) {\n        let _e105 = p[1u];\n        phi_121_ = (_e105 > 1f);\n    }\n    let _e108 = phi_121_;\n    if _e108 {\n        return 1f;\n    }\n    let _e109 = p;\n    fromCentre = (abs((_e109.xy - vec2(0.5f))) * 2f);\n    let _e116 = fromCentre[0u];\n    let _e118 = fromCentre[1u];\n    edgeFade = (1f - smoothstep(0.72f, 0.98f, max(_e116, _e118)));\n    let _e123 = p[2u];\n    let _e126 = edgeFade;\n    edgeFade = (_e126 * (1f - smoothstep(0.9f, 1f, _e123)));\n    let _e128 = edgeFade;\n    if (_e128 <= 0f) {\n        return 1f;\n    }\n    let _e131 = p[2u];\n    compare_1 = (_e131 - 0.0015f);\n    let _e133 = p;\n    let _e134 = _e133.xy;\n    let _e137 = vec3<f32>(_e134.x, _e134.y, 0f);\n    let _e143 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e137.x, _e137.y), i32(_e137.z), 0f);\n    param = _e143.x;\n    let _e145 = compare_1;\n    param_1 = _e145;\n    let _e146 = occlusion_u0028_f1_u003b_f1_u003b((&param), (&param_1));\n    blocked = _e146;\n    let _e148 = unnamed.uPeeledShadowEnabled;\n    if (_e148 != 0i) {\n        let _e150 = blocked;\n        let _e151 = p;\n        let _e152 = _e151.xy;\n        let _e155 = vec3<f32>(_e152.x, _e152.y, 2f);\n        let _e161 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e155.x, _e155.y), i32(_e155.z), 0f);\n        param_2 = _e161.x;\n        let _e163 = compare_1;\n        param_3 = _e163;\n        let _e164 = occlusion_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n        blocked = max(_e150, _e164);\n    }\n    let _e167 = unnamed.uMovingLightViewProj;\n    let _e168 = (*worldPos);\n    movingPos = (_e167 * vec4<f32>(_e168.x, _e168.y, _e168.z, 1f));\n    let _e174 = movingPos;\n    let _e177 = movingPos[3u];\n    pm = (((_e174.xyz / vec3(_e177)) * 0.5f) + vec3(0.5f));\n    let _e184 = movingPos[3u];\n    let _e185 = (_e184 > 0f);\n    phi_234_ = _e185;\n    if _e185 {\n        let _e187 = pm[2u];\n        phi_234_ = (_e187 <= 1f);\n    }\n    let _e190 = phi_234_;\n    phi_240_ = _e190;\n    if _e190 {\n        let _e192 = pm[0u];\n        phi_240_ = (_e192 >= 0f);\n    }\n    let _e195 = phi_240_;\n    phi_246_ = _e195;\n    if _e195 {\n        let _e197 = pm[0u];\n        phi_246_ = (_e197 <= 1f);\n    }\n    let _e200 = phi_246_;\n    phi_252_ = _e200;\n    if _e200 {\n        let _e202 = pm[1u];\n        phi_252_ = (_e202 >= 0f);\n    }\n    let _e205 = phi_252_;\n    phi_258_ = _e205;\n    if _e205 {\n        let _e207 = pm[1u];\n        phi_258_ = (_e207 <= 1f);\n    }\n    let _e210 = phi_258_;\n    if _e210 {\n        let _e211 = blocked;\n        let _e212 = pm;\n        let _e213 = _e212.xy;\n        let _e216 = vec3<f32>(_e213.x, _e213.y, 1f);\n        let _e222 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e216.x, _e216.y), i32(_e216.z), 0f);\n        let _e224 = pm[2u];\n        param_4 = _e222.x;\n        param_5 = (_e224 - 0.0015f);\n        let _e227 = occlusion_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        blocked = max(_e211, _e227);\n    }\n    let _e229 = blocked;\n    let _e232 = unnamed.uSunShadow;\n    let _e233 = edgeFade;\n    return mix(1f, (1f - _e229), (_e232 * _e233));\n}\n\nfn phase_u0028_f1_u003b_f1_u003b(cosTheta: ptr<function, f32>, g: ptr<function, f32>) -> f32 {\n    var g2_: f32;\n    var d: f32;\n\n    let _e51 = (*g);\n    let _e52 = (*g);\n    g2_ = (_e51 * _e52);\n    let _e54 = g2_;\n    let _e56 = (*g);\n    let _e58 = (*cosTheta);\n    d = max(((1f + _e54) - ((2f * _e56) * _e58)), 0.0001f);\n    let _e62 = g2_;\n    let _e64 = d;\n    let _e66 = d;\n    return ((1f - _e62) / ((12.566371f * _e64) * sqrt(_e66)));\n}\n\nfn hash21_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    let _e48 = (*p_1);\n    return fract((sin(dot(_e48, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn main_1() {\n    var ndc: vec2<f32>;\n    var probe: vec4<f32>;\n    var dir: vec3<f32>;\n    var stored_1: f32;\n    var far: f32;\n    var hit: vec4<f32>;\n    var steps: i32;\n    var dither: f32;\n    var param_6: vec2<f32>;\n    var scatter: f32;\n    var param_7: f32;\n    var param_8: f32;\n    var sunLit: vec3<f32>;\n    var skyLit: vec3<f32>;\n    var inscatter: vec3<f32>;\n    var transmittance: f32;\n    var previous: f32;\n    var i: i32;\n    var u: f32;\n    var next: f32;\n    var segment: f32;\n    var travelled: f32;\n    var segmentTransmittance: f32;\n    var scattered: f32;\n    var lit: f32;\n    var param_9: vec3<f32>;\n\n    let _e73 = vUv_1;\n    ndc = ((_e73 * 2f) - vec2(1f));\n    let _e78 = unnamed.uDepthToWorld;\n    let _e79 = ndc;\n    probe = (_e78 * vec4<f32>(_e79.x, _e79.y, 0.5f, 1f));\n    let _e84 = probe;\n    let _e87 = probe[3u];\n    let _e91 = unnamed.uCameraPos;\n    dir = normalize(((_e84.xyz / vec3(_e87)) - _e91));\n    let _e94 = vUv_1;\n    let _e95 = textureSampleLevel(uDepth_t, uDepth_s, _e94, 0f);\n    stored_1 = _e95.x;\n    let _e98 = unnamed.uMaxDistance;\n    far = _e98;\n    let _e99 = stored_1;\n    if !((_e99 <= 0f)) {\n        let _e103 = unnamed.uDepthToWorld;\n        let _e104 = ndc;\n        let _e105 = stored_1;\n        hit = (_e103 * vec4<f32>(_e104.x, _e104.y, _e105, 1f));\n        let _e111 = hit[3u];\n        if (_e111 > 0.000001f) {\n            let _e113 = far;\n            let _e114 = hit;\n            let _e117 = hit[3u];\n            let _e121 = unnamed.uCameraPos;\n            let _e123 = dir;\n            far = min(_e113, dot(((_e114.xyz / vec3(_e117)) - _e121), _e123));\n        }\n    }\n    let _e126 = far;\n    if (_e126 <= 0f) {\n        fragColor = vec4<f32>(0f, 0f, 0f, 1f);\n        return;\n    }\n    let _e129 = unnamed.uSteps;\n    steps = clamp(_e129, 1i, 64i);\n    let _e131 = gl_FragCoord_1;\n    param_6 = _e131.xy;\n    let _e133 = hash21_u0028_vf2_u003b((&param_6));\n    dither = (_e133 - 0.5f);\n    let _e136 = unnamed.uAlbedo;\n    let _e137 = dir;\n    let _e139 = unnamed.uSunDir;\n    param_7 = dot(_e137, _e139);\n    let _e142 = unnamed.uAnisotropy;\n    param_8 = _e142;\n    let _e143 = phase_u0028_f1_u003b_f1_u003b((&param_7), (&param_8));\n    scatter = (_e136 * _e143);\n    let _e146 = unnamed.uSunColor;\n    let _e147 = scatter;\n    sunLit = (_e146 * _e147);\n    let _e150 = unnamed.uAmbient;\n    let _e152 = unnamed.uAlbedo;\n    skyLit = ((_e150 * _e152) * 0.07957747f);\n    inscatter = vec3<f32>(0f, 0f, 0f);\n    transmittance = 1f;\n    previous = 0f;\n    i = 0i;\n    loop {\n        let _e155 = i;\n        if (_e155 < 64i) {\n            let _e157 = i;\n            let _e158 = steps;\n            if (_e157 >= _e158) {\n                break;\n            }\n            let _e160 = i;\n            let _e163 = steps;\n            u = (f32((_e160 + 1i)) / f32(_e163));\n            let _e166 = far;\n            let _e167 = u;\n            next = (_e166 * pow(_e167, 2f));\n            let _e170 = next;\n            let _e171 = previous;\n            segment = (_e170 - _e171);\n            let _e173 = previous;\n            let _e174 = next;\n            travelled = (0.5f * (_e173 + _e174));\n            let _e177 = next;\n            previous = _e177;\n            let _e179 = unnamed.uDensity;\n            let _e181 = segment;\n            segmentTransmittance = exp((-(_e179) * _e181));\n            let _e184 = segmentTransmittance;\n            scattered = (1f - _e184);\n            lit = 1f;\n            let _e187 = unnamed.uSunShadow;\n            if (_e187 > 0f) {\n                let _e190 = unnamed.uCameraPos;\n                let _e191 = dir;\n                let _e192 = travelled;\n                let _e193 = dither;\n                let _e194 = segment;\n                param_9 = (_e190 + (_e191 * (_e192 + (_e193 * _e194))));\n                let _e199 = sunReach_u0028_vf3_u003b((&param_9));\n                lit = _e199;\n            }\n            let _e200 = transmittance;\n            let _e201 = scattered;\n            let _e203 = sunLit;\n            let _e204 = lit;\n            let _e206 = skyLit;\n            let _e209 = inscatter;\n            inscatter = (_e209 + (((_e203 * _e204) + _e206) * (_e200 * _e201)));\n            let _e211 = segmentTransmittance;\n            let _e212 = transmittance;\n            transmittance = (_e212 * _e211);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e214 = i;\n            i = (_e214 + 1i);\n        }\n    }\n    let _e216 = inscatter;\n    let _e217 = (_e216 * 12.566371f);\n    let _e218 = transmittance;\n    fragColor = vec4<f32>(_e217.x, _e217.y, _e217.z, _e218);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

export const MEDIUM_UPSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uMediumTexel: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uMedium_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uMedium_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn viewDistance_u0028_f1_u003b(stored: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e27 = (*stored);\n    ndc = (1f - (_e27 * 2f));\n    let _e32 = unnamed.uDepthToViewZ[0u];\n    let _e33 = ndc;\n    let _e37 = unnamed.uDepthToViewZ[1u];\n    let _e41 = unnamed.uDepthToViewZ[2u];\n    let _e42 = ndc;\n    let _e46 = unnamed.uDepthToViewZ[3u];\n    return abs((((_e32 * _e33) + _e37) / ((_e41 * _e42) + _e46)));\n}\n\nfn main_1() {\n    var here: f32;\n    var param: f32;\n    var coord: vec2<f32>;\n    var base: vec2<f32>;\n    var f: vec2<f32>;\n    var total: vec4<f32>;\n    var weight: f32;\n    var nearest: vec4<f32>;\n    var nearestGap: f32;\n    var i: i32;\n    var offset: vec2<f32>;\n    var uv: vec2<f32>;\n    var bilinear: f32;\n    var there: f32;\n    var param_1: f32;\n    var gap: f32;\n    var sampled: vec4<f32>;\n    var depthWeight: f32;\n    var local: vec4<f32>;\n\n    let _e44 = vUv_1;\n    let _e45 = textureSampleLevel(uDepth_t, uDepth_s, _e44, 0f);\n    param = _e45.x;\n    let _e47 = viewDistance_u0028_f1_u003b((&param));\n    here = _e47;\n    let _e48 = vUv_1;\n    let _e50 = unnamed.uMediumTexel;\n    coord = ((_e48 / _e50) - vec2(0.5f));\n    let _e54 = coord;\n    base = floor(_e54);\n    let _e56 = coord;\n    let _e57 = base;\n    f = (_e56 - _e57);\n    total = vec4<f32>(0f, 0f, 0f, 0f);\n    weight = 0f;\n    nearest = vec4<f32>(0f, 0f, 0f, 1f);\n    nearestGap = 1000000000000000000000000000000f;\n    i = 0i;\n    loop {\n        let _e59 = i;\n        if (_e59 < 4i) {\n            let _e61 = i;\n            let _e64 = i;\n            offset = vec2<f32>(f32((_e61 & 1i)), f32(((_e64 >> bitcast<u32>(1i)) & 1i)));\n            let _e70 = base;\n            let _e71 = offset;\n            let _e76 = unnamed.uMediumTexel;\n            uv = (((_e70 + _e71) + vec2(0.5f)) * _e76);\n            let _e79 = f[0u];\n            let _e82 = f[0u];\n            let _e84 = offset[0u];\n            let _e87 = f[1u];\n            let _e90 = f[1u];\n            let _e92 = offset[1u];\n            bilinear = (mix((1f - _e79), _e82, _e84) * mix((1f - _e87), _e90, _e92));\n            let _e95 = uv;\n            let _e96 = textureSampleLevel(uDepth_t, uDepth_s, _e95, 0f);\n            param_1 = _e96.x;\n            let _e98 = viewDistance_u0028_f1_u003b((&param_1));\n            there = _e98;\n            let _e99 = there;\n            let _e100 = here;\n            let _e103 = there;\n            let _e104 = here;\n            gap = (abs((_e99 - _e100)) / max(min(_e103, _e104), 0.001f));\n            let _e108 = uv;\n            let _e109 = textureSampleLevel(uMedium_t, uMedium_s, _e108, 0f);\n            sampled = _e109;\n            let _e110 = gap;\n            let _e111 = nearestGap;\n            if (_e110 < _e111) {\n                let _e113 = gap;\n                nearestGap = _e113;\n                let _e114 = sampled;\n                nearest = _e114;\n            }\n            let _e115 = gap;\n            depthWeight = (1f - smoothstep(0.04f, 0.05f, _e115));\n            let _e118 = sampled;\n            let _e119 = bilinear;\n            let _e121 = depthWeight;\n            let _e123 = total;\n            total = (_e123 + ((_e118 * _e119) * _e121));\n            let _e125 = bilinear;\n            let _e126 = depthWeight;\n            let _e128 = weight;\n            weight = (_e128 + (_e125 * _e126));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e130 = i;\n            i = (_e130 + 1i);\n        }\n    }\n    let _e132 = weight;\n    if (_e132 > 0.0001f) {\n        let _e134 = total;\n        let _e135 = weight;\n        local = (_e134 / vec4(_e135));\n    } else {\n        let _e138 = nearest;\n        local = _e138;\n    }\n    let _e139 = local;\n    fragColor = _e139;\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const GLOBALMEDIUM_BINDINGS = {
  "MEDIUM_FRAG": {
    "uniforms": 1,
    "uniformSize": 304,
    "fields": {
      "uDepthToWorld": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uSunDir": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uSunColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uAmbient": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uDensity": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uAlbedo": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uAnisotropy": {
        "offset": 132,
        "size": 4,
        "type": "float"
      },
      "uMaxDistance": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uSteps": {
        "offset": 140,
        "size": 4,
        "type": "int"
      },
      "uSunShadow": {
        "offset": 144,
        "size": 4,
        "type": "float"
      },
      "uLightViewProj": {
        "offset": 160,
        "size": 64,
        "type": "mat4"
      },
      "uMovingLightViewProj": {
        "offset": 224,
        "size": 64,
        "type": "mat4"
      },
      "uPeeledShadowEnabled": {
        "offset": 288,
        "size": 4,
        "type": "int"
      }
    },
    "textures": {
      "uDepth": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uSunShadows": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2DArray"
      }
    }
  },
  "MEDIUM_UPSAMPLE_FRAG": {
    "uniforms": 1,
    "uniformSize": 32,
    "fields": {
      "uMediumTexel": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToViewZ": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      }
    },
    "textures": {
      "uMedium": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      }
    }
  }
} as const;
