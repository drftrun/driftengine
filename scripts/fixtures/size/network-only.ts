import {
  InputLog,
  RewindLoop,
  combineSnapshotters,
  randomSnapshotter,
  worldSnapshotter,
} from '@driftengine/network';
export const entry = [
  RewindLoop,
  InputLog,
  worldSnapshotter,
  randomSnapshotter,
  combineSnapshotters,
];
