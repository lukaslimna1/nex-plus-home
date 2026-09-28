/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Implementação PostgreSQL de Claims, Leases e Fencing Monotônico — Escopo 0.86 (0.86C-3B)
 *
 * Princípios Fundamentais:
 * 1. Autoridade operacional exclusiva do NEX sobre a tabela nex_job_claims.
 * 2. Aquisição atômica e imune a race conditions via INSERT ... ON CONFLICT DO UPDATE.
 * 3. Fencing token estritamente monotônico por Job (bigint no DB, string decimal positiva no boundary).
 * 4. Toda expiração e renovação consulta o relógio atômico do PostgreSQL (CURRENT_TIMESTAMP(3)).
 * 5. Fail-closed em corrupção de dados ou violação referencial com nex_job_heads.
 */

import type {
  AcquireJobClaimParams,
  AcquireJobClaimResult,
  JobClaimPgExecutor,
  JobClaimSnapshot,
  JobClaimState,
  JobClaimStore,
  ReleaseJobClaimParams,
  RenewJobClaimParams,
} from './contracts';
import {
  CorruptedJobClaimStorageError,
  JobClaimJobNotFoundError,
  JobClaimStaleError,
} from './errors';
import {
  FENCING_TOKEN_REGEX,
  assertAcquireJobClaimParams,
  assertJobId,
  assertReleaseJobClaimParams,
  assertRenewJobClaimParams,
} from './invariants';

export interface RawClaimRow {
  readonly job_id: unknown;
  readonly worker_id: unknown;
  readonly fencing_token: unknown;
  readonly acquired_at: unknown;
  readonly renewed_at: unknown;
  readonly lease_until: unknown;
  readonly released_at: unknown;
  readonly db_now: unknown;
}

function parseDbDate(value: unknown, fieldName: string, jobId?: string): Date {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new CorruptedJobClaimStorageError(`Field '${fieldName}' is an invalid Date object.`, jobId);
    }
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new CorruptedJobClaimStorageError(`Field '${fieldName}' is an invalid timestamp string: '${value}'.`, jobId);
    }
    return d;
  }

  throw new CorruptedJobClaimStorageError(`Field '${fieldName}' must be a valid Date or timestamp string, received: ${String(value)}.`, jobId);
}

export function mapRowToJobClaimSnapshot(raw: unknown): JobClaimSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new CorruptedJobClaimStorageError('Claim row must be a non-null object.');
  }

  const row = raw as RawClaimRow;
  const rawJobId = row.job_id;

  if (typeof rawJobId !== 'string' || rawJobId.trim().length === 0) {
    throw new CorruptedJobClaimStorageError('Field job_id must be a non-empty string.');
  }
  const jobId = rawJobId;

  if (typeof row.worker_id !== 'string' || row.worker_id.trim().length === 0) {
    throw new CorruptedJobClaimStorageError('Field worker_id must be a non-empty string.', jobId);
  }
  const workerId = row.worker_id;

  let fencingToken: string;
  if (typeof row.fencing_token === 'string') {
    fencingToken = row.fencing_token;
  } else if (typeof row.fencing_token === 'bigint') {
    if (row.fencing_token <= BigInt(0)) {
      throw new CorruptedJobClaimStorageError(
        `Field fencing_token as bigint must be positive (> 0), received: ${row.fencing_token.toString()}.`,
        jobId
      );
    }
    fencingToken = row.fencing_token.toString();
  } else {
    throw new CorruptedJobClaimStorageError(
      `Field fencing_token must be a valid decimal string or positive bigint, received ${typeof row.fencing_token}: ${String(row.fencing_token)}.`,
      jobId
    );
  }

  if (!FENCING_TOKEN_REGEX.test(fencingToken)) {
    throw new CorruptedJobClaimStorageError(
      `Field fencing_token must match ^[1-9][0-9]*$, received: '${fencingToken}'.`,
      jobId
    );
  }

  const acquiredAtDate = parseDbDate(row.acquired_at, 'acquired_at', jobId);
  const renewedAtDate = parseDbDate(row.renewed_at, 'renewed_at', jobId);
  const leaseUntilDate = parseDbDate(row.lease_until, 'lease_until', jobId);

  let releasedAtDate: Date | null = null;
  if (row.released_at !== null && row.released_at !== undefined) {
    releasedAtDate = parseDbDate(row.released_at, 'released_at', jobId);
  }

  // db_now é OBRIGATÓRIO e deve vir do PostgreSQL (CURRENT_TIMESTAMP(3) AS db_now).
  // Não é permitido fallback local (Date.now / new Date()).
  if (row.db_now === undefined || row.db_now === null) {
    throw new CorruptedJobClaimStorageError(
      "Field 'db_now' is required and cannot be null or undefined.",
      jobId
    );
  }
  const dbNowDate = parseDbDate(row.db_now, 'db_now', jobId);

  // Validação de sanidade temporal fail-closed
  if (renewedAtDate.getTime() < acquiredAtDate.getTime()) {
    throw new CorruptedJobClaimStorageError(
      `renewed_at (${renewedAtDate.toISOString()}) cannot be earlier than acquired_at (${acquiredAtDate.toISOString()}).`,
      jobId
    );
  }

  if (leaseUntilDate.getTime() < acquiredAtDate.getTime()) {
    throw new CorruptedJobClaimStorageError(
      `lease_until (${leaseUntilDate.toISOString()}) cannot be earlier than acquired_at (${acquiredAtDate.toISOString()}).`,
      jobId
    );
  }

  if (leaseUntilDate.getTime() <= renewedAtDate.getTime()) {
    throw new CorruptedJobClaimStorageError(
      `lease_until (${leaseUntilDate.toISOString()}) must be strictly later than renewed_at (${renewedAtDate.toISOString()}).`,
      jobId
    );
  }

  if (releasedAtDate !== null) {
    if (releasedAtDate.getTime() < acquiredAtDate.getTime()) {
      throw new CorruptedJobClaimStorageError(
        `released_at (${releasedAtDate.toISOString()}) cannot be earlier than acquired_at (${acquiredAtDate.toISOString()}).`,
        jobId
      );
    }
    if (releasedAtDate.getTime() < renewedAtDate.getTime()) {
      throw new CorruptedJobClaimStorageError(
        `released_at (${releasedAtDate.toISOString()}) cannot be earlier than renewed_at (${renewedAtDate.toISOString()}).`,
        jobId
      );
    }
  }

  let state: JobClaimState;
  if (releasedAtDate !== null) {
    state = 'released';
  } else if (leaseUntilDate.getTime() <= dbNowDate.getTime()) {
    state = 'expired';
  } else {
    state = 'active';
  }

  return Object.freeze({
    jobId,
    workerId,
    fencingToken,
    acquiredAt: acquiredAtDate.toISOString(),
    renewedAt: renewedAtDate.toISOString(),
    leaseUntil: leaseUntilDate.toISOString(),
    releasedAt: releasedAtDate ? releasedAtDate.toISOString() : null,
    state,
  });
}

export class PostgresJobClaimStore implements JobClaimStore {
  constructor(private readonly executor: JobClaimPgExecutor) {}

  /**
   * Aquisição atômica de claim sobre um Job.
   * Utiliza INSERT ... ON CONFLICT (job_id) DO UPDATE ... WHERE ... RETURNING.
   * Se nenhuma linha for atualizada, o claim está ativamente retido ('held').
   * Se a FK falhar (Job inexistente em nex_job_heads), lança JobClaimJobNotFoundError.
   */
  async acquireClaim(params: AcquireJobClaimParams): Promise<AcquireJobClaimResult> {
    assertAcquireJobClaimParams(params);

    try {
      const result = await this.executor.query<RawClaimRow>(
        `INSERT INTO "nex_job_claims" (
           "job_id",
           "worker_id",
           "fencing_token",
           "acquired_at",
           "renewed_at",
           "lease_until",
           "released_at"
         ) VALUES (
           $1,
           $2,
           1,
           CURRENT_TIMESTAMP(3),
           CURRENT_TIMESTAMP(3),
           CURRENT_TIMESTAMP(3) + ($3 * interval '1 millisecond'),
           NULL
         )
         ON CONFLICT ("job_id") DO UPDATE SET
           "worker_id" = EXCLUDED."worker_id",
           "fencing_token" = "nex_job_claims"."fencing_token" + 1,
           "acquired_at" = CURRENT_TIMESTAMP(3),
           "renewed_at" = CURRENT_TIMESTAMP(3),
           "lease_until" = CURRENT_TIMESTAMP(3) + ($3 * interval '1 millisecond'),
           "released_at" = NULL
         WHERE (
           "nex_job_claims"."released_at" IS NOT NULL
           OR "nex_job_claims"."lease_until" <= CURRENT_TIMESTAMP(3)
         )
         RETURNING
           "job_id",
           "worker_id",
           "fencing_token",
           "acquired_at",
           "renewed_at",
           "lease_until",
           "released_at",
           CURRENT_TIMESTAMP(3) AS "db_now";`,
        [params.jobId, params.workerId, params.leaseDurationMs]
      );

      if (!result.rows || result.rows.length === 0) {
        return Object.freeze({
          acquired: false,
          reason: 'held',
        });
      }

      const claim = mapRowToJobClaimSnapshot(result.rows[0]);
      return Object.freeze({
        acquired: true,
        claim,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23503') {
        throw new JobClaimJobNotFoundError(params.jobId, err);
      }
      throw err;
    }
  }

  /**
   * Renovação segura de lease para um claim ativo detido pelo mesmo worker e fencing token.
   * Falha deterministicamente com JobClaimStaleError se o claim expirou, foi liberado,
   * ou pertence a outro worker/geração.
   */
  async renewClaim(params: RenewJobClaimParams): Promise<JobClaimSnapshot> {
    assertRenewJobClaimParams(params);

    const result = await this.executor.query<RawClaimRow>(
      `UPDATE "nex_job_claims" SET
         "renewed_at" = CURRENT_TIMESTAMP(3),
         "lease_until" = CURRENT_TIMESTAMP(3) + ($4 * interval '1 millisecond')
       WHERE "job_id" = $1
         AND "worker_id" = $2
         AND "fencing_token" = $3::bigint
         AND "released_at" IS NULL
         AND "lease_until" > CURRENT_TIMESTAMP(3)
       RETURNING
         "job_id",
         "worker_id",
         "fencing_token",
         "acquired_at",
         "renewed_at",
         "lease_until",
         "released_at",
         CURRENT_TIMESTAMP(3) AS "db_now";`,
      [params.jobId, params.workerId, params.fencingToken, params.leaseDurationMs]
    );

    if (!result.rows || result.rows.length === 0) {
      throw new JobClaimStaleError(
        params.jobId,
        params.workerId,
        params.fencingToken,
        'claim does not exist, belongs to another worker/fence, was already released, or has expired'
      );
    }

    return mapRowToJobClaimSnapshot(result.rows[0]);
  }

  /**
   * Liberação graciosa de um claim ativo pelo detentor da geração corrente.
   * Não deleta a linha nem zera o fencing token; marca released_at atomicamente.
   */
  async releaseClaim(params: ReleaseJobClaimParams): Promise<JobClaimSnapshot> {
    assertReleaseJobClaimParams(params);

    const result = await this.executor.query<RawClaimRow>(
      `UPDATE "nex_job_claims" SET
         "released_at" = CURRENT_TIMESTAMP(3)
       WHERE "job_id" = $1
         AND "worker_id" = $2
         AND "fencing_token" = $3::bigint
         AND "released_at" IS NULL
         AND "lease_until" > CURRENT_TIMESTAMP(3)
       RETURNING
         "job_id",
         "worker_id",
         "fencing_token",
         "acquired_at",
         "renewed_at",
         "lease_until",
         "released_at",
         CURRENT_TIMESTAMP(3) AS "db_now";`,
      [params.jobId, params.workerId, params.fencingToken]
    );

    if (!result.rows || result.rows.length === 0) {
      throw new JobClaimStaleError(
        params.jobId,
        params.workerId,
        params.fencingToken,
        'claim cannot be released because it does not exist, belongs to another worker/fence, was already released, or has expired'
      );
    }

    return mapRowToJobClaimSnapshot(result.rows[0]);
  }

  /**
   * Inspeção operacional do claim atual de um Job.
   * Retorna undefined se o Job nunca teve um claim registrado.
   */
  async getJobClaim(jobId: string): Promise<JobClaimSnapshot | undefined> {
    assertJobId(jobId);

    const result = await this.executor.query<RawClaimRow>(
      `SELECT
         "job_id",
         "worker_id",
         "fencing_token",
         "acquired_at",
         "renewed_at",
         "lease_until",
         "released_at",
         CURRENT_TIMESTAMP(3) AS "db_now"
       FROM "nex_job_claims"
       WHERE "job_id" = $1;`,
      [jobId]
    );

    if (!result.rows || result.rows.length === 0) {
      return undefined;
    }

    return mapRowToJobClaimSnapshot(result.rows[0]);
  }
}
