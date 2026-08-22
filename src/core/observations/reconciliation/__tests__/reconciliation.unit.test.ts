/**
 * NEX+ · Testes Unitários Puros de Validadores, Coerência e Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D · Micro-Hardening A)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ObservationSubject,
  ObservationRecord,
  ReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  OpenReconciliationCase,
  ResolvedReconciliationCase,
  ContextualPrecedent,
  HumanActor,
  MaxActor,
  SystemActor,
  IntegrationActor,
} from '../../contracts';
import type { HumanAuthorizationDecision } from '../../../policy/contracts';
import {
  assertValidReconciliationCase,
  assertReconciliationCaseCoherence,
  assertReconciliationRevisionContinuity,
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

  const integrationActor: IntegrationActor = {
    kind: 'integration',
    provider: 'bling_connector',
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

    it('AF-3: rejeita quando observationIds contém duplicatas', () => {
      const duplicateObsCase: OpenReconciliationCase = {
        caseId: 'case_dup_obs' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any, 'obs_1' as any],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertValidReconciliationCase(duplicateObsCase),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'DUPLICATE_OBSERVATION_REFERENCES');
          return true;
        }
      );
    });

    it('AF-4: rejeita quando reviewIds contém duplicatas', () => {
      const duplicateRevCase: OpenReconciliationCase = {
        caseId: 'case_dup_rev' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any],
        reviewIds: ['rev_1' as any, 'rev_1' as any],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertValidReconciliationCase(duplicateRevCase),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'DUPLICATE_REVIEW_REFERENCES');
          return true;
        }
      );
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

    it('A1: rejeita quando observação referenciada não existe', () => {
      const caseObj: OpenReconciliationCase = {
        caseId: 'case_unit_a1' as any,
        subject: testSubject,
        observationIds: ['obs_missing' as any],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertReconciliationCaseCoherence(caseObj, [], []),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'OBSERVATION_NOT_FOUND');
          return true;
        }
      );
    });

    it('A2: rejeita quando review referenciada não existe', () => {
      const caseObj: OpenReconciliationCase = {
        caseId: 'case_unit_a2' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any],
        reviewIds: ['rev_missing' as any],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      const obs1: ObservationRecord = {
        observationId: 'obs_1' as any,
        subject: testSubject,
        observedClaim: 'Claim',
        rawValue: {},
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertReconciliationCaseCoherence(caseObj, [obs1], []),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'REVIEW_NOT_FOUND');
          return true;
        }
      );
    });

    it('A3: rejeita coerência quando observação referenciada pertence a subject divergente', () => {
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

    it('AF-1: rejeita quando review targets observation que não está em case.observationIds (mesmo do mesmo subject)', () => {
      const caseObj: OpenReconciliationCase = {
        caseId: 'case_unit_af1' as any,
        subject: testSubject,
        observationIds: ['obs_A' as any],
        reviewIds: ['rev_targets_B' as any],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      const obsA: ObservationRecord = {
        observationId: 'obs_A' as any,
        subject: testSubject,
        observedClaim: 'Claim A',
        rawValue: {},
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      const obsB: ObservationRecord = {
        observationId: 'obs_B' as any,
        subject: testSubject,
        observedClaim: 'Claim B',
        rawValue: {},
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      const revTargetsB: ReviewEvent = {
        reviewId: 'rev_targets_B' as any,
        actor: humanActor,
        targetObservationIds: ['obs_B' as any], // B não está em caseObj.observationIds!
        decision: 'corroborated',
        justification: 'Comparison with B',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertReconciliationCaseCoherence(caseObj, [obsA, obsB], [revTargetsB]),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'REVIEW_OBSERVATION_NOT_IN_CASE');
          return true;
        }
      );
    });

    it('AF-2: aceita quando review targets observation que está declarada em case.observationIds', () => {
      const caseObj: OpenReconciliationCase = {
        caseId: 'case_unit_af2' as any,
        subject: testSubject,
        observationIds: ['obs_A' as any],
        reviewIds: ['rev_targets_A' as any],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      const obsA: ObservationRecord = {
        observationId: 'obs_A' as any,
        subject: testSubject,
        observedClaim: 'Claim A',
        rawValue: {},
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      const revTargetsA: ReviewEvent = {
        reviewId: 'rev_targets_A' as any,
        actor: humanActor,
        targetObservationIds: ['obs_A' as any],
        decision: 'corroborated',
        justification: 'Approved obs A',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.doesNotThrow(() =>
        assertReconciliationCaseCoherence(caseObj, [obsA], [revTargetsA])
      );
    });

    it('A4: rejeita quando review targets observação de outro subject', () => {
      const caseObj: OpenReconciliationCase = {
        caseId: 'case_unit_a4' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any, 'obs_other' as any],
        reviewIds: ['rev_1' as any],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      const obs1: ObservationRecord = {
        observationId: 'obs_1' as any,
        subject: testSubject,
        observedClaim: 'Claim',
        rawValue: {},
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      const obsOtherSubject: ObservationRecord = {
        observationId: 'obs_other' as any,
        subject: { domain: 'other_domain', entityType: 'sku', entityId: 'SKU_888' },
        observedClaim: 'Other Claim',
        rawValue: {},
        actor: humanActor,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      };

      const rev1: ReviewEvent = {
        reviewId: 'rev_1' as any,
        actor: humanActor,
        targetObservationIds: ['obs_other' as any],
        decision: 'divergent',
        justification: 'Comparison',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertReconciliationCaseCoherence(caseObj, [obs1, obsOtherSubject], [rev1]),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.ok(
            err.code === 'CROSS_SUBJECT_OBSERVATION_MISMATCH' ||
            err.code === 'REVIEW_CROSS_SUBJECT_MISMATCH'
          );
          return true;
        }
      );
    });
  });

  describe('2. Continuidade e Imutabilidade entre Revisões', () => {
    const prevCase: OpenReconciliationCase = {
      caseId: 'case_cont_1' as any,
      subject: testSubject,
      observationIds: ['obs_1' as any, 'obs_2' as any],
      reviewIds: ['rev_1' as any],
      lifecycle: 'open',
      status: 'awaiting_evidence',
      openedAt: '2026-08-21T23:00:00.000Z',
    };

    it('A5: rejeita quando subject é alterado no append', () => {
      const mutatedSubjectCase: OpenReconciliationCase = {
        ...prevCase,
        subject: { domain: 'new_domain', entityType: 'sku', entityId: 'SKU_123' },
      };

      assert.throws(
        () => assertReconciliationRevisionContinuity(prevCase, mutatedSubjectCase),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'MUTATION_SUBJECT_PROHIBITED');
          return true;
        }
      );
    });

    it('A6: rejeita quando openedAt é alterado no append', () => {
      const mutatedOpenedAtCase: OpenReconciliationCase = {
        ...prevCase,
        openedAt: '2026-08-21T23:59:59.000Z',
      };

      assert.throws(
        () => assertReconciliationRevisionContinuity(prevCase, mutatedOpenedAtCase),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'MUTATION_OPENED_AT_PROHIBITED');
          return true;
        }
      );
    });

    it('A7: rejeita quando observationId histórica é removida', () => {
      const removedObsCase: OpenReconciliationCase = {
        ...prevCase,
        observationIds: ['obs_1' as any], // removeu obs_2!
      };

      assert.throws(
        () => assertReconciliationRevisionContinuity(prevCase, removedObsCase),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'HISTORICAL_OBSERVATIONS_CANNOT_BE_REMOVED');
          return true;
        }
      );
    });

    it('A8: rejeita quando reviewId histórica é removida', () => {
      const removedRevCase: OpenReconciliationCase = {
        ...prevCase,
        reviewIds: [], // removeu rev_1!
      };

      assert.throws(
        () => assertReconciliationRevisionContinuity(prevCase, removedRevCase),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'HISTORICAL_REVIEWS_CANNOT_BE_REMOVED');
          return true;
        }
      );
    });

    it('A9: rejeita transição de resolved para open (não reabre)', () => {
      const resolvedPrev: ResolvedReconciliationCase = {
        caseId: 'case_resolved_1' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any],
        reviewIds: ['rev_1' as any],
        lifecycle: 'resolved',
        status: 'validated',
        openedAt: '2026-08-21T23:00:00.000Z',
        resolvedAt: '2026-08-21T23:30:00.000Z',
        resolutionSummary: 'Validated completely',
      };

      const reopenedAttempt: OpenReconciliationCase = {
        caseId: 'case_resolved_1' as any,
        subject: testSubject,
        observationIds: ['obs_1' as any, 'obs_new' as any],
        reviewIds: ['rev_1' as any],
        lifecycle: 'open',
        status: 'divergent',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.throws(
        () => assertReconciliationRevisionContinuity(resolvedPrev, reopenedAttempt),
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'RESOLVED_CASE_CANNOT_BE_REOPENED');
          return true;
        }
      );
    });
  });

  describe('3. Gates de Autoridade para Promoção Canônica (Fail-Closed)', () => {
    const validHumanPromoReview: CanonicalPromotedReviewEvent = {
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

    const validHumanReclassReview: CanonicalReclassifiedReviewEvent = {
      reviewId: 'rev_reclass_human' as any,
      actor: humanActor,
      targetObservationIds: ['obs_1' as any],
      decision: 'canonical_reclassified',
      canonicalEffect: {
        action: 'reclassify',
        targetCanonicalState: { price: 120 },
      },
      justification: 'Reclassified price',
      reviewedAt: '2026-08-21T23:00:00.000Z',
    };

    it('A14: canonical_promoted + canonical_promotion = permitido', () => {
      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.doesNotThrow(() => assertCanonicalPromotionAuthority(validHumanPromoReview, validAuth));
    });

    it('A15: canonical_reclassified + canonical_reclassification = permitido', () => {
      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_reclassification',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      assert.doesNotThrow(() => assertCanonicalPromotionAuthority(validHumanReclassReview, validAuth));
    });

    it('A16: combinações cruzadas e aliases (promote / reclassify / cruzado) são rejeitados', () => {
      // 1. canonical_promoted com canonical_reclassification
      const crossAuth1: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_reclassification',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
      };
      assert.throws(
        () => assertCanonicalPromotionAuthority(validHumanPromoReview, crossAuth1),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'OPERATION_MISMATCH');
          return true;
        }
      );

      // 2. canonical_reclassified com canonical_promotion
      const crossAuth2: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
      };
      assert.throws(
        () => assertCanonicalPromotionAuthority(validHumanReclassReview, crossAuth2),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'OPERATION_MISMATCH');
          return true;
        }
      );

      // 3. alias genérico 'promote' rejeitado
      const aliasAuth1: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'promote',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
      };
      assert.throws(
        () => assertCanonicalPromotionAuthority(validHumanPromoReview, aliasAuth1),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'OPERATION_MISMATCH');
          return true;
        }
      );

      // 4. alias genérico 'reclassify' rejeitado
      const aliasAuth2: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'reclassify',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
      };
      assert.throws(
        () => assertCanonicalPromotionAuthority(validHumanReclassReview, aliasAuth2),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'OPERATION_MISMATCH');
          return true;
        }
      );
    });

    it('A19: promoção canônica tentada por MAX, System ou Integration é estritamente bloqueada', () => {
      const maxReview: any = {
        ...validHumanPromoReview,
        actor: maxActor,
      };
      const sysReview: any = {
        ...validHumanPromoReview,
        actor: systemActor,
      };
      const integReview: any = {
        ...validHumanPromoReview,
        actor: integrationActor,
      };

      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanActor.humanId,
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
      };

      assert.throws(
        () => assertCanonicalPromotionAuthority(maxReview, validAuth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
          return true;
        }
      );

      assert.throws(
        () => assertCanonicalPromotionAuthority(sysReview, validAuth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
          return true;
        }
      );

      assert.throws(
        () => assertCanonicalPromotionAuthority(integReview, validAuth),
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
          return true;
        }
      );
    });
  });

  describe('4. ContextualPrecedent', () => {
    it('A17: precedente de review humana com actor_payload real é aceito', () => {
      const review: ReviewEvent = {
        reviewId: 'rev_human_1' as any,
        actor: humanActor,
        targetObservationIds: ['obs_1' as any],
        decision: 'corroborated',
        justification: 'Vendor agreement discount rule',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const precedent: ContextualPrecedent = {
        precedentId: 'prec_1' as any,
        reviewEventId: 'rev_human_1' as any,
        contextSummary: 'Discount rule',
        applicabilityConditions: ['condition == true'],
      };

      assert.doesNotThrow(() => assertValidContextualPrecedent(precedent, review));
    });

    it('A19: precedente a partir de MAX/System/Integration é rejeitado', () => {
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
});
