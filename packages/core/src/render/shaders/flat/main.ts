/** The fragment entry point, which assembles everything above into a colour. */

export const MAIN_GLSL = `void main() {
  if (uClipEnabled != 0 && dot(vec4(vWorldPos, 1.0), uClipPlane) < 0.0) discard;

  /*
   * Surface colour and its coverage, resolved before anything else — including before it is
   * decided whether lighting runs at all. A thrown-away fragment should not pay for shading
   * it will never contribute to, whichever of the two paths below ends up running, and the
   * cutout is what a decal's edge needs regardless.
   *
   * An implicit-derivative texture() call rather than textureLod, and that is the
   * documented exception the 2026-08-07 rule asks for rather than a lapse: the branch
   * tests a *uniform*, so a compiler can prove it uniform and skip it wholesale, which
   * is precisely what the point-light loop's per-iteration index test could not offer.
   * The derivative is also the point here — this texture is mipmapped, and a tiled
   * floor at a grazing angle without mip selection aliases and crawls.
   *
   * Sampled once into a local instead of at each use, so the untextured majority pays a
   * single uniform test and the textured case pays a single fetch.
   */
  vec3 albedo = vColor;
  /*
   * How much of this fragment the surface actually covers.
   *
   * One for anything untextured, and the texture's own alpha for the rest. It reaches the
   * output only where a draw is translucent — an opaque draw has blending off and the
   * blend stage ignores alpha entirely — so this costs the opaque world nothing, and it
   * is what lets a *decal* work: a stain, a poster, a sticker, whose image is transparent
   * around the mark and partly transparent within it.
   *
   * Without it the cutout was the only thing a texture's alpha could say, so a translucent
   * draw carrying a cutout texture painted its whole quad at the draw's opacity — a
   * rectangle of haze with a picture in it, rather than a picture.
   */
  float coverage = 1.0;
  if (uAlbedoEnabled != 0) {
    vec4 texel = texture(uAlbedo, vUv);
    // Discarded before anything else is computed: a thrown-away fragment should not pay
    // for the lighting it will never contribute to.
    if (texel.a < uAlbedoCutout) discard;
    albedo *= texel.rgb;
    coverage = texel.a;
  }

  /*
   * Occlusion, roughness and metallic, resolved out here rather than inside the lighting branch.
   *
   * Occlusion applies to an unlit draw as much as to a lit one — uLightingEnabled at 0 is
   * three.js's meshBasicMaterial and a baked crevice is still a crevice — so the three values have
   * to exist on both sides of that branch.
   *
   * texture rather than textureLod, under a branch on a *uniform*, exactly as uAlbedo above: the
   * compiler can prove this branch uniform and skip it wholesale, and the derivative is the point,
   * because this image is mipmapped and a tiled floor at a grazing angle without mip selection
   * aliases and crawls. See AGENTS.md, 2026-08-07, for the case where a branch is not uniform and
   * this would be illegal.
   *
   * ormRoughness starts as the attribute and is overwritten rather than chosen by a ternary, so
   * that a draw with no map bound reads exactly what it read before this existed, with nothing to
   * get backwards. The map replaces the attribute rather than scaling it: an absent roughness
   * attribute is 0.4277 and not 1, so scaling would have read glossy on every procedural mesh.
   */
  float ormOcclusion = 1.0;
  float ormRoughness = vRoughness;
  float metal = 0.0;
  if (uOrmEnabled != 0) {
    vec3 t = texture(uOrmMap, vUv).rgb;
    ormOcclusion = mix(1.0, t.r, uOrmScale.r);
    ormRoughness = clamp(t.g * uOrmScale.g, 0.0, 1.0);
    metal = clamp(t.b * uOrmScale.b, 0.0, 1.0);
  }

  /*
   * The unlit default: exactly the surface's own colour, times its own texture, and nothing
   * else touching it — three.js calls this \`meshBasicMaterial\`. This is the value a draw with
   * \`uLightingEnabled\` at 0 keeps to the end, and the value every lit draw starts from before
   * the branch below builds a shaded result on top of it.
   */
  vec3 lit = albedo;

  if (uLightingEnabled != 0) {
    vec3 n = normalize(vNormal);
    /*
     * The authored normal, before either relief perturbs it.
     *
     * A map is the truth about which way the surface faces; uRelief invents structure from noise
     * and uTextureRelief reads a height off the albedo's own luminance, and both exist because
     * there was no way to author normals. So the map goes first and relief lays fine structure
     * over whatever it produced — composing rather than replacing, because a map that switched
     * relief off would silently discard a value the caller set.
     *
     * Gated on a uniform, which is what makes the derivatives inside tangentFrame legal at all —
     * AGENTS.md 2026-08-07 — and what makes a scene with no normal map pay nothing.
     *
     * texture rather than textureLod, and this is the one place in this shader where that is
     * right: a mipped colour image, sampled under uniform control flow, exactly as uAlbedo is
     * below. The rule is about non-uniform branches, and this branch is on a uniform.
     */
    if (uNormalStrength > 0.0) {
      vec3 mapped = texture(uNormalMap, vUv).xyz * 2.0 - 1.0;
      mat3 tbn = tangentFrame(n, vWorldPos, vUv, vTangent, vHasTangents);
      n = normalize(mix(n, normalize(tbn * mapped), uNormalStrength));
    }

    /*
     * Microscopic relief: the surface's own texture, as a turn of the normal rather than a change
     * of colour.
     *
     * **This is what makes a road read as asphalt instead of as a grey plane.** Real surfaces are
     * covered in structure too small to model and too large to ignore, and what it does to a
     * picture is change the *direction* light leaves each point, so a coarse surface catches a lamp
     * on one side of every bump and shades on the other. Grain cannot do it: that varies how much
     * light a point takes, which mottles a flat face and washes out at exactly the shallow angles
     * where a road shows its texture most.
     *
     * The bumps are the gradient of the same value noise the grain term uses, sampled three times
     * the shading point. That costs three extra noise evaluations and is gated on the surface
     * having asked, so a world with no textured surfaces pays nothing.
     *
     * **The roughness is widened with it, and that is not optional.** A perturbed normal is a
     * normal that varies fast, and a narrow highlight on a fast-varying normal is the sub-pixel
     * sparkle this engine spent a release fixing. The amplitude here is *known* rather than
     * measured from a screen-space derivative, which is what makes this the safe version: the same
     * widening driven by fwidth was measured making that artefact three times worse, because that
     * derivative spikes at every hard crease. See docs/IMPROVEMENTS.md.
     */
    float reliefAmount = uRelief * vRelief;
    /* Grown with the relief, before anything reads it. See the comment above: a normal that
       wanders cannot hold a highlight narrower than the wander. */
    /*
     * Grown with the relief *and* with the map, before anything reads it. A normal that wanders
     * cannot hold a highlight narrower than the wander, and a strongly mapped surface wanders as
     * surely as a procedurally relieved one — uTextureRelief already widens by its own amount for
     * exactly this reason, and a map left out of it sparkles.
     */
    float surfaceRoughness = clamp(
      ormRoughness + reliefAmount * RELIEF_ROUGHNESS + uNormalStrength * RELIEF_ROUGHNESS,
      0.0,
      1.0
    );
    /*
     * How much of the noise one pixel covers, and the fade that follows from it.
     *
     * **Point-sampled procedural detail aliases the moment a pixel is wider than a bump**, and
     * this had no defence against that at all. At the 60 cycles a metre a road asks for, a
     * carriageway seen at a grazing angle puts tens of bumps inside one fragment and takes a
     * single gradient from somewhere inside them; which one it lands on changes per pixel and
     * per frame, so the surface reads as salt-and-pepper noise rather than as aggregate. It is
     * worst exactly where a street scene spends most of its pixels: far away and near edge-on.
     *
     * The footprint is the world-space pixel size in noise cells, so the fade is stated in the
     * units the artefact is actually in — a road fades at the distance a bump stops being
     * resolvable, whatever the cycle count, the camera or the resolution.
     *
     * **Computed here rather than inside the branch below, and that is required rather than
     * tidy.** \`fwidth\` is a derivative and \`vRelief\` is a varying, so a derivative taken under
     * \`if (reliefAmount > 0.0)\` sits in non-uniform control flow: undefined in GLSL and refused
     * outright by WGSL. \`shadowFactor\` in this file carries the long version of that rule and
     * the shader that could not be translated until it was obeyed. \`uLightingEnabled\` above is
     * a uniform, so this is legal where it stands.
     *
     * The cost is one \`fwidth\` on every lit fragment, including those carrying no relief.
     * **What would make it wrong is reading this as the fix for sparkle**: it is not, and the
     * roughness widening above deliberately keeps the *unfaded* amount. Unresolved normal
     * variance is still roughness — a road that faded to smooth at distance would go glossy
     * instead of noisy, which is a worse artefact wearing better clothes.
     */
    vec3 reliefPixel = fwidth(vWorldPos) * uReliefCycles;
    float reliefFootprint = max(max(reliefPixel.x, reliefPixel.y), reliefPixel.z);
    float reliefResolved = reliefAmount * (1.0 - smoothstep(0.5, 1.5, reliefFootprint));
    if (reliefResolved > 0.0) {
      vec3 at = vWorldPos * uReliefCycles;
      /* One cell of the noise, which is one bump: the gradient over any smaller step is the
         interpolant's own slope rather than the shape's. */
      float here = grain(at);
      float dx = grain(at + vec3(0.5, 0.0, 0.0)) - here;
      float dy = grain(at + vec3(0.0, 0.5, 0.0)) - here;
      float dz = grain(at + vec3(0.0, 0.0, 0.5)) - here;
      vec3 slope = vec3(dx, dy, dz);
      /* Only the part across the surface tilts it; pushing along the normal would move the point
         rather than turn it, which a shading normal cannot express. */
      slope -= n * dot(slope, n);
      n = normalize(n - slope * reliefResolved * RELIEF_TILT);
    }

    /*
     * And the relief the bound texture itself carries, as its own luminance read as a height.
     *
     * **Both conditions are uniforms, which is what makes the derivatives below legal.** A branch
     * on a uniform is uniform control flow; \`shadowFactor\` above carries the long version of this
     * rule and the shader that could not be translated until it was obeyed. The four \`texture\`
     * calls are inside that same uniform branch, so the implicit level AGENTS.md's 2026-08-07
     * rule is about is well defined here too.
     *
     * **A basis from the screen rather than from a tangent attribute.** Turning a gradient
     * measured in UV into a tilt in world space needs to know which way U and V point on the
     * surface, and \`MeshData\` carries no tangents. Deriving them per fragment from how world
     * position and UV change across the quad needs nothing from the geometry, so this reaches
     * every mesh in every consumer rather than only remade ones — and it is the construction
     * three.js's own \`perturbNormalArb\` uses, so a surface ported from there is lit by the same
     * arithmetic instead of by an approximation of it.
     *
     * \`det\` carries the basis's own scale, so the normal is built as \`abs(det) * n - slope\`
     * and normalized: dividing the gradient by \`det\` instead would blow up on a fragment where
     * the surface is edge-on and the quad's footprint collapses.
     */
    if (uAlbedoEnabled != 0 && uTextureRelief != 0.0) {
      /*
       * **A centred difference, not three.js's forward one, and that is what makes the two
       * backends agree.** WebGL2's framebuffer counts y upward and WebGPU's counts it downward,
       * so \`dFdy\` of anything points the opposite way on the two — which the construction below
       * is built to survive, since \`sign(det)\` flips with it and cancels. A *forward* height
       * difference breaks that cancellation, because \`h(uv + d) - h(uv)\` is not the negative of
       * \`h(uv - d) - h(uv)\` anywhere the picture curves. Measured on the proof page: the y
       * component of the perturbed normal disagreed between the backends by a mean of 18 of 255
       * against 4 for the two components \`dFdx\` drives, with no dependence on pixel parity, so
       * it was the direction rather than the precision. A centred difference is exactly
       * antisymmetric, the cancellation holds, and it is the more accurate estimate besides: a
       * forward difference reports the slope half a step away from the point it is used at.
       */
      vec2 duvdx = dFdx(vUv);
      vec2 duvdy = dFdy(vUv);
      /* Half, because a centred difference spans two steps and three.js's number means one. */
      float reliefPerStep = uTextureRelief * 0.5;
      float dHdx = (surfaceHeight(texture(uAlbedo, vUv + duvdx).rgb)
                  - surfaceHeight(texture(uAlbedo, vUv - duvdx).rgb)) * reliefPerStep;
      float dHdy = (surfaceHeight(texture(uAlbedo, vUv + duvdy).rgb)
                  - surfaceHeight(texture(uAlbedo, vUv - duvdy).rgb)) * reliefPerStep;

      vec3 dpdx = dFdx(vWorldPos);
      vec3 dpdy = dFdy(vWorldPos);
      vec3 acrossV = cross(dpdy, n);
      vec3 acrossU = cross(n, dpdx);
      float det = dot(dpdx, acrossV);
      vec3 slope = sign(det) * (dHdx * acrossV + dHdy * acrossU);
      /*
       * **Capped at RELIEF_MAX_TILT, and that is not tuning.** This is *microscopic* relief:
       * structure too small to model, standing on geometry that is still the real shape. Turned
       * further than 45° it stops being that and starts lighting a face from behind its own
       * surface, which no amount of texture detail is evidence for. And past that point the
       * expression is near degenerate — \`slope\` has grown to the size of the term it is
       * subtracted from, so the normalized result swings a long way for a small change in
       * either, which is the fast-varying normal this engine already spent a release removing
       * the sparkle from. The cap binds only where the picture is a cliff; at the amplitudes a
       * photograph of a real surface produces, it never binds at all.
       */
      float lean = length(slope);
      float limit = abs(det) * RELIEF_MAX_TILT;
      if (lean > limit) slope *= limit / lean;
      n = normalize(abs(det) * n - slope);
      /* Widened for the same reason the procedural relief above widens it, and it is no more
         optional here: a normal that wanders cannot hold a highlight narrower than the wander.
         The amplitude is the caller's own stated one rather than a screen-space measurement,
         which is the condition that made that widening safe there. */
      surfaceRoughness = clamp(
        surfaceRoughness + abs(uTextureRelief) * RELIEF_ROUGHNESS,
        0.0,
        1.0
      );
    }

    /*
     * One dot product, used twice: ndl is the lit side and its negative is the night side below.
     * Shared rather than issued twice because it is the same number and one is cheaper, and not
     * because it fixes anything. It was tried as a fix and measured: it does not. See the night
     * term for what it does not fix.
     */
    float sunDot = dot(n, uDirectionalDir);
    float ndl = max(sunDot, 0.0);
    /*
     * Kept as its own value rather than folded into direct, because the emissive
     * term below needs it too. The sun and the moon are the only sources whose shadow
     * used to stop at a glowing surface.
     */
#if DIRECTIONAL_SHADOWS
    float sunShade = shadowFactor(ndl);
#else
    float sunShade = 1.0;
#endif
    /*
     * **How much sky this vertex can see, applied to the sun and to nothing else.**
     *
     * It multiplies sunShade rather than direct because the two are the same kind of quantity --
     * occlusion of the one directional source -- and because direct is not the only thing that
     * reads it: the sun's specular lobe below multiplies by sunShade on its own, so scaling
     * direct alone would leave an enclosed face with no sunlight and a sun highlight anyway.
     *
     * **Ambient is deliberately untouched, and that is the defect this lane exists to fix.** The
     * only per-vertex channel that reached shading before was colors, and the shader reads
     * albedo = vColor before lit = albedo * (ambient + sun), so a sky factor carried in the
     * vertex colour scales both terms: an enclosed face is darkened once for having no sky and
     * again for the ambient it should still have received. A consumer hitting this raised their
     * own floor constant to 0.45 to compensate and measured what it cost -- 55% of a chunk's
     * vertices sat between 0.10 and 0.20 -- which is contrast they could not get back.
     *
     * 1.0 for every mesh that carries no channel, so this is a multiply by one on every scene
     * that shipped before it.
     */
    sunShade *= vSkyDirect;
    float direct = ndl * sunShade;

    /*
     * Hemispheric: sky above, ground below, mixed by which way the surface looks. An
     * upward face takes the sky colour, a downward face the ground's, and a wall the
     * average — which is what makes a floor and a ceiling in the same room read as
     * different materials rather than the same one at different brightness.
     */
    vec3 ambient = mix(uAmbientGround, uAmbient, n.y * 0.5 + 0.5);
#if ENVIRONMENT_PROBE
    /*
     * The room's diffuse light, read from the probe array.
     *
     * **It replaces the hemispheric term where a grid exists, rather than lifting it.** What stood
     * here until 2026-08-25 was a mix toward \`textureLod(uEnvironment, n, maxLod - 3)\`, guarded
     * by a \`max\` so a *partial* probe could not darken a subject: a box-filtered level three
     * below the coarsest is a sample of the room rather than an integral over it, and a plain mix
     * toward one rendered a night courtyard black. What stood here after that was nine
     * spherical-harmonic coefficients, which is the integral and needed a readback to produce.
     *
     * This is the same integral again, convolved into a level of the array at bake time and read
     * with a fetch. **The clamp went with the fit that needed it**: a second-order projection can
     * go slightly negative where the environment is strongly directional, and a cosine convolution
     * of a non-negative environment cannot.
     *
     * \`uProbeGridAmbient\` is 0 when a caller declined the diffuse half, and the whole expression
     * is multiplied away there — so a scene that passed \`irradiance: false\` keeps the gradient it
     * set, which is the guarantee that option was added to give.
     */
    vec3 irradiance = gridIrradiance(n, vWorldPos);
    ambient = mix(ambient, irradiance, uProbeGridAmbient * uEnvironmentEnabled);
#endif
    /*
     * A metal keeps its ambient and loses its direct diffuse.
     *
     * **Written as one term because the honest two cancel.** The spelling this stands for is
     * albedo * (1 - metal) * (ambient + D * direct) + metal * albedo * ambient: a metal's reduced
     * diffuse, plus the ambient floor that stops a rough one going black once its diffuse is gone
     * and its reflection is scaled by (1 - roughness). Their two ambient contributions are
     * (1 - metal) * ambient and metal * ambient, which sum to ambient exactly, so all of it
     * reduces to this line.
     *
     * At metal 0 that is one multiply by 1.0 away from the expression it replaces, which is the
     * smallest change available in a shader with a documented history of shared subexpressions
     * rounding differently when their neighbours move. See the night-emissive term.
     */
    lit = albedo * (ambient + uDirectionalColor * direct * (1.0 - metal));

    /*
     * A sun highlight, for the few surfaces that ask for one.
     *
     * Blinn-Phong against the dominant source, which at night is the moon — so a polished
     * prop catches whatever is in the sky rather than only the day. It takes the same
     * sunShade the diffuse term takes, because a highlight that survives a shadow is
     * the clearest possible tell that lighting is faked.
     *
     * vSpecular is zero for every mesh that did not supply the attribute — the vast
     * majority — so for the rest of the world this is one multiply by a constant zero.
     */
    vec3 halfway = normalize(uDirectionalDir + normalize(uCameraPos - vWorldPos));
    /*
     * A metal's highlight takes its own colour; a dielectric's takes the light's.
     *
     * That is the single most visible thing metalness does, and it is why gold under a white lamp
     * reads as gold rather than as beige plastic with a white dot on it. vSpecular is this
     * engine's dielectric reflectance — a look control rather than an F0, as specularLobe's own
     * header says at length — so the mix runs from it to the albedo rather than from 0.04.
     *
     * mix(x, y, 0) is exactly x, so at metal 0 this is vec3(vSpecular) and the line below is the
     * one it replaces with the scalar broadened to three components.
     */
    vec3 specColor = mix(vec3(vSpecular), albedo, metal);
    /*
     * **A metal's highlight goes white at a grazing angle, and that is most of what reads as
     * polished.**
     *
     * Schlick says reflectance climbs to 1 at the edge whatever the material is, so a red metal
     * shows a red highlight face-on and a *white* one along every panel edge. Without this the
     * highlight is albedo-tinted at every angle, and a dark red suit gets a dark red highlight
     * that reads as matte paint however smooth the map says it is. The environment term below has
     * carried its own Fresnel since it was written; the direct term never had one.
     *
     * Scaled by metal, so at metal 0 this is mix(specColor, white, 0) — specColor exactly, and the
     * dielectric case is the expression it replaces. A dielectric's F0 is already so low that the
     * engine's vSpecular look control stands in for the whole term, which is the reading
     * specularLobe's header argues for at length.
     */
    float sunVoH = max(dot(normalize(uCameraPos - vWorldPos), halfway), 0.0);
    vec3 sunSpec = mix(specColor, vec3(1.0), pow(1.0 - sunVoH, 5.0) * metal);
    /*
     * **Held back until after the environment blend, because that blend is a mix and would
     * otherwise erase this.**
     *
     * The reflection below is written as \`mix(lit, environment, w)\`, so everything already in
     * \`lit\` is scaled by \`1 - w\`. On a metal \`w\` reaches 1, and a highlight added here is
     * multiplied by zero: the surface with the *most* reason to show a specular streak is the one
     * guaranteed not to. That is the single most visible difference between a bought PBR model
     * here and the same model in its own reference render, where every panel edge carries a white
     * streak brighter than the paint under it.
     *
     * The lamps have always added their highlight after this block; the sun was the odd one out,
     * and only because the block moved beneath it. Both are specular reflections of a source, and
     * a reflection of the room cannot subtract one.
     *
     * Zero for the whole world that carries no specular attribute and no metalness, exactly as
     * before: \`sunSpec\` is \`vec3(vSpecular)\` at metal 0 and \`vSpecular\` defaults to 0.
     */
    vec3 sunHighlight =
      uDirectionalColor * specularLobe(max(dot(n, halfway), 0.0), surfaceRoughness) * sunSpec * sunShade;
    /*
     * The dielectric's share goes in here, where it has always gone, so the environment blend
     * below dims it by exactly the reflectance it always dimmed it by. The metal's share is added
     * after that blend instead — see the line that does it for why the two cannot be one.
     */
    lit += sunHighlight * (1.0 - metal);

    /*
     * Procedural grain on the surfaces that asked for it, so a face is not one flat colour.
     *
     * This is what "texture" means in an engine that has none: the variation is computed
     * from world position rather than sampled, so it costs no upload, no memory and no
     * sampler, and it cannot be seen to tile. Grain is the half of a realistic material
     * that the colours alone cannot supply — a mineral surface is not uniform, and at
     * these sizes the eye reads
     * uniformity as plastic before it reads anything else.
     *
     * World-space rather than object-space, so the grain sits still in the world while a
     * prop turns through it — which is how a solid looks, and what stops the pattern
     * reading as something painted on and rotating with the object.
     *
     * Inside the branch on purpose. It is pure ALU with no texture fetch, so a
     * non-uniform branch is safe here (AGENTS.md, 2026-08-07 — that rule is about
     * implicit derivatives, which this has none of), and almost nothing in the world
     * carries a grain attribute at all.
     *
     * The amount is what the surface itself declared, and the third answer to a question
     * that was guessed twice. Gating on vSpecular meant "this is stone" only while stone
     * was the only shiny thing in the world, so an imported car came out sanded. Weighting
     * by vRoughness was closer and still a proxy: painted plaster is rough and has no
     * grain, polished granite is smooth and has plenty, so a painted tower at roughness 0.55
     * took 55% grain and read as marble. The two properties are independent and no weighting
     * between them can be right. uGrain remains as the pass-level scale over whatever the
     * geometry said, for an imported model that declares nothing.
     */
    if (vGrain > 0.0 && uGrain > 0.0) {
      float grainMix = mix(
        grain(vWorldPos * GRAIN_SCALE),
        grain(vWorldPos * GRAIN_COARSE_SCALE),
        GRAIN_COARSE_MIX
      );
      lit *= mix(1.0, mix(GRAIN_FLOOR, GRAIN_CEIL, grainMix), uGrain * vGrain);
    }

    /*
     * Environment reflection, Fresnel weighted.
     *
     * The sky and ground colours the ambient term already carries, sampled along the mirror
     * direction rather than the normal, so the reflection swings across a curved panel as the
     * eye moves instead of sitting still on it. That movement is most of what reads as gloss.
     *
     * Fresnel because every dielectric reflects far more at a grazing angle than head on:
     * about four percent facing the eye and nearly all of it at the edge, which is the bright
     * rim along a wing and the reason a windscreen turns into a mirror from the side. Scaled
     * by smoothness, since a rough surface scatters the same energy into no image at all.
     *
     * **Two sources, and which one is used is the caller's decision rather than a guess.** With a
     * reflection probe baked, the mirror direction samples the room itself and a car body carries
     * the panels above it and the walls around it. Without one, it samples the sky and ground
     * colours the ambient term already holds: an approximation, stated as one, with no scene in
     * it, which restores the tonal range a mirror surface has and cannot show anything.
     */
    /*
     * **Or an ORM map, because a metal is nothing but its reflection.**
     *
     * This read uReflectivity alone, which is a per-pass control a consumer sets from the
     * container's own scalar — and that scalar is 0 for exactly the materials that carry their
     * metalness in a map, because a per-texel value cannot be expressed as a per-draw one. So the
     * whole block was skipped for a fully metallic surface and max(uReflectivity, metal) inside it
     * was never reached. A chromed subject came out near black with a baked probe sitting unread.
     *
     * **Gated on uOrmEnabled rather than on metal, and that is required rather than tidy.** The
     * block takes fwidth of the mirror direction, and a derivative may only be taken under uniform
     * control flow. uOrmEnabled is a uniform; metal is a texture fetch, so branching on it would
     * put that derivative in non-uniform control flow and WGSL refuses the module outright. See
     * AGENTS.md, 2026-08-07. The per-texel decision still happens, one line down, in the amount.
     *
     * At uOrmEnabled 0 this is uReflectivity > 0.0 exactly, so nothing that binds no map takes a
     * branch it did not take before.
     */
    if (uReflectivity > 0.0 || uOrmEnabled != 0) {
      vec3 toEye = normalize(uCameraPos - vWorldPos);
      vec3 mirrored = reflect(-toEye, n);
      vec3 environment = mix(uAmbientGround, uAmbient, mirrored.y * 0.5 + 0.5);
#if ENVIRONMENT_PROBE
      /*
       * Rougher surfaces read a blurrier level, which is what separates satin from lacquer, and
       * **no level sharper than this pixel can resolve**, which is what stops a lacquered panel
       * sparkling.
       *
       * Roughness alone answers only half the question. It says how blurred the *material* makes a
       * reflection; it says nothing about how much of the cubemap lands inside one pixel. Where a
       * panel creases or a shut line runs, the mirror direction swings a long way between
       * neighbouring fragments, so at 0.025 for lacquered paint each of them reads a texel far from
       * its neighbour's at the sharpest level there is. A street of lit windows then lands in some
       * pixels and not the ones beside them: single bright dots tracing every crease, every gap and
       * every silhouette, worst on dark paint at night, and gone the moment you move close enough
       * for that curvature to span several pixels. **That is a sampling rate, not the model.**
       *
       * Two consumers reported it and it reproduces in demo/nightStreet.ts. It also looks exactly
       * like anti-aliasing being off, and is not: multisampling resolves *coverage*, so it cannot
       * touch a value that varies too fast inside one triangle.
       *
       * The footprint is fwidth of the mirror direction, turned into texels through the face size
       * the chain implies: a face spans a right angle, so texels per radian is that size over π/2.
       * The blurrier of the two levels wins. Nothing else about the term moves, deliberately —
       * widening the *material's* roughness from the same derivative was tried and measured worse,
       * because it also dims the reflection at exactly the creases it was meant to settle.
       *
       * Derivatives are well defined here: uReflectivity is a uniform, so this branch is uniform
       * for every fragment in the draw. See AGENTS.md, 2026-08-07, for the case where it is not.
       */
      /*
       * **Combined in roughness, not floored on a level — repaired 2026-08-25.**
       *
       * This turned the footprint into texels and took the blurrier of that level and the
       * material's. Against the **box-filtered capture** that was right: a level was a smaller
       * picture. Against the **GGX-prefiltered cube** a level is a *lobe convolved at roughness
       * level/maxLod*, so the same floor stopped saying "sample more coarsely" and started saying
       * "this surface is rough". Measured on a 512 probe with panels swinging about 0.03 rad a
       * pixel: level 3.3, which under the new chain is an enforced **roughness 0.37 on every metal
       * whatever its map says**. Reported from a consumer as metals reading opaque.
       *
       * So the footprint is the roughness whose lobe is as wide as the pixel, combined in
       * quadrature — independent angular spreads add that way. A GGX lobe at roughness r has a
       * characteristic half-angle of about r squared, so a footprint of \`swing\` radians is a
       * roughness of \`sqrt(swing)\`.
       *
       * **Halved, because \`fwidth\` is an upper bound rather than the footprint.** It is
       * \`abs(dFdx) + abs(dFdy)\`, a sum of both screen derivatives rather than the radius of the
       * pixel's cone, and those derivatives are *coarse* on nearly every GPU: one pair per 2x2
       * quad. Together they over-state the cone by about two, and this squares back into a
       * roughness, so a half here is a quarter of the solid angle.
       *
       * **The reason this shape was refused before is gone.** The comment it replaces recorded
       * that widening the material's roughness "was tried and measured worse, because it also dims
       * the reflection at exactly the creases it was meant to settle" — true under the old weight,
       * where \`reflectAmount\` carried a \`1 - roughness\` factor. \`envSpecularEnergy\` removed
       * that: a metal's weight is exactly 1.0 at every roughness, so widening no longer dims.
       *
       * **It widens only the level this picks.** \`surfaceRoughness\` is untouched, because it also
       * feeds the environment BRDF and the sun's own lobe, and a crease should not grow a wider
       * *direct* highlight for spanning few pixels.
       *
       * **What it costs**: a surface still loses its mirror where it is genuinely under-sampled,
       * which is the sparkle protection doing its job. **What would make it wrong** is a chain
       * whose levels are not roughness — the capture's own box chain is exactly that.
       */
      /*
       * **The map's edge, not \`exp2(uEnvironmentMaxLod)\`.** Those were one number while the
       * environment was a cube whose chain ran to a single texel a face. The chain now stops one
       * level below the cosine convolution, so the top level is 4 while the map is 256 across, and
       * the old expression would say sixteen — which reads as every metal being under-sampled and
       * forced to a roughness its material does not have.
       */
      float faceTexels = uEnvironmentEdge;
      float swingRad = max(length(fwidth(mirrored)), 1e-6);
      /*
       * **Two chains, two ways to pick a level, chosen by \`uEnvironmentPrefiltered\`.**
       *
       * A *box* level is a smaller picture of the room, so the footprint belongs as a floor on the
       * level: read coarsely enough that a pixel covers about a texel, and lose detail, nothing
       * else. A *prefiltered* level is the room convolved at roughness level/maxLod, so the same
       * floor stops saying "sample more coarsely" and starts saying "this surface is rough" —
       * measured on a 512 probe with panels swinging 0.03 rad a pixel, an enforced roughness of
       * 0.37 on every metal whatever its map says.
       *
       * So for the lobe chain the footprint is expressed as the roughness whose lobe is as wide as
       * the pixel and combined in quadrature, independent angular spreads adding that way: a GGX
       * lobe at roughness r has a characteristic half-angle of about r squared, so a footprint of
       * \`swing\` radians is a roughness of \`sqrt(swing)\`. Halved, because \`fwidth\` is
       * \`abs(dFdx) + abs(dFdy)\` over *coarse* derivatives — one pair per 2x2 quad — so it
       * over-states the pixel's cone by about two, and this squares back into a roughness.
       *
       * **What it costs** is both expressions evaluated and one selected, which is a handful of
       * multiply-adds against a uniform. **What would make it wrong** is a third kind of chain.
       */
      float boxLod = max(surfaceRoughness * uEnvironmentMaxLod, log2(max(swingRad * faceTexels * 0.6366, 1.0)));
      float footprintRough = 0.5 * sqrt(min(swingRad, 1.0));
      float lobeRough = min(1.0, sqrt(surfaceRoughness * surfaceRoughness + footprintRough * footprintRough));
      float envLod = clamp(
        mix(boxLod, lobeRough * uEnvironmentMaxLod, uEnvironmentPrefiltered),
        0.0,
        uEnvironmentMaxLod
      );
      vec3 room = gridRadiance(mirrored, envLod, vWorldPos);
      /*
       * **The room wins outright where there is one, and it must.**
       *
       * This was briefly written as \`max(environment, room)\`, to stop a dim probe leaving a metal
       * darker than the world around it. It does stop that, and it destroys the reflection doing
       * it: the hemispheric term is a two-colour gradient with no image in it whatsoever, and a
       * world's declared ambient is brighter than most of what a probe actually holds — so the max
       * returns the *gradient* over nearly the whole sphere and a mirror shows a smooth wash. That
       * is the same flat, matte surface this was trying to fix, arrived at from the other side.
       *
       * A floor is right for irradiance, where only the level matters, and wrong for a mirror,
       * where the level is the least of what is being carried. Brightness belongs to
       * \`uEnvironmentGain\`, which scales what the surface reflects and keeps its image.
       */
      environment = mix(environment, room, uEnvironmentEnabled);
#endif
      /*
       * Whatever the surface ends up reflecting, at the brightness the caller asked for — **and
       * weighted by metalness, which is the only case the gain was ever an answer to.**
       *
       * A metal has no diffuse and no ambient behind its reflection: what it reflects is all it
       * is, so when the probe under-reports the room the surface has no other way to be lit. A
       * dielectric is in no such position. Its reflection sits on top of a diffuse term that is
       * already carrying the world's light, and scaling it lifts a surface that was correct —
       * measured on a car painted black, which came out washed grey with a milky haze over every
       * panel, because \`fresnel * uReflectivity * (1 - roughness)\` reaches most of the way to 1 at
       * a grazing angle and three times the room is what landed there.
       *
       * \`mix(1, gain, 0)\` is exactly 1, so a dielectric is arithmetically untouched however the
       * caller sets this.
       */
      environment *= mix(1.0, uEnvironmentGain, metal);
      float facing = 1.0 - max(dot(n, toEye), 0.0);
      /*
       * **A metal's Fresnel base is close to its albedo, not a dielectric's four percent.** Schlick
       * with a fixed 0.04 is right for glass, plastic and paint and badly wrong for chrome: left
       * there, a smooth metal seen head-on takes a four percent reflection and reads as dark paint.
       *
       * And a metal is nothing but its reflection, so it raises the amount as well as the base —
       * uReflectivity is a per-pass control and a metal texel cannot be left mirroring nothing
       * because the pass it happens to be drawn in did not ask for reflections.
       *
       * Both collapse at metal 0: mix(0.04, 1.0, 0) is 0.04, and max(uReflectivity, 0) is
       * uReflectivity because both renderers clamp that uniform non-negative on upload.
       */
      float f0 = mix(0.04, 1.0, metal);
      float fresnel = mix(f0, 1.0, facing * facing * facing * facing * facing);
      /*
       * **A rough metal is still a metal, and \`1 - roughness\` said otherwise.**
       *
       * The thinning belongs to the dielectric term, where it stands for a polish that scatters
       * its reflection away into no image at all. A metal has no diffuse to fall back on: this is
       * its entire response to light, and scaling it by \`1 - roughness\` throws away 40% of
       * everything a surface at roughness 0.4 shows and replaces it with \`albedo * ambient\`,
       * which is a dark constant. That is the "reads dark, reads like paint" report, arithmetically.
       *
       * It is also double counting. The chain the sample comes from *is* the roughness — a rougher
       * surface reads a blurrier level a few lines above — so dimming it as well charges twice for
       * one property. A GGX prefilter loses some energy with roughness and it is nothing like this
       * steep; that belongs with the prefilter, when there is one.
       *
       * **Identical at metal 0**: \`max(uReflectivity * (1 - r), 0)\` is \`uReflectivity * (1 - r)\`,
       * which is what the old \`max(uReflectivity, metal) * (1 - r)\` came to, and both renderers
       * clamp that uniform non-negative on upload.
       */
      float reflectAmount = max(uReflectivity * (1.0 - surfaceRoughness), metal);
      /*
       * **With a prefiltered environment, how much a surface returns is an integral rather than a
       * curve somebody chose**, and this is where the comment above said the thinning should go
       * once a prefilter existed.
       *
       * \`envBrdfApprox\` is the split-sum's second half: the convolution decides *what* is
       * reflected at a roughness and this decides *how much*. It contains the angular dependence,
       * so it replaces \`fresnel\` as well as \`1 - roughness\` — keeping the separate Fresnel
       * factor would apply it twice.
       *
       * **Gated on \`uEnvironmentEnabled\`, and the gate is an argument rather than a way of
       * protecting a pixel count.** The split sum approximates an integral over a *prefiltered*
       * environment. With no probe, \`environment\` is the two-colour sky-and-ground gradient,
       * which was never integrated over anything and has no chain behind it, so applying a term
       * that assumes one would assert an integral that does not exist. Every scene without a probe
       * therefore keeps exactly the arithmetic it had.
       *
       * **That last clause used to read "which is every published scene", and it was wrong.**
       * \`nightStreet\` bakes at 128 and \`showroom\` at 256, so two of the seven take this
       * branch. They move no pixels — measured, 0 of 921,600 on each of the seven — but only
       * because neither binds an ORM map, so both are dielectrics at \`f0\` 0.04 where this term
       * is worth hundredths of a level. A claim about a gate is worth checking against the
       * scenes rather than remembering, which is what \`docs/README.md\` says about every claim
       * of this shape.
       *
       * **Measured rather than assumed, and it moved less than expected.** On the roughness ladder
       * the whole change is at most 0.2 of 255, because a rough surface reads the coarsest levels
       * of the chain and those are dark in a room with one bright wall. The term is nonetheless
       * the right one: it is where a bright loaded environment will show, and it stops a fully
       * rough dielectric reflecting exactly nothing, which \`1 - roughness\` asserted and which is
       * false of every real surface.
       */
      float ndv = 1.0 - facing;
      /*
       * **\`envSpecularEnergy\` and not \`f0 * dfg.x + dfg.y\`, and the difference is a metal
       * looking like paint.** The bare split sum integrates one scattering event and drops every
       * ray that bounces twice inside the microsurface, so it returns \`1 - 0.55 * roughness\` for
       * a surface at \`f0\` 1 — asserting that a perfect mirror absorbs over half the light once it
       * is roughened. Reported from a consumer whose subject is forced fully metallic: measured
       * losses of 22% at roughness 0.4, 33% at 0.6 and 44% at 0.8 against the term this replaced.
       *
       * The compensation returns it, and at \`f0\` 1 it returns *exactly* 1.0 at every roughness —
       * which is the old \`fresnel * reflectAmount\` weight for a metal, to the bit. So this is a
       * repair rather than a second look decision, and the arithmetic is in \`lobes.ts\`.
       */
      /*
       * **Compiled out where there is no probe, and that is worth 4,762 gzipped bytes.**
       *
       * With \`ENVIRONMENT_PROBE\` off, \`prefiltered\` was a literal 0 and \`mix\` returned the
       * left-hand side outright — so the fit, the compensation and the clamp were computed, and
       * shipped, to be multiplied by nothing in eight of the sixteen permutations. \`ARCHITECTURE.md\`
       * §1 is why that is not a rounding error: a permutation is larger than deflate's 32 KB window,
       * so sixteen near-identical copies do not dedupe and every consumer downloads all of them.
       *
       * Measured on \`core-only\`, gzipped: **529,889 ungated, 525,127 gated**, against a floor of
       * 524,402 before any of this. So the energy compensation costs **725 bytes** rather than the
       * 5,487 it costs computed unconditionally — and the gate pays for more than it: \`dfg\` moved
       * inside it too, so eight permutations stopped carrying \`envBrdfApprox\` as well, which they
       * had been doing since the split sum landed. The picture is identical to the bit either way.
       *
       * The prediction written here first was 2,708. It was wrong, and it is replaced by the
       * measurement rather than kept beside it.
       *
       * **What would make this wrong** is a second consumer of \`dfg\` outside this branch — a
       * clearcoat lobe wanting the same fit. It would then belong above the \`#if\` again, and the
       * bytes would be buying something.
       */
#if ENVIRONMENT_PROBE
      vec2 dfg = envBrdfApprox(ndv, surfaceRoughness);
      float integrated = clamp(envSpecularEnergy(f0, dfg) * max(uReflectivity, metal), 0.0, 1.0);
      /*
       * **The split sum only where a prefiltered chain is what is being sampled.** It is the
       * correct share of a *prefiltered* environment; over a box chain it asserts an integral that
       * was never performed, and it flattens the Fresnel sweep that reads as gloss — measured, the
       * grazing-to-head-on ratio falls from about 15 to 1 down to 5 to 1 at roughness 0.5, which
       * was reported twice as a metal going opaque. With the prefilter off this is exactly the
       * expression the engine carried before the lighting track.
       */
      float weight = mix(
        clamp(fresnel * reflectAmount, 0.0, 1.0),
        integrated,
        uEnvironmentEnabled * uEnvironmentPrefiltered
      );
#else
      float weight = clamp(fresnel * reflectAmount, 0.0, 1.0);
#endif
      lit = mix(
        lit,
        environment * mix(vec3(1.0), albedo, metal),
        weight
      );
    }
    /*
     * The sun's highlight, on top of whatever the surface reflects rather than underneath it —
     * **and only by as much as the surface is metal.**
     *
     * The metal half is the fix: the blend above reaches 1 on a metal, so a highlight added before
     * it was multiplied by zero and the surface with the most reason to show a specular streak was
     * the one guaranteed not to.
     *
     * The \`(1 - metal)\` half above is the part that must not move. A dielectric's blend weight is
     * \`fresnel * uReflectivity * (1 - roughness)\`, which on polished paint or glass reaches most
     * of the way to 1 at a grazing angle — and adding the highlight after the blend rather than
     * into it takes a lobe that was correctly dimmed by the surface's own reflectance and puts it
     * back at full strength. On a near-black glass lens carrying \`specular\` 1 that is a white
     * blob where there was none. So the dielectric keeps the arithmetic it has always had, exactly:
     * at metal 0 the line below adds nothing and the line above is the original expression.
     */
    lit += sunHighlight * metal;

    /*
     * Self-illuminated geometry. Additive and gated on the night factor, so it is
     * exactly invisible by day and costs two ALU ops.
     *
     * Dimmed in shadow, but only partly, and the fraction is the whole argument. Strictly,
     * emission is light leaving a surface and an occluder between that surface and the sun
     * has no business touching it — which is what this used to do, adding the full term
     * after the shadow. The result is that a shadow crossing the terrace darkens the deck
     * and leaves every inlaid band at full brightness, so the bands stop belonging to the
     * floor they are cut into. It gets reported as the shadow passing *under* the inlaid
     * markings, as though it could not be cast over them at all.
     *
     * That is a real break in the picture, and the physical reading is not much
     * of a defence, because none of these surfaces is a pure emitter: a lit inlay is worked
     * stone with light coming *through* it, and the stone around the light is in shadow like
     * everything else. So the shadow takes a share and leaves the rest. At 0.55 a band in
     * shade is visibly in shade and still visibly lit, which is what it is.
     */
    /*
     * Deferred to *after* the point lights, so their shadows can reach it. Addition
     * commutes; the order is only about what is known by then.
     */
    float lightShade = 1.0;

    /*
     * Which froxel this fragment is in.
     *
     * Derived in view space rather than from \`gl_FragCoord\`, for the reason \`uView\`'s own
     * comment gives: the two backends disagree about which way a framebuffer's y runs, and a tile
     * row taken from a window coordinate would be mirrored on one of them.
     *
     * The arithmetic is \`sliceOfViewDepth\` and \`tileOf\` from \`clusteredLights.ts\`, in the
     * same order and with the same clamps, because a fragment reading a froxel the binner filled
     * differently is a fragment lit by somebody else's lights.
     */
    vec3 clusterView = (uView * vec4(vWorldPos, 1.0)).xyz;
    float clusterDepth = -clusterView.z;
    float clusterHalfH = max(clusterDepth, 1e-4) * uClusterFrustum.z;
    float clusterHalfW = clusterHalfH * uClusterFrustum.w;
    int clusterTileX = clamp(
      int(floor((clusterView.x / clusterHalfW + 1.0) * 0.5 * float(CLUSTER_X))), 0, CLUSTER_X - 1);
    int clusterTileY = clamp(
      int(floor((clusterView.y / clusterHalfH + 1.0) * 0.5 * float(CLUSTER_Y))), 0, CLUSTER_Y - 1);
    int clusterSlice = 0;
    if (clusterDepth > uClusterFrustum.x) {
      clusterSlice = clamp(
        int(floor(log(clusterDepth / uClusterFrustum.x)
          / log(uClusterFrustum.y / uClusterFrustum.x) * float(CLUSTER_Z))),
        0, CLUSTER_Z - 1);
    }
    int clusterBaseTexel = LIGHT_REGION_TEXELS
      + (clusterTileX + clusterTileY * CLUSTER_X + clusterSlice * CLUSTER_X * CLUSTER_Y)
        * CLUSTER_TEXELS;
    int clusterLights = uClustered == 1 ? int(clusterTexel(clusterBaseTexel).x) : 0;

    // Point lights. Inverse-square-ish falloff clipped to a finite radius, so a
    // light can be culled without a visible seam.
    for (int slot = 0; slot < LIGHT_LOOP_MAX; slot++) {
      /*
       * **The two arms differ in where a light's numbers come from and in nothing else.**
       *
       * Everything below reads \`lightPos\`, \`lightColor\`, \`lightRadius\`,
       * \`lightSourceRadius\`, \`lightWeight\` and \`shadowSlot\`, so the clustered path is a
       * different *source* for the same six values rather than a second copy of the shading. That
       * is what makes the zero-pixel gate between the two arms mean something: if the body were
       * duplicated, the gate would only be comparing two transcriptions.
       */
      int i;
      vec3 lightPos;
      float lightRadius;
      vec3 lightColor;
      float lightSourceRadius;
      float lightWeight;
      int shadowSlot;
      vec3 lightDir;
      vec2 lightCone;
      float iesProfile;
      vec3 iesAxis;
      float cookie;
      if (uClustered == 1) {
      if (slot >= clusterLights) break;
      /*
       * Four indices to a texel. Selected with compares rather than by indexing the vector,
       * because a dynamic component index is legal in GLSL ES 3.00 and is one more thing for a
       * translator to disagree about on the one path that has no fallback beneath it.
       */
      uvec4 packedIndices = clusterTexel(clusterBaseTexel + 1 + (slot >> 2));
      int component = slot & 3;
      uint packed = component == 0
        ? packedIndices.x
        : component == 1 ? packedIndices.y : component == 2 ? packedIndices.z : packedIndices.w;
      i = int(packed);
      int record = i * LIGHT_TEXELS;
      uvec4 rec0 = clusterTexel(record);
      uvec4 rec1 = clusterTexel(record + 1);
      uvec4 rec2 = clusterTexel(record + 2);
      lightPos = vec3(
        uintBitsToFloat(rec0.x), uintBitsToFloat(rec0.y), uintBitsToFloat(rec0.z));
      lightRadius = uintBitsToFloat(rec0.w);
      lightColor = vec3(
        uintBitsToFloat(rec1.x), uintBitsToFloat(rec1.y), uintBitsToFloat(rec1.z));
      lightSourceRadius = uintBitsToFloat(rec1.w);
      lightWeight = uintBitsToFloat(rec2.x);
      shadowSlot = int(uintBitsToFloat(rec2.y));
      /*
       * The fourth texel, which is the cone. See LIGHT_RECORD in clusteredLights.ts: the
       * direction spans rec2.z, rec2.w and rec3.x, because the record is a run of floats rather
       * than a struct and a vec3 does not respect texel boundaries.
       */
      uvec4 rec3 = clusterTexel(record + 3);
      lightDir = vec3(
        uintBitsToFloat(rec2.z), uintBitsToFloat(rec2.w), uintBitsToFloat(rec3.x));
      lightCone = vec2(uintBitsToFloat(rec3.y), uintBitsToFloat(rec3.z));
      iesProfile = uintBitsToFloat(rec3.w);
      /* The fifth texel, which is the photometric azimuth. See LIGHT_RECORD in clusteredLights.ts
         for why it costs a texel rather than being derived from the direction. */
      uvec4 rec4 = clusterTexel(record + 4);
      iesAxis = vec3(
        uintBitsToFloat(rec4.x), uintBitsToFloat(rec4.y), uintBitsToFloat(rec4.z));
      cookie = uintBitsToFloat(rec4.w);
      } else {
      i = slot;
      if (i >= uLightCount) break;
      lightPos = uLightPos[i];
      lightRadius = uLightRadius[i];
      lightColor = uLightColor[i];
      lightSourceRadius = uLightSourceRadius[i];
      lightWeight = uLightWeight[i];
      shadowSlot = i;
      lightDir = uLightDir[i];
      lightCone = uLightCone[i];
      iesProfile = uLightIesProfile[i];
      iesAxis = uLightIesAxis[i];
      cookie = uLightCookie[i];
      }
      /*
       * **The cone, and a point light's is one that admits every direction.**
       *
       * \`lightCone\` is the cosine of the inner angle then of the outer, and a light that declared
       * no cone carries -1 and -2 — so the dot product, which is at least -1 for every direction
       * on the sphere, is always at or past the upper edge and the term is exactly 1. Not
       * approximately: \`smoothstep\` returns its upper bound outright once the argument reaches
       * it, with no arithmetic in between, which is what makes every scene with no spot light
       * bit-identical to the build before spot lights existed.
       *
       * **Not written as a branch on whether the light is a spot.** In the clustered arm that
       * would be a branch on a value read from a texture, which is not provably uniform control
       * flow, and the shadow fetches below sit inside this same loop — the 2026-08-07 rule is
       * about exactly that. Two multiply-adds are cheaper than the flattening a compiler would do
       * anyway.
       *
       * **What it costs** is that the edge is a smoothstep in the cosine rather than in the angle,
       * so the falloff is very slightly biased toward the outer edge. **What would make it wrong**
       * is a cone narrow enough for that bias to be visible, which is a few degrees, and at that
       * width the shadow map's resolution is the larger problem.
       */
      vec3 toLight = lightPos - vWorldPos;
      float dist = length(toLight);
      /* The direction the light travels, which is what a cone is measured against. */
      float coneFalloff =
        smoothstep(lightCone.y, lightCone.x, dot(-toLight / max(dist, 1e-4), lightDir));
      /*
       * Two ways for a lamp to fade, and the difference is a look rather than a detail.
       *
       * The default shapes the falloff to the radius: it reaches zero exactly at the edge, so
       * a light can be culled with no seam, and it stays gentle near the source. That is the
       * right behaviour for a world of large soft sources and it is what every world here is
       * authored against.
       *
       * Inverse-square is what a physically-based renderer does, and it is *violent* close
       * in: at a tenth of a metre it is a hundred times the value at one metre, so a lamp
       * mounted a few centimetres under a ceiling floods it and the panel around it reads as
       * lit rather than as a dark plate with a bright strip in it. Windowed by the radius the
       * same way three.js windows its own, so the light still ends where it says it does.
       */
      float falloff;
      if (uLightFalloff == 1) {
        float window = clamp(1.0 - pow(dist / max(lightRadius, 1e-4), 4.0), 0.0, 1.0);
        falloff = window * window / max(dist * dist, 0.01);
      } else {
        falloff = clamp(1.0 - dist / lightRadius, 0.0, 1.0);
      }
      if (falloff <= 0.0) continue;
      float ndl = max(dot(n, toLight / max(dist, 1e-4)), 0.0);
      if (ndl <= 0.0) continue;

      /*
       * Normal-offset bias.
       *
       * The deck is a single enormous flat plane, so the light grazes nearly all
       * of it: one shadow texel covers a long stretch whose depth changes far
       * faster than any depth bias can absorb. Pushing the *sample position*
       * along the surface normal instead moves the receiver clear of its own
       * occluder in the direction that actually matters, and it scales with how
       * grazing the angle is. Without it the cubemap's face seams show as a
       * diagonal cross and the whole plane bands.
       */
#if POINT_SHADOWS
      float grazing = 1.0 - ndl;
      float normalOffset = (0.06 + dist * 0.05) * grazing * grazing + 0.02;
      vec3 shadowFrom = (vWorldPos + n * normalOffset) - lightPos;

      /*
       * uPointShadowWeight is how present the cubemap is, and it is the difference
       * between a shadow arriving and a shadow appearing. A pool slot changing hands
       * throws its image away, so the map behind a light can go from absent to complete
       * between two frames; sampling it at full strength the frame it lands is a shadow
       * switching on under a lamp that never moved. It ramps instead.
       */
      float occl = 1.0;
      /*
       * One lookup, where there were ten unrolled else-if arms.
       *
       * GLSL ES cannot index a sampler array with a non-constant expression, so twelve cubemaps
       * meant twelve declared samplers and a chain comparing this light against each slot's
       * owner. One array texture makes the map a *layer* — an ordinary integer — so the light
       * indexes the arrays directly and the chain is a compare against -1.
       */
      /*
       * **Indexed by the shadow slot, not by the light.** Clustering lifts how many lights shade a
       * fragment and not how many shadow maps exist — the pool is a memory budget — so a clustered
       * light either holds one of these slots or casts none, and \`-1\` says which. \`clamp\` keeps
       * the read in range for a light with no slot, whose \`layer\` is then forced negative anyway;
       * indexing a uniform array with -1 is undefined and would be a picture rather than an error.
       *
       * **And in range at the other end, which a shrunken budget is what made reachable.** A
       * clustered light carries its slot in the froxel record rather than in \`i\`, so a build with
       * \`maxLights\` below \`MAX_LIGHTS_PER_CLUSTER\` can be handed a slot past the end of these
       * arrays — undefined again, and again as a picture. Past the end is treated as *no shadow*
       * rather than clamped onto the last slot: a light wearing another light's occlusion is a
       * wrong picture, where a light that occludes nothing is the engine's own stated trade
       * everywhere else it runs out of room.
       */
      int shadowRead = clamp(shadowSlot, 0, MAX_LIGHTS - 1);
      int layer = shadowSlot >= 0 && shadowSlot < MAX_LIGHTS ? uPointShadowLayer[shadowRead] : -1;
      if (layer >= 0) {
        occl = mix(
          1.0,
          pointShadow(
            uPointShadows,
            float(layer),
            shadowFrom,
            uPointShadowFar[shadowRead],
            uPointShadowNear[shadowRead],
            uPointShadowSize[shadowRead]
          ),
          uPointShadowWeight[shadowRead]
        );
      }

      // A live map contains movers only. Multiplication composes their occlusion
      // with the immutable world map, while the weight makes ownership changes a
      // crossfade rather than switching a whole character shadow in one frame.
      float liveOccl = 1.0;
      float liveWeight = 0.0;
      int liveLayer =
        shadowSlot >= 0 && shadowSlot < MAX_LIGHTS ? uLivePointShadowLayer[shadowRead] : -1;
      if (liveLayer >= 0) {
        liveOccl = pointShadow(
          uPointShadows,
          float(liveLayer),
          shadowFrom,
          uLivePointShadowFar[shadowRead],
          uLivePointShadowNear[shadowRead],
          uLivePointShadowSize[shadowRead]
        );
        liveWeight = uLivePointShadowWeight[shadowRead];
      }
      occl *= mix(1.0, liveOccl, liveWeight);
#else
      float occl = 1.0;
#endif

      // Blend occlusion out as the light fades, so a shadow can never be more
      // present than the light casting it — and slot changes at the edge of
      // range become invisible rather than a pop.
      float shaded = mix(1.0, occl, clamp(falloff * 2.0, 0.0, 1.0));
      /*
       * The cone multiplies the distance falloff rather than replacing it, which is what makes a
       * spot a point light with a direction rather than a second kind of light. It is exactly 1
       * for a light that declared no cone, so this line is arithmetically the one it replaces.
       */
      /*
       * **What a real fixture throws, rather than what a cone approximates.**
       *
       * An IES profile is a measured intensity by angle from the fixture's axis, so this is the
       * same angle the cone is measured at, read out of one row of the atlas. A light with no
       * profile carries a negative index and takes 1, which is the multiplicative identity and
       * costs a fetch nobody can avoid — see below.
       *
       * **The fetch is unconditional and \`textureLod\`, both deliberately.** This loop is not
       * provably uniform control flow: in the clustered arm the light index comes out of a
       * texture. A branch on the profile index would therefore be a non-uniform branch around a
       * sample, which is what the 2026-08-07 rule forbids and what lets a compiler flatten the
       * loop and cost every arm. So the row is clamped to a valid one, the sample always happens,
       * and the result is selected afterwards with a \`mix\` on a compare — which is arithmetic
       * rather than control flow.
       *
       * **What it costs** is one texture fetch per light per fragment on every scene, whether or
       * not anything loaded a profile. **What would make it wrong** is a scene where that fetch is
       * measurable against the shadow taps in the same loop, which would be a scene with many
       * lights and no shadows at all — at which point the honest answer is a permutation flag, and
       * \`ARCHITECTURE.md\` section 1 has the arithmetic for whether it earns one.
       */
      float iesRow = max(iesProfile, 0.0);
      /* The direction the fixture throws toward this fragment, which both angles are measured on. */
      vec3 iesRay = -toLight / max(dist, 1e-4);
      /* The angle from the fixture's axis, as a fraction of the 0-to-180 arc every row spans. */
      float iesAngle = acos(clamp(dot(iesRay, lightDir), -1.0, 1.0));
      float iesU = iesAngle / PI_IES;
      /*
       * **The azimuth about the fixture's own axis**, behind a branch on a uniform so a scene whose
       * profiles are all axially symmetric pays none of this arithmetic. A \`uniform float\` is
       * provably uniform control flow — no wavefront can diverge on it — so this is not the
       * 2026-08-07 case, which is about a branch a compiler *cannot* prove uniform.
       *
       * The reference is orthogonalised against the aim rather than assumed perpendicular to it,
       * so a caller may hand the fixture's own forward; one parallel to the aim leaves nothing to
       * project and stays on the first plane rather than producing a NaN.
       */
      float iesTurns = 0.0;
      vec3 cookieTint = vec3(1.0);
      /*
       * **The fixture's own frame, built once and shared by the azimuth and the cookie**, because
       * both are asking the same question about a fixture — which way is up — and both read
       * \`uLightIesAxis\` to answer it. Behind a branch on two uniforms, so a scene using neither
       * builds no frame at all.
       */
      if (uIesPlaneCount > 1.0 || uCookieTiles > 0.0) {
        vec3 iesRef = iesAxis - lightDir * dot(iesAxis, lightDir);
        float iesRefLen = length(iesRef);
        if (iesRefLen > 1e-5) {
          iesRef /= iesRefLen;
          vec3 iesBinormal = cross(lightDir, iesRef);
          if (uIesPlaneCount > 1.0) {
            /* \`atan\` answers -PI..PI and \`fract\` of a negative wraps forward, so this is 0..1
               across the whole turn without a branch on the sign. */
            iesTurns = fract(atan(dot(iesRay, iesBinormal), dot(iesRay, iesRef)) / TAU_IES);
          }
          if (uCookieTiles > 0.0) {
            /*
             * **A perspective projection onto the plane one unit down the aim**, which is what a
             * fixture actually throws: the mask grows with distance rather than being pasted on
             * at a fixed size.
             *
             * Scaled by the *outer cone's* tangent so a cookie fills whatever cone it is given —
             * a mask drawn once works in a narrow spot and a wide one. A light with no cone
             * carries a cosine of -2 and the \`max\` below turns that into zero rather than a NaN;
             * such a light also carries no cookie, so the result is discarded either way.
             */
            float cookieAlong = max(dot(iesRay, lightDir), 1e-4);
            float cosOuter = lightCone.y;
            float tanOuter = sqrt(max(1.0 - cosOuter * cosOuter, 0.0)) / max(cosOuter, 1e-3);
            vec2 fromAxis =
              vec2(dot(iesRay, iesRef), dot(iesRay, iesBinormal)) / cookieAlong;
            vec2 cookieUv = fromAxis / max(tanOuter, 1e-3) * 0.5 + 0.5;
            /*
             * Clamped inside the tile rather than wrapped: past the cone edge the cone term is
             * already zero, so what matters is only that the sample cannot reach the neighbouring
             * cookie — which a bilinear fetch at a seam otherwise does.
             */
            float cookieTile = max(cookie, 0.0);
            vec2 cookieAt = vec2(
              (cookieTile + clamp(cookieUv.x, COOKIE_INSET, 1.0 - COOKIE_INSET)) / uCookieTiles,
              clamp(cookieUv.y, COOKIE_INSET, 1.0 - COOKIE_INSET));
            /* Unconditional and \`textureLod\`, and selected with a \`mix\` afterwards: the light
               loop is not provably uniform control flow — the clustered arm reads its index from a
               texture — so a branch on the *light's* cookie index around a sample is what the
               2026-08-07 rule forbids. */
            vec3 cookieSample = textureLod(uCookieAtlas, cookieAt, 0.0).rgb;
            cookieTint = mix(vec3(1.0), cookieSample, step(0.0, cookie));
          }
        }
      }
      /*
       * **One fetch, and the atlas's own linear filter does the blend between planes.**
       *
       * A profile occupies \`planes + 1\` rows with the last repeating the first, so a fractional
       * row inside a profile is exactly the blend wanted and the wrap from the last plane back to
       * the first is a blend into that repeat rather than a bleed into the next profile. The
       * version this replaced took two explicit fetches and a \`mix\`, and cost **18,315 gzipped
       * bytes on \`core-only\`** across the sixteen fragment permutations.
       */
      float iesBase = iesRow * (uIesPlaneCount + 1.0);
      float iesV = uIesAtlasRows <= 1.0
        ? 0.5
        : (iesBase + iesTurns * uIesPlaneCount + 0.5) / uIesAtlasRows;
      float iesGain = textureLod(uIesAtlas, vec2(iesU, iesV), 0.0).r;
      float photometric = mix(1.0, iesGain, step(0.0, iesProfile));

      float shape = (uLightFalloff == 1 ? falloff : falloff * falloff) * coneFalloff * photometric;
      /*
       * The cookie tints rather than scales, because a mask may be coloured — a stained window is
       * the case that makes the difference — and a greyscale one is exactly a scale. Applied to
       * the light's colour rather than to \`shape\`, which is a scalar and could not carry it.
       */
      lightColor *= cookieTint;
      /*
       * **A metal has no diffuse term, and this lamp kept giving it one.**
       *
       * The sun's diffuse has been multiplied by \`(1 - metal)\` since metalness arrived. The lamps'
       * never was, and it is added *after* the environment blend, so it could not even be dimmed
       * by the reflection standing in front of it: every point light in a scene laid a full
       * Lambertian wash over a surface that physically reflects none of it, on top of everything
       * else the surface showed.
       *
       * **That wash is what a metal looked like.** A broad, soft, view-independent term is the
       * definition of matte, and in a room lit by its own fixtures it is most of the pixel — which
       * is why a chromed subject read as painted plastic in a lamp-lit hall, a garage and a night
       * street alike, and why raising what it reflected by four times moved almost nothing. The
       * reflection was not missing; it was being drowned.
       *
       * The light is not lost. What a metal does with a lamp arrives through the highlight below,
       * which is already metal-aware, and through the room it mirrors, which is where a lamp's
       * energy belongs on a metal.
       *
       * This was written once before and taken back out, because removing it alone made a metal
       * darker with nothing to replace what it lost. What replaces it is \`uEnvironmentGain\`: a
       * consumer whose rooms are darker than the surfaces standing in them can raise what those
       * surfaces reflect, rather than lighting a metal in a way metals are not lit.
       *
       * At metal 0 this is one multiply by 1.0 away from the expression it replaces.
       */
      lit += albedo * lightColor * ndl * shape * shaded * lightWeight * (1.0 - metal);

      /*
       * A lamp reflected in a polished surface, which point lights could not do at all.
       *
       * The specular term used to answer only to the dominant directional source, so a world
       * with no sun in it had no highlights in it either. That is fine outdoors and wrong
       * everywhere else: a waxed floor under a strip light reflects the *strip*, and it is
       * most of what tells you the floor is polished rather than merely pale. An interior lit
       * entirely by its own fixtures had no way to say so.
       *
       * Gated on vSpecular, which almost nothing carries, so the rest of the world pays one
       * compare per light. Shares the sun's exponent and the same shadow and weight terms, so
       * a highlight cannot outlive the light casting it or survive a light fading out.
       */
      /*
       * The metal half is there because vSpecular defaults to 0 and every mesh meshBuilder builds
       * takes that default, so a metal gated on the attribute alone would take no highlight from
       * any lamp in the scene. The condition is the old one exactly when metal is 0, so nothing
       * that binds no map takes a different branch than it took before.
       */
      if (vSpecular > 0.0 || metal > 0.0) {
        vec3 toEyeLamp = normalize(uCameraPos - vWorldPos);
        vec3 lampHalfway = normalize(toLight / max(dist, 1e-4) + toEyeLamp);
        /* The same grazing whitening the sun's highlight takes, and zero at metal 0. */
        vec3 lampSpec = mix(
          specColor,
          vec3(1.0),
          pow(1.0 - max(dot(toEyeLamp, lampHalfway), 0.0), 5.0) * metal
        );
        lit += lightColor * sphereLobe(max(dot(n, lampHalfway), 0.0), surfaceRoughness, lightSourceRadius, dist)
          * lampSpec * shape * shaded * lightWeight;
      }
      /*
       * The most any light in range shadows this point, for the emissive term below —
       * weighted, because this one is not a colour multiply and would otherwise ignore
       * the ramp entirely. A light arriving at zero brightness would still switch a
       * shadow onto the marked line it is arriving over, which is precisely the surface
       * it was first watched happening on.
       */
      lightShade = min(lightShade, mix(1.0, shaded, lightWeight));
    }

    /*
     * **Rectangular area lights: an exact diffuse integral and an approximate specular.**
     *
     * The diffuse half is the closed form of the cosine-weighted integral over a polygon, which is
     * what a linearly transformed cosine reduces to when its matrix is the identity — so this is
     * not an approximation of it, it *is* it. The specular half is a representative point handed to
     * \`sphereLobe\`, which widens a lobe by the source's subtended angle and renormalises its
     * energy; that is the approximate half, and it diverges from a fitted LTC at grazing angles
     * where the real lobe stretches along the view. Both are stated at their definitions.
     *
     * **A loop over a count rather than a permutation**, and the arithmetic is on record: thirty
     * lines of shared shader cost 6,215 gzipped bytes across the sixteen permutations this session
     * and fifty cost 10,517, while the fifth flag clustered lighting nearly took would have cost
     * 196,910. Compiled in unconditionally this is about a twentieth of what permuting it costs,
     * and a count of zero is what makes it free at runtime.
     *
     * **It occludes, as of 2026-08-28.** It used to not, and the note here said so: the pool is
     * octahedral and centred on a point, and a rectangle is not one. What settled it is that a
     * rectangle *does* have a point — its centre — and that the only thing separating an area
     * shadow from a point one is where the filter's width comes from. So the bake is a point
     * light's bake and the filter is an ellipse the size of the emitter; see \`areaShadow\` for
     * what that is exact about and what it approximates. Off unless a rectangle asks, because
     * every scene that already declared one was authored against a light that passed through
     * stone.
     */
    for (int a = 0; a < MAX_AREA_LIGHTS; a++) {
      if (a >= uAreaLightCount) break;
      vec3 centre = uAreaLightPos[a];
      vec3 right = uAreaLightRight[a];
      vec3 up = uAreaLightUp[a];
      vec2 halfSize = uAreaLightSize[a];

      /*
       * **Wound so a surface on the emitting side sees them counter-clockwise**, which is what
       * makes the form factor positive there. The natural order — minus, plus, plus, minus — winds
       * the other way, and every one-sided light then clamped to zero and the frame was black.
       */
      vec3 c0 = centre - right * halfSize.x + up * halfSize.y;
      vec3 c1 = centre + right * halfSize.x + up * halfSize.y;
      vec3 c2 = centre + right * halfSize.x - up * halfSize.y;
      vec3 c3 = centre - right * halfSize.x - up * halfSize.y;

      /*
       * **The sign is the sidedness.** A one-sided rectangle takes the positive part and a
       * two-sided one the magnitude — no facing test, because the sign already answers it exactly
       * per fragment rather than once for the rectangle's centre.
       */
      float signedForm = quadFormFactor(n, vWorldPos, c0, c1, c2, c3);
      float form = mix(max(0.0, signedForm), abs(signedForm), uAreaLightTwoSided[a]);
      if (form <= 0.0) continue;

      /*
       * **How much of the rectangle this fragment can actually see past whatever is in the way.**
       *
       * One octahedral layer baked from the rectangle's *centre*, filtered by an ellipse whose axes
       * are the rectangle's own — see \`areaShadow\`, which is where the emitter's shape enters.
       * Multiplies both halves below, because a surface in shadow is in shadow for its highlight
       * too: occluding only the diffuse term leaves a specular streak hanging in mid-air where the
       * caster is, which is the shape the water renderer's own notes call light passing through
       * stone.
       *
       * **Two layers, multiplied.** The static one holds the world and is baked once for a fixture
       * that does not move; the live one holds movers only and is refreshed every frame. Their
       * product is the composition, exactly as the point lights above compose theirs — a person
       * walking under a lit awning is in the live layer and the awning's posts are in the static
       * one, and neither map has to know about the other.
       *
       * **Not folded into \`lightShade\`**, which is what dims a self-lit surface when a lamp's
       * shadow crosses it. That term needs a per-light "is this light arriving" weight so a light
       * at zero brightness cannot switch a shadow onto a glowing inlay, and the point lights have
       * one in their own range ramp. An area light's \`form\` is an irradiance fraction rather than
       * a presence: it is 1 for a rectangle filling the sky and a few thousandths for a bright
       * panel across a room, so using it directly barely dims anything, and any threshold over it
       * is a constant nobody has measured. \`docs/IMPROVEMENTS.md\` carries the row.
       */
      float areaOccl = 1.0;
#if POINT_SHADOWS
      /*
       * The sample position is pushed along the surface normal before the lookup, and it scales
       * with how grazing the light is — the same cure and the same expression the point path uses a
       * few hundred lines up. Depth bias alone cannot fix a grazing receiver without peter-panning,
       * because one shadow texel then covers a stretch of floor whose depth changes faster than any
       * constant. The direction to the rectangle's *centre* is what "grazing" means here, which is
       * the same centre the map was baked from.
       */
      vec3 areaCentreVec = centre - vWorldPos;
      float areaCentreDist = length(areaCentreVec);
      float areaCentreNdl = areaCentreDist > 1e-4
        ? max(dot(n, areaCentreVec / areaCentreDist), 0.0)
        : 0.0;
      float areaGrazing = 1.0 - areaCentreNdl;
      float areaNormalOffset = (0.06 + areaCentreDist * 0.05) * areaGrazing * areaGrazing + 0.02;
      vec3 areaShadowFrom = (vWorldPos + n * areaNormalOffset) - centre;

      /*
       * \`-1\` is a rectangle with no image: one that declined to cast, one that named no range,
       * or one whose first bake has not landed yet. A layer index rather than a flag, for the
       * reason the point path's is one — GLSL ES cannot index a sampler array with a non-constant
       * expression, and a layer is an ordinary integer.
       */
      int areaLayer = uAreaShadowLayer[a];
      if (areaLayer >= 0) {
        areaOccl = mix(
          1.0,
          areaShadow(
            uPointShadows,
            float(areaLayer),
            areaShadowFrom,
            uAreaShadowFar[a],
            uAreaShadowNear[a],
            right,
            up,
            halfSize
          ),
          uAreaShadowWeight[a]
        );
      }
      int areaLiveLayer = uLiveAreaShadowLayer[a];
      if (areaLiveLayer >= 0) {
        areaOccl *= mix(
          1.0,
          areaShadow(
            uPointShadows,
            float(areaLiveLayer),
            areaShadowFrom,
            uLiveAreaShadowFar[a],
            uLiveAreaShadowNear[a],
            right,
            up,
            halfSize
          ),
          uLiveAreaShadowWeight[a]
        );
      }
#endif

      lit += albedo * uAreaLightColor[a] * form * (1.0 - metal) * areaOccl;

      if (vSpecular > 0.0 || metal > 0.0) {
        /*
         * **The lobe integrated over the rectangle, rather than sampled at one point on it.**
         *
         * What stood here handed the closest point on the rectangle to \`sphereLobe\` and scaled it
         * by \`form\`, the *diffuse* form factor. Measured against a brute-force integral by
         * \`scripts/areaSpecular.mjs\`, that lost the reflection rather than blurring it: on
         * polished metal facing a softbox it returned 0.000233 where the integral is 0.9207, and
         * head-on on a rough surface it was 3.7 times too bright. Worst 287% either way; this is
         * 40.1% where the light is what the surface reflects and 79.0% for one overhead.
         *
         * \`quadCoverage\` says what fraction of the specular lobe the rectangle covers and the
         * environment BRDF says how much the surface returns, which is the same split the probe
         * path uses. **\`dfg.x + dfg.y\` and not \`envSpecularEnergy\`**, deliberately and against
         * the obvious argument: the compensation returns the multiply-scattered share, and every
         * direct lobe in this shader is single-scattering, so adding it here returns energy the
         * light never had. Measured at 211% against 40.1%.
         */
        vec3 toEyeArea = normalize(uCameraPos - vWorldPos);
        float coverage = quadCoverage(n, vWorldPos, toEyeArea, surfaceRoughness, c0, c1, c2, c3);
        if (coverage > 0.0) {
          vec2 areaDfg = envBrdfApprox(max(dot(n, toEyeArea), 0.0), surfaceRoughness);
          vec3 areaSpec = specColor * areaDfg.x + vec3(areaDfg.y);
          lit += areaSpec * uAreaLightColor[a] * coverage * areaOccl;
        }
      }
    }

    /*
     * Self-illuminated geometry, dimmed where a lamp's shadow crosses it.
     *
     * Emission used to be added straight after the sun term and touched by nothing, so a
     * shadow could not land on a glowing surface at all — a character standing on the
     * terrace threw a shadow across the deck and the inlaid bands under it stayed at full
     * brightness, as though the shadow passed beneath them. Reported as the shadow going
     * *under* the inlaid markings rather than over them — and, narrowed down, as a fault
     * in the point lights' shadows specifically: a character's or a prop's, with the sun's
     * apparently unaffected.
     *
     * The sun is not affected because emission is gated on uNightFactor and so does not
     * exist by day, when the sun's shadow is the one being cast. At night the lamps are the
     * light and their occlusion is per-light inside the loop above, which the emissive term
     * never saw. Hence lightShade: the most any lamp in range shadows this point.
     *
     * Only a share of it, because none of these surfaces is a pure emitter — a lit inlay is
     * worked stone with light coming through it, and the stone is shadowed like everything
     * else. Taking all of it would darken a lamp head because something crossed in front of
     * it, which is a worse picture than the one being fixed.
     */
    /*
     * The sun and the moon shadow a glowing surface too.
     *
     * lightShade fixed this for lamps and stopped there, on the reasoning that
     * emission is gated on uNightFactor and so does not exist by day, when the sun's
     * shadow is the one being cast. That is true at noon and false at every hour that
     * matters: at dusk the bands are already lit and the sun is at its longest, and at
     * night the moon is the directional source and casts exactly the same way.
     *
     * So an emissive deck — emissive 0.55 — took a lamp post's shadow from a lamp and
     * not from the sky, and a post that threw a long shadow across the grass by day
     * threw none across the deck at night. Reported as self-shadowing that was present
     * under the sun and gone at night.
     *
     * Same share as the lamps get, and for the same reason: these surfaces are worked
     * stone with light coming through, not pure emitters, so taking all of it would
     * black out a lamp head because something crossed in front of it.
     */
    /*
     * What a surface emits is not always what it is made of.
     *
     * A negative component means no colour was named, and the term falls back to the albedo,
     * which is this engine's original behaviour and right for anything glowing because it is
     * hot or lit from within. Where a colour is named it replaces the albedo outright rather
     * than tinting it, because the point is a glow whose hue is independent of the paint
     * underneath: a ceiling emitting a dull warm haze over a pale panel cannot be expressed
     * by scaling the panel, and scaling it gets the brightness right and the hue wrong.
     */
    vec3 emissiveTint = vEmissiveColor.r < 0.0 ? albedo : vEmissiveColor;
    /*
     * Where the surface glows, from an image, or everywhere if it binds none.
     *
     * **A multiplier of exactly 1 when no map is bound**, so this line collapses to the arithmetic
     * it replaces bit for bit — which is what the zero-pixel gate on the published scenes is
     * measuring, none of them binding one.
     *
     * **It modulates the emission rather than creating it**, which is glTF's rule: emitted colour
     * is the factor times the texture. A mesh whose \`vEmissive\` is 0 stays dark however bright the
     * image, because the whole term is still multiplied by it. That is stated here as well as at
     * \`SurfaceMaterial.emissive\`, because this is where somebody debugging a model that will not
     * glow ends up looking.
     *
     * The branch is on a uniform, so the \`texture\` call sits in uniform control flow and needs no
     * explicit level — the 2026-08-07 rule is satisfied by the gate rather than by a \`textureLod\`.
     */
    vec3 emissiveMapped = vec3(1.0);
    if (uEmissiveMapEnabled != 0) {
      emissiveMapped = texture(uEmissiveMap, vUv).rgb * uEmissiveScale;
    }
    lit += emissiveTint * emissiveMapped * uEmissiveGain * vEmissive * uNightFactor
      * mix(1.0, min(lightShade, sunShade), EMISSIVE_SHADOW_SHARE);

#if NIGHT_EMISSIVE
    /*
     * And the same emission again, weighted by how far this surface faces away from the sun.
     *
     * uDirectionalDir points from the surface toward the source, so its negative dot with the
     * normal is how far into its own night this fragment is: 0 anywhere the sun can see and 1 at
     * the antisolar point. Added rather than mixed, and outside uNightFactor, because a body that
     * turns has a night side at every hour of whatever clock the world is keeping.
     *
     * Not shadowed by lightShade: a city is not switched off by a mountain standing in front of
     * the sun, and the term is already zero everywhere the sun reaches.
     *
     * **It is not free when it is off, and that is measured rather than assumed.** Held on the
     * gilded chamber with uNightEmissive at 0, against the build before this term existed: 110
     * pixels of 750,080 move, in scattered clusters of two to four, mean delta 17. Isolated by
     * elimination: the uniform declared and never used moves 0 pixels, the branch present with an
     * empty body moves 1, which is that scene's own floor, and the arithmetic above moves 110. So
     * it is the added instructions perturbing the rounding of shared subexpressions, and what
     * lands on screen is a shadow comparison sitting exactly on its boundary flipping sides.
     * Neither result is more correct than the other. Sharing the dot product above was tried as a
     * repair and changed nothing.
     */
    if (uNightEmissive > 0.0) {
      /* The same emission, so the same map: a night side is not a different material. */
      lit += emissiveTint * emissiveMapped * uNightEmissive * vEmissive * max(-sunDot, 0.0);
    }
#endif

    // Arrival glow: a world-space box lit independently of the clock, so
    // finishing a run reads the same at noon and at midnight. Costs one compare
    // per fragment and no extra draw call — the box is a uniform, not geometry.
    if (uHighlightGain > 0.0) {
      vec3 inside = step(uHighlightMin, vWorldPos) * step(vWorldPos, uHighlightMax);
      lit += albedo * uHighlightGain * inside.x * inside.y * inside.z;
    }
  }

  /*
   * The medium: fog and the underwater tint, both — see \`uFogEnabled\`'s own comment for why
   * the two are folded together and what a draw that skips them gives up. Every other pass in
   * the renderer binds \`uUnderwaterFactor\` unconditionally so that crossing the surface moves
   * the whole scene together; this is the one draw where that is the caller's choice.
   */
  /*
   * Baked occlusion, over everything this surface contributes.
   *
   * **Deliberately the same scope as the screen-space AO the composite pass applies**, which
   * multiplies the whole frame including direct light and emissive — see rush.ts. The narrower
   * physical reading, ambient and reflection only, was considered and not taken: consistency with
   * the effect already shipping won over it.
   *
   * **The stated cost of that is a double count with the shadow maps.** Where a baked crevice and
   * a cast shadow fall on the same fragment, both darken it, and the ambient-only reading would
   * not have. If that ever becomes visible enough to report, narrowing this is the fix.
   *
   * Outside the lighting branch, so an unlit draw — uLightingEnabled at 0, which is
   * meshBasicMaterial — is occluded too. Before the fog block, because fog is between the eye and
   * the surface, and darkening it would darken the air in front of a crevice rather than the
   * crevice.
   *
   * Exactly 1.0 with no map bound, so this is a multiply by one on every published scene.
   */
  lit *= ormOcclusion;

  float fog = 0.0;
  if (uFogEnabled != 0) {
    // Water is a camera medium, not a property of individual objects.
    vec3 waterTransmission = vec3(0.42) + uUnderwaterColor * 2.0;
    lit = mix(lit, lit * waterTransmission, uUnderwaterFactor * 0.55);
    fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);
  }

  vec3 shaded = applyOutputTransform(mix(lit, mediumColor(), fog));

  /*
   * **Refraction: the scene behind this surface, bent and absorbed.**
   *
   * The offset is along the surface normal in screen space, which is the cheap approximation every
   * real-time renderer ships rather than a ray traced through two interfaces of a solid. What it
   * cannot do is show anything the frame had not already drawn, so a pane at the edge of the frame
   * refracts what is beside it -- and the clamp below is what keeps that from being worse than
   * that. Without it a sample walks off the edge and wraps, which reads as a tear rather than as
   * an approximation.
   *
   * **Beer-Lambert, with the caller stating what survives one metre** rather than an absorption
   * coefficient: pow(tint, d) is exp(d * log(tint)), so a tint of one is clear glass with no
   * special case and there is no log of zero at the API to trap on. What it costs is that a caller
   * holding coefficients from a reference converts them once.
   *
   * **The path length divides by the view angle, and that is the whole reason this is not a
   * tint.** A slab seen edge-on is more glass than the same slab seen face-on, which is what makes
   * a glass edge go green while its middle stays clear; a tint multiplied straight in gives the
   * same colour at every angle. The clamp is a floor on the grazing case rather than a tolerance:
   * dot reaches zero at the silhouette, and an unclamped divide takes the pixel to infinity and
   * then to a NaN, which takes the fragment with it. Twenty thicknesses is where it caps, so a
   * medium that should go opaque at a grazing angle stops getting darker there.
   *
   * **It replaces the surface's own shading rather than mixing with it, and the strength is the
   * offset alone.** Mixing by the strength was tried first and is wrong twice over: the offset and
   * the amount of background shown are different quantities, so one scalar cannot be both -- a
   * plausible offset of 0.025 UV then meant a 2.5% blend, and a pane of glass drew as flat paint
   * over the thing it was supposed to be showing. Found by this row's own check, where every bar
   * behind the pane vanished.
   *
   * What replacing costs is the surface's own highlight: glass here shows the scene behind it and
   * not a specular of its own, because by this line the shaded colour has the lighting, the fog and
   * the tone curve already folded into it and there is no specular left to keep. A caller wanting a
   * glint draws a second, non-refracting pass over the same geometry. What would change it is
   * splitting the specular out before the fog, which is a larger change to the one shader every
   * draw uses.
   */
  if (uRefractStrength > 0.0) {
    vec3 refractN = normalize(vNormal);
    vec3 refractV = normalize(uCameraPos - vWorldPos);
    vec2 screenUv = gl_FragCoord.xy / vec2(textureSize(uRefractScene, 0));
    vec2 bent = clamp(screenUv + refractN.xy * uRefractStrength, vec2(0.0), vec2(1.0));
    vec3 behind = texture(uRefractScene, bent).rgb;
    float pathLength = uRefractThickness * vThickness / max(dot(refractN, refractV), 0.05);
    shaded = behind * pow(uRefractTint, vec3(pathLength));
  }
  /*
   * The per-vertex alpha lane, folded in here rather than given an expression of its own so the
   * order-independent branch below inherits it through the same local. 1.0 when absent.
   *
   * **It did not need MeshData.colors widened to four floats**, which is how the consumer who
   * asked for it had costed the change -- widening colors moves every mesh producer, the
   * container layout and every baked asset. Alpha is a factor on the draw's opacity, not a
   * component of its albedo, so it rides a lane instead and nothing existing moves.
   */
  float alpha = uOpacity * coverage * vAlpha;

  /*
   * **Order-independent transparency, when this draw is accumulating into it.**
   *
   * The weight falls off with distance so a near layer counts for more than a far one, and it is
   * clamped at both ends: without a ceiling a fragment on the near plane takes a weight large
   * enough to swamp the others inside a 16-bit target, and without a floor a distant one rounds to
   * nothing and vanishes rather than fading. The same arithmetic is \`oitWeight\` in
   * \`orderIndependent.ts\`, where it is asserted against numbers.
   *
   * The output is premultiplied and weighted, against a blend of \`(ONE, ONE)\`, so the target ends
   * up holding the weighted sum of colour and the weighted sum of alpha. The revealage pass draws
   * the same geometry with this at 0, where the branch below is not taken at all.
   */
  if (uOitWeighted != 0.0) {
    float z = distance(vWorldPos, uCameraPos) / 200.0;
    float falloff = 0.03 / (1e-5 + z * z * z * z);
    float w = alpha * clamp(falloff, 1e-2, 3e3);
    outColor = vec4(shaded * alpha * w, alpha * w);
    return;
  }

  outColor = vec4(shaded, alpha);
}
`;
