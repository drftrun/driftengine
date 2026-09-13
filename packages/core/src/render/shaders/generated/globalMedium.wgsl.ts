/*
 * Generated from ../globalMedium.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const MEDIUM_FRAG_WGSL = "struct Uniforms {\n    uDepthToWorld: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uSunDir: vec3<f32>,\n    uSunColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uDensity: f32,\n    uAlbedo: f32,\n    uAnisotropy: f32,\n    uMaxDistance: f32,\n    uSteps: i32,\n    uSunShadow: f32,\n    uLightViewProj: mat4x4<f32>,\n    uPeeledShadowEnabled: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uStaticShadowMap_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uStaticShadowMap_s: sampler;\n@group(0) @binding(36) \nvar uPeeledShadowMap_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uPeeledShadowMap_s: sampler;\n@group(0) @binding(38) \nvar uDynamicShadowMap_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uDynamicShadowMap_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn occlusion_u0028_f1_u003b_f1_u003b(stored: ptr<function, f32>, compare: ptr<function, f32>) -> f32 {\n    let _e52 = (*compare);\n    let _e53 = (*stored);\n    return smoothstep(-0.0025f, 0.0025f, (_e52 - _e53));\n}\n\nfn sunReach_u0028_vf3_u003b(worldPos: ptr<function, vec3<f32>>) -> f32 {\n    var lightPos: vec4<f32>;\n    var p: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var edgeFade: f32;\n    var compare_1: f32;\n    var blocked: f32;\n    var param: f32;\n    var param_1: f32;\n    var param_2: f32;\n    var param_3: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var phi_99_: bool;\n    var phi_106_: bool;\n    var phi_114_: bool;\n    var phi_121_: bool;\n\n    let _e64 = unnamed.uLightViewProj;\n    let _e65 = (*worldPos);\n    lightPos = (_e64 * vec4<f32>(_e65.x, _e65.y, _e65.z, 1f));\n    let _e72 = lightPos[3u];\n    if (_e72 <= 0f) {\n        return 1f;\n    }\n    let _e74 = lightPos;\n    let _e77 = lightPos[3u];\n    p = (((_e74.xyz / vec3(_e77)) * 0.5f) + vec3(0.5f));\n    let _e84 = p[2u];\n    let _e85 = (_e84 > 1f);\n    phi_99_ = _e85;\n    if !(_e85) {\n        let _e88 = p[0u];\n        phi_99_ = (_e88 < 0f);\n    }\n    let _e91 = phi_99_;\n    phi_106_ = _e91;\n    if !(_e91) {\n        let _e94 = p[0u];\n        phi_106_ = (_e94 > 1f);\n    }\n    let _e97 = phi_106_;\n    phi_114_ = _e97;\n    if !(_e97) {\n        let _e100 = p[1u];\n        phi_114_ = (_e100 < 0f);\n    }\n    let _e103 = phi_114_;\n    phi_121_ = _e103;\n    if !(_e103) {\n        let _e106 = p[1u];\n        phi_121_ = (_e106 > 1f);\n    }\n    let _e109 = phi_121_;\n    if _e109 {\n        return 1f;\n    }\n    let _e110 = p;\n    fromCentre = (abs((_e110.xy - vec2(0.5f))) * 2f);\n    let _e117 = fromCentre[0u];\n    let _e119 = fromCentre[1u];\n    edgeFade = (1f - smoothstep(0.72f, 0.98f, max(_e117, _e119)));\n    let _e124 = p[2u];\n    let _e127 = edgeFade;\n    edgeFade = (_e127 * (1f - smoothstep(0.9f, 1f, _e124)));\n    let _e129 = edgeFade;\n    if (_e129 <= 0f) {\n        return 1f;\n    }\n    let _e132 = p[2u];\n    compare_1 = (_e132 - 0.0015f);\n    let _e134 = p;\n    let _e136 = textureSampleLevel(uStaticShadowMap_t, uStaticShadowMap_s, _e134.xy, 0f);\n    param = _e136.x;\n    let _e138 = compare_1;\n    param_1 = _e138;\n    let _e139 = occlusion_u0028_f1_u003b_f1_u003b((&param), (&param_1));\n    blocked = _e139;\n    let _e141 = unnamed.uPeeledShadowEnabled;\n    if (_e141 != 0i) {\n        let _e143 = blocked;\n        let _e144 = p;\n        let _e146 = textureSampleLevel(uPeeledShadowMap_t, uPeeledShadowMap_s, _e144.xy, 0f);\n        param_2 = _e146.x;\n        let _e148 = compare_1;\n        param_3 = _e148;\n        let _e149 = occlusion_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n        blocked = max(_e143, _e149);\n    }\n    let _e151 = blocked;\n    let _e152 = p;\n    let _e154 = textureSampleLevel(uDynamicShadowMap_t, uDynamicShadowMap_s, _e152.xy, 0f);\n    param_4 = _e154.x;\n    let _e156 = compare_1;\n    param_5 = _e156;\n    let _e157 = occlusion_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    blocked = max(_e151, _e157);\n    let _e159 = blocked;\n    let _e162 = unnamed.uSunShadow;\n    let _e163 = edgeFade;\n    return mix(1f, (1f - _e159), (_e162 * _e163));\n}\n\nfn phase_u0028_f1_u003b_f1_u003b(cosTheta: ptr<function, f32>, g: ptr<function, f32>) -> f32 {\n    var g2_: f32;\n    var d: f32;\n\n    let _e54 = (*g);\n    let _e55 = (*g);\n    g2_ = (_e54 * _e55);\n    let _e57 = g2_;\n    let _e59 = (*g);\n    let _e61 = (*cosTheta);\n    d = max(((1f + _e57) - ((2f * _e59) * _e61)), 0.0001f);\n    let _e65 = g2_;\n    let _e67 = d;\n    let _e69 = d;\n    return ((1f - _e65) / ((12.566371f * _e67) * sqrt(_e69)));\n}\n\nfn hash21_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    let _e51 = (*p_1);\n    return fract((sin(dot(_e51, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn main_1() {\n    var ndc: vec2<f32>;\n    var probe: vec4<f32>;\n    var dir: vec3<f32>;\n    var stored_1: f32;\n    var far: f32;\n    var hit: vec4<f32>;\n    var steps: i32;\n    var dither: f32;\n    var param_6: vec2<f32>;\n    var scatter: f32;\n    var param_7: f32;\n    var param_8: f32;\n    var sunLit: vec3<f32>;\n    var skyLit: vec3<f32>;\n    var inscatter: vec3<f32>;\n    var transmittance: f32;\n    var previous: f32;\n    var i: i32;\n    var u: f32;\n    var next: f32;\n    var segment: f32;\n    var travelled: f32;\n    var segmentTransmittance: f32;\n    var scattered: f32;\n    var lit: f32;\n    var param_9: vec3<f32>;\n\n    let _e76 = vUv_1;\n    ndc = ((_e76 * 2f) - vec2(1f));\n    let _e81 = unnamed.uDepthToWorld;\n    let _e82 = ndc;\n    probe = (_e81 * vec4<f32>(_e82.x, _e82.y, 0.5f, 1f));\n    let _e87 = probe;\n    let _e90 = probe[3u];\n    let _e94 = unnamed.uCameraPos;\n    dir = normalize(((_e87.xyz / vec3(_e90)) - _e94));\n    let _e97 = vUv_1;\n    let _e98 = textureSampleLevel(uDepth_t, uDepth_s, _e97, 0f);\n    stored_1 = _e98.x;\n    let _e101 = unnamed.uMaxDistance;\n    far = _e101;\n    let _e102 = stored_1;\n    if !((_e102 <= 0f)) {\n        let _e106 = unnamed.uDepthToWorld;\n        let _e107 = ndc;\n        let _e108 = stored_1;\n        hit = (_e106 * vec4<f32>(_e107.x, _e107.y, _e108, 1f));\n        let _e114 = hit[3u];\n        if (_e114 > 0.000001f) {\n            let _e116 = far;\n            let _e117 = hit;\n            let _e120 = hit[3u];\n            let _e124 = unnamed.uCameraPos;\n            let _e126 = dir;\n            far = min(_e116, dot(((_e117.xyz / vec3(_e120)) - _e124), _e126));\n        }\n    }\n    let _e129 = far;\n    if (_e129 <= 0f) {\n        fragColor = vec4<f32>(0f, 0f, 0f, 1f);\n        return;\n    }\n    let _e132 = unnamed.uSteps;\n    steps = clamp(_e132, 1i, 64i);\n    let _e134 = gl_FragCoord_1;\n    param_6 = _e134.xy;\n    let _e136 = hash21_u0028_vf2_u003b((&param_6));\n    dither = (_e136 - 0.5f);\n    let _e139 = unnamed.uAlbedo;\n    let _e140 = dir;\n    let _e142 = unnamed.uSunDir;\n    param_7 = dot(_e140, _e142);\n    let _e145 = unnamed.uAnisotropy;\n    param_8 = _e145;\n    let _e146 = phase_u0028_f1_u003b_f1_u003b((&param_7), (&param_8));\n    scatter = (_e139 * _e146);\n    let _e149 = unnamed.uSunColor;\n    let _e150 = scatter;\n    sunLit = (_e149 * _e150);\n    let _e153 = unnamed.uAmbient;\n    let _e155 = unnamed.uAlbedo;\n    skyLit = ((_e153 * _e155) * 0.07957747f);\n    inscatter = vec3<f32>(0f, 0f, 0f);\n    transmittance = 1f;\n    previous = 0f;\n    i = 0i;\n    loop {\n        let _e158 = i;\n        if (_e158 < 64i) {\n            let _e160 = i;\n            let _e161 = steps;\n            if (_e160 >= _e161) {\n                break;\n            }\n            let _e163 = i;\n            let _e166 = steps;\n            u = (f32((_e163 + 1i)) / f32(_e166));\n            let _e169 = far;\n            let _e170 = u;\n            next = (_e169 * pow(_e170, 2f));\n            let _e173 = next;\n            let _e174 = previous;\n            segment = (_e173 - _e174);\n            let _e176 = previous;\n            let _e177 = next;\n            travelled = (0.5f * (_e176 + _e177));\n            let _e180 = next;\n            previous = _e180;\n            let _e182 = unnamed.uDensity;\n            let _e184 = segment;\n            segmentTransmittance = exp((-(_e182) * _e184));\n            let _e187 = segmentTransmittance;\n            scattered = (1f - _e187);\n            lit = 1f;\n            let _e190 = unnamed.uSunShadow;\n            if (_e190 > 0f) {\n                let _e193 = unnamed.uCameraPos;\n                let _e194 = dir;\n                let _e195 = travelled;\n                let _e196 = dither;\n                let _e197 = segment;\n                param_9 = (_e193 + (_e194 * (_e195 + (_e196 * _e197))));\n                let _e202 = sunReach_u0028_vf3_u003b((&param_9));\n                lit = _e202;\n            }\n            let _e203 = transmittance;\n            let _e204 = scattered;\n            let _e206 = sunLit;\n            let _e207 = lit;\n            let _e209 = skyLit;\n            let _e212 = inscatter;\n            inscatter = (_e212 + (((_e206 * _e207) + _e209) * (_e203 * _e204)));\n            let _e214 = segmentTransmittance;\n            let _e215 = transmittance;\n            transmittance = (_e215 * _e214);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e217 = i;\n            i = (_e217 + 1i);\n        }\n    }\n    let _e219 = inscatter;\n    let _e220 = (_e219 * 12.566371f);\n    let _e221 = transmittance;\n    fragColor = vec4<f32>(_e220.x, _e220.y, _e220.z, _e221);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

export const MEDIUM_UPSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uMediumTexel: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uMedium_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uMedium_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn viewDistance_u0028_f1_u003b(stored: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e27 = (*stored);\n    ndc = (1f - (_e27 * 2f));\n    let _e32 = unnamed.uDepthToViewZ[0u];\n    let _e33 = ndc;\n    let _e37 = unnamed.uDepthToViewZ[1u];\n    let _e41 = unnamed.uDepthToViewZ[2u];\n    let _e42 = ndc;\n    let _e46 = unnamed.uDepthToViewZ[3u];\n    return abs((((_e32 * _e33) + _e37) / ((_e41 * _e42) + _e46)));\n}\n\nfn main_1() {\n    var here: f32;\n    var param: f32;\n    var coord: vec2<f32>;\n    var base: vec2<f32>;\n    var f: vec2<f32>;\n    var total: vec4<f32>;\n    var weight: f32;\n    var nearest: vec4<f32>;\n    var nearestGap: f32;\n    var i: i32;\n    var offset: vec2<f32>;\n    var uv: vec2<f32>;\n    var bilinear: f32;\n    var there: f32;\n    var param_1: f32;\n    var gap: f32;\n    var sampled: vec4<f32>;\n    var depthWeight: f32;\n    var local: vec4<f32>;\n\n    let _e44 = vUv_1;\n    let _e45 = textureSampleLevel(uDepth_t, uDepth_s, _e44, 0f);\n    param = _e45.x;\n    let _e47 = viewDistance_u0028_f1_u003b((&param));\n    here = _e47;\n    let _e48 = vUv_1;\n    let _e50 = unnamed.uMediumTexel;\n    coord = ((_e48 / _e50) - vec2(0.5f));\n    let _e54 = coord;\n    base = floor(_e54);\n    let _e56 = coord;\n    let _e57 = base;\n    f = (_e56 - _e57);\n    total = vec4<f32>(0f, 0f, 0f, 0f);\n    weight = 0f;\n    nearest = vec4<f32>(0f, 0f, 0f, 1f);\n    nearestGap = 1000000000000000000000000000000f;\n    i = 0i;\n    loop {\n        let _e59 = i;\n        if (_e59 < 4i) {\n            let _e61 = i;\n            let _e64 = i;\n            offset = vec2<f32>(f32((_e61 & 1i)), f32(((_e64 >> bitcast<u32>(1i)) & 1i)));\n            let _e70 = base;\n            let _e71 = offset;\n            let _e76 = unnamed.uMediumTexel;\n            uv = (((_e70 + _e71) + vec2(0.5f)) * _e76);\n            let _e79 = f[0u];\n            let _e82 = f[0u];\n            let _e84 = offset[0u];\n            let _e87 = f[1u];\n            let _e90 = f[1u];\n            let _e92 = offset[1u];\n            bilinear = (mix((1f - _e79), _e82, _e84) * mix((1f - _e87), _e90, _e92));\n            let _e95 = uv;\n            let _e96 = textureSampleLevel(uDepth_t, uDepth_s, _e95, 0f);\n            param_1 = _e96.x;\n            let _e98 = viewDistance_u0028_f1_u003b((&param_1));\n            there = _e98;\n            let _e99 = there;\n            let _e100 = here;\n            let _e103 = there;\n            let _e104 = here;\n            gap = (abs((_e99 - _e100)) / max(min(_e103, _e104), 0.001f));\n            let _e108 = uv;\n            let _e109 = textureSampleLevel(uMedium_t, uMedium_s, _e108, 0f);\n            sampled = _e109;\n            let _e110 = gap;\n            let _e111 = nearestGap;\n            if (_e110 < _e111) {\n                let _e113 = gap;\n                nearestGap = _e113;\n                let _e114 = sampled;\n                nearest = _e114;\n            }\n            let _e115 = gap;\n            depthWeight = (1f - smoothstep(0.04f, 0.05f, _e115));\n            let _e118 = sampled;\n            let _e119 = bilinear;\n            let _e121 = depthWeight;\n            let _e123 = total;\n            total = (_e123 + ((_e118 * _e119) * _e121));\n            let _e125 = bilinear;\n            let _e126 = depthWeight;\n            let _e128 = weight;\n            weight = (_e128 + (_e125 * _e126));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e130 = i;\n            i = (_e130 + 1i);\n        }\n    }\n    let _e132 = weight;\n    if (_e132 > 0.0001f) {\n        let _e134 = total;\n        let _e135 = weight;\n        local = (_e134 / vec4(_e135));\n    } else {\n        let _e138 = nearest;\n        local = _e138;\n    }\n    let _e139 = local;\n    fragColor = _e139;\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const GLOBALMEDIUM_BINDINGS = {
  "MEDIUM_FRAG": {
    "uniforms": 1,
    "uniformSize": 240,
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
      "uPeeledShadowEnabled": {
        "offset": 224,
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
      "uStaticShadowMap": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uPeeledShadowMap": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      },
      "uDynamicShadowMap": {
        "texture": 38,
        "sampler": 39,
        "type": "sampler2D"
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
