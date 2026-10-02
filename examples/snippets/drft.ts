/**
 * A `.drft` written from geometry made in code, and read back whole.
 *
 * A snippet, typechecked with the examples and quoted by the manual's `.drft` chapter.
 */
import { LoadTracker, MeshBuilder } from '@driftengine/core';
import { readDrft, writeDrft } from '@driftengine/drft';

// #region write
/** Two meshes and a name: everything else a container can carry is optional. */
const crate = new MeshBuilder().addBox([0, 0.5, 0], [0.5, 0.5, 0.5], [0.6, 0.45, 0.3]).build();
const lid = new MeshBuilder().addBox([0, 1.05, 0], [0.55, 0.05, 0.55], [0.4, 0.3, 0.2]).build();
export const file: ArrayBuffer = writeDrft({ head: { name: 'crate' }, meshes: [crate, lid] });
// #endregion

// #region read
/** Read whole: each array is a view over the file's own bytes, with nothing parsed or copied. */
export function describe(bytes: ArrayBuffer): string {
  const asset = readDrft(bytes);
  const vertices = asset.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  return `${asset.head.name}: ${asset.meshes.length} meshes, ${vertices} vertices`;
}
// #endregion

// #region tracker
/** Everything a loading screen waits on, weighted, so its bar means something. */
const loading = new LoadTracker();
loading.add('level', 4_000_000);
loading.add('music', 900_000);
loading.add('settings', 2_000);

/** Each part reports as it goes; the summary is the weighted whole and the one to talk about. */
export function loadingLine(levelFraction: number): string {
  loading.report('level', levelFraction);
  const { fraction, activeId } = loading.summary;
  return `${Math.round(fraction * 100)}%, waiting on the ${activeId}`;
}
// #endregion
