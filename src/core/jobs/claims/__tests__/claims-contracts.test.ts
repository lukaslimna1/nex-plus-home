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

    it('converte fencing_token de bigint ou number retornado pelo driver para string decimal', () => {
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

      const snapshot = mapRowToJobClaimSnapshot(rowBigInt);
      assert.equal(snapshot.fencingToken, '42');
      assert.equal(typeof snapshot.fencingToken, 'string');
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
