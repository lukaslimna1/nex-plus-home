/**
 * NEX+ · Testes Unitários Puros de Validadores, Coerência e Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D · Checkpoint 1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ObservationSubject,
  ObservationRecord,
  ReviewEvent,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  OpenReconciliationCase,
  ResolvedReconciliationCase,
  ContextualPrecedent,
  HumanActor,
  MaxActor,
  SystemActor,
} from '../../contracts';
import type { HumanAuthorizationDecision } from '../../../policy/contracts';
import {
  assertValidReconciliationCase,
  assertReconciliationCaseCoherence,
  assertValidContextualPrecedent,
  assertCanonicalPromotionAuthority,
} from '../validators';
import {
  ReconciliationCaseCoherenceError,
  ContextualPrecedentInvalidReviewError,
  CanonicalPromotionAuthorityError,
} from '../errors';

describe('Escopo 0.85D · Validadores Puros de Reconciliação & Autoridade (Sem I/O)', () => {
  const testSubject: ObservationSubject = {
    domain: 'ecommerce',
    entityType: 'sku',
    entityId: 'SKU_123',
  };

  const humanActor: HumanActor = {
    kind: 'human',
    humanId: 'user_master_lucas',
    role: 'admin_master',
  };

  const maxActor: MaxActor = {
    kind: 'max',
    maxVersion: 'MAX_3.0',
  };

  const systemActor: SystemActor = {
    kind: 'system',
    component: 'reconciliation_engine',
  };

  describe('1. Validação Estrutural e de Coerência de ReconciliationCase', () => {
    it('aceita ReconciliationCase aberto válido', () => {
      const validCase: OpenReconciliationCase = {
        caseId: 'case_unit_1' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any],
        reviewIds: ['rev_1' as any],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.doesNotThrow(() => assertValidReconciliationCase(validCase));
    });

    it('rejeita ReconciliationCase resolvido sem resolvedAt ou resolutionSummary', () => {
      const invalidCase: any = {
        caseId: 'case_unit_2',
        subject: testSubject,
        observationIds: ['obs_1'],
        reviewIds: [],
        lifecycle: 'resolved',
        status: 'validated',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertValidReconciliationCase(invalidCase),
        ReconciliationCaseCoherenceError
      );
    });

    it('rejeita coerência quando observação referenciada pertence a subject divergente', () => {
      const caseObj: OpenReconciliationCase = {
        caseId: 'case_unit_3' as any,
        subject: testSubject,
        observationIds: ['obs_diff' as any],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      const obsDiff: ObservationRecord = {
        observationId: 'obs_diff' as any,
        subject: { domain: 'other_domain', entityType: 'sku', entityId: 'SKU_999' },
        observedClaim: 'Other price',
        rawValue: { price: 50 },
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertReconciliationCaseCoherence(caseObj, [obsDiff], []),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'CROSS_SUBJECT_OBSERVATION_MISMATCH');
          return true;
        }
      );
    });
  });

  describe('2. Validação de ContextualPrecedent', () => {
    it('aceita precedente associado a revisão humana com justificativa', () => {
      const review: ReviewEvent = {
        reviewId: 'rev_human_1' as any,
        actor: humanActor,
        targetObservationIds: ['obs_1' as any],
        decision: 'corroborated',
        justification: 'Vendor discount approved per terms',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const precedent: ContextualPrecedent = {
        precedentId: 'prec_1' as any,
        reviewEventId: 'rev_human_1' as any,
        contextSummary: 'Vendor discount rule',
        applicabilityConditions: ['term == net30'],
      };

      assert.doesNotThrow(() => assertValidContextualPrecedent(precedent, review));
    });

    it('rejeita precedente associado a revisão de MAX ou System', () => {
      const maxReview: ReviewEvent = {
        reviewId: 'rev_max_1' as any,
        actor: maxActor,
        targetObservationIds: ['obs_1' as any],
        decision: 'divergent',
        justification: 'Discrepancy detected',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const precedent: ContextualPrecedent = {
        precedentId: 'prec_2' as any,
        reviewEventId: 'rev_max_1' as any,
        contextSummary: 'Automated precedent attempt',
        applicabilityConditions: ['true'],
      };

      assert.throws(
        () => assertValidContextualPrecedent(precedent, maxReview),
        ContextualPrecedentInvalidReviewError
      );
    });
  });

  describe('3. Gate de Autoridade para Promoção Canônica (Fail-Closed)', () => {
    it('bloqueia estritamente tentativa de promoção com ator MAX', () => {
      const review: any = {
        reviewId: 'rev_promo_max',
        actor: maxActor,
        decision: 'canonical_promoted',
        justification: 'MAX trying to promote',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const auth: HumanAuthorizationDecision = {
        actorRef: 'user_master_lucas',
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'OVERRIDE',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertCanonicalPromotionAuthority(review, auth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
          return true;
        }
      );
    });

    it('bloqueia tentativa de promoção com ator System', () => {
      const review: any = {
        reviewId: 'rev_promo_sys',
        actor: systemActor,
        decision: 'canonical_promoted',
        justification: 'System trying to promote',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const auth: HumanAuthorizationDecision = {
        actorRef: 'user_master_lucas',
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'OVERRIDE',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertCanonicalPromotionAuthority(review, auth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
          return true;
        }
      );
    });

    it('bloqueia quando HumanAuthorizationDecision está ausente ou denied', () => {
      const review: CanonicalPromotedReviewEvent = {
        reviewId: 'rev_promo_human' as any,
        actor: humanActor,
        targetObservationIds: ['obs_1' as any],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 100 },
        },
        justification: 'Human promotion',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      // Ausente
      assert.throws(
        () => assertCanonicalPromotionAuthority(review, undefined),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'MISSING_AUTHORIZATION');
          return true;
        }
      );

      // Denied
      const deniedAuth: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_promotion',
        verdict: 'denied',
        reasonCode: 'SECURITY_GATE_REJECTION',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertCanonicalPromotionAuthority(review, deniedAuth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'AUTHORIZATION_DENIED');
          return true;
        }
      );
    });

    it('bloqueia quando actorRef da autorização diverge do humanId do review', () => {
      const review: CanonicalPromotedReviewEvent = {
        reviewId: 'rev_promo_human' as any,
        actor: humanActor,
        targetObservationIds: ['obs_1' as any],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 100 },
        },
        justification: 'Human promotion',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const mismatchedAuth: HumanAuthorizationDecision = {
        actorRef: 'different_user_123',
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'VALID',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertCanonicalPromotionAuthority(review, mismatchedAuth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'ACTOR_MISMATCH');
          return true;
        }
      );
    });

    it('permite promoção canônica quando todos os critérios de autoridade humana são satisfeitos', () => {
      const review: CanonicalPromotedReviewEvent = {
        reviewId: 'rev_promo_human' as any,
        actor: humanActor,
        targetObservationIds: ['obs_1' as any],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 100 },
        },
        justification: 'Approved per certified manual review',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'APPROVED',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.doesNotThrow(() => assertCanonicalPromotionAuthority(review, validAuth));
    });
  });
});
