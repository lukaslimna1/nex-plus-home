/**
 * NEX+ · Continuation Checkpoint PostgreSQL Store
 * Implementação Durável sobre PostgreSQL — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-4A)
 *
 * Princípios Fundamentais:
 * 1. Append-only absoluto: a tabela nex_job_checkpoints é protegida contra UPDATE/DELETE/TRUNCATE.
 * 2. Unicidade determinística por checkpoint_id com mapeamento seguro de DuplicateJobCheckpointError.
 * 3. Integridade referencial com nex_job_events e nex_execution_outcome_assessments via FK composta.
 * 4. Listagem monotônica ordenada por append_sequence ASC.
 */

import type { JobId } from '../contracts';
import type {
  JobCheckpoint,
  JobCheckpointId,
  JobCheckpointPgExecutor,
  JobCheckpointStore,
} from './contracts';
import {
  DuplicateJobCheckpointError,
  JobCheckpointInvariantError,
} from './errors';
import {
  mapRowToJobCheckpoint,
  serializeJobCheckpoint,
} from './serialization';

export class PostgresJobCheckpointStore implements JobCheckpointStore {
  constructor(private readonly executor: JobCheckpointPgExecutor) {}

  /**
   * Adiciona um novo checkpoint imutável ao histórico durável.
   * Lança DuplicateJobCheckpointError se o checkpointId já existir.
   */
  async appendCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
    const row = serializeJobCheckpoint(checkpoint);

    const sql = `
      INSERT INTO "nex_job_checkpoints" (
        "checkpoint_id",
        "job_id",
        "job_revision",
        "attempt_id",
        "outcome_assessment_id",
        "decision_material_context_id",
        "capability_revision_id",
        "capability_domain_effect",
        "binding_revision_id",
        "binding_domain_effect_attested",
        "route_revision_id",
        "route_domain_effect",
        "effective_is_domain_mutating",
        "continuation_directive",
        "continuation_reason_code",
        "recorded_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
    `;

    const params = [
      row.checkpoint_id,
      row.job_id,
      row.job_revision,
      row.attempt_id,
      row.outcome_assessment_id,
      row.decision_material_context_id,
      row.capability_revision_id,
      row.capability_domain_effect,
      row.binding_revision_id,
      row.binding_domain_effect_attested,
      row.route_revision_id,
      row.route_domain_effect,
      row.effective_is_domain_mutating,
      row.continuation_directive,
      row.continuation_reason_code,
      row.recorded_at,
    ];

    try {
      await this.executor.query(sql, params);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string; detail?: string };
      if (pgErr && pgErr.code === '23505') {
        throw new DuplicateJobCheckpointError(checkpoint.checkpointId);
      }
      if (pgErr && pgErr.code === '23503') {
        throw new JobCheckpointInvariantError({
          code: 'CHECKPOINT_ID_INVALID',
          message: `[JobCheckpointStore] Foreign key violation while appending checkpoint: ${pgErr.detail || pgErr.message || String(err)}`,
          checkpointId: checkpoint.checkpointId,
          cause: err,
        });
      }
      throw err;
    }
  }

  /**
   * Recupera um checkpoint pelo seu ID único.
   * Retorna undefined se não existir.
   */
  async getCheckpoint(checkpointId: JobCheckpointId): Promise<JobCheckpoint | undefined> {
    if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
      throw new JobCheckpointInvariantError({
        code: 'CHECKPOINT_ID_INVALID',
        message: '[JobCheckpointStore] checkpointId must be a non-empty string.',
      });
    }

    const sql = `
      SELECT
        "checkpoint_id",
        "job_id",
        "job_revision",
        "attempt_id",
        "outcome_assessment_id",
        "decision_material_context_id",
        "capability_revision_id",
        "capability_domain_effect",
        "binding_revision_id",
        "binding_domain_effect_attested",
        "route_revision_id",
        "route_domain_effect",
        "effective_is_domain_mutating",
        "continuation_directive",
        "continuation_reason_code",
        "recorded_at"
      FROM "nex_job_checkpoints"
      WHERE "checkpoint_id" = $1
    `;

    const result = await this.executor.query(sql, [checkpointId]);
    if (result.rows.length === 0) {
      return undefined;
    }

    return mapRowToJobCheckpoint(result.rows[0]);
  }

  /**
   * Lista todos os checkpoints registrados para um Job em ordem de append monotônica.
   */
  async listCheckpointsByJob(jobId: JobId): Promise<readonly JobCheckpoint[]> {
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      throw new JobCheckpointInvariantError({
        code: 'CHECKPOINT_ID_INVALID',
        message: '[JobCheckpointStore] jobId must be a non-empty string.',
      });
    }

    const sql = `
      SELECT
        "checkpoint_id",
        "job_id",
        "job_revision",
        "attempt_id",
        "outcome_assessment_id",
        "decision_material_context_id",
        "capability_revision_id",
        "capability_domain_effect",
        "binding_revision_id",
        "binding_domain_effect_attested",
        "route_revision_id",
        "route_domain_effect",
        "effective_is_domain_mutating",
        "continuation_directive",
        "continuation_reason_code",
        "recorded_at"
      FROM "nex_job_checkpoints"
      WHERE "job_id" = $1
      ORDER BY "append_sequence" ASC
    `;

    const result = await this.executor.query(sql, [jobId]);
    const checkpoints = result.rows.map((r) => mapRowToJobCheckpoint(r));
    return Object.freeze(checkpoints);
  }
}
