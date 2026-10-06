/*
 * Generated from ../ssrTrace.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SSR_TRACE_FRAG_WGSL = "struct Uniforms {\n    uSsrDepthToWorld: mat4x4<f32>,\n    uSsrViewProj: mat4x4<f32>,\n    uWorldToSurface: mat4x4<f32>,\n    uSsrEye: vec3<f32>,\n    uSsrAxis: vec3<f32>,\n    uSsrTint: vec3<f32>,\n    uSsrStrength: f32,\n    uSsrFresnel: vec2<f32>,\n    uSsrFacingCos: f32,\n    uSsrReach: f32,\n    uSsrThickness: f32,\n    uSsrSteps: f32,\n    uSsrEdgeFade: f32,\n    uSsrMaterial: f32,\n    uSsrMaxRoughness: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSsrDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSsrDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(38) \nvar uSsrTintMap_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uSsrTintMap_s: sampler;\n@group(0) @binding(36) \nvar uSsrProbeMap_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uSsrProbeMap_s: sampler;\n@group(0) @binding(34) \nvar uSsrScene_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uSsrScene_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn worldAt_u0028_vf2_u003b_f1_u003b(uv: ptr<function, vec2<f32>>, stored: ptr<function, f32>) -> vec3<f32> {\n    var world: vec4<f32>;\n\n    let _e60 = unnamed.uSsrDepthToWorld;\n    let _e61 = (*uv);\n    let _e64 = ((_e61 * 2f) - vec2(1f));\n    let _e65 = (*stored);\n    world = (_e60 * vec4<f32>(_e64.x, _e64.y, _e65, 1f));\n    let _e70 = world;\n    let _e73 = world[3u];\n    return (_e70.xyz / vec3(_e73));\n}\n\nfn sceneDistanceAt_u0028_vf2_u003b(uv_1: ptr<function, vec2<f32>>) -> f32 {\n    var stored_1: f32;\n    var param: vec2<f32>;\n    var param_1: f32;\n\n    let _e60 = (*uv_1);\n    let _e61 = textureSampleLevel(uSsrDepth_t, uSsrDepth_s, _e60, 0f);\n    stored_1 = _e61.x;\n    let _e63 = stored_1;\n    if (_e63 <= 0f) {\n        return 1000000000f;\n    }\n    let _e65 = (*uv_1);\n    param = _e65;\n    let _e66 = stored_1;\n    param_1 = _e66;\n    let _e67 = worldAt_u0028_vf2_u003b_f1_u003b((&param), (&param_1));\n    let _e69 = unnamed.uSsrEye;\n    return length((_e67 - _e69));\n}\n\nfn projectPoint_u0028_vf3_u003b_vf2_u003b(point: ptr<function, vec3<f32>>, uv_2: ptr<function, vec2<f32>>) -> bool {\n    var clip: vec4<f32>;\n    var phi_175_: bool;\n    var phi_181_: bool;\n    var phi_187_: bool;\n\n    let _e60 = unnamed.uSsrViewProj;\n    let _e61 = (*point);\n    clip = (_e60 * vec4<f32>(_e61.x, _e61.y, _e61.z, 1f));\n    let _e68 = clip[3u];\n    if (_e68 <= 0f) {\n        return false;\n    }\n    let _e70 = clip;\n    let _e73 = clip[3u];\n    (*uv_2) = (((_e70.xy / vec2(_e73)) * 0.5f) + vec2(0.5f));\n    let _e80 = (*uv_2)[0u];\n    let _e81 = (_e80 >= 0f);\n    phi_175_ = _e81;\n    if _e81 {\n        let _e83 = (*uv_2)[0u];\n        phi_175_ = (_e83 <= 1f);\n    }\n    let _e86 = phi_175_;\n    phi_181_ = _e86;\n    if _e86 {\n        let _e88 = (*uv_2)[1u];\n        phi_181_ = (_e88 >= 0f);\n    }\n    let _e91 = phi_181_;\n    phi_187_ = _e91;\n    if _e91 {\n        let _e93 = (*uv_2)[1u];\n        phi_187_ = (_e93 <= 1f);\n    }\n    let _e96 = phi_187_;\n    return _e96;\n}\n\nfn envBrdfApprox_u0028_f1_u003b_f1_u003b(ndv: ptr<function, f32>, roughness: ptr<function, f32>) -> vec2<f32> {\n    var r: vec4<f32>;\n    var a004_: f32;\n\n    let _e60 = (*roughness);\n    r = ((vec4<f32>(-1f, -0.0275f, -0.572f, 0.022f) * _e60) + vec4<f32>(1f, 0.0425f, 1.04f, -0.04f));\n    let _e64 = r[0u];\n    let _e66 = r[0u];\n    let _e68 = (*ndv);\n    let _e73 = r[0u];\n    let _e76 = r[1u];\n    a004_ = ((min((_e64 * _e66), exp2((-9.28f * _e68))) * _e73) + _e76);\n    let _e78 = a004_;\n    let _e80 = r;\n    return ((vec2<f32>(-1.04f, 1.04f) * _e78) + _e80.zw);\n}\n\nfn main_1() {\n    var stored_2: f32;\n    var point_1: vec3<f32>;\n    var param_2: vec2<f32>;\n    var param_3: f32;\n    var plane: vec3<f32>;\n    var span: f32;\n    var normal: vec3<f32>;\n    var local: vec3<f32>;\n    var toEye: vec3<f32>;\n    var box: vec3<f32>;\n    var inside: vec3<f32>;\n    var mask: f32;\n    var facing: f32;\n    var returned: f32;\n    var dfg: vec2<f32>;\n    var param_4: f32;\n    var param_5: f32;\n    var tint: vec3<f32>;\n    var roughness_1: f32;\n    var reflective: f32;\n    var ceiling: f32;\n    var found: vec3<f32>;\n    var weight: f32;\n    var view: vec3<f32>;\n    var ray: vec3<f32>;\n    var steps: f32;\n    var behind: f32;\n    var previous: f32;\n    var hitUv: vec2<f32>;\n    var hitDistance: f32;\n    var found_hit: bool;\n    var i: i32;\n    var at: f32;\n    var t: f32;\n    var sample_point: vec3<f32>;\n    var uv_3: vec2<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec2<f32>;\n    var scene: f32;\n    var param_8: vec2<f32>;\n    var gap: f32;\n    var near: f32;\n    var far: f32;\n    var refinedUv: vec2<f32>;\n    var refinedGap: f32;\n    var refine: i32;\n    var mid: f32;\n    var midPoint: vec3<f32>;\n    var midUv: vec2<f32>;\n    var param_9: vec3<f32>;\n    var param_10: vec2<f32>;\n    var midScene: f32;\n    var param_11: vec2<f32>;\n    var midGap: f32;\n    var edge: f32;\n    var away: f32;\n    var reach: f32;\n\n    let _e113 = vUv_1;\n    let _e114 = textureSampleLevel(uSsrDepth_t, uSsrDepth_s, _e113, 0f);\n    stored_2 = _e114.x;\n    let _e116 = vUv_1;\n    param_2 = _e116;\n    let _e117 = stored_2;\n    param_3 = _e117;\n    let _e118 = worldAt_u0028_vf2_u003b_f1_u003b((&param_2), (&param_3));\n    point_1 = _e118;\n    let _e119 = point_1;\n    let _e120 = dpdx(_e119);\n    let _e121 = point_1;\n    let _e122 = dpdy(_e121);\n    plane = cross(_e120, _e122);\n    let _e124 = plane;\n    span = length(_e124);\n    let _e126 = span;\n    if (_e126 > 0f) {\n        let _e128 = plane;\n        let _e129 = span;\n        local = (_e128 / vec3(_e129));\n    } else {\n        let _e133 = unnamed.uSsrAxis;\n        local = -(_e133);\n    }\n    let _e135 = local;\n    normal = _e135;\n    let _e137 = unnamed.uSsrEye;\n    let _e138 = point_1;\n    toEye = (_e137 - _e138);\n    let _e140 = toEye;\n    let _e141 = normal;\n    let _e144 = normal;\n    normal = (_e144 * sign(dot(_e140, _e141)));\n    let _e147 = unnamed.uWorldToSurface;\n    let _e148 = point_1;\n    box = (_e147 * vec4<f32>(_e148.x, _e148.y, _e148.z, 1f)).xyz;\n    let _e155 = box;\n    inside = step(abs(_e155), vec3<f32>(1f, 1f, 1f));\n    let _e159 = inside[0u];\n    let _e161 = inside[1u];\n    let _e164 = inside[2u];\n    mask = ((_e159 * _e161) * _e164);\n    let _e166 = normal;\n    let _e168 = unnamed.uSsrAxis;\n    facing = dot(_e166, -(_e168));\n    let _e172 = unnamed.uSsrFacingCos;\n    let _e174 = unnamed.uSsrFacingCos;\n    let _e177 = facing;\n    let _e179 = mask;\n    mask = (_e179 * smoothstep(_e172, min(1f, (_e174 + 0.25f)), _e177));\n    let _e181 = stored_2;\n    let _e184 = mask;\n    mask = (_e184 * select(1f, 0f, (_e181 <= 0f)));\n    let _e187 = unnamed.uSsrStrength;\n    returned = _e187;\n    let _e190 = unnamed.uSsrFresnel[0u];\n    if (_e190 > 0.5f) {\n        let _e192 = normal;\n        let _e193 = toEye;\n        param_4 = clamp(dot(_e192, normalize(_e193)), 0f, 1f);\n        let _e199 = unnamed.uSsrFresnel[1u];\n        param_5 = _e199;\n        let _e200 = envBrdfApprox_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        dfg = _e200;\n        let _e202 = unnamed.uSsrStrength;\n        let _e204 = dfg[0u];\n        let _e207 = dfg[1u];\n        returned = clamp(((_e202 * _e204) + _e207), 0f, 1f);\n    }\n    let _e210 = returned;\n    let _e211 = mask;\n    mask = (_e211 * _e210);\n    let _e214 = unnamed.uSsrMaterial;\n    if (_e214 > 0.5f) {\n        let _e216 = vUv_1;\n        let _e217 = textureSampleLevel(uSsrTintMap_t, uSsrTintMap_s, _e216, 0f);\n        tint = _e217.xyz;\n        let _e219 = vUv_1;\n        let _e220 = textureSampleLevel(uSsrProbeMap_t, uSsrProbeMap_s, _e219, 0f);\n        roughness_1 = _e220.w;\n        let _e223 = tint[0u];\n        let _e225 = tint[1u];\n        let _e228 = tint[2u];\n        reflective = select(0f, 1f, (max(max(_e223, _e225), _e228) > 0f));\n        let _e233 = unnamed.uSsrMaxRoughness;\n        ceiling = max(_e233, 0.0001f);\n        let _e235 = reflective;\n        let _e236 = ceiling;\n        let _e238 = ceiling;\n        let _e239 = roughness_1;\n        mask = (_e235 * (1f - smoothstep((_e236 * 0.75f), _e238, _e239)));\n        let _e243 = stored_2;\n        let _e246 = mask;\n        mask = (_e246 * select(1f, 0f, (_e243 <= 0f)));\n    }\n    found = vec3<f32>(0f, 0f, 0f);\n    weight = 0f;\n    let _e248 = mask;\n    if (_e248 > 0f) {\n        let _e250 = point_1;\n        let _e252 = unnamed.uSsrEye;\n        view = normalize((_e250 - _e252));\n        let _e255 = view;\n        let _e256 = normal;\n        ray = reflect(_e255, _e256);\n        let _e259 = unnamed.uSsrSteps;\n        steps = max(1f, _e259);\n        behind = 0f;\n        previous = 0f;\n        hitUv = vec2<f32>(0f, 0f);\n        hitDistance = 0f;\n        found_hit = false;\n        i = 1i;\n        loop {\n            let _e261 = i;\n            if (_e261 <= 32i) {\n                let _e263 = i;\n                let _e265 = steps;\n                if (f32(_e263) > _e265) {\n                    break;\n                }\n                let _e267 = i;\n                let _e269 = steps;\n                at = (f32(_e267) / _e269);\n                let _e272 = unnamed.uSsrReach;\n                let _e273 = at;\n                let _e275 = at;\n                t = ((_e272 * _e273) * _e275);\n                let _e277 = point_1;\n                let _e278 = ray;\n                let _e279 = t;\n                sample_point = (_e277 + (_e278 * _e279));\n                let _e282 = sample_point;\n                param_6 = _e282;\n                let _e283 = projectPoint_u0028_vf3_u003b_vf2_u003b((&param_6), (&param_7));\n                let _e284 = param_7;\n                uv_3 = _e284;\n                if !(_e283) {\n                    break;\n                }\n                let _e286 = uv_3;\n                param_8 = _e286;\n                let _e287 = sceneDistanceAt_u0028_vf2_u003b((&param_8));\n                scene = _e287;\n                let _e288 = sample_point;\n                let _e290 = unnamed.uSsrEye;\n                let _e293 = scene;\n                gap = (length((_e288 - _e290)) - _e293);\n                let _e295 = behind;\n                let _e297 = gap;\n                if ((_e295 < 0f) && (_e297 >= 0f)) {\n                    let _e300 = previous;\n                    near = _e300;\n                    let _e301 = t;\n                    far = _e301;\n                    let _e302 = uv_3;\n                    refinedUv = _e302;\n                    let _e303 = gap;\n                    refinedGap = _e303;\n                    refine = 0i;\n                    loop {\n                        let _e304 = refine;\n                        if (_e304 < 6i) {\n                            let _e306 = near;\n                            let _e307 = far;\n                            mid = ((_e306 + _e307) * 0.5f);\n                            let _e310 = point_1;\n                            let _e311 = ray;\n                            let _e312 = mid;\n                            midPoint = (_e310 + (_e311 * _e312));\n                            let _e315 = midPoint;\n                            param_9 = _e315;\n                            let _e316 = projectPoint_u0028_vf3_u003b_vf2_u003b((&param_9), (&param_10));\n                            let _e317 = param_10;\n                            midUv = _e317;\n                            if !(_e316) {\n                                break;\n                            }\n                            let _e319 = midUv;\n                            param_11 = _e319;\n                            let _e320 = sceneDistanceAt_u0028_vf2_u003b((&param_11));\n                            midScene = _e320;\n                            let _e321 = midPoint;\n                            let _e323 = unnamed.uSsrEye;\n                            let _e326 = midScene;\n                            midGap = (length((_e321 - _e323)) - _e326);\n                            let _e328 = midGap;\n                            if (_e328 >= 0f) {\n                                let _e330 = mid;\n                                far = _e330;\n                                let _e331 = midUv;\n                                refinedUv = _e331;\n                                let _e332 = midGap;\n                                refinedGap = _e332;\n                            } else {\n                                let _e333 = mid;\n                                near = _e333;\n                            }\n                            continue;\n                        } else {\n                            break;\n                        }\n                        continuing {\n                            let _e334 = refine;\n                            refine = (_e334 + 1i);\n                        }\n                    }\n                    let _e336 = refinedGap;\n                    let _e338 = unnamed.uSsrThickness;\n                    if (_e336 <= _e338) {\n                        found_hit = true;\n                        let _e340 = refinedUv;\n                        hitUv = _e340;\n                        let _e341 = far;\n                        hitDistance = _e341;\n                    }\n                    break;\n                }\n                let _e342 = gap;\n                behind = _e342;\n                let _e343 = t;\n                previous = _e343;\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e344 = i;\n                i = (_e344 + 1i);\n            }\n        }\n        let _e346 = found_hit;\n        if _e346 {\n            let _e348 = hitUv[0u];\n            let _e350 = hitUv[0u];\n            let _e354 = hitUv[1u];\n            let _e356 = hitUv[1u];\n            let _e361 = unnamed.uSsrEdgeFade;\n            edge = clamp((min(min(_e348, (1f - _e350)), min(_e354, (1f - _e356))) / max(_e361, 0.0001f)), 0f, 1f);\n            let _e365 = ray;\n            let _e367 = view;\n            away = clamp(((dot(normalize(_e365), _e367) + 1f) * 0.5f), 0f, 1f);\n            let _e372 = hitDistance;\n            let _e374 = unnamed.uSsrReach;\n            reach = (1f - clamp((_e372 / max(_e374, 0.0001f)), 0f, 1f));\n            let _e379 = mask;\n            let _e380 = edge;\n            let _e382 = away;\n            let _e384 = reach;\n            weight = (((_e379 * _e380) * _e382) * _e384);\n            let _e386 = hitUv;\n            let _e387 = textureSampleLevel(uSsrScene_t, uSsrScene_s, _e386, 0f);\n            let _e390 = unnamed.uSsrTint;\n            found = (_e387.xyz * _e390);\n        }\n    }\n    let _e392 = found;\n    let _e393 = weight;\n    let _e394 = (_e392 * _e393);\n    let _e395 = weight;\n    fragColor = vec4<f32>(_e394.x, _e394.y, _e394.z, _e395);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SSRTRACE_BINDINGS = {
  "SSR_TRACE_FRAG": {
    "uniforms": 1,
    "uniformSize": 288,
    "fields": {
      "uSsrDepthToWorld": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uSsrViewProj": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uWorldToSurface": {
        "offset": 128,
        "size": 64,
        "type": "mat4"
      },
      "uSsrEye": {
        "offset": 192,
        "size": 12,
        "type": "vec3"
      },
      "uSsrAxis": {
        "offset": 208,
        "size": 12,
        "type": "vec3"
      },
      "uSsrTint": {
        "offset": 224,
        "size": 12,
        "type": "vec3"
      },
      "uSsrStrength": {
        "offset": 236,
        "size": 4,
        "type": "float"
      },
      "uSsrFresnel": {
        "offset": 240,
        "size": 8,
        "type": "vec2"
      },
      "uSsrFacingCos": {
        "offset": 248,
        "size": 4,
        "type": "float"
      },
      "uSsrReach": {
        "offset": 252,
        "size": 4,
        "type": "float"
      },
      "uSsrThickness": {
        "offset": 256,
        "size": 4,
        "type": "float"
      },
      "uSsrSteps": {
        "offset": 260,
        "size": 4,
        "type": "float"
      },
      "uSsrEdgeFade": {
        "offset": 264,
        "size": 4,
        "type": "float"
      },
      "uSsrMaterial": {
        "offset": 268,
        "size": 4,
        "type": "float"
      },
      "uSsrMaxRoughness": {
        "offset": 272,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSsrDepth": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uSsrScene": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uSsrProbeMap": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      },
      "uSsrTintMap": {
        "texture": 38,
        "sampler": 39,
        "type": "sampler2D"
      }
    }
  }
} as const;
