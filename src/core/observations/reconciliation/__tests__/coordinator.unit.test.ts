/**
 * NEX+ · Testes Unitários do ReconciliationCoordinator (Preservação Stale Fail-Visible & Identidade Semântica)
 * Escopo 0.85D (Blockers J + K)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  ReviewEvent,
  ReviewEventId,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  HumanActor,
  MaxActor,
} from '../../contracts';
import type {
  ObservationPersistenceAdapter,
  CommitCanonicalPromotionParams,
  CommitCanonicalPromotionResult,
  RecordObservationResult,
  CanonicalHeadInfo,
} from '../../persistence/contracts';
import type {
  ReconciliationPersistenceAdapter,
  CreateReconciliationCaseParams,
  CreateReconciliationCaseResult,
  AppendReconciliationRevisionParams,
  AppendReconciliationRevisionResult,
  ReconciliationHeadInfo,
} from '../contracts';
import { StaleCanonicalBaseConflictError } from '../../persistence/errors';
import {
  StaleReviewPreservationError,
  ReviewIdentityConflictError,
} from '../errors';
import { ReconciliationCoordinator } from '../coordinator';
import type { HumanAuthorizationDecision } from '../../../policy/contracts';

class MockObservationPersistenceAdapter implements ObservationPersistenceAdapter {
  public reviews = new Map<string, ReviewEvent>();
  public commitPromotionFn?: (params: CommitCanonicalPromotionParams) => Promise<CommitCanonicalPromotionResult>;
  public recordNonCanonicalFn?: (review: NonCanonicalReviewEvent) => Promise<ReviewEvent>;
  public getReviewFn?: (reviewId: ReviewEventId) => Promise<ReviewEvent | null>;

  async recordObservation(): Promise<RecordObservationResult> {
    throw new Error('Not implemented');
  }

  async getObservation(): Promise<ObservationRecord | null> {
    throw new Error('Not implemented');
  }

  async listObservationsBySubject(): Promise<readonly ObservationRecord[]> {
    return [];
  }

  async recordNonCanonicalReview(review: NonCanonicalReviewEvent): Promise<ReviewEvent> {
    if (this.recordNonCanonicalFn) {
      return this.recordNonCanonicalFn(review);
    }
    this.reviews.set(review.reviewId, review);
    return review;
  }

  async getReview(reviewId: ReviewEventId): Promise<ReviewEvent | null> {
    if (this.getReviewFn) {
      return this.getReviewFn(reviewId);
    }
    return this.reviews.get(reviewId) ?? null;
  }

  async commitCanonicalPromotion(params: CommitCanonicalPromotionParams): Promise<CommitCanonicalPromotionResult> {
    if (this.commitPromotionFn) {
      return this.commitPromotionFn(params);
    }
    throw new Error('commitCanonicalPromotion not mocked');
  }

  async getCanonicalProjectionRevision(): Promise<CanonicalProjection | null> {
    return null;
  }

  async getCurrentCanonicalProjection(): Promise<CanonicalProjection | null> {
    return null;
  }

  async getCurrentCanonicalHead(): Promise<CanonicalHeadInfo | null> {
    return null;
  }
}

class MockReconciliationPersistenceAdapter implements ReconciliationPersistenceAdapter {
  async createReconciliationCase(params: CreateReconciliationCaseParams): Promise<CreateReconciliationCaseResult> {
    throw new Error('Not implemented');
  }

  async appendReconciliationRevision(params: AppendReconciliationRevisionParams): Promise<AppendReconciliationRevisionResult> {
    throw new Error('Not implemented');
  }

  async getCurrentReconciliationCase(): Promise<any> {
    return null;
  }

  async getCurrentReconciliationHead(): Promise<ReconciliationHeadInfo | null> {
    return null;
  }

  async listReconciliationHistory(): Promise<readonly any[]> {
    return [];
  }

  async recordContextualPrecedent(): Promise<any> {
    throw new Error('Not implemented');
  }

  async getContextualPrecedent(): Promise<any> {
    return null;
  }

  async listContextualPrecedentsByReview(): Promise<readonly any[]> {
    return [];
  }
}

function makeStaleError(expectedBaseRevisionId = 'proj_v1', currentHeadRevisionId = 'proj_v2_other'): StaleCanonicalBaseConflictError {
  return new StaleCanonicalBaseConflictError({
    domain: 'commerce_offer',
    entityType: 'product_offer',
    entityId: 'prod_unit_test_sku',
    expectedBaseRevisionId,
    currentHeadRevisionId,
  });
}

describe('ReconciliationCoordinator · Preservação Stale Fail-Visible & Identidade Semântica (Blockers J + K)', () => {
  const subject: ObservationSubject = {
    domain: 'commerce_offer',
    entityType: 'product_offer',
    entityId: 'prod_unit_test_sku',
  };

  const humanAlice: HumanActor = {
    kind: 'human',
    humanId: 'user_alice_auditor',
    role: 'auditor',
    authorityRef: 'AUTH_TEST_ALICE',
  };

  const validAuth: HumanAuthorizationDecision = {
    actorRef: humanAlice.humanId,
    operation: 'canonical_promotion',
    verdict: 'authorized',
    reasonCode: 'AUTH_OK',
    authorizedAt: '2026-08-22T15:00:00.000Z',
  };

  const validReclassifyAuth: HumanAuthorizationDecision = {
    actorRef: humanAlice.humanId,
    operation: 'canonical_reclassification',
    verdict: 'authorized',
    reasonCode: 'AUTH_OK',
    authorizedAt: '2026-08-22T15:00:00.000Z',
  };

  const sampleReview: CanonicalPromotedReviewEvent = {
    reviewId: 'rev_alice_stale_100' as ReviewEventId,
    targetObservationIds: ['obs_1' as ObservationRecordId, 'obs_2' as ObservationRecordId],
    actor: humanAlice,
    decision: 'canonical_promoted',
    canonicalEffect: { action: 'promote', targetCanonicalState: { price: 99.90 } },
    targetBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
    justification: 'Alice promotion on stale base.',
    reviewedAt: '2026-08-22T15:00:00.000Z',
  };

  const sampleProjection: CanonicalProjection = {
    projectionRevisionId: 'proj_v2_alice' as CanonicalProjectionRevisionId,
    subject,
    canonicalState: { price: 99.90 },
    underlyingObservationIds: ['obs_1' as ObservationRecordId, 'obs_2' as ObservationRecordId],
    authorizingReviewIds: [sampleReview.reviewId],
    materializedAt: '2026-08-22T15:00:05.000Z',
    explanation: 'Alice price update.',
  };

  // ==========================================================================
  // CENÁRIO J1: FALHA NA PRESERVAÇÃO LANÇA StaleReviewPreservationError
  // ==========================================================================
  it('J1: Se a persistência da review stale falhar, lança StaleReviewPreservationError sem engolir o erro', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    const persistenceError = new Error('Database connection terminated during review write');
    obsMock.recordNonCanonicalFn = async () => {
      throw persistenceError;
    };

    let callCount = 0;
    obsMock.getReviewFn = async () => {
      callCount++;
      return null; // Ausente antes e depois
    };

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: sampleReview,
          projection: sampleProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleReviewPreservationError, 'Deve lançar StaleReviewPreservationError');
        assert.equal(err.name, 'StaleReviewPreservationError');
        assert.equal(err.reviewId, sampleReview.reviewId);
        assert.equal(err.staleConflict, originalStaleError);
        assert.equal(err.cause, persistenceError);
        return true;
      }
    );

    assert.equal(callCount, 2, 'Deve verificar getReview antes e depois da tentativa de insert');
  });

  // ==========================================================================
  // CENÁRIO J2: PRESERVAÇÃO BEM SUCEDIDA RELANÇA StaleCanonicalBaseConflictError
  // ==========================================================================
  it('J2: Se a review stale for gravada com sucesso, relança o StaleCanonicalBaseConflictError original', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    let recordedReview: NonCanonicalReviewEvent | null = null;
    obsMock.recordNonCanonicalFn = async (r) => {
      recordedReview = r;
      obsMock.reviews.set(r.reviewId, r);
      return r;
    };

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: sampleReview,
          projection: sampleProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleCanonicalBaseConflictError, 'Deve relançar StaleCanonicalBaseConflictError');
        assert.equal(err, originalStaleError);
        return true;
      }
    );

    assert.ok(recordedReview);
    assert.equal((recordedReview as any).reviewId, sampleReview.reviewId);
    assert.equal((recordedReview as any).decision, 'contested');
    assert.equal((recordedReview as any).targetBaseRevisionId, 'proj_v1');
    assert.equal((recordedReview as any).justification, sampleReview.justification);
    assert.deepEqual((recordedReview as any).targetObservationIds, sampleReview.targetObservationIds);
  });

  // ==========================================================================
  // CENÁRIO K1: COLISÃO COM REVIEW PREEXISTENTE DIVERGENTE LANÇA ReviewIdentityConflictError
  // ==========================================================================
  it('K1: Se já existir uma review com mesmo reviewId mas conteúdo divergente, lança ReviewIdentityConflictError', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    // Preexistir uma review com mesmo ID mas justification e actor divergentes
    obsMock.reviews.set(sampleReview.reviewId, {
      reviewId: sampleReview.reviewId,
      actor: { kind: 'max', maxVersion: '3.0' } as MaxActor,
      decision: 'contested',
      targetObservationIds: ['obs_1' as ObservationRecordId],
      justification: 'Completely different pre-existing review.',
      reviewedAt: '2026-08-20T10:00:00.000Z',
    });

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: sampleReview,
          projection: sampleProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof ReviewIdentityConflictError, 'Deve lançar ReviewIdentityConflictError');
        assert.equal(err.name, 'ReviewIdentityConflictError');
        assert.equal(err.reviewId, sampleReview.reviewId);
        return true;
      }
    );
  });

  // ==========================================================================
  // CENÁRIO K2: RETRY IDÊNTICO É ACEITO IDEMPOTENTEMENTE
  // ==========================================================================
  it('K2: Se já existir a review contested exatamente equivalente, aceita idempotentemente e relança o stale', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    // Preexistir exatamente a contested review esperada
    const existingContested: NonCanonicalReviewEvent = {
      reviewId: sampleReview.reviewId,
      actor: sampleReview.actor,
      decision: 'contested',
      targetObservationIds: sampleReview.targetObservationIds,
      previousReviewIds: sampleReview.previousReviewIds,
      consideredEvidenceIds: sampleReview.consideredEvidenceIds,
      targetBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
      justification: sampleReview.justification,
      reviewedAt: sampleReview.reviewedAt,
    };
    obsMock.reviews.set(sampleReview.reviewId, existingContested);

    let recordCalled = false;
    obsMock.recordNonCanonicalFn = async () => {
      recordCalled = true;
      throw new Error('Should not attempt to insert when already present');
    };

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: sampleReview,
          projection: sampleProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleCanonicalBaseConflictError);
        assert.equal(err, originalStaleError);
        return true;
      }
    );

    assert.equal(recordCalled, false, 'Não deve chamar recordNonCanonicalReview se já existe equivalente');
  });

  // ==========================================================================
  // CENÁRIO K3: ORDEM NÃO SEMÂNTICA DOS ARRAYS É RECONHECIDA COMO EQUIVALENTE
  // ==========================================================================
  it('K3: Arrays com mesmos elementos em ordem diferente são reconhecidos como equivalentes sem erro de colisão', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    // Review preexistente com targetObservationIds invertidos (obs_2 antes de obs_1)
    const existingContestedInverted: NonCanonicalReviewEvent = {
      reviewId: sampleReview.reviewId,
      actor: sampleReview.actor,
      decision: 'contested',
      targetObservationIds: ['obs_2' as ObservationRecordId, 'obs_1' as ObservationRecordId],
      targetBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
      justification: sampleReview.justification,
      reviewedAt: sampleReview.reviewedAt,
    };
    obsMock.reviews.set(sampleReview.reviewId, existingContestedInverted);

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: sampleReview, // Possui ['obs_1', 'obs_2']
          projection: sampleProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleCanonicalBaseConflictError, 'Deve reconhecer equivalência e relançar stale');
        assert.equal(err, originalStaleError);
        return true;
      }
    );
  });

  // ==========================================================================
  // CENÁRIO L: RETRY CONCORRENTE COM INSERT RACE
  // ==========================================================================
  it('L: Em caso de corrida concorrente no insert onde releitura confirma equivalência, relança stale com sucesso', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    const expectedContested: NonCanonicalReviewEvent = {
      reviewId: sampleReview.reviewId,
      actor: sampleReview.actor,
      decision: 'contested',
      targetObservationIds: sampleReview.targetObservationIds,
      targetBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
      justification: sampleReview.justification,
      reviewedAt: sampleReview.reviewedAt,
    };

    let readCount = 0;
    obsMock.getReviewFn = async () => {
      readCount++;
      if (readCount === 1) {
        return null; // Primeira checagem: ainda não inserido
      }
      // Segunda checagem pós-falha de insert: simula que outro worker inseriu com sucesso
      return expectedContested;
    };

    obsMock.recordNonCanonicalFn = async () => {
      // Simula erro de chave duplicada (SQLSTATE 23505)
      throw new Error('duplicate key value violates unique constraint "nex_review_events_pkey"');
    };

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: sampleReview,
          projection: sampleProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleCanonicalBaseConflictError);
        assert.equal(err, originalStaleError);
        return true;
      }
    );

    assert.equal(readCount, 2);
  });

  // ==========================================================================
  // CENÁRIO: STALE RECLASSIFICATION
  // ==========================================================================
  it('Stale Reclassification: reclassificação sobre base stale também é preservada como contested e relança stale', async () => {
    const obsMock = new MockObservationPersistenceAdapter();
    const recMock = new MockReconciliationPersistenceAdapter();
    const coordinator = new ReconciliationCoordinator(obsMock, recMock);

    const originalStaleError = makeStaleError('proj_v1', 'proj_v2_other');
    obsMock.commitPromotionFn = async () => {
      throw originalStaleError;
    };

    const reclassReview: CanonicalReclassifiedReviewEvent = {
      reviewId: 'rev_alice_reclass_stale' as ReviewEventId,
      targetObservationIds: ['obs_1' as ObservationRecordId],
      actor: humanAlice,
      decision: 'canonical_reclassified',
      canonicalEffect: { action: 'reclassify', targetCanonicalState: { price: 89.90, catalogCategory: 'clearance' } },
      targetBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
      justification: 'Reclassifying product to clearance.',
      reviewedAt: '2026-08-22T15:10:00.000Z',
    };

    const reclassProjection: CanonicalProjection = {
      projectionRevisionId: 'proj_v2_reclass' as CanonicalProjectionRevisionId,
      subject,
      canonicalState: { price: 89.90, catalogCategory: 'clearance' },
      underlyingObservationIds: ['obs_1' as ObservationRecordId],
      authorizingReviewIds: [reclassReview.reviewId],
      materializedAt: '2026-08-22T15:10:05.000Z',
      explanation: 'Reclassification to clearance.',
    };

    let recordedReview: NonCanonicalReviewEvent | null = null;
    obsMock.recordNonCanonicalFn = async (r) => {
      recordedReview = r;
      obsMock.reviews.set(r.reviewId, r);
      return r;
    };

    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: reclassReview,
          projection: reclassProjection,
          expectedBaseRevisionId: 'proj_v1' as CanonicalProjectionRevisionId,
          authorization: validReclassifyAuth,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleCanonicalBaseConflictError);
        assert.equal(err, originalStaleError);
        return true;
      }
    );

    assert.ok(recordedReview);
    assert.equal((recordedReview as any).reviewId, reclassReview.reviewId);
    assert.equal((recordedReview as any).decision, 'contested');
    assert.equal((recordedReview as any).targetBaseRevisionId, 'proj_v1');
  });
});
