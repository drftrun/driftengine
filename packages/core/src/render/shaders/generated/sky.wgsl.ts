/*
 * Generated from ../sky.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SKY_FRAG_WGSL = "struct Uniforms {\n    uInvViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTopColor: vec3<f32>,\n    uHorizonColor: vec3<f32>,\n    uDeepColor: vec3<f32>,\n    uSunDir: vec3<f32>,\n    uSunColor: vec3<f32>,\n    uSunDiscExponent: f32,\n    uMoonDir: vec3<f32>,\n    uMoonColor: vec3<f32>,\n    uMoonAngularRadius: f32,\n    uMoonPhase: f32,\n    uNightFactor: f32,\n    uCloudOffset: vec2<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNdc_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e105 = (*p);\n    return fract((sin(dot(_e105, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var a: f32;\n    var param: vec2<f32>;\n    var b: f32;\n    var param_1: vec2<f32>;\n    var c: f32;\n    var param_2: vec2<f32>;\n    var d: f32;\n    var param_3: vec2<f32>;\n\n    let _e116 = (*p_1);\n    i = floor(_e116);\n    let _e118 = (*p_1);\n    f = fract(_e118);\n    let _e120 = f;\n    let _e121 = f;\n    let _e123 = f;\n    u = ((_e120 * _e121) * (vec2(3f) - (_e123 * 2f)));\n    let _e128 = i;\n    param = _e128;\n    let _e129 = hash21_u0028_vf2_u003b((&param));\n    a = _e129;\n    let _e130 = i;\n    param_1 = (_e130 + vec2<f32>(1f, 0f));\n    let _e132 = hash21_u0028_vf2_u003b((&param_1));\n    b = _e132;\n    let _e133 = i;\n    param_2 = (_e133 + vec2<f32>(0f, 1f));\n    let _e135 = hash21_u0028_vf2_u003b((&param_2));\n    c = _e135;\n    let _e136 = i;\n    param_3 = (_e136 + vec2<f32>(1f, 1f));\n    let _e138 = hash21_u0028_vf2_u003b((&param_3));\n    d = _e138;\n    let _e139 = a;\n    let _e140 = b;\n    let _e142 = u[0u];\n    let _e144 = c;\n    let _e145 = d;\n    let _e147 = u[0u];\n    let _e150 = u[1u];\n    return mix(mix(_e139, _e140, _e142), mix(_e144, _e145, _e147), _e150);\n}\n\nfn fbm_u0028_vf2_u003b(p_2: ptr<function, vec2<f32>>) -> f32 {\n    var v: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n\n    let _e109 = (*p_2);\n    param_4 = _e109;\n    let _e110 = valueNoise_u0028_vf2_u003b((&param_4));\n    v = (_e110 * 0.5f);\n    let _e112 = (*p_2);\n    param_5 = (_e112 * 2.03f);\n    let _e114 = valueNoise_u0028_vf2_u003b((&param_5));\n    let _e116 = v;\n    v = (_e116 + (_e114 * 0.3f));\n    let _e118 = (*p_2);\n    param_6 = (_e118 * 4.01f);\n    let _e120 = valueNoise_u0028_vf2_u003b((&param_6));\n    let _e122 = v;\n    v = (_e122 + (_e120 * 0.2f));\n    let _e124 = v;\n    return _e124;\n}\n\nfn main_1() {\n    var world: vec4<f32>;\n    var dir: vec3<f32>;\n    var t: f32;\n    var col: vec3<f32>;\n    var local: vec3<f32>;\n    var aboveHorizon: f32;\n    var sunset: f32;\n    var ember: vec3<f32>;\n    var s: f32;\n    var discColor: vec3<f32>;\n    var sunBearing: vec2<f32>;\n    var viewBearing: vec2<f32>;\n    var toward: f32;\n    var fromHorizon: f32;\n    var local_1: f32;\n    var band: f32;\n    var away: f32;\n    var moonReference: vec3<f32>;\n    var moonRight: vec3<f32>;\n    var moonUp: vec3<f32>;\n    var moonRadius: f32;\n    var moonUv: vec2<f32>;\n    var moonRadiusSq: f32;\n    var moonFacing: f32;\n    var moonDisc: f32;\n    var sphereZ: f32;\n    var surfaceNormal: vec3<f32>;\n    var phaseAngle: f32;\n    var phaseLight: vec3<f32>;\n    var phaseShade: f32;\n    var maria: f32;\n    var param_7: vec2<f32>;\n    var param_8: vec2<f32>;\n    var albedo: f32;\n    var limb: f32;\n    var earthshine: f32;\n    var lunarLight: f32;\n    var phaseIllumination: f32;\n    var moonHalo: f32;\n    var p_3: vec2<f32>;\n    var cell: vec2<f32>;\n    var h: f32;\n    var param_9: vec2<f32>;\n    var jitter: vec2<f32>;\n    var param_10: vec2<f32>;\n    var param_11: vec2<f32>;\n    var d_1: f32;\n    var star: f32;\n    var uv: vec2<f32>;\n    var band_1: f32;\n    var param_12: vec2<f32>;\n    var fade: f32;\n    var cloudCol: vec3<f32>;\n    var waterLight: f32;\n\n    let _e159 = unnamed.uInvViewProj;\n    let _e160 = vNdc_1;\n    world = (_e159 * vec4<f32>(_e160.x, _e160.y, 1f, 1f));\n    let _e165 = world;\n    let _e168 = world[3u];\n    let _e172 = unnamed.uCameraPos;\n    dir = normalize(((_e165.xyz / vec3(_e168)) - _e172));\n    let _e176 = dir[1u];\n    t = _e176;\n    let _e177 = t;\n    if (_e177 >= 0f) {\n        let _e180 = unnamed.uHorizonColor;\n        let _e182 = unnamed.uTopColor;\n        let _e183 = t;\n        local = mix(_e180, _e182, vec3(pow(min(_e183, 1f), 0.55f)));\n    } else {\n        let _e189 = unnamed.uHorizonColor;\n        let _e191 = unnamed.uDeepColor;\n        let _e192 = t;\n        local = mix(_e189, _e191, vec3(min((-(_e192) * 1.8f), 1f)));\n    }\n    let _e198 = local;\n    col = _e198;\n    let _e200 = dir[1u];\n    aboveHorizon = smoothstep(-0.04f, 0.06f, _e200);\n    let _e204 = unnamed.uSunDir[1u];\n    let _e209 = unnamed.uSunDir[1u];\n    sunset = ((1f - smoothstep(-0.03f, 0.3f, _e204)) * smoothstep(-0.35f, -0.05f, _e209));\n    ember = vec3<f32>(1f, 0.36f, 0.13f);\n    let _e212 = dir;\n    let _e214 = unnamed.uSunDir;\n    s = max(dot(_e212, _e214), 0f);\n    let _e218 = unnamed.uSunColor;\n    let _e220 = unnamed.uSunColor;\n    let _e221 = ember;\n    let _e223 = sunset;\n    discColor = mix(_e218, (_e220 * _e221), vec3((_e223 * 0.85f)));\n    let _e227 = discColor;\n    let _e228 = s;\n    let _e230 = unnamed.uSunDiscExponent;\n    let _e233 = s;\n    let _e235 = unnamed.uSunDiscExponent;\n    let _e242 = aboveHorizon;\n    let _e244 = col;\n    col = (_e244 + ((_e227 * ((pow(_e228, _e230) * 1.2f) + (pow(_e233, max((_e235 / 75f), 1f)) * 0.12f))) * _e242));\n    let _e247 = unnamed.uSunDir;\n    sunBearing = normalize((_e247.xz + vec2<f32>(0.00001f, 0.00001f)));\n    let _e251 = dir;\n    viewBearing = normalize((_e251.xz + vec2<f32>(0.00001f, 0.00001f)));\n    let _e255 = viewBearing;\n    let _e256 = sunBearing;\n    toward = max(dot(_e255, _e256), 0f);\n    let _e260 = dir[1u];\n    if (_e260 >= 0f) {\n        let _e263 = dir[1u];\n        local_1 = _e263;\n    } else {\n        let _e265 = dir[1u];\n        local_1 = (-(_e265) * 3f);\n    }\n    let _e268 = local_1;\n    fromHorizon = _e268;\n    let _e269 = fromHorizon;\n    band = pow((1f - min((_e269 * 2.2f), 1f)), 2.6f);\n    let _e274 = ember;\n    let _e275 = sunset;\n    let _e277 = band;\n    let _e279 = toward;\n    let _e284 = col;\n    col = (_e284 + (((_e274 * _e275) * _e277) * (0.18f + (0.75f * pow(_e279, 2.2f)))));\n    let _e286 = viewBearing;\n    let _e287 = sunBearing;\n    away = max(-(dot(_e286, _e287)), 0f);\n    let _e291 = sunset;\n    let _e293 = band;\n    let _e295 = away;\n    let _e298 = col;\n    col = (_e298 + ((((vec3<f32>(0.42f, 0.28f, 0.45f) * _e291) * _e293) * _e295) * 0.22f));\n    let _e302 = unnamed.uMoonDir[1u];\n    moonReference = select(vec3<f32>(1f, 0f, 0f), vec3<f32>(0f, 1f, 0f), vec3((abs(_e302) < 0.98f)));\n    let _e307 = moonReference;\n    let _e309 = unnamed.uMoonDir;\n    moonRight = normalize(cross(_e307, _e309));\n    let _e313 = unnamed.uMoonDir;\n    let _e314 = moonRight;\n    moonUp = cross(_e313, _e314);\n    let _e317 = unnamed.uMoonAngularRadius;\n    moonRadius = clamp(_e317, 0.001f, 0.5f);\n    let _e319 = dir;\n    let _e320 = moonRight;\n    let _e322 = dir;\n    let _e323 = moonUp;\n    let _e326 = moonRadius;\n    moonUv = (vec2<f32>(dot(_e319, _e320), dot(_e322, _e323)) / vec2(_e326));\n    let _e329 = moonUv;\n    let _e330 = moonUv;\n    moonRadiusSq = dot(_e329, _e330);\n    let _e332 = dir;\n    let _e334 = unnamed.uMoonDir;\n    moonFacing = step(0f, dot(_e332, _e334));\n    let _e337 = moonRadiusSq;\n    let _e340 = moonFacing;\n    moonDisc = ((1f - smoothstep(0.9f, 1f, _e337)) * _e340);\n    let _e342 = moonDisc;\n    if (_e342 > 0f) {\n        let _e344 = moonRadiusSq;\n        sphereZ = sqrt(max((1f - _e344), 0f));\n        let _e348 = moonUv;\n        let _e349 = sphereZ;\n        surfaceNormal = normalize(vec3<f32>(_e348.x, _e348.y, _e349));\n        let _e355 = unnamed.uMoonPhase;\n        phaseAngle = (_e355 * 6.2831855f);\n        let _e357 = phaseAngle;\n        let _e359 = phaseAngle;\n        phaseLight = vec3<f32>(sin(_e357), 0f, -(cos(_e359)));\n        let _e363 = surfaceNormal;\n        let _e364 = phaseLight;\n        phaseShade = max(dot(_e363, _e364), 0f);\n        let _e367 = moonUv;\n        param_7 = ((_e367 * 3.2f) + vec2<f32>(4.7f, 9.1f));\n        let _e370 = valueNoise_u0028_vf2_u003b((&param_7));\n        let _e372 = moonUv;\n        param_8 = ((_e372 * 9.3f) - vec2<f32>(7.4f, 2.6f));\n        let _e375 = valueNoise_u0028_vf2_u003b((&param_8));\n        maria = ((_e370 * 0.68f) + (_e375 * 0.32f));\n        let _e378 = maria;\n        albedo = mix(0.56f, 1.02f, _e378);\n        let _e380 = sphereZ;\n        limb = mix(0.72f, 1f, _e380);\n        earthshine = 0.035f;\n        let _e382 = earthshine;\n        let _e383 = earthshine;\n        let _e385 = phaseShade;\n        lunarLight = (_e382 + ((1f - _e383) * _e385));\n        let _e389 = unnamed.uMoonColor;\n        let _e390 = albedo;\n        let _e392 = limb;\n        let _e394 = lunarLight;\n        let _e396 = moonDisc;\n        let _e400 = unnamed.uNightFactor;\n        let _e402 = aboveHorizon;\n        let _e404 = col;\n        col = (_e404 + (((((((_e389 * _e390) * _e392) * _e394) * _e396) * 1.35f) * _e400) * _e402));\n    }\n    let _e407 = unnamed.uMoonPhase;\n    phaseIllumination = (0.5f - (cos((_e407 * 6.2831855f)) * 0.5f));\n    let _e412 = moonUv;\n    let _e416 = moonFacing;\n    moonHalo = ((1f - smoothstep(1f, 3f, length(_e412))) * _e416);\n    let _e419 = unnamed.uMoonColor;\n    let _e420 = moonHalo;\n    let _e423 = phaseIllumination;\n    let _e426 = unnamed.uNightFactor;\n    let _e428 = aboveHorizon;\n    let _e430 = col;\n    col = (_e430 + (((((_e419 * _e420) * 0.08f) * _e423) * _e426) * _e428));\n    let _e433 = dir[1u];\n    if (_e433 > 0f) {\n        let _e436 = unnamed.uNightFactor;\n        if (_e436 > 0f) {\n            let _e438 = dir;\n            let _e441 = dir[1u];\n            p_3 = ((_e438.xz / vec2((1f + _e441))) * 26f);\n            let _e446 = p_3;\n            cell = floor(_e446);\n            let _e448 = cell;\n            param_9 = _e448;\n            let _e449 = hash21_u0028_vf2_u003b((&param_9));\n            h = _e449;\n            let _e450 = h;\n            if (_e450 > 0.93f) {\n                let _e452 = cell;\n                param_10 = (_e452 + vec2(17.3f));\n                let _e455 = hash21_u0028_vf2_u003b((&param_10));\n                let _e456 = cell;\n                param_11 = (_e456 + vec2(41.7f));\n                let _e459 = hash21_u0028_vf2_u003b((&param_11));\n                jitter = vec2<f32>(_e455, _e459);\n                let _e461 = p_3;\n                let _e463 = jitter;\n                d_1 = length((fract(_e461) - _e463));\n                let _e466 = d_1;\n                let _e468 = h;\n                star = (smoothstep(0.1f, 0f, _e466) * (0.4f + (_e468 * 0.6f)));\n                let _e472 = star;\n                let _e475 = unnamed.uNightFactor;\n                let _e478 = dir[1u];\n                let _e481 = col;\n                col = (_e481 + (((vec3<f32>(0.86f, 0.91f, 1f) * _e472) * _e475) * smoothstep(0.03f, 0.3f, _e478)));\n            }\n        }\n        let _e484 = dir[1u];\n        if (_e484 > 0.02f) {\n            let _e486 = dir;\n            let _e489 = dir[1u];\n            let _e495 = unnamed.uCloudOffset;\n            uv = (((_e486.xz / vec2(max(_e489, 0.16f))) * 0.09f) + (_e495 * 0.012f));\n            let _e498 = uv;\n            param_12 = _e498;\n            let _e499 = fbm_u0028_vf2_u003b((&param_12));\n            band_1 = smoothstep(0.46f, 0.6f, _e499);\n            let _e502 = dir[1u];\n            fade = smoothstep(0.02f, 0.3f, _e502);\n            let _e505 = unnamed.uHorizonColor;\n            let _e509 = unnamed.uNightFactor;\n            cloudCol = (mix(_e505, vec3<f32>(1f, 1f, 1f), vec3(0.45f)) * mix(1f, 0.32f, _e509));\n            let _e512 = col;\n            let _e513 = cloudCol;\n            let _e514 = band_1;\n            let _e515 = fade;\n            col = mix(_e512, _e513, vec3(((_e514 * _e515) * 0.8f)));\n        }\n    }\n    let _e521 = dir[1u];\n    waterLight = mix(0.62f, 1.08f, clamp(((_e521 * 0.5f) + 0.5f), 0f, 1f));\n    let _e526 = col;\n    let _e528 = unnamed.uUnderwaterColor;\n    let _e529 = waterLight;\n    let _e532 = unnamed.uUnderwaterFactor;\n    col = mix(_e526, (_e528 * _e529), vec3(_e532));\n    let _e535 = col;\n    outColor = vec4<f32>(_e535.x, _e535.y, _e535.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vNdc: vec2<f32>) -> @location(0) vec4<f32> {\n    vNdc_1 = vNdc;\n    main_1();\n    let _e3 = outColor;\n    return _e3;\n}\n";

export const SKY_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vNdc: vec2<f32>;\nvar<private> gl_VertexIndex_1: i32;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var indexable: array<vec2<f32>, 3>;\n\n    let _e14 = gl_VertexIndex_1;\n    indexable = array<vec2<f32>, 3>(vec2<f32>(-1f, -1f), vec2<f32>(3f, -1f), vec2<f32>(-1f, 3f));\n    let _e16 = indexable[_e14];\n    vNdc = _e16;\n    let _e17 = vNdc;\n    unnamed.gl_Position = vec4<f32>(_e17.x, _e17.y, 0f, 1f);\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32) -> VertexOutput {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    main_1();\n    let _e7 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e7);\n    let _e9 = vNdc;\n    let _e10 = unnamed.gl_Position;\n    return VertexOutput(_e9, _e10);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SKY_BINDINGS = {
  "SKY_FRAG": {
    "uniforms": 1,
    "uniformSize": 224,
    "fields": {
      "uInvViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uTopColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uHorizonColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uDeepColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uSunDir": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      },
      "uSunColor": {
        "offset": 144,
        "size": 12,
        "type": "vec3"
      },
      "uSunDiscExponent": {
        "offset": 156,
        "size": 4,
        "type": "float"
      },
      "uMoonDir": {
        "offset": 160,
        "size": 12,
        "type": "vec3"
      },
      "uMoonColor": {
        "offset": 176,
        "size": 12,
        "type": "vec3"
      },
      "uMoonAngularRadius": {
        "offset": 188,
        "size": 4,
        "type": "float"
      },
      "uMoonPhase": {
        "offset": 192,
        "size": 4,
        "type": "float"
      },
      "uNightFactor": {
        "offset": 196,
        "size": 4,
        "type": "float"
      },
      "uCloudOffset": {
        "offset": 200,
        "size": 8,
        "type": "vec2"
      },
      "uUnderwaterColor": {
        "offset": 208,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 220,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "SKY_VERT": {
    "uniforms": null,
    "textures": {}
  }
} as const;
