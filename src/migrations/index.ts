import * as migration_20260817_144409_foundation from './20260817_144409_foundation';

export const migrations = [
  {
    up: migration_20260817_144409_foundation.up,
    down: migration_20260817_144409_foundation.down,
    name: '20260817_144409_foundation'
  },
];
