import * as migration_20260817_230927_foundation from './20260817_230927_foundation';
import * as migration_20260820_030631_multiuser_auth from './20260820_030631_multiuser_auth';
import * as migration_20260821_210000_observation_persistence from './20260821_210000_observation_persistence';
import * as migration_20260821_220000_evidence_artifact_store from './20260821_220000_evidence_artifact_store';
import * as migration_20260821_230000_reconciliation_and_precedents from './20260821_230000_reconciliation_and_precedents';

export const migrations = [
  {
    up: migration_20260817_230927_foundation.up,
    down: migration_20260817_230927_foundation.down,
    name: '20260817_230927_foundation',
  },
  {
    up: migration_20260820_030631_multiuser_auth.up,
    down: migration_20260820_030631_multiuser_auth.down,
    name: '20260820_030631_multiuser_auth',
  },
  {
    up: migration_20260821_210000_observation_persistence.up,
    down: migration_20260821_210000_observation_persistence.down,
    name: '20260821_210000_observation_persistence',
  },
  {
    up: migration_20260821_220000_evidence_artifact_store.up,
    down: migration_20260821_220000_evidence_artifact_store.down,
    name: '20260821_220000_evidence_artifact_store',
  },
  {
    up: migration_20260821_230000_reconciliation_and_precedents.up,
    down: migration_20260821_230000_reconciliation_and_precedents.down,
    name: '20260821_230000_reconciliation_and_precedents',
  },
];
