import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import {
  FACE_COUNT,
  pointShadowFaceRotation,
  pointShadowFaceViewProj,
} from './pointShadowImage.ts';

/** The resolve shader's tie-breaking, exactly: x first, then y, then z. */
function dominantFace(d: readonly number[]): number {
  const x = d[0] ?? 0;
  const y = d[1] ?? 0;
  const z = d[2] ?? 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

/** A deterministic spread over the sphere at five metres, so a failure reproduces. */
function probes(): number[][] {
  const out: number[][] = [];
  let s = 7;
  const next = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < 600; i++) {
    const d = vec3.fromValues(next(), next(), next());
    if (vec3.length(d) < 1e-3) continue;
    vec3.scale(d, vec3.normalize(d, d), 5);
    out.push([d[0], d[1], d[2]]);
  }
  return out;
}

/*
 * The resolve projects a direction with the rotation; the bake rasterises it with the frustum.
 *
 * If the two disagree about a face's up vector — or about which way `lookAt` looks, which is down
 * `-z` — then every octahedral texel of that face is read from the wrong place. That looks like a
 * lighting bug and is a transcription error, which is the whole reason both come off one
 * `FACE_TARGETS` table and the whole reason this is asserted rather than argued about.
 *
 * **This is what fixes the sign in the resolve shader.** It divides by `-v.z`; if that were
 * `v.z` this fails on all six faces at once.
 */
test('the face rotation and the face frustum agree on every face', () => {
  const rotation = mat3.create();
  const viewProj = mat4.create();
  const view = vec3.create();
  const clip = vec4.create();
  const all = probes();
  for (let face = 0; face < FACE_COUNT; face++) {
    pointShadowFaceRotation(face, rotation);
    pointShadowFaceViewProj(face, 0, 0, 0, 0.25, 20, viewProj);
    let checked = 0;
    for (const d of all) {
      if (dominantFace(d) !== face) continue;
      checked++;

      vec3.set(view, d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
      vec3.transformMat3(view, view, rotation);
      const forward = -view[2];
      const fromRotation = [(view[0] / forward) * 0.5 + 0.5, (view[1] / forward) * 0.5 + 0.5];

      vec4.set(clip, d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, 1);
      vec4.transformMat4(clip, clip, viewProj);
      const fromFrustum = [(clip[0] / clip[3]) * 0.5 + 0.5, (clip[1] / clip[3]) * 0.5 + 0.5];

      expect(fromRotation[0] ?? 0, `face ${face} u`).toBeCloseTo(fromFrustum[0] ?? 0, 5);
      expect(fromRotation[1] ?? 0, `face ${face} v`).toBeCloseTo(fromFrustum[1] ?? 0, 5);
    }
    expect(checked, `face ${face} had probes to check`).toBeGreaterThan(10);
  }
});
