import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type {
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  SourceRefId,
  EvidenceArtifactRefId,
  ReviewEventId,
  CanonicalProjectionRevisionId,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  CanonicalProjection,
} from '../../contracts';
import { PgObservationPersistenceAdapter } from '../postgres';
import {
  IdempotencyConflictError,
  StaleCanonicalBaseConflictError,
  PersistenceInvariantViolationError,
} from '../errors';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

describe('Escopo 0.85B · Persistência PostgreSQL Append-Only & Projeções (Micro-Hardening)', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let adapter: PgObservationPersistenceAdapter;

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    adapter = new PgObservationPersistenceAdapter(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  describe('1. ObservationRecord & Ingestão Idempotente com Advisory Locks', () => {
    it('A, B, C: ObservationRecord round-trip preserva rawValue null e timestamps UTC Z', async () => {
      const now = Date.now();
      const obsId = `obs_test_roundtrip_${now}` as ObservationRecordId;
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'product_price',
        entityId: `sku_camisa_azul_${now}`,
      };

      const record: ObservationRecord = {
        observationId: obsId,
        subject,
        observedClaim: 'supplier_discount_rate',
        rawValue: null,
        normalizedValue: null,
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          role: 'director',
        },
        channel: 'email_attachment',
        acquisitionMethod: 'manual_entry',
        sourceRefs: ['src_fornecedor_1' as SourceRefId],
        evidenceRefs: ['art_screenshot_1' as EvidenceArtifactRefId],
        occurredAt: '2026-08-21T10:00:00.000Z',
        observedAt: '2026-08-21T10:15:00.000Z',
        capturedAt: '2026-08-21T10:20:00.000Z',
        receivedAt: '2026-08-21T10:05:00.000Z',
      };

      const res = await adapter.recordObservation(record);
      assert.equal(res.deduplicated, false);
      assert.equal(res.record.observationId, obsId);

      const fetched = await adapter.getObservation(obsId);
      assert.ok(fetched);
      assert.equal(fetched.observationId, obsId);
      assert.equal(fetched.rawValue, null);
      assert.equal(fetched.normalizedValue, null);
      assert.equal(fetched.occurredAt, '2026-08-21T10:00:00.000Z');
      assert.equal(fetched.observedAt, '2026-08-21T10:15:00.000Z');
      assert.equal(fetched.capturedAt, '2026-08-21T10:20:00.000Z');
      assert.equal(fetched.receivedAt, '2026-08-21T10:05:00.000Z');
      assert.equal(fetched.sourceRefs.length, 1);
      assert.equal(fetched.evidenceRefs.length, 1);
    });

    it('D: Duas observações com mesmo subject e mesmo valor em instantes distintos permanecem duas linhas', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'pricing',
        entityType: 'sku',
        entityId: `item_same_val_${now}`,
      };

      const obs1: ObservationRecord = {
        observationId: `obs_val_1_${now}` as ObservationRecordId,
        subject,
        observedClaim: 'price',
        rawValue: 42.0,
        actor: { kind: 'system', component: 'scraper' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T08:00:00.000Z',
        capturedAt: '2026-08-21T08:01:00.000Z',
      };

      const obs2: ObservationRecord = {
        observationId: `obs_val_2_${now}` as ObservationRecordId,
        subject,
        observedClaim: 'price',
        rawValue: 42.0,
        actor: { kind: 'system', component: 'scraper' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T09:00:00.000Z',
        capturedAt: '2026-08-21T09:01:00.000Z',
      };

      await adapter.recordObservation(obs1);
      await adapter.recordObservation(obs2);

      const history = await adapter.listObservationsBySubject(subject);
      const ids = history.map((h) => h.observationId);
      assert.ok(ids.includes(obs1.observationId));
      assert.ok(ids.includes(obs2.observationId));
      assert.equal(history.length, 2);
    });

    it('E: Mesma chave de idempotência repetida com mesmo ID retorna registro existente (deduplicated: true)', async () => {
      const now = Date.now();
      const obsId = `obs_idem_ok_${now}` as ObservationRecordId;
      const idempotency = { scope: 'test_scope_e', key: `key_e_${now}` };

      const record: ObservationRecord = {
        observationId: obsId,
        subject: { domain: 'd', entityType: 't', entityId: `e_${now}` },
        observedClaim: 'test_claim',
        rawValue: { sample: 'data' },
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      };

      const first = await adapter.recordObservation(record, idempotency);
      assert.equal(first.deduplicated, false);

      const second = await adapter.recordObservation(record, idempotency);
      assert.equal(second.deduplicated, true);
      assert.equal(second.record.observationId, obsId);
    });

    it('F: Mesma chave de idempotência reaproveitada para observationId diferente gera IdempotencyConflictError', async () => {
      const now = Date.now();
      const idempotency = { scope: 'test_scope_f', key: `key_f_${now}` };

      const record1: ObservationRecord = {
        observationId: `obs_f_1_${now}` as ObservationRecordId,
        subject: { domain: 'd', entityType: 't', entityId: `f_${now}` },
        observedClaim: 'c1',
        rawValue: 10,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      };

      const record2: ObservationRecord = {
        observationId: `obs_f_2_${now}` as ObservationRecordId,
        subject: { domain: 'd', entityType: 't', entityId: `f_${now}` },
        observedClaim: 'c2',
        rawValue: 20,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      };

      await adapter.recordObservation(record1, idempotency);

      await assert.rejects(
        async () => {
          await adapter.recordObservation(record2, idempotency);
        },
        (err: unknown) => {
          assert.ok(err instanceof IdempotencyConflictError);
          assert.equal(err.scope, idempotency.scope);
          assert.equal(err.key, idempotency.key);
          assert.equal(err.existingObservationId, record1.observationId);
          assert.equal(err.attemptedObservationId, record2.observationId);
          return true;
        }
      );
    });

    it('J: Concorrência simultânea com mesma observationId + mesma chave de idempotência não duplica nem quebra', async () => {
      const now = Date.now();
      const obsId = `obs_concurrent_idem_${now}` as ObservationRecordId;
      const idempotency = { scope: 'test_scope_j', key: `key_j_${now}` };

      const record: ObservationRecord = {
        observationId: obsId,
        subject: { domain: 'd', entityType: 't', entityId: `j_${now}` },
        observedClaim: 'concurrent_claim',
        rawValue: 100,
        actor: { kind: 'integration', provider: 'bling' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      };

      const [res1, res2] = await Promise.all([
        adapter.recordObservation(record, idempotency),
        adapter.recordObservation(record, idempotency),
      ]);

      const deduplicatedCount = [res1.deduplicated, res2.deduplicated].filter((d) => d).length;
      assert.equal(deduplicatedCount, 1);

      const checkAll = await adapter.getObservation(obsId);
      assert.ok(checkAll);
    });

    it('K: Concorrência simultânea com observationIds distintos + mesma chave: uma vence e outra recebe IdempotencyConflictError', async () => {
      const now = Date.now();
      const idempotency = { scope: 'test_scope_k', key: `key_k_${now}` };

      const recordA: ObservationRecord = {
        observationId: `obs_k_a_${now}` as ObservationRecordId,
        subject: { domain: 'd', entityType: 't', entityId: `k_${now}` },
        observedClaim: 'claim_k_a',
        rawValue: 'val_a',
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      };

      const recordB: ObservationRecord = {
        observationId: `obs_k_b_${now}` as ObservationRecordId,
        subject: { domain: 'd', entityType: 't', entityId: `k_${now}` },
        observedClaim: 'claim_k_b',
        rawValue: 'val_b',
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      };

      const results = await Promise.allSettled([
        adapter.recordObservation(recordA, idempotency),
        adapter.recordObservation(recordB, idempotency),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(rejectedReason instanceof IdempotencyConflictError);

      // A perdedora não deve ter deixado registro órfão
      const winningRecord = (fulfilled[0] as PromiseFulfilledResult<any>).value.record;
      const losingObsId = winningRecord.observationId === recordA.observationId ? recordB.observationId : recordA.observationId;
      assert.equal(await adapter.getObservation(losingObsId), null);
    });
  });

  describe('2. ReviewEvent (Append-Only) & Vínculos Relacionais', () => {
    it('ReviewEvent round-trip preserva targetObservationIds, previousReviewIds e evidenceRefs', async () => {
      const now = Date.now();
      const obsId1 = `obs_rev_target_1_${now}` as ObservationRecordId;
      const obsId2 = `obs_rev_target_2_${now}` as ObservationRecordId;

      await adapter.recordObservation({
        observationId: obsId1,
        subject: { domain: 'd', entityType: 't', entityId: `rev_subject_${now}` },
        observedClaim: 'c1',
        rawValue: 1,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      await adapter.recordObservation({
        observationId: obsId2,
        subject: { domain: 'd', entityType: 't', entityId: `rev_subject_${now}` },
        observedClaim: 'c2',
        rawValue: 2,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const prevReviewId = `rev_prev_${now}` as ReviewEventId;
      const prevReview: NonCanonicalReviewEvent = {
        reviewId: prevReviewId,
        actor: { kind: 'max', maxVersion: '1.0' },
        targetObservationIds: [obsId1],
        decision: 'provisional',
        justification: 'Análise preliminar',
        reviewedAt: '2026-08-21T11:00:00.000Z',
      };
      await adapter.recordNonCanonicalReview(prevReview);

      const mainReviewId = `rev_main_${now}` as ReviewEventId;
      const mainReview: NonCanonicalReviewEvent = {
        reviewId: mainReviewId,
        actor: { kind: 'human', humanId: 'user_lucas', role: 'auditor' },
        targetObservationIds: [obsId1, obsId2],
        previousReviewIds: [prevReviewId],
        consideredEvidenceIds: ['art_ev_1' as EvidenceArtifactRefId],
        decision: 'corroborated',
        justification: 'Corroborado após conferência cruzada',
        reviewedAt: '2026-08-21T11:30:00.000Z',
      };

      await adapter.recordNonCanonicalReview(mainReview);

      const fetched = await adapter.getReview(mainReviewId);
      assert.ok(fetched);
      assert.equal(fetched.reviewId, mainReviewId);
      assert.equal(fetched.targetObservationIds.length, 2);
      assert.ok(fetched.targetObservationIds.includes(obsId1));
      assert.ok(fetched.targetObservationIds.includes(obsId2));
      assert.deepEqual(fetched.previousReviewIds, [prevReviewId]);
      assert.deepEqual(fetched.consideredEvidenceIds, ['art_ev_1']);
      assert.equal(fetched.decision, 'corroborated');
    });

    it('ReviewEvent referenciando observationId inexistente falha por integridade referencial', async () => {
      const now = Date.now();
      const invalidReview: NonCanonicalReviewEvent = {
        reviewId: `rev_invalid_fk_${now}` as ReviewEventId,
        actor: { kind: 'max', maxVersion: '1.0' },
        targetObservationIds: ['obs_non_existent_12345' as ObservationRecordId],
        decision: 'divergent',
        justification: 'FK inválida',
        reviewedAt: '2026-08-21T12:00:00.000Z',
      };

      await assert.rejects(async () => {
        await adapter.recordNonCanonicalReview(invalidReview);
      });
    });
  });

  describe('3. Validação de Coerência Cruzada ReviewEvent ↔ CanonicalProjection', () => {
    it('A: Review com estado approved e Projection com estado rejected -> CANONICAL_STATE_MISMATCH', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'compliance',
        entityType: 'audit_status',
        entityId: `doc_${now}`,
      };

      const obsId = `obs_cohere_a_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'status',
        rawValue: 'ok',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const revId = `rev_mismatch_${now}` as ReviewEventId;
      const projId = `proj_mismatch_${now}` as CanonicalProjectionRevisionId;

      await assert.rejects(
        async () => {
          await adapter.commitCanonicalPromotion({
            review: {
              reviewId: revId,
              actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
              targetObservationIds: [obsId],
              decision: 'canonical_promoted',
              canonicalEffect: { action: 'promote', targetCanonicalState: { status: 'approved' } },
              justification: 'Aprovado pelo diretor',
              reviewedAt: '2026-08-21T10:00:00.000Z',
            },
            projection: {
              projectionRevisionId: projId,
              subject,
              canonicalState: { status: 'rejected' }, // Divergente!
              underlyingObservationIds: [obsId],
              authorizingReviewIds: [revId],
              materializedAt: '2026-08-21T10:01:00.000Z',
              explanation: 'Divergente',
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'CANONICAL_STATE_MISMATCH');
          return true;
        }
      );
    });

    it('B: Projection cuja authorizingReviewIds não inclui a review corrente -> CURRENT_REVIEW_NOT_AUTHORIZING_PROJECTION', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'compliance',
        entityType: 'audit_status',
        entityId: `doc_b_${now}`,
      };

      const obsId = `obs_cohere_b_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'status',
        rawValue: 'ok',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const revId = `rev_b_${now}` as ReviewEventId;
      const otherRevId = `rev_b_other_${now}` as ReviewEventId;
      const projId = `proj_b_${now}` as CanonicalProjectionRevisionId;

      await assert.rejects(
        async () => {
          await adapter.commitCanonicalPromotion({
            review: {
              reviewId: revId,
              actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
              targetObservationIds: [obsId],
              decision: 'canonical_promoted',
              canonicalEffect: { action: 'promote', targetCanonicalState: { status: 'approved' } },
              justification: 'Aprovado',
              reviewedAt: '2026-08-21T10:00:00.000Z',
            },
            projection: {
              projectionRevisionId: projId,
              subject,
              canonicalState: { status: 'approved' },
              underlyingObservationIds: [obsId],
              authorizingReviewIds: [otherRevId], // Não inclui revId!
              materializedAt: '2026-08-21T10:01:00.000Z',
              explanation: 'Sem autorização atual',
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'CURRENT_REVIEW_NOT_AUTHORIZING_PROJECTION');
          return true;
        }
      );
    });

    it('C: Authorizing review referenciada existe mas não é canônica -> AUTHORIZING_REVIEW_NOT_CANONICAL', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'compliance',
        entityType: 'audit_status',
        entityId: `doc_c_${now}`,
      };

      const obsId = `obs_cohere_c_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'status',
        rawValue: 'ok',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      // Cria uma review não canônica (corroborated)
      const nonCanonicalRevId = `rev_non_canon_${now}` as ReviewEventId;
      await adapter.recordNonCanonicalReview({
        reviewId: nonCanonicalRevId,
        actor: { kind: 'human', humanId: 'user_analyst', role: 'analyst' },
        targetObservationIds: [obsId],
        decision: 'corroborated',
        justification: 'Corroborado mas não promovido',
        reviewedAt: '2026-08-21T10:00:00.000Z',
      });

      const currentRevId = `rev_c_${now}` as ReviewEventId;
      const projId = `proj_c_${now}` as CanonicalProjectionRevisionId;

      await assert.rejects(
        async () => {
          await adapter.commitCanonicalPromotion({
            review: {
              reviewId: currentRevId,
              actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
              targetObservationIds: [obsId],
              decision: 'canonical_promoted',
              canonicalEffect: { action: 'promote', targetCanonicalState: { status: 'approved' } },
              justification: 'Aprovado',
              reviewedAt: '2026-08-21T10:00:00.000Z',
            },
            projection: {
              projectionRevisionId: projId,
              subject,
              canonicalState: { status: 'approved' },
              underlyingObservationIds: [obsId],
              authorizingReviewIds: [currentRevId, nonCanonicalRevId], // nonCanonicalRevId não é canônica!
              materializedAt: '2026-08-21T10:01:00.000Z',
              explanation: 'Uso indevido de review não canônica como autorizadora',
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'AUTHORIZING_REVIEW_NOT_CANONICAL');
          return true;
        }
      );
    });

    it('D: Observation subjacente de outro subject na Projeção -> CROSS_SUBJECT_OBSERVATION_MISMATCH', async () => {
      const now = Date.now();
      const subjectTarget: ObservationSubject = {
        domain: 'catalog',
        entityType: 'product',
        entityId: `target_prod_${now}`,
      };

      const subjectAlien: ObservationSubject = {
        domain: 'catalog',
        entityType: 'product',
        entityId: `alien_prod_${now}`,
      };

      const obsAlienId = `obs_alien_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsAlienId,
        subject: subjectAlien, // Outro subject!
        observedClaim: 'status',
        rawValue: 'ok',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const currentRevId = `rev_d_${now}` as ReviewEventId;
      const projId = `proj_d_${now}` as CanonicalProjectionRevisionId;

      await assert.rejects(
        async () => {
          await adapter.commitCanonicalPromotion({
            review: {
              reviewId: currentRevId,
              actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
              targetObservationIds: [obsAlienId],
              decision: 'canonical_promoted',
              canonicalEffect: { action: 'promote', targetCanonicalState: { valid: true } },
              justification: 'Aprovado',
              reviewedAt: '2026-08-21T10:00:00.000Z',
            },
            projection: {
              projectionRevisionId: projId,
              subject: subjectTarget,
              canonicalState: { valid: true },
              underlyingObservationIds: [obsAlienId],
              authorizingReviewIds: [currentRevId],
              materializedAt: '2026-08-21T10:01:00.000Z',
              explanation: 'Cruzamento indevido de subject',
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'CROSS_SUBJECT_OBSERVATION_MISMATCH');
          return true;
        }
      );
    });

    it('F: Observation subjacente na Projeção não coberta por nenhuma authorizing review -> UNDERLYING_OBSERVATION_NOT_AUTHORIZED', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'product',
        entityId: `unauth_prod_${now}`,
      };

      const obsAuthorizedId = `obs_auth_${now}` as ObservationRecordId;
      const obsUnauthId = `obs_unauth_${now}` as ObservationRecordId;

      await adapter.recordObservation({
        observationId: obsAuthorizedId,
        subject,
        observedClaim: 'claim1',
        rawValue: 'val1',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      await adapter.recordObservation({
        observationId: obsUnauthId,
        subject,
        observedClaim: 'claim2',
        rawValue: 'val2',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const currentRevId = `rev_f_${now}` as ReviewEventId;
      const projId = `proj_f_${now}` as CanonicalProjectionRevisionId;

      await assert.rejects(
        async () => {
          await adapter.commitCanonicalPromotion({
            review: {
              reviewId: currentRevId,
              actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
              targetObservationIds: [obsAuthorizedId], // Avaliou apenas obsAuthorizedId
              decision: 'canonical_promoted',
              canonicalEffect: { action: 'promote', targetCanonicalState: { valid: true } },
              justification: 'Aprovado',
              reviewedAt: '2026-08-21T10:00:00.000Z',
            },
            projection: {
              projectionRevisionId: projId,
              subject,
              canonicalState: { valid: true },
              underlyingObservationIds: [obsAuthorizedId, obsUnauthId], // Tenta incluir obsUnauthId sem autorização!
              authorizingReviewIds: [currentRevId],
              materializedAt: '2026-08-21T10:01:00.000Z',
              explanation: 'Sem autorização para obsUnauthId',
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'UNDERLYING_OBSERVATION_NOT_AUTHORIZED');
          return true;
        }
      );
    });

    it('G: Cenário válido com review corrente + review canônica anterior sustentando histórico cumulativo -> Aceito', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'product',
        entityId: `cumul_prod_${now}`,
      };

      const obs1Id = `obs_cumul_1_${now}` as ObservationRecordId;
      const obs2Id = `obs_cumul_2_${now}` as ObservationRecordId;

      await adapter.recordObservation({
        observationId: obs1Id,
        subject,
        observedClaim: 'claim1',
        rawValue: 'val1',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      await adapter.recordObservation({
        observationId: obs2Id,
        subject,
        observedClaim: 'claim2',
        rawValue: 'val2',
        actor: { kind: 'system', component: 'sensor' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T11:00:00.000Z',
        capturedAt: '2026-08-21T11:00:01.000Z',
      });

      // 1. Promoção V1 avaliando obs1
      const rev1Id = `rev_cumul_1_${now}` as ReviewEventId;
      const proj1Id = `proj_cumul_1_${now}` as CanonicalProjectionRevisionId;

      await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev1Id,
          actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
          targetObservationIds: [obs1Id],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { step: 1 } },
          justification: 'Step 1',
          reviewedAt: '2026-08-21T10:30:00.000Z',
        },
        projection: {
          projectionRevisionId: proj1Id,
          subject,
          canonicalState: { step: 1 },
          underlyingObservationIds: [obs1Id],
          authorizingReviewIds: [rev1Id],
          materializedAt: '2026-08-21T10:35:00.000Z',
          explanation: 'Step 1',
        },
      });

      // 2. Promoção V2 avaliando obs2, sustentada por rev1 (anterior) e rev2 (corrente), abrangendo obs1 e obs2
      const rev2Id = `rev_cumul_2_${now}` as ReviewEventId;
      const proj2Id = `proj_cumul_2_${now}` as CanonicalProjectionRevisionId;

      const res2 = await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev2Id,
          actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
          targetObservationIds: [obs2Id],
          targetBaseRevisionId: proj1Id,
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { step: 2 } },
          justification: 'Step 2 acumulado',
          reviewedAt: '2026-08-21T11:30:00.000Z',
        },
        projection: {
          projectionRevisionId: proj2Id,
          subject,
          canonicalState: { step: 2 },
          underlyingObservationIds: [obs1Id, obs2Id], // Ambas cobertas pela união de rev1 e rev2
          authorizingReviewIds: [rev1Id, rev2Id],
          supersedesRevisionId: proj1Id,
          materializedAt: '2026-08-21T11:35:00.000Z',
          explanation: 'Step 2 cumulativo',
        },
        expectedBaseRevisionId: proj1Id,
      });

      assert.equal(res2.head.currentProjectionRevisionId, proj2Id);
      assert.equal(res2.head.version, BigInt(2));
    });
  });

  describe('4. Promoção Canônica, Head e Concorrência Otimista com Advisory Locks', () => {
    it('L, M, N, O: Primeira promoção cria Head V1; segunda supersedes e cria Head V2 com histórico intacto', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'sku_pricing',
        entityId: `sku_promo_${now}`,
      };

      const obsId1 = `obs_promo_1_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId1,
        subject,
        observedClaim: 'base_price',
        rawValue: 50.0,
        actor: { kind: 'system', component: 'feeder' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:01:00.000Z',
      });

      const rev1Id = `rev_promo_1_${now}` as ReviewEventId;
      const proj1Id = `proj_rev_1_${now}` as CanonicalProjectionRevisionId;

      const review1: CanonicalPromotedReviewEvent = {
        reviewId: rev1Id,
        actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
        targetObservationIds: [obsId1],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 50.0, approved: true },
        },
        justification: 'Aprovação inicial do preço base',
        reviewedAt: '2026-08-21T11:00:00.000Z',
      };

      const projection1: CanonicalProjection = {
        projectionRevisionId: proj1Id,
        subject,
        canonicalState: { price: 50.0, approved: true },
        underlyingObservationIds: [obsId1],
        authorizingReviewIds: [rev1Id],
        materializedAt: '2026-08-21T11:05:00.000Z',
        explanation: 'Primeira projeção canônica aprovada por Lucas',
      };

      const commit1Res = await adapter.commitCanonicalPromotion({
        review: review1,
        projection: projection1,
        expectedBaseRevisionId: undefined,
      });

      assert.equal(commit1Res.head.currentProjectionRevisionId, proj1Id);
      assert.equal(commit1Res.head.version, BigInt(1));

      const head1 = await adapter.getCurrentCanonicalHead(subject);
      assert.ok(head1);
      assert.equal(head1.currentProjectionRevisionId, proj1Id);
      assert.equal(head1.version, BigInt(1));

      const obsId2 = `obs_promo_2_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId2,
        subject,
        observedClaim: 'base_price',
        rawValue: 55.0,
        actor: { kind: 'system', component: 'feeder' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T12:00:00.000Z',
        capturedAt: '2026-08-21T12:01:00.000Z',
      });

      const rev2Id = `rev_promo_2_${now}` as ReviewEventId;
      const proj2Id = `proj_rev_2_${now}` as CanonicalProjectionRevisionId;

      const review2: CanonicalPromotedReviewEvent = {
        reviewId: rev2Id,
        actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_DIR' },
        targetObservationIds: [obsId2],
        targetBaseRevisionId: proj1Id,
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 55.0, approved: true },
        },
        justification: 'Reajuste anual de preço aprovado',
        reviewedAt: '2026-08-21T13:00:00.000Z',
      };

      const projection2: CanonicalProjection = {
        projectionRevisionId: proj2Id,
        subject,
        canonicalState: { price: 55.0, approved: true },
        underlyingObservationIds: [obsId2],
        authorizingReviewIds: [rev2Id],
        supersedesRevisionId: proj1Id,
        materializedAt: '2026-08-21T13:05:00.000Z',
        explanation: 'Segunda projeção canônica reajustada',
      };

      const commit2Res = await adapter.commitCanonicalPromotion({
        review: review2,
        projection: projection2,
        expectedBaseRevisionId: proj1Id,
      });

      assert.equal(commit2Res.head.currentProjectionRevisionId, proj2Id);
      assert.equal(commit2Res.head.version, BigInt(2));

      const fetchedProj1 = await adapter.getCanonicalProjectionRevision(proj1Id);
      assert.ok(fetchedProj1);
      assert.equal(fetchedProj1.canonicalState.price, 50.0);

      const currentProj = await adapter.getCurrentCanonicalProjection(subject);
      assert.ok(currentProj);
      assert.equal(currentProj.projectionRevisionId, proj2Id);
      assert.equal(currentProj.canonicalState.price, 55.0);
      assert.equal(currentProj.supersedesRevisionId, proj1Id);
    });

    it('P, Q, R: Promoção avaliada contra base stale é rejeitada e não deixa estado parcial', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'stale_test',
        entityId: `stale_item_${now}`,
      };

      const obsId = `obs_stale_1_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'val',
        rawValue: 10,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const rev1Id = `rev_stale_1_${now}` as ReviewEventId;
      const proj1Id = `proj_stale_1_${now}` as CanonicalProjectionRevisionId;

      await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev1Id,
          actor: { kind: 'human', humanId: 'user_1', authorityRef: 'AUTH_1' },
          targetObservationIds: [obsId],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { v: 1 } },
          justification: 'V1',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: proj1Id,
          subject,
          canonicalState: { v: 1 },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [rev1Id],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'V1',
        },
        expectedBaseRevisionId: undefined,
      });

      const rev2Id = `rev_stale_2_${now}` as ReviewEventId;
      const proj2Id = `proj_stale_2_${now}` as CanonicalProjectionRevisionId;

      await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev2Id,
          actor: { kind: 'human', humanId: 'user_1', authorityRef: 'AUTH_1' },
          targetObservationIds: [obsId],
          targetBaseRevisionId: proj1Id,
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { v: 2 } },
          justification: 'V2',
          reviewedAt: '2026-08-21T11:00:00.000Z',
        },
        projection: {
          projectionRevisionId: proj2Id,
          subject,
          canonicalState: { v: 2 },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [rev2Id],
          supersedesRevisionId: proj1Id,
          materializedAt: '2026-08-21T11:01:00.000Z',
          explanation: 'V2',
        },
        expectedBaseRevisionId: proj1Id,
      });

      const rev3Id = `rev_stale_3_failing_${now}` as ReviewEventId;
      const proj3Id = `proj_stale_3_failing_${now}` as CanonicalProjectionRevisionId;

      await assert.rejects(
        async () => {
          await adapter.commitCanonicalPromotion({
            review: {
              reviewId: rev3Id,
              actor: { kind: 'human', humanId: 'user_2', authorityRef: 'AUTH_2' },
              targetObservationIds: [obsId],
              targetBaseRevisionId: proj1Id,
              decision: 'canonical_promoted',
              canonicalEffect: { action: 'promote', targetCanonicalState: { v: 3 } },
              justification: 'Tentativa concorrente sobre V1',
              reviewedAt: '2026-08-21T12:00:00.000Z',
            },
            projection: {
              projectionRevisionId: proj3Id,
              subject,
              canonicalState: { v: 3 },
              underlyingObservationIds: [obsId],
              authorizingReviewIds: [rev3Id],
              supersedesRevisionId: proj1Id,
              materializedAt: '2026-08-21T12:01:00.000Z',
              explanation: 'V3 stale',
            },
            expectedBaseRevisionId: proj1Id,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleCanonicalBaseConflictError);
          assert.equal(err.expectedBaseRevisionId, proj1Id);
          assert.equal(err.currentHeadRevisionId, proj2Id);
          return true;
        }
      );

      const orphanReview = await adapter.getReview(rev3Id);
      assert.equal(orphanReview, null);

      const orphanProjection = await adapter.getCanonicalProjectionRevision(proj3Id);
      assert.equal(orphanProjection, null);

      const head = await adapter.getCurrentCanonicalHead(subject);
      assert.ok(head);
      assert.equal(head.currentProjectionRevisionId, proj2Id);
      assert.equal(head.version, BigInt(2));
    });

    it('H: Duas promoções concorrentes sobre a mesma base: exatamente uma vence e a outra recebe StaleCanonicalBaseConflictError', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'concurrency_test',
        entityId: `concurrent_item_${now}`,
      };

      const obsId = `obs_conc_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'c',
        rawValue: 100,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const baseRevId = `rev_base_${now}` as ReviewEventId;
      const baseProjId = `proj_base_${now}` as CanonicalProjectionRevisionId;

      await adapter.commitCanonicalPromotion({
        review: {
          reviewId: baseRevId,
          actor: { kind: 'human', humanId: 'user_1', authorityRef: 'AUTH_1' },
          targetObservationIds: [obsId],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { val: 'base' } },
          justification: 'Base V1',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: baseProjId,
          subject,
          canonicalState: { val: 'base' },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [baseRevId],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'Base V1',
        },
      });

      const revAId = `rev_conc_a_${now}` as ReviewEventId;
      const projAId = `proj_conc_a_${now}` as CanonicalProjectionRevisionId;
      const promoA = {
        review: {
          reviewId: revAId,
          actor: { kind: 'human' as const, humanId: 'user_a', authorityRef: 'AUTH_A' },
          targetObservationIds: [obsId],
          targetBaseRevisionId: baseProjId,
          decision: 'canonical_promoted' as const,
          canonicalEffect: { action: 'promote' as const, targetCanonicalState: { val: 'A' } },
          justification: 'Promo A',
          reviewedAt: '2026-08-21T11:00:00.000Z',
        },
        projection: {
          projectionRevisionId: projAId,
          subject,
          canonicalState: { val: 'A' },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [revAId],
          supersedesRevisionId: baseProjId,
          materializedAt: '2026-08-21T11:01:00.000Z',
          explanation: 'Proj A',
        },
        expectedBaseRevisionId: baseProjId,
      };

      const revBId = `rev_conc_b_${now}` as ReviewEventId;
      const projBId = `proj_conc_b_${now}` as CanonicalProjectionRevisionId;
      const promoB = {
        review: {
          reviewId: revBId,
          actor: { kind: 'human' as const, humanId: 'user_b', authorityRef: 'AUTH_B' },
          targetObservationIds: [obsId],
          targetBaseRevisionId: baseProjId,
          decision: 'canonical_promoted' as const,
          canonicalEffect: { action: 'promote' as const, targetCanonicalState: { val: 'B' } },
          justification: 'Promo B',
          reviewedAt: '2026-08-21T11:00:00.000Z',
        },
        projection: {
          projectionRevisionId: projBId,
          subject,
          canonicalState: { val: 'B' },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [revBId],
          supersedesRevisionId: baseProjId,
          materializedAt: '2026-08-21T11:01:00.000Z',
          explanation: 'Proj B',
        },
        expectedBaseRevisionId: baseProjId,
      };

      const results = await Promise.allSettled([
        adapter.commitCanonicalPromotion(promoA),
        adapter.commitCanonicalPromotion(promoB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(rejectedReason instanceof StaleCanonicalBaseConflictError);

      const head = await adapter.getCurrentCanonicalHead(subject);
      assert.ok(head);
      assert.equal(head.version, BigInt(2));
    });

    it('I: Duas promoções concorrentes criando primeira Head: exatamente uma vence e outra recebe StaleCanonicalBaseConflictError sem 23505', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'initial_head_concurrency',
        entityId: `init_item_${now}`,
      };

      const obsId = `obs_init_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'init',
        rawValue: 1,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const revAId = `rev_init_a_${now}` as ReviewEventId;
      const projAId = `proj_init_a_${now}` as CanonicalProjectionRevisionId;
      const promoA = {
        review: {
          reviewId: revAId,
          actor: { kind: 'human' as const, humanId: 'user_a', authorityRef: 'AUTH_A' },
          targetObservationIds: [obsId],
          decision: 'canonical_promoted' as const,
          canonicalEffect: { action: 'promote' as const, targetCanonicalState: { init: 'A' } },
          justification: 'Init A',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: projAId,
          subject,
          canonicalState: { init: 'A' },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [revAId],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'Init Proj A',
        },
      };

      const revBId = `rev_init_b_${now}` as ReviewEventId;
      const projBId = `proj_init_b_${now}` as CanonicalProjectionRevisionId;
      const promoB = {
        review: {
          reviewId: revBId,
          actor: { kind: 'human' as const, humanId: 'user_b', authorityRef: 'AUTH_B' },
          targetObservationIds: [obsId],
          decision: 'canonical_promoted' as const,
          canonicalEffect: { action: 'promote' as const, targetCanonicalState: { init: 'B' } },
          justification: 'Init B',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: projBId,
          subject,
          canonicalState: { init: 'B' },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [revBId],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'Init Proj B',
        },
      };

      const results = await Promise.allSettled([
        adapter.commitCanonicalPromotion(promoA),
        adapter.commitCanonicalPromotion(promoB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(rejectedReason instanceof StaleCanonicalBaseConflictError);

      const head = await adapter.getCurrentCanonicalHead(subject);
      assert.ok(head);
      assert.equal(head.version, BigInt(1));

      // A perdedora não deve deixar linhas órfãs
      const winningRev = (fulfilled[0] as PromiseFulfilledResult<any>).value.review;
      const losingRevId = winningRev.reviewId === revAId ? revBId : revAId;
      const losingProjId = winningRev.reviewId === revAId ? projBId : projAId;

      assert.equal(await adapter.getReview(losingRevId), null);
      assert.equal(await adapter.getCanonicalProjectionRevision(losingProjId), null);
    });

    it('canonical_reclassified cria nova revision com action reclassify e preserva anterior', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'catalog',
        entityType: 'reclassify_test',
        entityId: `reclass_item_${now}`,
      };

      const obsId = `obs_reclass_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'category',
        rawValue: 'draft_cat',
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const rev1Id = `rev_rec_1_${now}` as ReviewEventId;
      const proj1Id = `proj_rec_1_${now}` as CanonicalProjectionRevisionId;

      await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev1Id,
          actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_1' },
          targetObservationIds: [obsId],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { category: 'Standard' } },
          justification: 'Aprovado Standard',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: proj1Id,
          subject,
          canonicalState: { category: 'Standard' },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [rev1Id],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'Standard',
        },
      });

      const rev2Id = `rev_rec_2_${now}` as ReviewEventId;
      const proj2Id = `proj_rec_2_${now}` as CanonicalProjectionRevisionId;

      const reclassReview: CanonicalReclassifiedReviewEvent = {
        reviewId: rev2Id,
        actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_BOARD' },
        targetObservationIds: [obsId],
        targetBaseRevisionId: proj1Id,
        decision: 'canonical_reclassified',
        canonicalEffect: { action: 'reclassify', targetCanonicalState: { category: 'Premium' } },
        justification: 'Reclassificado formalmente para Premium após nova inspeção técnica',
        reviewedAt: '2026-08-21T14:00:00.000Z',
      };

      const reclassProj: CanonicalProjection = {
        projectionRevisionId: proj2Id,
        subject,
        canonicalState: { category: 'Premium' },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [rev2Id],
        supersedesRevisionId: proj1Id,
        materializedAt: '2026-08-21T14:05:00.000Z',
        explanation: 'Reclassificação canônica para Premium',
      };

      await adapter.commitCanonicalPromotion({
        review: reclassReview,
        projection: reclassProj,
        expectedBaseRevisionId: proj1Id,
      });

      const v1 = await adapter.getCanonicalProjectionRevision(proj1Id);
      assert.ok(v1);
      assert.equal(v1.canonicalState.category, 'Standard');

      const v2 = await adapter.getCurrentCanonicalProjection(subject);
      assert.ok(v2);
      assert.equal(v2.canonicalState.category, 'Premium');
      assert.equal(v2.supersedesRevisionId, proj1Id);
    });

    it('R: Teste real de rollback de transação após escrita parcial (falha em INSERT de Projection)', async () => {
      const now = Date.now();
      const subject1: ObservationSubject = {
        domain: 'catalog',
        entityType: 'rollback_subject',
        entityId: `subj_1_${now}`,
      };

      const obs1Id = `obs_rb_1_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obs1Id,
        subject: subject1,
        observedClaim: 'claim_1',
        rawValue: 'val_1',
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      // 1. Cria Projection P_EXISTING válida
      const existingRevId = `rev_existing_${now}` as ReviewEventId;
      const existingProjId = `proj_existing_${now}` as CanonicalProjectionRevisionId;

      await adapter.commitCanonicalPromotion({
        review: {
          reviewId: existingRevId,
          actor: { kind: 'human', humanId: 'user_1', authorityRef: 'AUTH_1' },
          targetObservationIds: [obs1Id],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { v: 'existing' } },
          justification: 'Existing V1',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: existingProjId,
          subject: subject1,
          canonicalState: { v: 'existing' },
          underlyingObservationIds: [obs1Id],
          authorizingReviewIds: [existingRevId],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'Existing',
        },
      });

      // 2. Tenta criar promoção em subject2 com nova review válida, mas reusando o existingProjId (colisão de PK na projection)
      const subject2: ObservationSubject = {
        domain: 'catalog',
        entityType: 'rollback_subject',
        entityId: `subj_2_${now}`,
      };

      const obs2Id = `obs_rb_2_${now}` as ObservationRecordId;
      await adapter.recordObservation({
        observationId: obs2Id,
        subject: subject2,
        observedClaim: 'claim_2',
        rawValue: 'val_2',
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      const doomedRevId = `rev_doomed_${now}` as ReviewEventId;

      await assert.rejects(async () => {
        await adapter.commitCanonicalPromotion({
          review: {
            reviewId: doomedRevId,
            actor: { kind: 'human', humanId: 'user_2', authorityRef: 'AUTH_2' },
            targetObservationIds: [obs2Id],
            decision: 'canonical_promoted',
            canonicalEffect: { action: 'promote', targetCanonicalState: { v: 'doomed' } },
            justification: 'Doomed review que passaria antes da falha da projection',
            reviewedAt: '2026-08-21T10:00:00.000Z',
          },
          projection: {
            projectionRevisionId: existingProjId, // Colisão de PK na projection!
            subject: subject2,
            canonicalState: { v: 'doomed' },
            underlyingObservationIds: [obs2Id],
            authorizingReviewIds: [doomedRevId],
            materializedAt: '2026-08-21T10:01:00.000Z',
            explanation: 'Doomed projection',
          },
        });
      });

      // Confirmação de Rollback total: a review doomed NÃO existe, a head do subject 2 NÃO existe, e existingProjId permanece intacta
      assert.equal(await adapter.getReview(doomedRevId), null);
      assert.equal(await adapter.getCurrentCanonicalHead(subject2), null);

      const intactProj = await adapter.getCanonicalProjectionRevision(existingProjId);
      assert.ok(intactProj);
      assert.equal(intactProj.canonicalState.v, 'existing');
    });
  });

  describe('5. Proteção Estrutural Append-Only no PostgreSQL (Triggers de Rejeição)', () => {
    it('L: SQL direto UPDATE em nex_review_events é rejeitado pelo trigger', async () => {
      await assert.rejects(
        async () => {
          await pool.query(`UPDATE nex_review_events SET justification = 'hacked' WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );
    });

    it('M: SQL direto DELETE em nex_observation_records é rejeitado pelo trigger', async () => {
      await assert.rejects(
        async () => {
          await pool.query(`DELETE FROM nex_observation_records WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );
    });

    it('N: SQL direto DELETE em tabela de relation (nex_review_event_observations) é rejeitado pelo trigger', async () => {
      await assert.rejects(
        async () => {
          await pool.query(`DELETE FROM nex_review_event_observations WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );
    });

    it('O: SQL direto TRUNCATE em nex_canonical_projection_revisions é rejeitado pelo trigger', async () => {
      await assert.rejects(
        async () => {
          await pool.query(`TRUNCATE nex_canonical_projection_revisions CASCADE`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );
    });

    it('P & Q: Inserção pelo adapter continua funcionando e Head continua sendo mutável', async () => {
      const now = Date.now();
      const subject: ObservationSubject = {
        domain: 'pricing',
        entityType: 'head_mut_test',
        entityId: `item_${now}`,
      };

      const obsId = `obs_head_mut_${now}` as ObservationRecordId;
      const recRes = await adapter.recordObservation({
        observationId: obsId,
        subject,
        observedClaim: 'val',
        rawValue: 10,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });
      assert.ok(recRes);

      const rev1Id = `rev_hm_1_${now}` as ReviewEventId;
      const proj1Id = `proj_hm_1_${now}` as CanonicalProjectionRevisionId;

      const p1 = await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev1Id,
          actor: { kind: 'human', humanId: 'user_1', authorityRef: 'AUTH_1' },
          targetObservationIds: [obsId],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { v: 1 } },
          justification: 'V1',
          reviewedAt: '2026-08-21T10:00:00.000Z',
        },
        projection: {
          projectionRevisionId: proj1Id,
          subject,
          canonicalState: { v: 1 },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [rev1Id],
          materializedAt: '2026-08-21T10:01:00.000Z',
          explanation: 'V1',
        },
      });
      assert.equal(p1.head.version, BigInt(1));

      const rev2Id = `rev_hm_2_${now}` as ReviewEventId;
      const proj2Id = `proj_hm_2_${now}` as CanonicalProjectionRevisionId;

      const p2 = await adapter.commitCanonicalPromotion({
        review: {
          reviewId: rev2Id,
          actor: { kind: 'human', humanId: 'user_1', authorityRef: 'AUTH_1' },
          targetObservationIds: [obsId],
          targetBaseRevisionId: proj1Id,
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: { v: 2 } },
          justification: 'V2 mutando a head',
          reviewedAt: '2026-08-21T11:00:00.000Z',
        },
        projection: {
          projectionRevisionId: proj2Id,
          subject,
          canonicalState: { v: 2 },
          underlyingObservationIds: [obsId],
          authorizingReviewIds: [rev2Id],
          supersedesRevisionId: proj1Id,
          materializedAt: '2026-08-21T11:01:00.000Z',
          explanation: 'V2',
        },
        expectedBaseRevisionId: proj1Id,
      });
      assert.equal(p2.head.version, BigInt(2));
      assert.equal(p2.head.currentProjectionRevisionId, proj2Id);
    });
  });
});
