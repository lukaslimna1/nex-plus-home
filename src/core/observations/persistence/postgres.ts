/**
 * NEX+ · PostgreSQL Adapter para Observações, Revisões & Projeções
 * Escopo 0.85 (Bloco 0.85B - Micro-Hardening)
 *
 * Implementação append-only com concorrência otimista, advisory locks transacionais
 * e validação estrita de coerência cruzada Review ↔ Projection.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { FactProvenance } from '../../capabilities/contracts';
import type {
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  SourceRefId,
  EvidenceArtifactRefId,
  ReviewEvent,
  ReviewEventId,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  Actor,
} from '../contracts';
import {
  validateObservationRecord,
  validateReviewEvent,
  validateCanonicalProjection,
} from '../invariants';
import type {
  ObservationPersistenceAdapter,
  IdempotencyKeyParams,
  RecordObservationResult,
  CommitCanonicalPromotionParams,
  CommitCanonicalPromotionResult,
  CanonicalHeadInfo,
} from './contracts';
import {
  IdempotencyConflictError,
  StaleCanonicalBaseConflictError,
  PersistenceInvariantViolationError,
} from './errors';
import {
  serializeToPgJsonb,
  parsePgJsonb,
  formatPgTimestampToUtcInstant,
} from './serialization';

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgExecutor {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgClientWithTransaction extends PgExecutor {
  release?(): void;
}

export interface PgPoolLike extends PgExecutor {
  connect(): Promise<PgClientWithTransaction>;
}

/**
 * Gera chave bigint determinística com sinal para pg_advisory_xact_lock.
 */
export function generateSubjectLockKey(subject: ObservationSubject): string {
  const hash = createHash('sha256')
    .update(`canonical_subject:${subject.domain}:${subject.entityType}:${subject.entityId}`)
    .digest();
  return hash.readBigInt64BE(0).toString();
}

/**
 * Gera chave bigint determinística com sinal para idempotência (namespace isolado).
 */
export function generateIdempotencyLockKey(scope: string, key: string): string {
  const hash = createHash('sha256')
    .update(`observation_idempotency:${scope}:${key}`)
    .digest();
  return hash.readBigInt64BE(0).toString();
}

/**
 * Validação profunda de coerência relacional e semântica entre ReviewEvent e CanonicalProjection.
 * Executada estritamente dentro da transação ativa.
 */
export async function validateCanonicalCommitCoherence(
  client: PgExecutor,
  review: CanonicalPromotedReviewEvent | CanonicalReclassifiedReviewEvent,
  projection: CanonicalProjection
): Promise<void> {
  const { domain, entityType, entityId } = projection.subject;

  // 1. Coerência Estrutural do Estado Canônico (Node isDeepStrictEqual)
  if (!isDeepStrictEqual(review.canonicalEffect.targetCanonicalState, projection.canonicalState)) {
    throw new PersistenceInvariantViolationError(
      'CANONICAL_STATE_MISMATCH',
      `Review targetCanonicalState and Projection canonicalState must be structurally equal.`
    );
  }

  // 2. Review Corrente DEVE constar na lista de authorizingReviewIds da Projeção
  if (!projection.authorizingReviewIds.includes(review.reviewId)) {
    throw new PersistenceInvariantViolationError(
      'CURRENT_REVIEW_NOT_AUTHORIZING_PROJECTION',
      `Current review '${review.reviewId}' must be included in projection.authorizingReviewIds.`
    );
  }

  // 3. Validação das Authorizing Reviews Anteriores (Devem existir e ser canônicas)
  const previousAuthorizerIds = projection.authorizingReviewIds.filter((id) => id !== review.reviewId);
  if (previousAuthorizerIds.length > 0) {
    const prevReviewsRes = await client.query<{ review_id: string; decision: string }>(
      `SELECT review_id, decision FROM nex_review_events WHERE review_id = ANY($1::varchar[])`,
      [previousAuthorizerIds]
    );

    if (prevReviewsRes.rows.length !== previousAuthorizerIds.length) {
      const foundIds = new Set(prevReviewsRes.rows.map((r) => r.review_id));
      const missing = previousAuthorizerIds.filter((id) => !foundIds.has(id));
      throw new PersistenceInvariantViolationError(
        'AUTHORIZING_REVIEW_NOT_FOUND',
        `Authorizing review(s) not found in persistence: ${missing.join(', ')}.`
      );
    }

    for (const r of prevReviewsRes.rows) {
      if (r.decision !== 'canonical_promoted' && r.decision !== 'canonical_reclassified') {
        throw new PersistenceInvariantViolationError(
          'AUTHORIZING_REVIEW_NOT_CANONICAL',
          `Authorizing review '${r.review_id}' has non-canonical decision '${r.decision}'. Only canonical decisions can authorize projections.`
        );
      }
    }
  }

  // 4. Validação de Coerência de Subject das Observações (Cross-Subject Violation Check)
  const allObsIds = Array.from(
    new Set([...review.targetObservationIds, ...projection.underlyingObservationIds])
  );

  const obsCheckRes = await client.query<{
    observation_id: string;
    domain: string;
    entity_type: string;
    entity_id: string;
  }>(
    `SELECT observation_id, domain, entity_type, entity_id
     FROM nex_observation_records
     WHERE observation_id = ANY($1::varchar[])`,
    [allObsIds]
  );

  if (obsCheckRes.rows.length !== allObsIds.length) {
    const foundIds = new Set(obsCheckRes.rows.map((r) => r.observation_id));
    const missing = allObsIds.filter((id) => !foundIds.has(id));
    throw new PersistenceInvariantViolationError(
      'OBSERVATION_NOT_FOUND',
      `Observation(s) not found in persistence: ${missing.join(', ')}.`
    );
  }

  for (const row of obsCheckRes.rows) {
    if (row.domain !== domain || row.entity_type !== entityType || row.entity_id !== entityId) {
      throw new PersistenceInvariantViolationError(
        'CROSS_SUBJECT_OBSERVATION_MISMATCH',
        `Observation '${row.observation_id}' belongs to subject (${row.domain}, ${row.entity_type}, ${row.entity_id}), but projection is for subject (${domain}, ${entityType}, ${entityId}).`
      );
    }
  }

  // 5. Cobertura de Observações Subjacentes por Authorizing Reviews (Histórico Cumulativo)
  const authorizedObsSet = new Set<string>(review.targetObservationIds);

  if (previousAuthorizerIds.length > 0) {
    const prevObsRes = await client.query<{ observation_id: string }>(
      `SELECT observation_id FROM nex_review_event_observations WHERE review_id = ANY($1::varchar[])`,
      [previousAuthorizerIds]
    );
    for (const r of prevObsRes.rows) {
      authorizedObsSet.add(r.observation_id);
    }
  }

  for (const obsId of projection.underlyingObservationIds) {
    if (!authorizedObsSet.has(obsId)) {
      throw new PersistenceInvariantViolationError(
        'UNDERLYING_OBSERVATION_NOT_AUTHORIZED',
        `Underlying observation '${obsId}' is not authorized by any of the authorizing reviews for this projection.`
      );
    }
  }
}

export class PgObservationPersistenceAdapter implements ObservationPersistenceAdapter {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  // ==========================================================================
  // 1. OBSERVATION RECORD (Append-Only)
  // ==========================================================================

  async recordObservation(
    record: ObservationRecord,
    idempotency?: IdempotencyKeyParams
  ): Promise<RecordObservationResult> {
    const validation = validateObservationRecord(record);
    if (!validation.valid) {
      throw new PersistenceInvariantViolationError(
        'INVALID_OBSERVATION_RECORD',
        validation.errors.join('; ')
      );
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Advisory Lock transacional por chave de idempotência (Serialização determinística)
      if (idempotency) {
        const idemLockKey = generateIdempotencyLockKey(idempotency.scope, idempotency.key);
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [idemLockKey]);

        const existingKeyRes = await client.query<{ observation_id: string }>(
          `SELECT observation_id FROM nex_observation_ingest_keys
           WHERE idempotency_scope = $1 AND idempotency_key = $2`,
          [idempotency.scope, idempotency.key]
        );

        if (existingKeyRes.rows.length > 0) {
          const boundObservationId = existingKeyRes.rows[0].observation_id;
          if (boundObservationId === record.observationId) {
            await client.query('COMMIT');
            const existingRecord = await this.getObservation(boundObservationId as ObservationRecordId);
            if (!existingRecord) {
              throw new PersistenceInvariantViolationError(
                'DANGLING_IDEMPOTENCY_KEY',
                `Idempotency key references non-existent observation '${boundObservationId}'.`
              );
            }
            return { record: existingRecord, deduplicated: true };
          } else {
            await client.query('ROLLBACK');
            throw new IdempotencyConflictError({
              scope: idempotency.scope,
              key: idempotency.key,
              existingObservationId: boundObservationId,
              attemptedObservationId: record.observationId,
            });
          }
        }
      }

      // 2. Inserção do ObservationRecord
      const rawValueJson = serializeToPgJsonb(record.rawValue, 'rawValue');
      const hasNormVal = record.normalizedValue !== undefined;
      const normValJson = hasNormVal ? serializeToPgJsonb(record.normalizedValue, 'normalizedValue') : null;
      const actorPayloadJson = serializeToPgJsonb(record.actor, 'actor');
      const provenanceJson = record.provenance ? serializeToPgJsonb(record.provenance, 'provenance') : null;

      try {
        await client.query(
          `INSERT INTO nex_observation_records (
            observation_id, domain, entity_type, entity_id, observed_claim,
            raw_value, has_normalized_value, normalized_value, actor_kind,
            actor_payload, channel, acquisition_method, provenance,
            execution_evidence_ref, occurred_at, observed_at, captured_at, received_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6::jsonb, $7, $8::jsonb, $9,
            $10::jsonb, $11, $12, $13::jsonb,
            $14, $15, $16, $17, $18
          )`,
          [
            record.observationId,
            record.subject.domain,
            record.subject.entityType,
            record.subject.entityId,
            record.observedClaim,
            rawValueJson,
            hasNormVal,
            normValJson,
            record.actor.kind,
            actorPayloadJson,
            record.channel ?? null,
            record.acquisitionMethod ?? null,
            provenanceJson,
            record.executionEvidenceRef ?? null,
            record.occurredAt ?? null,
            record.observedAt,
            record.capturedAt,
            record.receivedAt ?? null,
          ]
        );
      } catch (insertObsErr: any) {
        if (insertObsErr?.code === '23505' && idempotency) {
          // Colisão de PK quando já gravado por chamada concorrente
          const existingKeyRes = await client.query<{ observation_id: string }>(
            `SELECT observation_id FROM nex_observation_ingest_keys
             WHERE idempotency_scope = $1 AND idempotency_key = $2`,
            [idempotency.scope, idempotency.key]
          );
          if (existingKeyRes.rows.length > 0 && existingKeyRes.rows[0].observation_id === record.observationId) {
            await client.query('COMMIT');
            const existingRecord = await this.getObservation(record.observationId);
            if (existingRecord) return { record: existingRecord, deduplicated: true };
          }
        }
        throw insertObsErr;
      }

      // 3. Inserção de Sources vinculadas
      for (const sourceRefId of record.sourceRefs) {
        await client.query(
          `INSERT INTO nex_observation_sources (observation_id, source_ref_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [record.observationId, sourceRefId]
        );
      }

      // 4. Inserção de Evidence Refs vinculadas
      for (const evidenceArtifactId of record.evidenceRefs) {
        await client.query(
          `INSERT INTO nex_observation_evidence_refs (observation_id, evidence_artifact_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [record.observationId, evidenceArtifactId]
        );
      }

      // 5. Inserção da chave de idempotência
      if (idempotency) {
        try {
          await client.query(
            `INSERT INTO nex_observation_ingest_keys (idempotency_scope, idempotency_key, observation_id)
             VALUES ($1, $2, $3)`,
            [idempotency.scope, idempotency.key, record.observationId]
          );
        } catch (insertErr: any) {
          if (insertErr?.code === '23505') {
            await client.query('ROLLBACK');
            const checkRes = await this.pool.query<{ observation_id: string }>(
              `SELECT observation_id FROM nex_observation_ingest_keys
               WHERE idempotency_scope = $1 AND idempotency_key = $2`,
              [idempotency.scope, idempotency.key]
            );
            if (checkRes.rows.length > 0 && checkRes.rows[0].observation_id === record.observationId) {
              const existingRecord = await this.getObservation(record.observationId);
              if (existingRecord) return { record: existingRecord, deduplicated: true };
            }
            throw new IdempotencyConflictError({
              scope: idempotency.scope,
              key: idempotency.key,
              existingObservationId: checkRes.rows[0]?.observation_id ?? 'unknown',
              attemptedObservationId: record.observationId,
            });
          }
          throw insertErr;
        }
      }

      await client.query('COMMIT');
      return { record, deduplicated: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (typeof client.release === 'function') {
        client.release();
      }
    }
  }

  async getObservation(observationId: ObservationRecordId): Promise<ObservationRecord | null> {
    const obsRes = await this.pool.query(
      `SELECT * FROM nex_observation_records WHERE observation_id = $1`,
      [observationId]
    );

    if (obsRes.rows.length === 0) {
      return null;
    }

    const row = obsRes.rows[0];

    const sourcesRes = await this.pool.query<{ source_ref_id: string }>(
      `SELECT source_ref_id FROM nex_observation_sources WHERE observation_id = $1 ORDER BY source_ref_id ASC`,
      [observationId]
    );

    const evidenceRes = await this.pool.query<{ evidence_artifact_id: string }>(
      `SELECT evidence_artifact_id FROM nex_observation_evidence_refs WHERE observation_id = $1 ORDER BY evidence_artifact_id ASC`,
      [observationId]
    );

    const rawValue = parsePgJsonb(row.raw_value);
    const normalizedValue = row.has_normalized_value ? parsePgJsonb(row.normalized_value) : undefined;
    const actor = parsePgJsonb<Actor>(row.actor_payload);
    const provenance = row.provenance ? parsePgJsonb<FactProvenance>(row.provenance) : undefined;

    return {
      observationId: row.observation_id as ObservationRecordId,
      subject: {
        domain: row.domain,
        entityType: row.entity_type,
        entityId: row.entity_id,
      },
      observedClaim: row.observed_claim,
      rawValue,
      normalizedValue,
      actor,
      channel: row.channel ?? undefined,
      acquisitionMethod: row.acquisition_method ?? undefined,
      sourceRefs: sourcesRes.rows.map((r) => r.source_ref_id as SourceRefId),
      evidenceRefs: evidenceRes.rows.map((r) => r.evidence_artifact_id as EvidenceArtifactRefId),
      provenance,
      executionEvidenceRef: row.execution_evidence_ref ?? undefined,
      occurredAt: row.occurred_at ? formatPgTimestampToUtcInstant(row.occurred_at) : undefined,
      observedAt: formatPgTimestampToUtcInstant(row.observed_at),
      capturedAt: formatPgTimestampToUtcInstant(row.captured_at),
      receivedAt: row.received_at ? formatPgTimestampToUtcInstant(row.received_at) : undefined,
    };
  }

  async listObservationsBySubject(subject: ObservationSubject): Promise<readonly ObservationRecord[]> {
    const res = await this.pool.query<{ observation_id: string }>(
      `SELECT observation_id FROM nex_observation_records
       WHERE domain = $1 AND entity_type = $2 AND entity_id = $3
       ORDER BY observed_at ASC, captured_at ASC`,
      [subject.domain, subject.entityType, subject.entityId]
    );

    const records: ObservationRecord[] = [];
    for (const row of res.rows) {
      const obs = await this.getObservation(row.observation_id as ObservationRecordId);
      if (obs) {
        records.push(obs);
      }
    }

    return records;
  }

  // ==========================================================================
  // 2. REVIEW EVENT (Append-Only)
  // ==========================================================================

  async recordNonCanonicalReview(review: NonCanonicalReviewEvent): Promise<ReviewEvent> {
    const validation = validateReviewEvent(review);
    if (!validation.valid) {
      throw new PersistenceInvariantViolationError(
        'INVALID_REVIEW_EVENT',
        validation.errors.join('; ')
      );
    }

    const rawDecision = (review as any).decision;
    if (rawDecision === 'canonical_promoted' || rawDecision === 'canonical_reclassified') {
      throw new PersistenceInvariantViolationError(
        'CANONICAL_PROMOTION_REQUIRES_TRANSACTION',
        `Canonical decision '${rawDecision}' must be committed via commitCanonicalPromotion().`
      );
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const actorPayloadJson = serializeToPgJsonb(review.actor, 'actor');

      await client.query(
        `INSERT INTO nex_review_events (
          review_id, actor_kind, actor_payload, decision,
          canonical_action, target_canonical_state, target_base_revision_id,
          justification, reviewed_at
        ) VALUES (
          $1, $2, $3::jsonb, $4,
          NULL, NULL, $5,
          $6, $7
        )`,
        [
          review.reviewId,
          review.actor.kind,
          actorPayloadJson,
          review.decision,
          review.targetBaseRevisionId ?? null,
          review.justification,
          review.reviewedAt,
        ]
      );

      for (const obsId of review.targetObservationIds) {
        await client.query(
          `INSERT INTO nex_review_event_observations (review_id, observation_id)
           VALUES ($1, $2)`,
          [review.reviewId, obsId]
        );
      }

      if (review.previousReviewIds) {
        for (const prevId of review.previousReviewIds) {
          await client.query(
            `INSERT INTO nex_review_event_previous_reviews (review_id, previous_review_id)
             VALUES ($1, $2)`,
            [review.reviewId, prevId]
          );
        }
      }

      if (review.consideredEvidenceIds) {
        for (const evId of review.consideredEvidenceIds) {
          await client.query(
            `INSERT INTO nex_review_event_evidence (review_id, evidence_artifact_id)
             VALUES ($1, $2)`,
            [review.reviewId, evId]
          );
        }
      }

      await client.query('COMMIT');
      return review;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (typeof client.release === 'function') {
        client.release();
      }
    }
  }

  async getReview(reviewId: ReviewEventId): Promise<ReviewEvent | null> {
    const revRes = await this.pool.query(
      `SELECT * FROM nex_review_events WHERE review_id = $1`,
      [reviewId]
    );

    if (revRes.rows.length === 0) {
      return null;
    }

    const row = revRes.rows[0];

    const obsRes = await this.pool.query<{ observation_id: string }>(
      `SELECT observation_id FROM nex_review_event_observations WHERE review_id = $1 ORDER BY observation_id ASC`,
      [reviewId]
    );

    const prevRes = await this.pool.query<{ previous_review_id: string }>(
      `SELECT previous_review_id FROM nex_review_event_previous_reviews WHERE review_id = $1 ORDER BY previous_review_id ASC`,
      [reviewId]
    );

    const evRes = await this.pool.query<{ evidence_artifact_id: string }>(
      `SELECT evidence_artifact_id FROM nex_review_event_evidence WHERE review_id = $1 ORDER BY evidence_artifact_id ASC`,
      [reviewId]
    );

    const actor = parsePgJsonb<Actor>(row.actor_payload);
    const targetObservationIds = obsRes.rows.map((r) => r.observation_id as ObservationRecordId);
    const previousReviewIds = prevRes.rows.length > 0 ? prevRes.rows.map((r) => r.previous_review_id as ReviewEventId) : undefined;
    const consideredEvidenceIds = evRes.rows.length > 0 ? evRes.rows.map((r) => r.evidence_artifact_id as EvidenceArtifactRefId) : undefined;

    const baseEvent = {
      reviewId: row.review_id as ReviewEventId,
      targetObservationIds,
      previousReviewIds,
      consideredEvidenceIds,
      targetBaseRevisionId: row.target_base_revision_id ? (row.target_base_revision_id as CanonicalProjectionRevisionId) : undefined,
      justification: row.justification,
      reviewedAt: formatPgTimestampToUtcInstant(row.reviewed_at),
    };

    if (row.decision === 'canonical_promoted') {
      return {
        ...baseEvent,
        actor: actor as any,
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: parsePgJsonb(row.target_canonical_state),
        },
      };
    } else if (row.decision === 'canonical_reclassified') {
      return {
        ...baseEvent,
        actor: actor as any,
        decision: 'canonical_reclassified',
        canonicalEffect: {
          action: 'reclassify',
          targetCanonicalState: parsePgJsonb(row.target_canonical_state),
        },
      };
    } else {
      return {
        ...baseEvent,
        actor,
        decision: row.decision,
      };
    }
  }

  // ==========================================================================
  // 3. CANONICAL PROMOTION & HEAD (Atomic Transacional com Concorrência)
  // ==========================================================================

  async commitCanonicalPromotion(
    params: CommitCanonicalPromotionParams
  ): Promise<CommitCanonicalPromotionResult> {
    const { review, projection, expectedBaseRevisionId } = params;

    const revValidation = validateReviewEvent(review);
    if (!revValidation.valid) {
      throw new PersistenceInvariantViolationError(
        'INVALID_REVIEW_EVENT',
        revValidation.errors.join('; ')
      );
    }

    const projValidation = validateCanonicalProjection(projection);
    if (!projValidation.valid) {
      throw new PersistenceInvariantViolationError(
        'INVALID_CANONICAL_PROJECTION',
        projValidation.errors.join('; ')
      );
    }

    const rawDecision = (review as any).decision;
    if (rawDecision !== 'canonical_promoted' && rawDecision !== 'canonical_reclassified') {
      throw new PersistenceInvariantViolationError(
        'INVALID_PROMOTION_DECISION',
        `Decision must be canonical_promoted or canonical_reclassified, received '${rawDecision}'.`
      );
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const { domain, entityType, entityId } = projection.subject;

      // 1. Advisory Lock transacional do subject (Protege mesmo quando a Head não existe)
      const subjectLockKey = generateSubjectLockKey(projection.subject);
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [subjectLockKey]);

      // 2. Lock exclusivo da head do subject
      const headRes = await client.query<{
        current_projection_revision_id: string;
        version: string;
        updated_at: Date;
      }>(
        `SELECT current_projection_revision_id, version, updated_at
         FROM nex_canonical_projection_heads
         WHERE domain = $1 AND entity_type = $2 AND entity_id = $3
         FOR UPDATE`,
        [domain, entityType, entityId]
      );

      const existingHead = headRes.rows.length > 0 ? headRes.rows[0] : null;
      const currentHeadRevisionId = existingHead?.current_projection_revision_id as CanonicalProjectionRevisionId | undefined;

      // 3. Validação estrita de concorrência / base obsoleta
      if (existingHead) {
        if (
          expectedBaseRevisionId !== currentHeadRevisionId ||
          projection.supersedesRevisionId !== currentHeadRevisionId ||
          review.targetBaseRevisionId !== currentHeadRevisionId
        ) {
          await client.query('ROLLBACK');
          throw new StaleCanonicalBaseConflictError({
            domain,
            entityType,
            entityId,
            expectedBaseRevisionId: expectedBaseRevisionId ?? projection.supersedesRevisionId ?? review.targetBaseRevisionId,
            currentHeadRevisionId,
          });
        }
      } else {
        if (
          expectedBaseRevisionId !== undefined ||
          projection.supersedesRevisionId !== undefined ||
          review.targetBaseRevisionId !== undefined
        ) {
          await client.query('ROLLBACK');
          throw new StaleCanonicalBaseConflictError({
            domain,
            entityType,
            entityId,
            expectedBaseRevisionId: expectedBaseRevisionId ?? projection.supersedesRevisionId ?? review.targetBaseRevisionId,
            currentHeadRevisionId: undefined,
          });
        }
      }

      // 4. Validação Cruzada de Coerência ReviewEvent ↔ CanonicalProjection dentro da transação
      await validateCanonicalCommitCoherence(client, review as any, projection);

      // 5. Persistência do ReviewEvent
      const actorPayloadJson = serializeToPgJsonb(review.actor, 'actor');
      const canonicalStateJson = serializeToPgJsonb(review.canonicalEffect.targetCanonicalState, 'targetCanonicalState');

      await client.query(
        `INSERT INTO nex_review_events (
          review_id, actor_kind, actor_payload, decision,
          canonical_action, target_canonical_state, target_base_revision_id,
          justification, reviewed_at
        ) VALUES (
          $1, $2, $3::jsonb, $4,
          $5, $6::jsonb, $7,
          $8, $9
        )`,
        [
          review.reviewId,
          review.actor.kind,
          actorPayloadJson,
          review.decision,
          review.canonicalEffect.action,
          canonicalStateJson,
          review.targetBaseRevisionId ?? null,
          review.justification,
          review.reviewedAt,
        ]
      );

      for (const obsId of review.targetObservationIds) {
        await client.query(
          `INSERT INTO nex_review_event_observations (review_id, observation_id)
           VALUES ($1, $2)`,
          [review.reviewId, obsId]
        );
      }

      if (review.previousReviewIds) {
        for (const prevId of review.previousReviewIds) {
          await client.query(
            `INSERT INTO nex_review_event_previous_reviews (review_id, previous_review_id)
             VALUES ($1, $2)`,
            [review.reviewId, prevId]
          );
        }
      }

      if (review.consideredEvidenceIds) {
        for (const evId of review.consideredEvidenceIds) {
          await client.query(
            `INSERT INTO nex_review_event_evidence (review_id, evidence_artifact_id)
             VALUES ($1, $2)`,
            [review.reviewId, evId]
          );
        }
      }

      // 6. Persistência da CanonicalProjectionRevision
      const projStateJson = serializeToPgJsonb(projection.canonicalState, 'canonicalState');

      await client.query(
        `INSERT INTO nex_canonical_projection_revisions (
          projection_revision_id, domain, entity_type, entity_id,
          canonical_state, reconciliation_case_id, supersedes_revision_id,
          materialized_at, explanation
        ) VALUES (
          $1, $2, $3, $4,
          $5::jsonb, $6, $7,
          $8, $9
        )`,
        [
          projection.projectionRevisionId,
          domain,
          entityType,
          entityId,
          projStateJson,
          projection.reconciliationCaseId ?? null,
          projection.supersedesRevisionId ?? null,
          projection.materializedAt,
          projection.explanation,
        ]
      );

      for (const obsId of projection.underlyingObservationIds) {
        await client.query(
          `INSERT INTO nex_canonical_projection_observations (projection_revision_id, observation_id)
           VALUES ($1, $2)`,
          [projection.projectionRevisionId, obsId]
        );
      }

      for (const revId of projection.authorizingReviewIds) {
        await client.query(
          `INSERT INTO nex_canonical_projection_reviews (projection_revision_id, review_id)
           VALUES ($1, $2)`,
          [projection.projectionRevisionId, revId]
        );
      }

      // 7. Atualização ou Criação da Head (com fallback defensivo para 23505)
      let finalVersion: bigint;
      let finalUpdatedAt: string;

      try {
        if (existingHead) {
          const updateRes = await client.query<{ version: string; updated_at: Date }>(
            `UPDATE nex_canonical_projection_heads
             SET current_projection_revision_id = $1, version = version + 1, updated_at = NOW()
             WHERE domain = $2 AND entity_type = $3 AND entity_id = $4
             RETURNING version, updated_at`,
            [projection.projectionRevisionId, domain, entityType, entityId]
          );
          finalVersion = BigInt(updateRes.rows[0].version);
          finalUpdatedAt = formatPgTimestampToUtcInstant(updateRes.rows[0].updated_at);
        } else {
          const insertHeadRes = await client.query<{ version: string; updated_at: Date }>(
            `INSERT INTO nex_canonical_projection_heads (
              domain, entity_type, entity_id, current_projection_revision_id, version, updated_at
            ) VALUES ($1, $2, $3, $4, 1, NOW())
            RETURNING version, updated_at`,
            [domain, entityType, entityId, projection.projectionRevisionId]
          );
          finalVersion = BigInt(insertHeadRes.rows[0].version);
          finalUpdatedAt = formatPgTimestampToUtcInstant(insertHeadRes.rows[0].updated_at);
        }
      } catch (headErr: any) {
        if (headErr?.code === '23505') {
          // Colisão na PK da Head em cenário concorrente de primeira head
          await client.query('ROLLBACK');
          const latestHead = await this.getCurrentCanonicalHead(projection.subject);
          throw new StaleCanonicalBaseConflictError({
            domain,
            entityType,
            entityId,
            expectedBaseRevisionId,
            currentHeadRevisionId: latestHead?.currentProjectionRevisionId,
          });
        }
        throw headErr;
      }

      await client.query('COMMIT');

      const head: CanonicalHeadInfo = {
        subject: projection.subject,
        currentProjectionRevisionId: projection.projectionRevisionId,
        version: finalVersion,
        updatedAt: finalUpdatedAt,
      };

      return {
        review,
        projection,
        head,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (typeof client.release === 'function') {
        client.release();
      }
    }
  }

  async getCanonicalProjectionRevision(
    revisionId: CanonicalProjectionRevisionId
  ): Promise<CanonicalProjection | null> {
    const revRes = await this.pool.query(
      `SELECT * FROM nex_canonical_projection_revisions WHERE projection_revision_id = $1`,
      [revisionId]
    );

    if (revRes.rows.length === 0) {
      return null;
    }

    const row = revRes.rows[0];

    const obsRes = await this.pool.query<{ observation_id: string }>(
      `SELECT observation_id FROM nex_canonical_projection_observations
       WHERE projection_revision_id = $1 ORDER BY observation_id ASC`,
      [revisionId]
    );

    const reviewsRes = await this.pool.query<{ review_id: string }>(
      `SELECT review_id FROM nex_canonical_projection_reviews
       WHERE projection_revision_id = $1 ORDER BY review_id ASC`,
      [revisionId]
    );

    return {
      projectionRevisionId: row.projection_revision_id as CanonicalProjectionRevisionId,
      subject: {
        domain: row.domain,
        entityType: row.entity_type,
        entityId: row.entity_id,
      },
      canonicalState: parsePgJsonb(row.canonical_state),
      underlyingObservationIds: obsRes.rows.map((r) => r.observation_id as ObservationRecordId),
      authorizingReviewIds: reviewsRes.rows.map((r) => r.review_id as ReviewEventId),
      reconciliationCaseId: row.reconciliation_case_id ?? undefined,
      supersedesRevisionId: row.supersedes_revision_id ? (row.supersedes_revision_id as CanonicalProjectionRevisionId) : undefined,
      materializedAt: formatPgTimestampToUtcInstant(row.materialized_at),
      explanation: row.explanation,
    };
  }

  async getCurrentCanonicalHead(subject: ObservationSubject): Promise<CanonicalHeadInfo | null> {
    const headRes = await this.pool.query<{
      current_projection_revision_id: string;
      version: string;
      updated_at: Date;
    }>(
      `SELECT current_projection_revision_id, version, updated_at
       FROM nex_canonical_projection_heads
       WHERE domain = $1 AND entity_type = $2 AND entity_id = $3`,
      [subject.domain, subject.entityType, subject.entityId]
    );

    if (headRes.rows.length === 0) {
      return null;
    }

    const row = headRes.rows[0];
    return {
      subject,
      currentProjectionRevisionId: row.current_projection_revision_id as CanonicalProjectionRevisionId,
      version: BigInt(row.version),
      updatedAt: formatPgTimestampToUtcInstant(row.updated_at),
    };
  }

  async getCurrentCanonicalProjection(subject: ObservationSubject): Promise<CanonicalProjection | null> {
    const head = await this.getCurrentCanonicalHead(subject);
    if (!head) {
      return null;
    }
    return this.getCanonicalProjectionRevision(head.currentProjectionRevisionId);
  }
}
