/**
 * NEX+ · Implementação PostgreSQL da Camada de Reconciliação & Precedentes
 * Escopo 0.85 (Bloco 0.85D · Micro-Hardening A)
 */

import type { Pool, PoolClient } from 'pg';
import type {
  ReconciliationCase,
  ReconciliationCaseId,
  OpenReconciliationCase,
  ResolvedReconciliationCase,
  ContextualPrecedent,
  ContextualPrecedentRefId,
  ReviewEvent,
  ReviewEventId,
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  Actor,
  HumanActor,
} from '../contracts';
import type {
  ReconciliationPersistenceAdapter,
  CreateReconciliationCaseParams,
  CreateReconciliationCaseResult,
  AppendReconciliationRevisionParams,
  AppendReconciliationRevisionResult,
  ReconciliationHeadInfo,
} from './contracts';
import {
  assertValidReconciliationCase,
  assertValidContextualPrecedent,
  assertReconciliationCaseCoherence,
  assertReconciliationRevisionContinuity,
} from './validators';
import {
  ReconciliationCaseConflictError,
  StaleReconciliationVersionConflictError,
  ContextualPrecedentConflictError,
  ContextualPrecedentInvalidReviewError,
} from './errors';
import { parsePgJsonb } from '../persistence/serialization';
import { PgObservationPersistenceAdapter } from '../persistence/postgres';
import type { ObservationPersistenceAdapter } from '../persistence/contracts';

export class PgReconciliationPersistenceAdapter implements ReconciliationPersistenceAdapter {
  private readonly obsPersistence: ObservationPersistenceAdapter;

  constructor(
    private readonly pool: Pool,
    obsPersistence?: ObservationPersistenceAdapter
  ) {
    this.obsPersistence = obsPersistence ?? new PgObservationPersistenceAdapter(pool);
  }

  private rowToReconciliationCase(row: any): ReconciliationCase {
    const subject: ObservationSubject = {
      domain: row.subject_domain,
      entityType: row.subject_entity_type,
      entityId: row.subject_entity_id,
    };

    const base = {
      caseId: row.case_id as ReconciliationCaseId,
      subject,
      observationIds: (row.observation_ids as string[]).map((id) => id as ObservationRecordId),
      reviewIds: (row.review_ids as string[]).map((id) => id as ReviewEventId),
      openedAt: new Date(row.opened_at).toISOString(),
    };

    if (row.lifecycle === 'open') {
      const openCase: OpenReconciliationCase = {
        ...base,
        lifecycle: 'open',
        status: row.status,
        resolutionSummary: row.resolution_summary ?? undefined,
      };
      return openCase;
    } else {
      const resolvedCase: ResolvedReconciliationCase = {
        ...base,
        lifecycle: 'resolved',
        status: row.status,
        resolvedAt: new Date(row.resolved_at).toISOString(),
        resolutionSummary: row.resolution_summary,
      };
      return resolvedCase;
    }
  }

  private rowToHeadInfo(row: any): ReconciliationHeadInfo {
    return {
      caseId: row.case_id as ReconciliationCaseId,
      currentVersion: Number(row.current_version),
      subject: {
        domain: row.subject_domain,
        entityType: row.subject_entity_type,
        entityId: row.subject_entity_id,
      },
      lifecycle: row.lifecycle,
      status: row.status,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private rowToPrecedent(row: any): ContextualPrecedent {
    return {
      precedentId: row.precedent_id as ContextualPrecedentRefId,
      reviewEventId: row.review_event_id as ReviewEventId,
      contextSummary: row.context_summary,
      applicabilityConditions: row.applicability_conditions as string[],
      policyProposalRef: row.policy_proposal_ref ?? undefined,
    };
  }

  private isReconciliationCaseEqual(a: ReconciliationCase, b: ReconciliationCase): boolean {
    if (a.caseId !== b.caseId) return false;
    if (
      a.subject.domain !== b.subject.domain ||
      a.subject.entityType !== b.subject.entityType ||
      a.subject.entityId !== b.subject.entityId
    ) {
      return false;
    }
    if (a.lifecycle !== b.lifecycle || a.status !== b.status) return false;
    if (a.openedAt !== b.openedAt) return false;
    if (a.lifecycle === 'resolved') {
      const aRes = a as ResolvedReconciliationCase;
      const bRes = b as ResolvedReconciliationCase;
      if (aRes.resolvedAt !== bRes.resolvedAt || aRes.resolutionSummary !== bRes.resolutionSummary) {
        return false;
      }
    } else {
      const aOpen = a as OpenReconciliationCase;
      const bOpen = b as OpenReconciliationCase;
      if (aOpen.resolutionSummary !== bOpen.resolutionSummary) return false;
    }

    if (a.observationIds.length !== b.observationIds.length) return false;
    for (let i = 0; i < a.observationIds.length; i++) {
      if (a.observationIds[i] !== b.observationIds[i]) return false;
    }

    if (a.reviewIds.length !== b.reviewIds.length) return false;
    for (let i = 0; i < a.reviewIds.length; i++) {
      if (a.reviewIds[i] !== b.reviewIds[i]) return false;
    }

    return true;
  }

  private isPrecedentEqual(a: ContextualPrecedent, b: ContextualPrecedent): boolean {
    if (a.precedentId !== b.precedentId) return false;
    if (a.reviewEventId !== b.reviewEventId) return false;
    if (a.contextSummary !== b.contextSummary) return false;
    if (a.policyProposalRef !== b.policyProposalRef) return false;
    if (a.applicabilityConditions.length !== b.applicabilityConditions.length) return false;
    for (let i = 0; i < a.applicabilityConditions.length; i++) {
      if (a.applicabilityConditions[i] !== b.applicabilityConditions[i]) return false;
    }
    return true;
  }

  /**
   * Validação profunda de referências no Persistence Boundary antes de qualquer escrita.
   */
  private async validateReferencesCoherence(caseObj: ReconciliationCase): Promise<void> {
    // 1. Carrega todas as observações diretas do caso
    const loadedObservations: ObservationRecord[] = [];
    for (const obsId of caseObj.observationIds) {
      const obs = await this.obsPersistence.getObservation(obsId);
      if (obs) {
        loadedObservations.push(obs);
      }
    }

    // 2. Carrega todas as reviews do caso e suas targetObservations
    const loadedReviews: ReviewEvent[] = [];
    for (const revId of caseObj.reviewIds) {
      const rev = await this.obsPersistence.getReview(revId);
      if (rev) {
        loadedReviews.push(rev);
        for (const targetObsId of rev.targetObservationIds) {
          if (!loadedObservations.some((o) => o.observationId === targetObsId)) {
            const targetObs = await this.obsPersistence.getObservation(targetObsId);
            if (targetObs) {
              loadedObservations.push(targetObs);
            }
          }
        }
      }
    }

    // 3. Executa assertReconciliationCaseCoherence
    assertReconciliationCaseCoherence(caseObj, loadedObservations, loadedReviews);
  }

  async createReconciliationCase(
    params: CreateReconciliationCaseParams
  ): Promise<CreateReconciliationCaseResult> {
    const caseObj = params.case;
    assertValidReconciliationCase(caseObj);

    // Validação estrita de coerência de referências no persistence boundary antes de abrir a transação de escrita
    await this.validateReferencesCoherence(caseObj);

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Advisory lock transacional determinístico no caseId
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [caseObj.caseId]);

      // Verifica se já existe head para este caseId
      const headRes = await client.query(
        `SELECT h.case_id, h.current_version, h.updated_at,
                r.subject_domain, r.subject_entity_type, r.subject_entity_id, r.lifecycle, r.status
         FROM nex_reconciliation_case_heads h
         JOIN nex_reconciliation_case_revisions r
           ON h.case_id = r.case_id AND h.current_version = r.version
         WHERE h.case_id = $1 FOR UPDATE`,
        [caseObj.caseId]
      );

      if (headRes.rows.length > 0) {
        const currentVersion = Number(headRes.rows[0].current_version);

        // Se o caso já evoluiu para uma versão posterior (v2, v3, ...), a tentativa de recriar v1 é um conflito
        if (currentVersion > 1) {
          throw new ReconciliationCaseConflictError(
            caseObj.caseId,
            `Case already exists and has evolved to version ${currentVersion}. Cannot recreate initial version.`
          );
        }

        // Busca a revisão 1 para validar idempotência estrita
        const revRes = await client.query(
          `SELECT * FROM nex_reconciliation_case_revisions WHERE case_id = $1 AND version = 1`,
          [caseObj.caseId]
        );

        if (revRes.rows.length > 0) {
          const existingCase = this.rowToReconciliationCase(revRes.rows[0]);
          if (this.isReconciliationCaseEqual(existingCase, caseObj)) {
            await client.query('COMMIT');
            return {
              case: existingCase,
              head: this.rowToHeadInfo(headRes.rows[0]),
            };
          }
        }

        throw new ReconciliationCaseConflictError(
          caseObj.caseId,
          `Case already exists with version 1 and different payload.`
        );
      }

      // Insere revisão 1
      const resolvedAt = caseObj.lifecycle === 'resolved' ? (caseObj as ResolvedReconciliationCase).resolvedAt : null;
      const resolutionSummary =
        caseObj.lifecycle === 'resolved'
          ? (caseObj as ResolvedReconciliationCase).resolutionSummary
          : (caseObj as OpenReconciliationCase).resolutionSummary ?? null;

      await client.query(
        `INSERT INTO nex_reconciliation_case_revisions (
          case_id, version, subject_domain, subject_entity_type, subject_entity_id,
          observation_ids, review_ids, lifecycle, status, opened_at, resolved_at, resolution_summary
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          caseObj.caseId,
          caseObj.subject.domain,
          caseObj.subject.entityType,
          caseObj.subject.entityId,
          JSON.stringify(caseObj.observationIds),
          JSON.stringify(caseObj.reviewIds),
          caseObj.lifecycle,
          caseObj.status,
          caseObj.openedAt,
          resolvedAt,
          resolutionSummary,
        ]
      );

      // Insere Head normalizada (apenas ponteiro operacional)
      await client.query(
        `INSERT INTO nex_reconciliation_case_heads (
          case_id, current_version, updated_at
        ) VALUES ($1, 1, clock_timestamp())`,
        [caseObj.caseId]
      );

      await client.query('COMMIT');

      const headInfo: ReconciliationHeadInfo = {
        caseId: caseObj.caseId,
        currentVersion: 1,
        subject: caseObj.subject,
        lifecycle: caseObj.lifecycle,
        status: caseObj.status,
        updatedAt: new Date().toISOString(),
      };

      return {
        case: caseObj,
        head: headInfo,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async appendReconciliationRevision(
    params: AppendReconciliationRevisionParams
  ): Promise<AppendReconciliationRevisionResult> {
    const caseObj = params.case;
    assertValidReconciliationCase(caseObj);

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Advisory lock transacional determinístico no caseId
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [caseObj.caseId]);

      const headRes = await client.query(
        `SELECT * FROM nex_reconciliation_case_heads WHERE case_id = $1 FOR UPDATE`,
        [caseObj.caseId]
      );

      if (headRes.rows.length === 0) {
        throw new ReconciliationCaseConflictError(
          caseObj.caseId,
          `Case does not exist. Must call createReconciliationCase first.`
        );
      }

      const currentHead = headRes.rows[0];
      const currentVersion = Number(currentHead.current_version);

      if (currentVersion !== params.expectedVersion) {
        throw new StaleReconciliationVersionConflictError(
          caseObj.caseId,
          params.expectedVersion,
          currentVersion
        );
      }

      // Carrega a revisão corrente apontada pela head para validar continuidade histórica
      const prevRevRes = await client.query(
        `SELECT * FROM nex_reconciliation_case_revisions WHERE case_id = $1 AND version = $2`,
        [caseObj.caseId, currentVersion]
      );

      if (prevRevRes.rows.length === 0) {
        throw new ReconciliationCaseConflictError(
          caseObj.caseId,
          `Corrupt state: head points to version ${currentVersion}, but revision record is missing.`
        );
      }

      const previousCase = this.rowToReconciliationCase(prevRevRes.rows[0]);

      // Validação estrita de continuidade e imutabilidade histórica entre revisões
      assertReconciliationRevisionContinuity(previousCase, caseObj);

      // Validação de coerência das referências da nova revisão no persistence boundary
      await this.validateReferencesCoherence(caseObj);

      const nextVersion = currentVersion + 1;
      const resolvedAt = caseObj.lifecycle === 'resolved' ? (caseObj as ResolvedReconciliationCase).resolvedAt : null;
      const resolutionSummary =
        caseObj.lifecycle === 'resolved'
          ? (caseObj as ResolvedReconciliationCase).resolutionSummary
          : (caseObj as OpenReconciliationCase).resolutionSummary ?? null;

      // Insere nova revisão (Append-Only)
      await client.query(
        `INSERT INTO nex_reconciliation_case_revisions (
          case_id, version, subject_domain, subject_entity_type, subject_entity_id,
          observation_ids, review_ids, lifecycle, status, opened_at, resolved_at, resolution_summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          caseObj.caseId,
          nextVersion,
          caseObj.subject.domain,
          caseObj.subject.entityType,
          caseObj.subject.entityId,
          JSON.stringify(caseObj.observationIds),
          JSON.stringify(caseObj.reviewIds),
          caseObj.lifecycle,
          caseObj.status,
          caseObj.openedAt,
          resolvedAt,
          resolutionSummary,
        ]
      );

      // Atualiza Head operacional
      await client.query(
        `UPDATE nex_reconciliation_case_heads
         SET current_version = $1,
             updated_at = clock_timestamp()
         WHERE case_id = $2`,
        [nextVersion, caseObj.caseId]
      );

      await client.query('COMMIT');

      const headInfo: ReconciliationHeadInfo = {
        caseId: caseObj.caseId,
        currentVersion: nextVersion,
        subject: caseObj.subject,
        lifecycle: caseObj.lifecycle,
        status: caseObj.status,
        updatedAt: new Date().toISOString(),
      };

      return {
        case: caseObj,
        head: headInfo,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getCurrentReconciliationCase(caseId: ReconciliationCaseId): Promise<ReconciliationCase | null> {
    const res = await this.pool.query(
      `SELECT r.*
       FROM nex_reconciliation_case_heads h
       JOIN nex_reconciliation_case_revisions r
         ON h.case_id = r.case_id AND h.current_version = r.version
       WHERE h.case_id = $1`,
      [caseId]
    );

    if (res.rows.length === 0) return null;
    return this.rowToReconciliationCase(res.rows[0]);
  }

  async getCurrentReconciliationHead(caseId: ReconciliationCaseId): Promise<ReconciliationHeadInfo | null> {
    const res = await this.pool.query(
      `SELECT h.case_id, h.current_version, h.updated_at,
              r.subject_domain, r.subject_entity_type, r.subject_entity_id, r.lifecycle, r.status
       FROM nex_reconciliation_case_heads h
       JOIN nex_reconciliation_case_revisions r
         ON h.case_id = r.case_id AND h.current_version = r.version
       WHERE h.case_id = $1`,
      [caseId]
    );

    if (res.rows.length === 0) return null;
    return this.rowToHeadInfo(res.rows[0]);
  }

  async listReconciliationHistory(caseId: ReconciliationCaseId): Promise<readonly ReconciliationCase[]> {
    const res = await this.pool.query(
      `SELECT * FROM nex_reconciliation_case_revisions
       WHERE case_id = $1
       ORDER BY version ASC`,
      [caseId]
    );

    return res.rows.map((row) => this.rowToReconciliationCase(row));
  }

  async recordContextualPrecedent(precedent: ContextualPrecedent): Promise<ContextualPrecedent> {
    // 1. Consulta a revisão fonte no PostgreSQL
    const reviewRes = await this.pool.query(
      `SELECT review_id, actor_kind, actor_payload, justification, reviewed_at FROM nex_review_events WHERE review_id = $1`,
      [precedent.reviewEventId]
    );

    if (reviewRes.rows.length === 0) {
      throw new ContextualPrecedentInvalidReviewError(
        precedent.precedentId,
        precedent.reviewEventId,
        `Referenced reviewEventId '${precedent.reviewEventId}' does not exist in PostgreSQL.`
      );
    }

    const reviewRow = reviewRes.rows[0];
    const parsedActor = parsePgJsonb<Actor>(reviewRow.actor_payload);

    // Validação fail-closed de consistência do ator persistido
    if (reviewRow.actor_kind !== 'human' || !parsedActor || parsedActor.kind !== 'human') {
      throw new ContextualPrecedentInvalidReviewError(
        precedent.precedentId,
        precedent.reviewEventId,
        `ContextualPrecedent strictly requires a human actor review. Review '${reviewRow.review_id}' has column actor_kind='${reviewRow.actor_kind}' and payload kind='${parsedActor?.kind}'.`
      );
    }

    const humanActor = parsedActor as HumanActor;
    if (!humanActor.humanId || humanActor.humanId.trim() === '') {
      throw new ContextualPrecedentInvalidReviewError(
        precedent.precedentId,
        precedent.reviewEventId,
        `Source review human actor payload is missing valid humanId.`
      );
    }

    const sourceReview: ReviewEvent = {
      reviewId: reviewRow.review_id as ReviewEventId,
      targetObservationIds: [],
      justification: reviewRow.justification,
      reviewedAt: new Date(reviewRow.reviewed_at).toISOString(),
      actor: humanActor,
      decision: 'corroborated' as any,
    };

    assertValidContextualPrecedent(precedent, sourceReview);

    // 2. Transação com advisory lock para gravação append-only e idempotência
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [precedent.precedentId]);

      const existingRes = await client.query(
        `SELECT * FROM nex_contextual_precedents WHERE precedent_id = $1`,
        [precedent.precedentId]
      );

      if (existingRes.rows.length > 0) {
        const existingPrec = this.rowToPrecedent(existingRes.rows[0]);
        if (this.isPrecedentEqual(existingPrec, precedent)) {
          await client.query('COMMIT');
          return existingPrec;
        }

        throw new ContextualPrecedentConflictError(
          precedent.precedentId,
          `Precedent already exists with different payload.`
        );
      }

      await client.query(
        `INSERT INTO nex_contextual_precedents (
          precedent_id, review_event_id, context_summary, applicability_conditions, policy_proposal_ref
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          precedent.precedentId,
          precedent.reviewEventId,
          precedent.contextSummary,
          JSON.stringify(precedent.applicabilityConditions),
          precedent.policyProposalRef ?? null,
        ]
      );

      await client.query('COMMIT');
      return precedent;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getContextualPrecedent(precedentId: ContextualPrecedentRefId): Promise<ContextualPrecedent | null> {
    const res = await this.pool.query(
      `SELECT * FROM nex_contextual_precedents WHERE precedent_id = $1`,
      [precedentId]
    );

    if (res.rows.length === 0) return null;
    return this.rowToPrecedent(res.rows[0]);
  }

  async listContextualPrecedentsByReview(reviewId: ReviewEventId): Promise<readonly ContextualPrecedent[]> {
    const res = await this.pool.query(
      `SELECT * FROM nex_contextual_precedents WHERE review_event_id = $1 ORDER BY created_at ASC`,
      [reviewId]
    );

    return res.rows.map((row) => this.rowToPrecedent(row));
  }
}
