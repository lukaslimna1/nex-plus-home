/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Testes Unitários de Mapeamento, Estado Derivado e Erros Estruturados (0.86C-3B)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapRowToJobClaimSnapshot,
  PostgresJobClaimStore,
} from '../postgres';
import {
  CorruptedJobClaimStorageError,
  JobClaimJobNotFoundError,
  JobClaimStaleError,
} from '../errors';
import type { JobClaimPgExecutor, JobClaimPgQueryResult } from '../contracts';

describe('Canonical Job Claims — Mapping, States & Error Boundaries (0.86C-3B)', () => {
  const baseNow = new Date('2026-09-28T12:00:00.000Z');
  const futureLease = new Date('2026-09-28T12:05:00.000Z');
  const pastLease = new Date('2026-09-28T11:55:00.000Z');

  describe('mapRowToJobClaimSnapshot', () => {
    it('mapeia claim ativo corretamente (released_at nulo e lease_until > db_now)', () => {
      const row = {
        job_id: 'job_001',
        worker_id: 'worker_alpha',
        fencing_token: '1',
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
        db_now: baseNow,
      };

      const snapshot = mapRowToJobClaimSnapshot(row);
      assert.equal(snapshot.jobId, 'job_001');
      assert.equal(snapshot.workerId, 'worker_alpha');
      assert.equal(snapshot.fencingToken, '1');
      assert.equal(snapshot.acquiredAt, baseNow.toISOString());
      assert.equal(snapshot.renewedAt, baseNow.toISOString());
      assert.equal(snapshot.leaseUntil, futureLease.toISOString());
      assert.equal(snapshot.releasedAt, null);
      assert.equal(snapshot.state, 'active');
      assert.ok(Object.isFrozen(snapshot));
    });

    it('mapeia claim expirado (released_at nulo e lease_until <= db_now)', () => {
      const row = {
        job_id: 'job_002',
        worker_id: 'worker_beta',
        fencing_token: '5',
        acquired_at: new Date('2026-09-28T11:00:00.000Z'),
        renewed_at: new Date('2026-09-28T11:30:00.000Z'),
        lease_until: pastLease,
        released_at: null,
        db_now: baseNow,
      };

      const snapshot = mapRowToJobClaimSnapshot(row);
      assert.equal(snapshot.state, 'expired');
      assert.equal(snapshot.fencingToken, '5');
      assert.equal(snapshot.releasedAt, null);
    });

    it('mapeia claim liberado com prioridade (released_at preenchido)', () => {
      const releaseTime = new Date('2026-09-28T12:02:00.000Z');
      const row = {
        job_id: 'job_003',
        worker_id: 'worker_gamma',
        fencing_token: '12',
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: releaseTime,
        db_now: baseNow,
      };

      const snapshot = mapRowToJobClaimSnapshot(row);
      assert.equal(snapshot.state, 'released');
      assert.equal(snapshot.releasedAt, releaseTime.toISOString());
    });

    it('preserva fencing_token como string decimal ou bigint exato e rejeita tipo number (lossless)', () => {
      // 1. string decimal positiva
      const rowStr = {
        job_id: 'job_str',
        worker_id: 'w1',
        fencing_token: '42',
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
        db_now: baseNow,
      };
      const snapStr = mapRowToJobClaimSnapshot(rowStr);
      assert.equal(snapStr.fencingToken, '42');

      // 2. bigint positivo
      const rowBigInt = {
        job_id: 'job_bigint',
        worker_id: 'w1',
        fencing_token: BigInt(42),
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
        db_now: baseNow,
      };
      const snapBigInt = mapRowToJobClaimSnapshot(rowBigInt);
      assert.equal(snapBigInt.fencingToken, '42');
      assert.equal(typeof snapBigInt.fencingToken, 'string');

      // 3. string grande além de MAX_SAFE_INTEGER preservada sem perda de precisão
      const rowLargeStr = {
        job_id: 'job_large_str',
        worker_id: 'w1',
        fencing_token: '9007199254740993',
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
        db_now: baseNow,
      };
      const snapLargeStr = mapRowToJobClaimSnapshot(rowLargeStr);
      assert.equal(snapLargeStr.fencingToken, '9007199254740993');

      // 4. bigint grande além de MAX_SAFE_INTEGER preservado sem perda de precisão
      const rowLargeBigInt = {
        job_id: 'job_large_bigint',
        worker_id: 'w1',
        fencing_token: BigInt('9007199254740993'),
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
        db_now: baseNow,
      };
      const snapLargeBigInt = mapRowToJobClaimSnapshot(rowLargeBigInt);
      assert.equal(snapLargeBigInt.fencingToken, '9007199254740993');

      // 5. number JS (mesmo safe) é rejeitado com CorruptedJobClaimStorageError
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...rowStr,
            fencing_token: 42,
          }),
        CorruptedJobClaimStorageError
      );

      // 6. unsafe number JS é rejeitado com CorruptedJobClaimStorageError
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...rowStr,
            fencing_token: 9007199254740993,
          }),
        CorruptedJobClaimStorageError
      );
    });

    it('exige db_now obrigatório e falha fechado com CorruptedJobClaimStorageError quando ausente ou inválido', () => {
      const validBase = {
        job_id: 'job_now_test',
        worker_id: 'w1',
        fencing_token: '1',
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
      };

      // db_now ausente (undefined)
      assert.throws(
        () => mapRowToJobClaimSnapshot({ ...validBase }),
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobClaimStorageError);
          assert.match(err.message, /Field 'db_now' is required/);
          return true;
        }
      );

      // db_now nulo
      assert.throws(
        () => mapRowToJobClaimSnapshot({ ...validBase, db_now: null }),
        CorruptedJobClaimStorageError
      );

      // db_now string inválida
      assert.throws(
        () => mapRowToJobClaimSnapshot({ ...validBase, db_now: 'not-a-date' }),
        CorruptedJobClaimStorageError
      );

      // db_now tipo inesperado (number)
      assert.throws(
        () => mapRowToJobClaimSnapshot({ ...validBase, db_now: 123456789 }),
        CorruptedJobClaimStorageError
      );
    });

    it('valida sanidade temporal estrita e falha fechado com CorruptedJobClaimStorageError em estados impossíveis', () => {
      const validBase = {
        job_id: 'job_time_test',
        worker_id: 'w1',
        fencing_token: '1',
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: null,
        db_now: baseNow,
      };

      // 1. renewed_at < acquired_at
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...validBase,
            acquired_at: futureLease,
            renewed_at: pastLease,
            lease_until: new Date('2026-09-28T13:00:00.000Z'),
          }),
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobClaimStorageError);
          assert.match(err.message, /renewed_at .* cannot be earlier than acquired_at/);
          return true;
        }
      );

      // 2. lease_until <= renewed_at (igual ou menor)
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...validBase,
            acquired_at: baseNow,
            renewed_at: baseNow,
            lease_until: baseNow, // igual a renewed_at
          }),
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobClaimStorageError);
          assert.match(err.message, /lease_until .* must be strictly later than renewed_at/);
          return true;
        }
      );

      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...validBase,
            acquired_at: baseNow,
            renewed_at: baseNow,
            lease_until: pastLease, // anterior a renewed_at
          }),
        CorruptedJobClaimStorageError
      );

      // 3. lease_until < acquired_at
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...validBase,
            acquired_at: baseNow,
            renewed_at: pastLease, // já viola renewed_at < acquired_at
            lease_until: pastLease,
          }),
        CorruptedJobClaimStorageError
      );

      // 4. released_at < acquired_at
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...validBase,
            acquired_at: baseNow,
            renewed_at: baseNow,
            lease_until: futureLease,
            released_at: pastLease, // anterior a acquired_at
          }),
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobClaimStorageError);
          assert.match(err.message, /released_at .* cannot be earlier than acquired_at/);
          return true;
        }
      );

      // 5. released_at < renewed_at
      const laterRenewed = new Date('2026-09-28T12:02:00.000Z');
      const earlierRelease = new Date('2026-09-28T12:01:00.000Z');
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            ...validBase,
            acquired_at: baseNow,
            renewed_at: laterRenewed,
            lease_until: futureLease,
            released_at: earlierRelease, // posterior a acquired_at mas anterior a renewed_at
          }),
        (err: unknown) => {
          assert.ok(err instanceof CorruptedJobClaimStorageError);
          assert.match(err.message, /released_at .* cannot be earlier than renewed_at/);
          return true;
        }
      );

      // 6. released_at > lease_until é estruturalmente permitido (ex: liberação tardia registrada)
      const lateRelease = new Date('2026-09-28T12:10:00.000Z');
      const snapLate = mapRowToJobClaimSnapshot({
        ...validBase,
        acquired_at: baseNow,
        renewed_at: baseNow,
        lease_until: futureLease,
        released_at: lateRelease,
        db_now: lateRelease,
      });
      assert.equal(snapLate.state, 'released');
      assert.equal(snapLate.releasedAt, lateRelease.toISOString());
    });

    it('falha fechado com CorruptedJobClaimStorageError sob corrupção de storage', () => {
      // Row nula ou não objeto
      assert.throws(() => mapRowToJobClaimSnapshot(null), CorruptedJobClaimStorageError);

      // jobId vazio
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            job_id: '',
            worker_id: 'w1',
            fencing_token: '1',
            acquired_at: baseNow,
            renewed_at: baseNow,
            lease_until: futureLease,
            db_now: baseNow,
          }),
        CorruptedJobClaimStorageError
      );

      // workerId vazio
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            job_id: 'j1',
            worker_id: '  ',
            fencing_token: '1',
            acquired_at: baseNow,
            renewed_at: baseNow,
            lease_until: futureLease,
            db_now: baseNow,
          }),
        CorruptedJobClaimStorageError
      );

      // fencing_token malformado (0 ou negativo)
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            job_id: 'j1',
            worker_id: 'w1',
            fencing_token: '0',
            acquired_at: baseNow,
            renewed_at: baseNow,
            lease_until: futureLease,
            db_now: baseNow,
          }),
        CorruptedJobClaimStorageError
      );

      // timestamp inválido
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            job_id: 'j1',
            worker_id: 'w1',
            fencing_token: '1',
            acquired_at: 'invalid-date',
            renewed_at: baseNow,
            lease_until: futureLease,
            db_now: baseNow,
          }),
        CorruptedJobClaimStorageError
      );

      // temporalidade impossível: renewed_at anterior a acquired_at
      assert.throws(
        () =>
          mapRowToJobClaimSnapshot({
            job_id: 'j1',
            worker_id: 'w1',
            fencing_token: '1',
            acquired_at: futureLease,
            renewed_at: pastLease,
            lease_until: futureLease,
            db_now: baseNow,
          }),
        CorruptedJobClaimStorageError
      );
    });
  });

  describe('PostgresJobClaimStore — Mocked Queries & Boundaries', () => {
    it('acquireClaim retorna acquired: true quando PostgreSQL retorna row', async () => {
      const mockExecutor: JobClaimPgExecutor = {
        async query<T>(_sql: string, _params?: unknown[]): Promise<JobClaimPgQueryResult<T>> {
          return {
            rows: [
              {
                job_id: 'job_test_1',
                worker_id: 'worker_x',
                fencing_token: '1',
                acquired_at: baseNow,
                renewed_at: baseNow,
                lease_until: futureLease,
                released_at: null,
                db_now: baseNow,
              } as T,
            ],
            rowCount: 1,
          };
        },
      };

      const store = new PostgresJobClaimStore(mockExecutor);
      const res = await store.acquireClaim({
        jobId: 'job_test_1',
        workerId: 'worker_x',
        leaseDurationMs: 30000,
      });

      assert.equal(res.acquired, true);
      if (res.acquired) {
        assert.equal(res.claim.jobId, 'job_test_1');
        assert.equal(res.claim.workerId, 'worker_x');
        assert.equal(res.claim.fencingToken, '1');
        assert.equal(res.claim.state, 'active');
      }
    });

    it('acquireClaim retorna acquired: false, reason: held quando 0 rows retornadas', async () => {
      const mockExecutor: JobClaimPgExecutor = {
        async query<T>(_sql: string, _params?: unknown[]): Promise<JobClaimPgQueryResult<T>> {
          return { rows: [], rowCount: 0 };
        },
      };

      const store = new PostgresJobClaimStore(mockExecutor);
      const res = await store.acquireClaim({
        jobId: 'job_test_1',
        workerId: 'worker_y',
        leaseDurationMs: 30000,
      });

      assert.equal(res.acquired, false);
      if (!res.acquired) {
        assert.equal(res.reason, 'held');
      }
    });

    it('acquireClaim mapeia erro FK 23503 para JobClaimJobNotFoundError', async () => {
      const mockExecutor: JobClaimPgExecutor = {
        async query<T>(_sql: string, _params?: unknown[]): Promise<JobClaimPgQueryResult<T>> {
          const fkErr = new Error('insert or update on table "nex_job_claims" violates foreign key constraint');
          (fkErr as unknown as { code: string }).code = '23503';
          throw fkErr;
        },
      };

      const store = new PostgresJobClaimStore(mockExecutor);
      await assert.rejects(
        () =>
          store.acquireClaim({
            jobId: 'non_existent_job',
            workerId: 'worker_x',
            leaseDurationMs: 10000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof JobClaimJobNotFoundError);
          assert.equal(err.code, 'JOB_NOT_FOUND');
          assert.equal(err.jobId, 'non_existent_job');
          return true;
        }
      );
    });

    it('renewClaim falha com JobClaimStaleError quando rowCount === 0', async () => {
      const mockExecutor: JobClaimPgExecutor = {
        async query<T>(_sql: string, _params?: unknown[]): Promise<JobClaimPgQueryResult<T>> {
          return { rows: [], rowCount: 0 };
        },
      };

      const store = new PostgresJobClaimStore(mockExecutor);
      await assert.rejects(
        () =>
          store.renewClaim({
            jobId: 'job_stale',
            workerId: 'worker_old',
            fencingToken: '1',
            leaseDurationMs: 10000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof JobClaimStaleError);
          assert.equal(err.code, 'JOB_CLAIM_STALE');
          assert.equal(err.jobId, 'job_stale');
          assert.equal(err.fencingToken, '1');
          return true;
        }
      );
    });

    it('releaseClaim falha com JobClaimStaleError quando rowCount === 0', async () => {
      const mockExecutor: JobClaimPgExecutor = {
        async query<T>(_sql: string, _params?: unknown[]): Promise<JobClaimPgQueryResult<T>> {
          return { rows: [], rowCount: 0 };
        },
      };

      const store = new PostgresJobClaimStore(mockExecutor);
      await assert.rejects(
        () =>
          store.releaseClaim({
            jobId: 'job_stale',
            workerId: 'worker_old',
            fencingToken: '1',
          }),
        (err: unknown) => {
          assert.ok(err instanceof JobClaimStaleError);
          assert.equal(err.code, 'JOB_CLAIM_STALE');
          return true;
        }
      );
    });

    it('getJobClaim retorna undefined quando não há registro', async () => {
      const mockExecutor: JobClaimPgExecutor = {
        async query<T>(_sql: string, _params?: unknown[]): Promise<JobClaimPgQueryResult<T>> {
          return { rows: [], rowCount: 0 };
        },
      };

      const store = new PostgresJobClaimStore(mockExecutor);
      const res = await store.getJobClaim('job_empty');
      assert.equal(res, undefined);
    });
  });
});
