/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * PostgreSQL Adapter para Durable Execution Ledger — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 *
 * Plano de Autoridade (L0).
 * Implementação concreta e durável de DurableExecutionLedgerStore sobre PostgreSQL.
 * Transacional, fail-closed, concorrência segura com row lock em heads e proteção append-only.
 */

import type {
  AttemptEvent,
  AttemptId,
  AttemptState,
  DecisionId,
  ExecutionEvidence,
  ExecutionEvidenceId,
  ExecutionSignal,
  ExecutionSignalId,
  OutcomeAssessment,
  OutcomeAssessmentId,
  Receipt,
  ReceiptId,
} from '../contracts';
import type { DurableExecutionLedgerStore } from './contracts';
import {
  DuplicateIdError,
  InvalidAttemptTransitionError,
  InvalidAttemptReferenceError,
  InvalidSignalReferenceError,
  InvalidEvidenceReferenceError,
  InvalidAssessmentReferenceError,
  InvalidAssessmentLineageError,
  CrossAttemptReferenceError,
  InvalidReceiptStructureError,
} from './errors';
import {
  mapRowToAttemptState,
  mapRowToAttemptEvent,
  mapRowToExecutionSignal,
  mapRowsToExecutionEvidence,
  mapRowsToOutcomeAssessment,
  mapRowToReceipt,
} from './serialization';

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgExecutor {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgTransactionalClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  release(): void;
}

export interface PgTransactionalExecutor extends PgExecutor {
  connect?(): Promise<PgTransactionalClient>;
}

export class PostgresExecutionLedgerStore implements DurableExecutionLedgerStore {
  constructor(private readonly executor: PgTransactionalExecutor) {}

  private async withTransaction<T>(
    operation: (client: PgExecutor) => Promise<T>,
  ): Promise<T> {
    let client: PgTransactionalClient | undefined;
    let runner: PgExecutor;

    if (typeof this.executor.connect === 'function') {
      client = await this.executor.connect();
      runner = client;
    } else {
      runner = this.executor;
    }

    try {
      await runner.query('BEGIN');
      const result = await operation(runner);
      await runner.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await runner.query('ROLLBACK');
      } catch {
        // Ignora erro no rollback
      }
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // ==========================================================================
  // 1. ATTEMPT LIFECYCLE
  // ==========================================================================

  async appendAttemptEvent(event: AttemptEvent): Promise<void> {
    await this.withTransaction(async (tx) => {
      if (event.type === 'AttemptCreated') {
        const existing = await tx.query(
          `SELECT attempt_id FROM "nex_execution_attempt_heads" WHERE "attempt_id" = $1`,
          [event.attemptId],
        );
        if (existing.rows.length > 0) {
          throw new DuplicateIdError(event.attemptId as string, 'Attempt');
        }

        try {
          // 1. Evento histórico sequencial (seq = 1)
          await tx.query(
            `INSERT INTO "nex_execution_attempt_events"
             ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
             VALUES ($1, $2, $3, $4, $5)`,
            [
              event.attemptId,
              1,
              event.type,
              JSON.stringify(event),
              event.createdAt,
            ],
          );

          // 2. Head operacional mutável
          await tx.query(
            `INSERT INTO "nex_execution_attempt_heads"
             ("attempt_id", "decision_id", "route_evaluation_id", "capability_revision_id",
              "binding_revision_id", "route_revision_id", "policy_revision_id",
              "status", "created_at", "revision")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              event.attemptId,
              event.decisionId,
              event.routeEvaluationId,
              event.capabilityRevisionId,
              event.bindingRevisionId,
              event.routeRevisionId,
              event.policyRevisionId || null,
              'created',
              event.createdAt,
              1,
            ],
          );
        } catch (err: any) {
          if (err?.code === '23505') {
            throw new DuplicateIdError(event.attemptId as string, 'Attempt');
          }
          throw err;
        }
        return;
      }

      if (event.type === 'AttemptStarted') {
        const headRes = await tx.query(
          `SELECT "status", "revision" FROM "nex_execution_attempt_heads"
           WHERE "attempt_id" = $1 FOR UPDATE`,
          [event.attemptId],
        );

        if (headRes.rows.length === 0) {
          throw new InvalidAttemptReferenceError(event.attemptId as string, 'AttemptStarted');
        }

        const current = headRes.rows[0];
        if (current.status !== 'created') {
          throw new InvalidAttemptTransitionError(event.attemptId as string, current.status, 'running');
        }

        const countRes = await tx.query(
          `SELECT count(*)::int as cnt FROM "nex_execution_attempt_events" WHERE "attempt_id" = $1`,
          [event.attemptId],
        );
        const nextSeq = (countRes.rows[0]?.cnt ?? 0) + 1;

        // 1. Evento histórico sequencial
        await tx.query(
          `INSERT INTO "nex_execution_attempt_events"
           ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
           VALUES ($1, $2, $3, $4, $5)`,
          [
            event.attemptId,
            nextSeq,
            event.type,
            JSON.stringify(event),
            event.startedAt,
          ],
        );

        // 2. Atualizar head operacional
        await tx.query(
          `UPDATE "nex_execution_attempt_heads"
           SET "status" = 'running', "started_at" = $2, "revision" = "revision" + 1
           WHERE "attempt_id" = $1`,
          [event.attemptId, event.startedAt],
        );
        return;
      }

      if (event.type === 'AttemptTerminal') {
        const headRes = await tx.query(
          `SELECT "status", "revision" FROM "nex_execution_attempt_heads"
           WHERE "attempt_id" = $1 FOR UPDATE`,
          [event.attemptId],
        );

        if (headRes.rows.length === 0) {
          throw new InvalidAttemptReferenceError(event.attemptId as string, 'AttemptTerminal');
        }

        const current = headRes.rows[0];
        if (current.status !== 'running') {
          throw new InvalidAttemptTransitionError(event.attemptId as string, current.status, event.terminalStatus);
        }

        const countRes = await tx.query(
          `SELECT count(*)::int as cnt FROM "nex_execution_attempt_events" WHERE "attempt_id" = $1`,
          [event.attemptId],
        );
        const nextSeq = (countRes.rows[0]?.cnt ?? 0) + 1;

        // 1. Evento histórico sequencial
        await tx.query(
          `INSERT INTO "nex_execution_attempt_events"
           ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
           VALUES ($1, $2, $3, $4, $5)`,
          [
            event.attemptId,
            nextSeq,
            event.type,
            JSON.stringify(event),
            event.finishedAt,
          ],
        );

        // 2. Atualizar head operacional
        await tx.query(
          `UPDATE "nex_execution_attempt_heads"
           SET "status" = $2, "finished_at" = $3, "terminal_reason" = $4, "revision" = "revision" + 1
           WHERE "attempt_id" = $1`,
          [event.attemptId, event.terminalStatus, event.finishedAt, event.terminalReason || null],
        );
        return;
      }
    });
  }

  async getAttempt(attemptId: AttemptId): Promise<AttemptState | undefined> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_attempt_heads" WHERE "attempt_id" = $1`,
      [attemptId],
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return mapRowToAttemptState(res.rows[0]);
  }

  async listAttemptEvents(attemptId: AttemptId): Promise<readonly AttemptEvent[]> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_attempt_events" WHERE "attempt_id" = $1 ORDER BY "sequence_number" ASC`,
      [attemptId],
    );
    return Object.freeze(res.rows.map(mapRowToAttemptEvent));
  }

  async listAttempts(decisionId?: DecisionId): Promise<readonly AttemptState[]> {
    const querySql = decisionId
      ? `SELECT * FROM "nex_execution_attempt_heads" WHERE "decision_id" = $1 ORDER BY "created_at" ASC`
      : `SELECT * FROM "nex_execution_attempt_heads" ORDER BY "created_at" ASC`;
    const params = decisionId ? [decisionId] : [];
    const res = await this.executor.query(querySql, params);
    return Object.freeze(res.rows.map(mapRowToAttemptState));
  }

  // ==========================================================================
  // 2. EXECUTION SIGNALS
  // ==========================================================================

  async appendExecutionSignal(signal: ExecutionSignal): Promise<void> {
    await this.withTransaction(async (tx) => {
      const existing = await tx.query(
        `SELECT signal_id FROM "nex_execution_signals" WHERE "signal_id" = $1`,
        [signal.signalId],
      );
      if (existing.rows.length > 0) {
        throw new DuplicateIdError(signal.signalId as string, 'ExecutionSignal');
      }

      const attemptExists = await tx.query(
        `SELECT attempt_id FROM "nex_execution_attempt_heads" WHERE "attempt_id" = $1`,
        [signal.attemptId],
      );
      if (attemptExists.rows.length === 0) {
        throw new InvalidAttemptReferenceError(signal.attemptId as string, 'appendExecutionSignal');
      }

      try {
        await tx.query(
          `INSERT INTO "nex_execution_signals"
           ("signal_id", "attempt_id", "kind", "safe_metadata", "provenance", "observed_at")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            signal.signalId,
            signal.attemptId,
            signal.kind,
            JSON.stringify(signal.safeMetadata),
            JSON.stringify(signal.provenance),
            signal.observedAt,
          ],
        );
      } catch (err: any) {
        if (err?.code === '23505') {
          throw new DuplicateIdError(signal.signalId as string, 'ExecutionSignal');
        }
        if (err?.code === '23503') {
          throw new InvalidAttemptReferenceError(signal.attemptId as string, 'appendExecutionSignal');
        }
        throw err;
      }
    });
  }

  async getExecutionSignal(signalId: ExecutionSignalId): Promise<ExecutionSignal | undefined> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_signals" WHERE "signal_id" = $1`,
      [signalId],
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return mapRowToExecutionSignal(res.rows[0]);
  }

  async listExecutionSignals(attemptId: AttemptId): Promise<readonly ExecutionSignal[]> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_signals" WHERE "attempt_id" = $1 ORDER BY "observed_at" ASC`,
      [attemptId],
    );
    return Object.freeze(res.rows.map(mapRowToExecutionSignal));
  }

  // ==========================================================================
  // 3. EXECUTION EVIDENCE
  // ==========================================================================

  async appendExecutionEvidence(evidence: ExecutionEvidence): Promise<void> {
    await this.withTransaction(async (tx) => {
      const existing = await tx.query(
        `SELECT evidence_id FROM "nex_execution_evidence" WHERE "evidence_id" = $1`,
        [evidence.evidenceId],
      );
      if (existing.rows.length > 0) {
        throw new DuplicateIdError(evidence.evidenceId as string, 'ExecutionEvidence');
      }

      const attemptExists = await tx.query(
        `SELECT attempt_id FROM "nex_execution_attempt_heads" WHERE "attempt_id" = $1`,
        [evidence.attemptId],
      );
      if (attemptExists.rows.length === 0) {
        throw new InvalidAttemptReferenceError(evidence.attemptId as string, 'appendExecutionEvidence');
      }

      // Validar existência e correlação causal estrita de todos os sinais referenciados
      for (const sigRef of evidence.signalRefs) {
        const sigRes = await tx.query(
          `SELECT "signal_id", "attempt_id" FROM "nex_execution_signals" WHERE "signal_id" = $1`,
          [sigRef],
        );
        if (sigRes.rows.length === 0) {
          throw new InvalidSignalReferenceError(sigRef as string);
        }
        if (sigRes.rows[0].attempt_id !== evidence.attemptId) {
          throw new CrossAttemptReferenceError(
            `Evidence '${evidence.evidenceId}' (Attempt ${evidence.attemptId}) references Signal '${sigRef}' belonging to Attempt '${sigRes.rows[0].attempt_id}'`,
          );
        }
      }

      try {
        // 1. Inserir evidence header
        await tx.query(
          `INSERT INTO "nex_execution_evidence"
           ("evidence_id", "attempt_id", "kind", "safe_facts", "provenance", "recorded_at", "no_side_effect_guarantee")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            evidence.evidenceId,
            evidence.attemptId,
            evidence.kind,
            JSON.stringify(evidence.safeFacts),
            JSON.stringify(evidence.provenance),
            evidence.recordedAt,
            evidence.noSideEffectGuarantee || null,
          ],
        );

        // 2. Inserir referências ordenadas de signals
        for (let pos = 0; pos < evidence.signalRefs.length; pos++) {
          await tx.query(
            `INSERT INTO "nex_execution_evidence_signals"
             ("evidence_id", "signal_id", "attempt_id", "position")
             VALUES ($1, $2, $3, $4)`,
            [
              evidence.evidenceId,
              evidence.signalRefs[pos],
              evidence.attemptId,
              pos,
            ],
          );
        }
      } catch (err: any) {
        if (err?.code === '23505') {
          throw new DuplicateIdError(evidence.evidenceId as string, 'ExecutionEvidence');
        }
        throw err;
      }
    });
  }

  async getExecutionEvidence(evidenceId: ExecutionEvidenceId): Promise<ExecutionEvidence | undefined> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_evidence" WHERE "evidence_id" = $1`,
      [evidenceId],
    );
    if (res.rows.length === 0) {
      return undefined;
    }

    const sigRes = await this.executor.query(
      `SELECT "signal_id", "position" FROM "nex_execution_evidence_signals"
       WHERE "evidence_id" = $1 ORDER BY "position" ASC`,
      [evidenceId],
    );

    return mapRowsToExecutionEvidence(res.rows[0], sigRes.rows);
  }

  async listExecutionEvidence(attemptId: AttemptId): Promise<readonly ExecutionEvidence[]> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_evidence" WHERE "attempt_id" = $1 ORDER BY "recorded_at" ASC`,
      [attemptId],
    );
    if (res.rows.length === 0) {
      return Object.freeze([]);
    }

    const allSignals = await this.executor.query(
      `SELECT "evidence_id", "signal_id", "position"
       FROM "nex_execution_evidence_signals"
       WHERE "attempt_id" = $1 ORDER BY "evidence_id", "position" ASC`,
      [attemptId],
    );

    const signalsByEvidence = new Map<string, any[]>();
    for (const sr of allSignals.rows) {
      const list = signalsByEvidence.get(sr.evidence_id) || [];
      list.push(sr);
      signalsByEvidence.set(sr.evidence_id, list);
    }

    return Object.freeze(
      res.rows.map((row) =>
        mapRowsToExecutionEvidence(row, signalsByEvidence.get(row.evidence_id) || []),
      ),
    );
  }

  // ==========================================================================
  // 4. OUTCOME ASSESSMENTS
  // ==========================================================================

  async appendOutcomeAssessment(assessment: OutcomeAssessment): Promise<void> {
    await this.withTransaction(async (tx) => {
      const existing = await tx.query(
        `SELECT assessment_id FROM "nex_execution_outcome_assessments" WHERE "assessment_id" = $1`,
        [assessment.assessmentId],
      );
      if (existing.rows.length > 0) {
        throw new DuplicateIdError(assessment.assessmentId as string, 'OutcomeAssessment');
      }

      // Adquire lock no Attempt head para serializar lineage
      const attemptHeadRes = await tx.query(
        `SELECT "attempt_id" FROM "nex_execution_attempt_heads" WHERE "attempt_id" = $1 FOR UPDATE`,
        [assessment.attemptId],
      );
      if (attemptHeadRes.rows.length === 0) {
        throw new InvalidAttemptReferenceError(assessment.attemptId as string, 'appendOutcomeAssessment');
      }

      // 1. Validar cada EvidenceRef referenciada
      for (const eviRef of assessment.evidenceRefs) {
        const eviRes = await tx.query(
          `SELECT "evidence_id", "attempt_id" FROM "nex_execution_evidence" WHERE "evidence_id" = $1`,
          [eviRef],
        );
        if (eviRes.rows.length === 0) {
          throw new InvalidEvidenceReferenceError(eviRef as string);
        }
        if (eviRes.rows[0].attempt_id !== assessment.attemptId) {
          throw new CrossAttemptReferenceError(
            `Assessment '${assessment.assessmentId}' (Attempt ${assessment.attemptId}) references Evidence '${eviRef}' belonging to Attempt '${eviRes.rows[0].attempt_id}'`,
          );
        }
      }

      // 2. Validar supersedes se informado
      if (assessment.supersedesAssessmentId) {
        const prevRes = await tx.query(
          `SELECT "assessment_id", "attempt_id" FROM "nex_execution_outcome_assessments" WHERE "assessment_id" = $1`,
          [assessment.supersedesAssessmentId],
        );
        if (prevRes.rows.length === 0) {
          throw new InvalidAssessmentReferenceError(assessment.supersedesAssessmentId as string);
        }
        if (prevRes.rows[0].attempt_id !== assessment.attemptId) {
          throw new CrossAttemptReferenceError(
            `Assessment '${assessment.assessmentId}' (Attempt ${assessment.attemptId}) attempts to supersede Assessment '${assessment.supersedesAssessmentId}' belonging to Attempt '${prevRes.rows[0].attempt_id}'`,
          );
        }
      }

      // 3. Obter Outcome head atual com row lock
      const outcomeHeadRes = await tx.query(
        `SELECT * FROM "nex_execution_outcome_heads" WHERE "attempt_id" = $1 FOR UPDATE`,
        [assessment.attemptId],
      );

      if (outcomeHeadRes.rows.length === 0) {
        if (assessment.supersedesAssessmentId) {
          throw new InvalidAssessmentLineageError(
            `First assessment '${assessment.assessmentId}' on Attempt '${assessment.attemptId}' cannot supersede another assessment.`,
          );
        }
      } else {
        const currentHead = outcomeHeadRes.rows[0];
        if (!assessment.supersedesAssessmentId) {
          throw new InvalidAssessmentLineageError(
            `Second assessment '${assessment.assessmentId}' on Attempt '${assessment.attemptId}' must supersede current head '${currentHead.latest_assessment_id}'`,
          );
        }
        if (assessment.supersedesAssessmentId !== currentHead.latest_assessment_id) {
          throw new InvalidAssessmentLineageError(
            `Assessment '${assessment.assessmentId}' must supersede current head '${currentHead.latest_assessment_id}', but specified '${assessment.supersedesAssessmentId}'`,
          );
        }
      }

      try {
        // 4. Inserir assessment
        await tx.query(
          `INSERT INTO "nex_execution_outcome_assessments"
           ("assessment_id", "attempt_id", "verdict", "reason_code", "supersedes_assessment_id", "assessed_at")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            assessment.assessmentId,
            assessment.attemptId,
            assessment.verdict,
            assessment.reasonCode,
            assessment.supersedesAssessmentId || null,
            assessment.assessedAt,
          ],
        );

        // 5. Inserir evidências relacionadas
        for (let pos = 0; pos < assessment.evidenceRefs.length; pos++) {
          await tx.query(
            `INSERT INTO "nex_execution_outcome_evidence"
             ("assessment_id", "evidence_id", "attempt_id", "position")
             VALUES ($1, $2, $3, $4)`,
            [
              assessment.assessmentId,
              assessment.evidenceRefs[pos],
              assessment.attemptId,
              pos,
            ],
          );
        }

        // 6. Atualizar ou inserir outcome head
        if (outcomeHeadRes.rows.length === 0) {
          await tx.query(
            `INSERT INTO "nex_execution_outcome_heads"
             ("attempt_id", "latest_assessment_id", "assessment_count", "updated_at")
             VALUES ($1, $2, 1, $3)`,
            [assessment.attemptId, assessment.assessmentId, assessment.assessedAt],
          );
        } else {
          await tx.query(
            `UPDATE "nex_execution_outcome_heads"
             SET "latest_assessment_id" = $2, "assessment_count" = "assessment_count" + 1, "updated_at" = $3
             WHERE "attempt_id" = $1`,
            [assessment.attemptId, assessment.assessmentId, assessment.assessedAt],
          );
        }
      } catch (err: any) {
        if (err?.code === '23505') {
          throw new DuplicateIdError(assessment.assessmentId as string, 'OutcomeAssessment');
        }
        throw err;
      }
    });
  }

  async getOutcomeAssessment(assessmentId: OutcomeAssessmentId): Promise<OutcomeAssessment | undefined> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_outcome_assessments" WHERE "assessment_id" = $1`,
      [assessmentId],
    );
    if (res.rows.length === 0) {
      return undefined;
    }

    const eviRes = await this.executor.query(
      `SELECT "evidence_id", "position" FROM "nex_execution_outcome_evidence"
       WHERE "assessment_id" = $1 ORDER BY "position" ASC`,
      [assessmentId],
    );

    return mapRowsToOutcomeAssessment(res.rows[0], eviRes.rows);
  }

  async getLatestOutcomeAssessment(attemptId: AttemptId): Promise<OutcomeAssessment | undefined> {
    const headRes = await this.executor.query(
      `SELECT "latest_assessment_id" FROM "nex_execution_outcome_heads" WHERE "attempt_id" = $1`,
      [attemptId],
    );
    if (headRes.rows.length === 0) {
      return undefined;
    }
    return this.getOutcomeAssessment(headRes.rows[0].latest_assessment_id as OutcomeAssessmentId);
  }

  async listOutcomeAssessments(attemptId: AttemptId): Promise<readonly OutcomeAssessment[]> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_outcome_assessments" WHERE "attempt_id" = $1 ORDER BY "assessed_at" ASC`,
      [attemptId],
    );
    if (res.rows.length === 0) {
      return Object.freeze([]);
    }

    const allEvidence = await this.executor.query(
      `SELECT "assessment_id", "evidence_id", "position"
       FROM "nex_execution_outcome_evidence"
       WHERE "attempt_id" = $1 ORDER BY "assessment_id", "position" ASC`,
      [attemptId],
    );

    const evidenceByAssessment = new Map<string, any[]>();
    for (const er of allEvidence.rows) {
      const list = evidenceByAssessment.get(er.assessment_id) || [];
      list.push(er);
      evidenceByAssessment.set(er.assessment_id, list);
    }

    return Object.freeze(
      res.rows.map((row) =>
        mapRowsToOutcomeAssessment(row, evidenceByAssessment.get(row.assessment_id) || []),
      ),
    );
  }

  // ==========================================================================
  // 5. RECEIPTS
  // ==========================================================================

  async appendReceipt(receipt: Receipt): Promise<void> {
    await this.withTransaction(async (tx) => {
      const existing = await tx.query(
        `SELECT receipt_id FROM "nex_execution_receipts" WHERE "receipt_id" = $1`,
        [receipt.receiptId],
      );
      if (existing.rows.length > 0) {
        throw new DuplicateIdError(receipt.receiptId as string, 'Receipt');
      }

      if (receipt.kind === 'execution_outcome') {
        if (!receipt.attemptId || !receipt.outcomeAssessmentId || !receipt.routeEvaluationId) {
          throw new InvalidReceiptStructureError(
            `Receipt of kind 'execution_outcome' must have attemptId, outcomeAssessmentId, and routeEvaluationId.`,
          );
        }

        const attRes = await tx.query(
          `SELECT "attempt_id", "route_evaluation_id" FROM "nex_execution_attempt_heads" WHERE "attempt_id" = $1`,
          [receipt.attemptId],
        );
        if (attRes.rows.length === 0) {
          throw new InvalidAttemptReferenceError(receipt.attemptId as string, 'appendReceipt');
        }
        if (attRes.rows[0].route_evaluation_id !== receipt.routeEvaluationId) {
          throw new InvalidReceiptStructureError(
            `Receipt routeEvaluationId '${receipt.routeEvaluationId}' does not match Attempt routeEvaluationId '${attRes.rows[0].route_evaluation_id}'.`,
          );
        }

        const assRes = await tx.query(
          `SELECT "assessment_id", "attempt_id" FROM "nex_execution_outcome_assessments" WHERE "assessment_id" = $1`,
          [receipt.outcomeAssessmentId],
        );
        if (assRes.rows.length === 0) {
          throw new InvalidAssessmentReferenceError(receipt.outcomeAssessmentId as string);
        }
        if (assRes.rows[0].attempt_id !== receipt.attemptId) {
          throw new CrossAttemptReferenceError(
            `Receipt '${receipt.receiptId}' references Attempt '${receipt.attemptId}' but Assessment '${receipt.outcomeAssessmentId}' belongs to Attempt '${assRes.rows[0].attempt_id}'`,
          );
        }

        try {
          await tx.query(
            `INSERT INTO "nex_execution_receipts"
             ("receipt_id", "decision_id", "kind", "verdict_summary", "reason_code",
              "safe_structured_facts", "materialized_at", "route_evaluation_id", "attempt_id", "outcome_assessment_id")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              receipt.receiptId,
              receipt.decisionId,
              receipt.kind,
              receipt.verdictSummary,
              receipt.reasonCode,
              JSON.stringify(receipt.safeStructuredFacts),
              receipt.materializedAt,
              receipt.routeEvaluationId,
              receipt.attemptId,
              receipt.outcomeAssessmentId,
            ],
          );
        } catch (err: any) {
          if (err?.code === '23505') {
            throw new DuplicateIdError(receipt.receiptId as string, 'Receipt');
          }
          throw err;
        }
        return;
      }

      // Receipts sem Attempt (policy_denial, authorization_denial, cancelled, no_eligible_route)
      const untyped = (receipt as unknown) as Record<string, unknown>;
      if (untyped.attemptId !== undefined) {
        throw new InvalidReceiptStructureError(
          `Receipt of kind '${receipt.kind}' must NOT have an attemptId (INV-09 violation).`,
        );
      }
      if (untyped.outcomeAssessmentId !== undefined) {
        throw new InvalidReceiptStructureError(
          `Receipt of kind '${receipt.kind}' must NOT have an outcomeAssessmentId.`,
        );
      }
      if (untyped.routeEvaluationId !== undefined) {
        throw new InvalidReceiptStructureError(
          `Receipt of kind '${receipt.kind}' must NOT have a routeEvaluationId.`,
        );
      }

      try {
        await tx.query(
          `INSERT INTO "nex_execution_receipts"
           ("receipt_id", "decision_id", "kind", "verdict_summary", "reason_code",
            "safe_structured_facts", "materialized_at", "route_evaluation_id", "attempt_id", "outcome_assessment_id")
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL)`,
          [
            receipt.receiptId,
            receipt.decisionId,
            receipt.kind,
            receipt.verdictSummary,
            receipt.reasonCode,
            JSON.stringify(receipt.safeStructuredFacts),
            receipt.materializedAt,
          ],
        );
      } catch (err: any) {
        if (err?.code === '23505') {
          throw new DuplicateIdError(receipt.receiptId as string, 'Receipt');
        }
        throw err;
      }
    });
  }

  async getReceipt(receiptId: ReceiptId): Promise<Receipt | undefined> {
    const res = await this.executor.query(
      `SELECT * FROM "nex_execution_receipts" WHERE "receipt_id" = $1`,
      [receiptId],
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return mapRowToReceipt(res.rows[0]);
  }

  async listReceipts(decisionId?: DecisionId): Promise<readonly Receipt[]> {
    const querySql = decisionId
      ? `SELECT * FROM "nex_execution_receipts" WHERE "decision_id" = $1 ORDER BY "materialized_at" ASC`
      : `SELECT * FROM "nex_execution_receipts" ORDER BY "materialized_at" ASC`;
    const params = decisionId ? [decisionId] : [];
    const res = await this.executor.query(querySql, params);
    return Object.freeze(res.rows.map(mapRowToReceipt));
  }
}

export function createPostgresExecutionLedgerStore(
  executor: PgTransactionalExecutor,
): DurableExecutionLedgerStore {
  return new PostgresExecutionLedgerStore(executor);
}
