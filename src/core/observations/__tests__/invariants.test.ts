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
  isCanonicalUtcInstant,
  isActor,
  validateActor,
  isEvidenceArtifactRef,
  validateEvidenceArtifactRef,
  validateObservationRecord,
  validateReviewEvent,
  validateCanonicalPromotion,
  evaluateReviewBaseStatus,
  validateCanonicalProjection,
  validateReconciliationCase,
  isPrecedentContextual,
} from '../invariants';

describe('Escopo 0.85A · Invariantes & Validadores Puros (Hardening)', () => {
  describe('Blocker 1 · Validação Runtime de Actor', () => {
    it('Aceita variantes de Actor conhecidas e válidas', () => {
      assert.equal(isActor({ kind: 'human', humanId: 'user_lucas' }), true);
      assert.equal(isActor({ kind: 'max', maxVersion: 'max-1.0-gov' }), true);
      assert.equal(isActor({ kind: 'system', component: 'reconciler' }), true);
      assert.equal(isActor({ kind: 'integration', provider: 'bling_v3' }), true);
    });

    it('Rejeita expressamente kinds desconhecidos ou inválidos (banana, admin_bot, trusted_max)', () => {
      const invalidActors = [
        { kind: 'banana' },
        { kind: 'admin_bot' },
        { kind: 'trusted_max' },
        { kind: '' },
        { kind: null },
        { humanId: 'user_1' }, // sem kind
        null,
        undefined,
        'human', // não objeto
        123,
      ];

      for (const actor of invalidActors) {
        assert.equal(isActor(actor), false);
        const res = validateActor(actor);
        assert.equal(res.valid, false);
      }
    });

    it('Rejeita atores com identificadores específicos vazios', () => {
      assert.equal(validateActor({ kind: 'human', humanId: '   ' }).valid, false);
      assert.equal(validateActor({ kind: 'max', maxVersion: '' }).valid, false);
      assert.equal(validateActor({ kind: 'system', component: '  ' }).valid, false);
      assert.equal(validateActor({ kind: 'integration', provider: '' }).valid, false);
    });
  });

  describe('Blocker 2 · Matriz Fechada ReviewDecision × CanonicalEffect & Autoridade', () => {
    it('A: Humano autorizado com authorityRef e promote effect produz promoção canônica válida', () => {
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
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const promoResult = validateCanonicalPromotion(review);
      assert.equal(promoResult.allowed, true);

      const fullValidation = validateReviewEvent(review);
      assert.equal(fullValidation.valid, true);
      assert.equal(fullValidation.errors.length, 0);
    });

    it('Rejeita canonical_promoted sem canonicalEffect', () => {
      const invalidPromo = {
        reviewId: 'rev_no_effect' as ReviewEventId,
        actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_1' },
        targetObservationIds: ['obs_1' as ObservationRecordId],
        decision: 'canonical_promoted',
        // canonicalEffect ausente
        justification: 'Promoção sem effect',
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const validation = validateReviewEvent(invalidPromo);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes('canonicalEffect is mandatory')));
    });

    it('Rejeita canonical_promoted com canonicalEffect.action divergente (reclassify)', () => {
      const invalidAction = {
        reviewId: 'rev_mismatch_action' as ReviewEventId,
        actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_1' },
        targetObservationIds: ['obs_1' as ObservationRecordId],
        decision: 'canonical_promoted',
        canonicalEffect: { action: 'reclassify', targetCanonicalState: {} },
        justification: 'Action mismatch',
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const validation = validateReviewEvent(invalidAction);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes("must be 'promote'")));
    });

    it('Rejeita decisões não-canônicas que acompanhem canonicalEffect (provisional, rejected, etc.)', () => {
      const invalidProvisional = {
        reviewId: 'rev_prov_with_effect' as ReviewEventId,
        actor: { kind: 'max', maxVersion: '1.0' },
        targetObservationIds: ['obs_1' as ObservationRecordId],
        decision: 'provisional',
        canonicalEffect: { action: 'promote', targetCanonicalState: {} },
        justification: 'Provisório com effect',
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const res = validateReviewEvent(invalidProvisional);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('canonicalEffect is strictly prohibited')));
    });

    it('Rejeita decisions desconhecidas ou inválidas (banana, approved_by_ai, auto_promote)', () => {
      const invalidDecisions = ['banana', 'approved_by_ai', 'auto_promote', ''];
      for (const dec of invalidDecisions) {
        const invalidReview = {
          reviewId: 'rev_bad_dec',
          actor: { kind: 'human', humanId: 'user_1' },
          targetObservationIds: ['obs_1'],
          decision: dec,
          justification: 'Teste',
          reviewedAt: '2026-08-21T16:00:00Z',
        };
        const res = validateReviewEvent(invalidReview);
        assert.equal(res.valid, false);
        assert.ok(res.errors.some((e) => e.includes('decision') && e.includes('invalid')));
      }
    });

    it('B: Humano SEM authorityRef explícito é rejeitado para promoção canônica', () => {
      const review = {
        reviewId: 'rev_promo_unauth' as ReviewEventId,
        actor: {
          kind: 'human',
          humanId: 'user_anonymous_operator',
        },
        targetObservationIds: ['obs_valid_01' as ObservationRecordId],
        decision: 'canonical_promoted',
        canonicalEffect: { action: 'promote', targetCanonicalState: {} },
        justification: 'Tentativa de promoção sem autoridade declarada',
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const promoResult = validateCanonicalPromotion(review as unknown as ReviewEvent);
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
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const promoResult = validateCanonicalPromotion(maxReview);
      assert.equal(promoResult.allowed, true);

      const fullValidation = validateReviewEvent(maxReview);
      assert.equal(fullValidation.valid, true);
    });

    it('D, E, F: MAX, Integration e System são estritamente impedidos de promover canônico', () => {
      const actors = [
        { kind: 'max', maxVersion: '1.0' },
        { kind: 'integration', provider: 'bling' },
        { kind: 'system', component: 'reconciler' },
      ];

      for (const actor of actors) {
        const illegalPromo = {
          reviewId: 'rev_illegal',
          actor,
          targetObservationIds: ['obs_1'],
          decision: 'canonical_promoted',
          canonicalEffect: { action: 'promote', targetCanonicalState: {} },
          justification: 'Tentativa autônoma ilegal',
          reviewedAt: '2026-08-21T16:00:00Z',
        };

        const promoResult = validateCanonicalPromotion(illegalPromo as unknown as ReviewEvent);
        assert.equal(promoResult.allowed, false);
        assert.ok(promoResult.reason?.includes(actor.kind));

        const fullValidation = validateReviewEvent(illegalPromo);
        assert.equal(fullValidation.valid, false);
      }
    });

    it('G: Revisão com justification vazia ou composta só por espaços é rejeitada', () => {
      const emptyJustificationReview = {
        reviewId: 'rev_empty_just',
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          authorityRef: 'AUTH_DIRECTOR',
        },
        targetObservationIds: ['obs_1'],
        decision: 'canonical_promoted',
        canonicalEffect: { action: 'promote', targetCanonicalState: {} },
        justification: '   ',
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const validation = validateReviewEvent(emptyJustificationReview);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes('justification')));
    });

    it('H: Revisão deve apontar para pelo menos uma observação alvo', () => {
      const noTargetReview = {
        reviewId: 'rev_no_target',
        actor: {
          kind: 'human',
          humanId: 'user_lucas',
          authorityRef: 'AUTH_DIRECTOR',
        },
        targetObservationIds: [],
        decision: 'canonical_promoted',
        canonicalEffect: { action: 'promote', targetCanonicalState: {} },
        justification: 'Revisão sem observações alvo',
        reviewedAt: '2026-08-21T16:00:00Z',
      };

      const validation = validateReviewEvent(noTargetReview);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes('targetObservationIds')));
    });
  });

  describe('Blocker 3 · Validação de EvidenceArtifactRef', () => {
    it('Aceita execution_evidence_ref com executionEvidenceId válido', () => {
      const validExec = {
        artifactId: 'art_1',
        kind: 'execution_evidence_ref',
        executionEvidenceId: 'exec_123',
        capturedAt: '2026-08-21T10:00:00Z',
      };
      assert.equal(isEvidenceArtifactRef(validExec), true);
    });

    it('Rejeita execution_evidence_ref sem executionEvidenceId', () => {
      const invalidExec = {
        artifactId: 'art_1',
        kind: 'execution_evidence_ref',
        capturedAt: '2026-08-21T10:00:00Z',
      };
      const res = validateEvidenceArtifactRef(invalidExec);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('executionEvidenceId is mandatory')));
    });

    it('Rejeita artefato genérico (ex: screenshot) com executionEvidenceId presente', () => {
      const invalidScreen = {
        artifactId: 'art_2',
        kind: 'screenshot',
        executionEvidenceId: 'exec_123',
        capturedAt: '2026-08-21T10:00:00Z',
      };
      const res = validateEvidenceArtifactRef(invalidScreen);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('executionEvidenceId is prohibited')));
    });

    it('Rejeita kind de evidência desconhecido', () => {
      const invalidKind = {
        artifactId: 'art_3',
        kind: 'unknown_kind',
        capturedAt: '2026-08-21T10:00:00Z',
      };
      const res = validateEvidenceArtifactRef(invalidKind);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('invalid')));
    });
  });

  describe('Blocker 4 · Política Temporal de Instantes Canônicos UTC Z', () => {
    it('Aceita instantes ISO 8601 UTC terminados estritamente em Z', () => {
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00Z'), true);
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00.000Z'), true);
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00.123Z'), true);
    });

    it('Rejeita timestamps sem timezone (sem Z)', () => {
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00'), false);
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00.000'), false);
    });

    it('Rejeita offsets numéricos não-Z (+03:00, -03:00)', () => {
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00+03:00'), false);
      assert.equal(isCanonicalUtcInstant('2026-08-21T10:00:00-03:00'), false);
    });

    it('Rejeita datas impossíveis (overflow) e formatos inválidos', () => {
      assert.equal(isCanonicalUtcInstant('2026-02-30T10:00:00Z'), false); // 30 de fevereiro
      assert.equal(isCanonicalUtcInstant('2026-13-01T10:00:00Z'), false); // Mês 13
      assert.equal(isCanonicalUtcInstant('21/08/2026 10:00'), false);
      assert.equal(isCanonicalUtcInstant('banana'), false);
      assert.equal(isCanonicalUtcInstant(''), false);
      assert.equal(isCanonicalUtcInstant(null), false);
    });
  });

  describe('Blocker 5 · Validação de ReconciliationCase por Lifecycle', () => {
    it('Aceita OpenReconciliationCase com status permitido e sem resolvedAt', () => {
      const openCases = [
        {
          caseId: 'case_1',
          subject: { domain: 'a', entityType: 'b', entityId: 'c' },
          lifecycle: 'open',
          status: 'open',
          observationIds: ['obs_1'],
          reviewIds: [],
          openedAt: '2026-08-21T10:00:00Z',
        },
        {
          caseId: 'case_2',
          subject: { domain: 'a', entityType: 'b', entityId: 'c' },
          lifecycle: 'open',
          status: 'awaiting_evidence',
          observationIds: ['obs_1'],
          reviewIds: [],
          openedAt: '2026-08-21T10:00:00Z',
        },
        {
          caseId: 'case_3',
          subject: { domain: 'a', entityType: 'b', entityId: 'c' },
          lifecycle: 'open',
          status: 'divergent',
          observationIds: ['obs_1'],
          reviewIds: [],
          openedAt: '2026-08-21T10:00:00Z',
          resolutionSummary: 'Anotação corrente',
        },
      ];

      for (const c of openCases) {
        const res = validateReconciliationCase(c);
        assert.equal(res.valid, true);
      }
    });

    it('Rejeita OpenReconciliationCase com resolvedAt presente', () => {
      const invalidOpen = {
        caseId: 'case_inv',
        subject: { domain: 'a', entityType: 'b', entityId: 'c' },
        lifecycle: 'open',
        status: 'open',
        observationIds: ['obs_1'],
        reviewIds: [],
        openedAt: '2026-08-21T10:00:00Z',
        resolvedAt: '2026-08-21T10:30:00Z', // Proibido em open
      };
      const res = validateReconciliationCase(invalidOpen);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('resolvedAt is prohibited')));
    });

    it('Aceita ResolvedReconciliationCase com status permitido, resolvedAt e resolutionSummary', () => {
      const resolvedCases = [
        {
          caseId: 'case_res_1',
          subject: { domain: 'a', entityType: 'b', entityId: 'c' },
          lifecycle: 'resolved',
          status: 'validated',
          observationIds: ['obs_1'],
          reviewIds: ['rev_1'],
          openedAt: '2026-08-21T10:00:00Z',
          resolvedAt: '2026-08-21T11:00:00Z',
          resolutionSummary: 'Validação concluída com sucesso.',
        },
        {
          caseId: 'case_res_2',
          subject: { domain: 'a', entityType: 'b', entityId: 'c' },
          lifecycle: 'resolved',
          status: 'divergent',
          observationIds: ['obs_1', 'obs_2'],
          reviewIds: ['rev_1'],
          openedAt: '2026-08-21T10:00:00Z',
          resolvedAt: '2026-08-21T11:00:00Z',
          resolutionSummary: 'Encerrado como divergência insolúvel entre fornecedores.',
        },
      ];

      for (const c of resolvedCases) {
        const res = validateReconciliationCase(c);
        assert.equal(res.valid, true);
      }
    });

    it('Rejeita ResolvedReconciliationCase sem resolvedAt ou sem resolutionSummary', () => {
      const missingResolvedAt = {
        caseId: 'case_res_bad_1',
        subject: { domain: 'a', entityType: 'b', entityId: 'c' },
        lifecycle: 'resolved',
        status: 'validated',
        observationIds: ['obs_1'],
        reviewIds: [],
        openedAt: '2026-08-21T10:00:00Z',
        resolutionSummary: 'Faltando resolvedAt',
      };
      assert.equal(validateReconciliationCase(missingResolvedAt).valid, false);

      const missingSummary = {
        caseId: 'case_res_bad_2',
        subject: { domain: 'a', entityType: 'b', entityId: 'c' },
        lifecycle: 'resolved',
        status: 'validated',
        observationIds: ['obs_1'],
        reviewIds: [],
        openedAt: '2026-08-21T10:00:00Z',
        resolvedAt: '2026-08-21T11:00:00Z',
        resolutionSummary: '   ', // Vazio
      };
      assert.equal(validateReconciliationCase(missingSummary).valid, false);
    });

    it('Rejeita lifecycle ou status desconhecido (banana)', () => {
      const badLifecycle = {
        caseId: 'case_bad_life',
        subject: { domain: 'a', entityType: 'b', entityId: 'c' },
        lifecycle: 'banana',
        status: 'open',
        observationIds: ['obs_1'],
        reviewIds: [],
        openedAt: '2026-08-21T10:00:00Z',
      };
      assert.equal(validateReconciliationCase(badLifecycle).valid, false);

      const badStatus = {
        caseId: 'case_bad_stat',
        subject: { domain: 'a', entityType: 'b', entityId: 'c' },
        lifecycle: 'open',
        status: 'banana',
        observationIds: ['obs_1'],
        reviewIds: [],
        openedAt: '2026-08-21T10:00:00Z',
      };
      assert.equal(validateReconciliationCase(badStatus).valid, false);
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
        targetBaseRevisionId: 'proj_rev_01' as CanonicalProjectionRevisionId,
        decision: 'canonical_promoted',
        canonicalEffect: { action: 'promote', targetCanonicalState: {} },
        justification: 'Aprovado com base no estado V1',
        reviewedAt: '2026-08-21T16:10:00Z',
      };

      assert.equal(
        evaluateReviewBaseStatus(reviewEvaluatedOnV1, 'proj_rev_01' as CanonicalProjectionRevisionId),
        'current'
      );
      assert.equal(
        evaluateReviewBaseStatus(reviewEvaluatedOnV1, 'proj_rev_02' as CanonicalProjectionRevisionId),
        'stale_conflicting'
      );

      const unanchoredReview: ReviewEvent = {
        ...reviewEvaluatedOnV1,
        targetBaseRevisionId: undefined,
      };
      assert.equal(evaluateReviewBaseStatus(unanchoredReview, undefined), 'unanchored');
      assert.equal(
        evaluateReviewBaseStatus(unanchoredReview, 'proj_rev_01' as CanonicalProjectionRevisionId),
        'stale_conflicting'
      );
    });
  });

  describe('Validação de CanonicalProjection', () => {
    it('N: CanonicalProjection exige identificadores, observações, revisões autorizadoras e UTC Z', () => {
      const validProj: CanonicalProjection = {
        projectionRevisionId: 'proj_01' as CanonicalProjectionRevisionId,
        subject: { domain: 'pricing', entityType: 'sku', entityId: 'sku_1' },
        canonicalState: { price: 29.9 },
        underlyingObservationIds: ['obs_1' as ObservationRecordId],
        authorizingReviewIds: ['rev_1' as ReviewEventId],
        materializedAt: '2026-08-21T16:00:00Z',
        explanation: 'Preço validado e consolidado.',
      };

      assert.equal(validateCanonicalProjection(validProj).valid, true);

      const invalidProj = {
        ...validProj,
        underlyingObservationIds: [],
        authorizingReviewIds: [],
        explanation: '',
      };

      const res = validateCanonicalProjection(invalidProj);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('underlyingObservationIds')));
      assert.ok(res.errors.some((e) => e.includes('authorizingReviewIds')));
      assert.ok(res.errors.some((e) => e.includes('explanation')));
    });
  });
});
