import * as migration_20260817_230927_foundation from './20260817_230927_foundation';

export const migrations = [
  {
    up: migration_20260817_230927_foundation.up,
    down: migration_20260817_230927_foundation.down,
    name: '20260817_230927_foundation'
  },
];
