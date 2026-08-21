import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ObservationRecord,
  ObservationRecordId,
  SourceRefId,
  EvidenceArtifactRefId,
  ReviewEvent,
  ReviewEventId,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  ReconciliationCase,
  ReconciliationCaseId,
  ContextualPrecedent,
  ContextualPrecedentRefId,
} from '../contracts';
import {
  validateObservationRecord,
  validateReviewEvent,
  validateCanonicalPromotion,
  evaluateReviewBaseStatus,
  validateCanonicalProjection,
  validateReconciliationCase,
  isPrecedentContextual,
} from '../invariants';

describe('Escopo 0.85A · Invariantes & Validadores Puros', () => {
  describe('Invariante de Autoridade e Promoção Canônica', () => {
    it('A: Humano autorizado com authorityRef e justificativa produz promoção canônica válida', () => {
      const review: ReviewEvent = {
        reviewId: 'rev_promo_01' as ReviewEventId,
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          role: 'director',
          authorityRef: 'AUTH_DECISION_BOARD_2026_08',
        },
        targetObservationIds: ['obs_valid_01' as ObservationRecordId],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { unitPrice: 42.5 },
        },
        justification: 'Aprovado formalmente pelo sócio responsável após conferência documental.',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const promoResult = validateCanonicalPromotion(review);
      assert.equal(promoResult.allowed, true);

      const fullValidation = validateReviewEvent(review);
      assert.equal(fullValidation.valid, true);
      assert.equal(fullValidation.errors.length, 0);
    });

    it('B: Humano SEM authorityRef explícito é rejeitado para promoção canônica', () => {
      const review: ReviewEvent = {
        reviewId: 'rev_promo_unauth' as ReviewEventId,
        actor: {
          kind: 'human',
          humanId: 'user_anonymous_operator',
          // authorityRef ausente
        },
        targetObservationIds: ['obs_valid_01' as ObservationRecordId],
        decision: 'canonical_promoted',
        justification: 'Tentativa de promoção sem autoridade declarada',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const promoResult = validateCanonicalPromotion(review);
      assert.equal(promoResult.allowed, false);
      assert.ok(promoResult.reason?.includes('authorityRef'));

      const fullValidation = validateReviewEvent(review);
      assert.equal(fullValidation.valid, false);
      assert.ok(fullValidation.errors.some((e) => e.includes('authorityRef')));
    });

    it('C: MAX consegue emitir recomendações e avaliações provisórias', () => {
      const maxReview: ReviewEvent = {
        reviewId: 'rev_max_rec' as ReviewEventId,
        actor: {
          kind: 'max',
          maxVersion: 'max-1.0-gov',
          sessionRef: 'sess_123',
        },
        targetObservationIds: ['obs_catalog_1' as ObservationRecordId],
        decision: 'provisional',
        justification: 'Valores conferem com histórico do fornecedor, sugerida aprovação.',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const promoResult = validateCanonicalPromotion(maxReview);
      assert.equal(promoResult.allowed, true); // Decisão 'provisional' não é promoção canônica

      const fullValidation = validateReviewEvent(maxReview);
      assert.equal(fullValidation.valid, true);
    });

    it('D: MAX é estritamente impedido de promover ou reclassificar canonicamente', () => {
      const maxPromoAttempt: ReviewEvent = {
        reviewId: 'rev_max_illegal' as ReviewEventId,
        actor: {
          kind: 'max',
          maxVersion: 'max-1.0-gov',
        },
        targetObservationIds: ['obs_catalog_1' as ObservationRecordId],
        decision: 'canonical_promoted',
        justification: 'MAX tentando promover canônico autonomamente',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const promoResult = validateCanonicalPromotion(maxPromoAttempt);
      assert.equal(promoResult.allowed, false);
      assert.ok(promoResult.reason?.includes("actor kind: 'max'"));

      const fullValidation = validateReviewEvent(maxPromoAttempt);
      assert.equal(fullValidation.valid, false);
    });

    it('E: IntegrationActor é estritamente impedido de promover canônico', () => {
      const integrationPromo: ReviewEvent = {
        reviewId: 'rev_integ_illegal' as ReviewEventId,
        actor: {
          kind: 'integration',
          provider: 'bling_api_v3',
        },
        targetObservationIds: ['obs_ext_1' as ObservationRecordId],
        decision: 'canonical_promoted',
        justification: 'Webhook do Bling tentando forçar estado canônico',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const promoResult = validateCanonicalPromotion(integrationPromo);
      assert.equal(promoResult.allowed, false);
      assert.ok(promoResult.reason?.includes("actor kind: 'integration'"));
    });

    it('F: SystemActor é estritamente impedido de promover canônico', () => {
      const systemPromo: ReviewEvent = {
        reviewId: 'rev_sys_illegal' as ReviewEventId,
        actor: {
          kind: 'system',
          component: 'cron_reconciler',
        },
        targetObservationIds: ['obs_sys_1' as ObservationRecordId],
        decision: 'canonical_reclassified',
        justification: 'Job de reconciliação tentando reclassificar canônico sem humano',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const promoResult = validateCanonicalPromotion(systemPromo);
      assert.equal(promoResult.allowed, false);
      assert.ok(promoResult.reason?.includes("actor kind: 'system'"));
    });

    it('G: Revisão com justification vazia ou composta só por espaços é rejeitada', () => {
      const emptyJustificationReview: ReviewEvent = {
        reviewId: 'rev_empty_just' as ReviewEventId,
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          authorityRef: 'AUTH_DIRECTOR',
        },
        targetObservationIds: ['obs_1' as ObservationRecordId],
        decision: 'canonical_promoted',
        justification: '   ', // Somente espaços
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const validation = validateReviewEvent(emptyJustificationReview);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes('justification')));
    });

    it('H: Revisão deve apontar para pelo menos uma observação alvo', () => {
      const noTargetReview: ReviewEvent = {
        reviewId: 'rev_no_target' as ReviewEventId,
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          authorityRef: 'AUTH_DIRECTOR',
        },
        targetObservationIds: [], // Vazio
        decision: 'canonical_promoted',
        justification: 'Revisão sem observações alvo',
        reviewedAt: '2026-08-21T16:00:00.000Z',
      };

      const validation = validateReviewEvent(noTargetReview);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes('targetObservationIds')));
    });
  });

  describe('Concorrência e Detecção de Revisão Obsoleta (Stale Base)', () => {
    it('I: Revisão avaliada contra base desatualizada é classificada como stale_conflicting', () => {
      const reviewEvaluatedOnV1: ReviewEvent = {
        reviewId: 'rev_on_v1' as ReviewEventId,
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          authorityRef: 'AUTH_DIR',
        },
        targetObservationIds: ['obs_new_1' as ObservationRecordId],
        targetBaseRevisionId: 'proj_rev_01' as CanonicalProjectionRevisionId, // Avaliou quando a base era V1
        decision: 'canonical_promoted',
        justification: 'Aprovado com base no estado V1',
        reviewedAt: '2026-08-21T16:10:00.000Z',
      };

      // Cenário 1: Base no sistema ainda é V1 -> 'current'
      const status1 = evaluateReviewBaseStatus(reviewEvaluatedOnV1, 'proj_rev_01' as CanonicalProjectionRevisionId);
      assert.equal(status1, 'current');

      // Cenário 2: Base no sistema avançou para V2 (enquanto o revisor analisava) -> 'stale_conflicting'
      const status2 = evaluateReviewBaseStatus(reviewEvaluatedOnV1, 'proj_rev_02' as CanonicalProjectionRevisionId);
      assert.equal(status2, 'stale_conflicting');

      // Cenário 3: Criação inicial sem base existente no sistema -> 'unanchored'
      const unanchoredReview: ReviewEvent = {
        ...reviewEvaluatedOnV1,
        targetBaseRevisionId: undefined,
      };
      assert.equal(evaluateReviewBaseStatus(unanchoredReview, undefined), 'unanchored');

      // Cenário 4: Revisão sem âncora mas quando já existe base no sistema -> 'stale_conflicting'
      assert.equal(
        evaluateReviewBaseStatus(unanchoredReview, 'proj_rev_01' as CanonicalProjectionRevisionId),
        'stale_conflicting'
      );
    });
  });

  describe('Validação de ObservationRecord & Temporalidade', () => {
    it('Valida ObservationRecord completo com todas as propriedades', () => {
      const validRecord: ObservationRecord = {
        observationId: 'obs_001' as ObservationRecordId,
        subject: {
          domain: 'inventory',
          entityType: 'blank_tshirt',
          entityId: 'tshirt_black_m',
        },
        observedClaim: 'in_stock_quantity',
        rawValue: 150,
        normalizedValue: 150,
        actor: {
          kind: 'human',
          humanId: 'user_operator_1',
        },
        sourceRefs: ['src_physical_count' as SourceRefId],
        evidenceRefs: ['art_count_sheet' as EvidenceArtifactRefId],
        occurredAt: '2026-08-21T14:00:00.000Z',
        observedAt: '2026-08-21T14:15:00.000Z',
        capturedAt: '2026-08-21T14:20:00.000Z',
      };

      const res = validateObservationRecord(validRecord);
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });

    it('Rejeita ObservationRecord com datas inválidas ou campos essenciais ausentes', () => {
      const invalidRecord = {
        observationId: '',
        subject: { domain: '', entityType: '', entityId: '' },
        observedClaim: '',
        rawValue: undefined,
        actor: { kind: 'unknown_actor' },
        sourceRefs: 'not_an_array',
        evidenceRefs: [],
        observedAt: 'invalid-date',
        capturedAt: '2026-08-21T14:00:00.000Z',
      };

      const res = validateObservationRecord(invalidRecord);
      assert.equal(res.valid, false);
      assert.ok(res.errors.length >= 5);
    });
  });

  describe('Validação de CanonicalProjection & ReconciliationCase', () => {
    it('N: CanonicalProjection exige identificadores, observações e revisões autorizadoras', () => {
      const validProj: CanonicalProjection = {
        projectionRevisionId: 'proj_01' as CanonicalProjectionRevisionId,
        subject: { domain: 'pricing', entityType: 'sku', entityId: 'sku_1' },
        canonicalState: { price: 29.9 },
        underlyingObservationIds: ['obs_1' as ObservationRecordId],
        authorizingReviewIds: ['rev_1' as ReviewEventId],
        materializedAt: '2026-08-21T16:00:00.000Z',
        explanation: 'Preço validado e consolidado.',
      };

      assert.equal(validateCanonicalProjection(validProj).valid, true);

      const invalidProj = {
        ...validProj,
        underlyingObservationIds: [], // Sem observações
        authorizingReviewIds: [],      // Sem revisões
        explanation: '',
      };

      const res = validateCanonicalProjection(invalidProj);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('underlyingObservationIds')));
      assert.ok(res.errors.some((e) => e.includes('authorizingReviewIds')));
      assert.ok(res.errors.some((e) => e.includes('explanation')));
    });

    it('Valida ReconciliationCase e conformidade estrutural de Precedente', () => {
      const validCase: ReconciliationCase = {
        caseId: 'case_01' as ReconciliationCaseId,
        subject: { domain: 'supplier', entityType: 'price', entityId: 'item_1' },
        status: 'divergent',
        observationIds: ['obs_1' as ObservationRecordId, 'obs_2' as ObservationRecordId],
        reviewIds: ['rev_1' as ReviewEventId],
        openedAt: '2026-08-21T10:00:00.000Z',
      };

      assert.equal(validateReconciliationCase(validCase).valid, true);

      const precedent: ContextualPrecedent = {
        precedentId: 'prec_01' as ContextualPrecedentRefId,
        reviewEventId: 'rev_1' as ReviewEventId,
        contextSummary: 'Desconto aprovado para lote específico',
        applicabilityConditions: ['lote == 2026_A'],
      };

      assert.equal(isPrecedentContextual(precedent), true);
    });
  });
});
