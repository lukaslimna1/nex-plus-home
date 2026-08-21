import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ObservationRecord,
  ObservationRecordId,
  SourceRefId,
  EvidenceArtifactRefId,
  GenericEvidenceArtifactRef,
  ExecutionEvidenceArtifactRef,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalReclassifiedReviewEvent,
  ReviewEventId,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  OpenReconciliationCase,
  ResolvedReconciliationCase,
  ReconciliationCaseId,
  ContextualPrecedent,
  ContextualPrecedentRefId,
  FreshnessInfo,
  ConfidenceAssessment,
} from '../contracts';
import type { ExecutionEvidenceId } from '../../execution/contracts';

// Helper puro para testes de checagem estática de tipos
const checkType = <T>(_val: T) => {};

describe('Escopo 0.85A · Contratos Canônicos de Observação, Revisão & Temporalidade', () => {
  it('P: ObservationRecord pode existir sem occurredAt quando a ocorrência for desconhecida', () => {
    const obs: ObservationRecord = {
      observationId: 'obs_123' as ObservationRecordId,
      subject: {
        domain: 'suppliers',
        entityType: 'supplier_catalog',
        entityId: 'sup_alpha',
      },
      observedClaim: 'catalog_price',
      rawValue: 49.9,
      actor: {
        kind: 'system',
        component: 'catalog_ingestion',
      },
      sourceRefs: ['src_1' as SourceRefId],
      evidenceRefs: ['art_1' as EvidenceArtifactRefId],
      observedAt: '2026-08-21T10:00:00Z',
      capturedAt: '2026-08-21T10:05:00Z',
      // occurredAt é omitido
    };

    assert.equal(obs.occurredAt, undefined);
    assert.equal(obs.rawValue, 49.9);
    assert.equal(obs.actor.kind, 'system');
  });

  it('Q: observedAt, capturedAt e occurredAt podem expressar instantes temporais distintos em UTC Z', () => {
    const obs: ObservationRecord = {
      observationId: 'obs_456' as ObservationRecordId,
      subject: {
        domain: 'purchases',
        entityType: 'invoice',
        entityId: 'inv_99',
      },
      observedClaim: 'total_amount',
      rawValue: 1200.0,
      normalizedValue: 1200.0,
      actor: {
        kind: 'human',
        humanId: 'user_lucas',
        role: 'operator',
      },
      sourceRefs: [],
      evidenceRefs: [],
      occurredAt: '2026-08-20T14:30:00Z', // Emissão da nota pelo fornecedor
      observedAt: '2026-08-21T08:00:00Z', // Quando Lucas abriu e leu a nota
      capturedAt: '2026-08-21T08:05:00Z', // Quando o sistema gravou
      receivedAt: '2026-08-20T16:00:00Z', // Quando o e-mail chegou
    };

    assert.notEqual(obs.occurredAt, obs.observedAt);
    assert.notEqual(obs.observedAt, obs.capturedAt);
    assert.equal(obs.receivedAt, '2026-08-20T16:00:00Z');
  });

  it('R: EvidenceArtifactRef discriminated union modela execution_evidence_ref e proíbe em genéricos', () => {
    const techEvidenceId = 'exec_ev_789' as ExecutionEvidenceId;

    const execArtifact: ExecutionEvidenceArtifactRef = {
      artifactId: 'art_exec_1' as EvidenceArtifactRefId,
      kind: 'execution_evidence_ref',
      executionEvidenceId: techEvidenceId, // Obrigatório
      capturedAt: '2026-08-21T12:00:00Z',
      safeDescription: 'Vinculação factual à execução técnica L0',
    };

    const screenshotArtifact: GenericEvidenceArtifactRef = {
      artifactId: 'art_screen_1' as EvidenceArtifactRefId,
      kind: 'screenshot',
      capturedAt: '2026-08-21T12:05:00Z',
      locationRef: 's3://artifacts/screen1.png',
      // executionEvidenceId proibido nesta variante
    };

    assert.equal(execArtifact.executionEvidenceId, 'exec_ev_789');
    assert.equal(execArtifact.kind, 'execution_evidence_ref');
    assert.equal(screenshotArtifact.kind, 'screenshot');
  });

  it('Type-level Negative Tests: EvidenceArtifactRef combinations', () => {
    // @ts-expect-error executionEvidenceId é obrigatório para execution_evidence_ref
    checkType<ExecutionEvidenceArtifactRef>({
      artifactId: 'art_1' as EvidenceArtifactRefId,
      kind: 'execution_evidence_ref',
      capturedAt: '2026-08-21T12:00:00Z',
    });

    checkType<GenericEvidenceArtifactRef>({
      artifactId: 'art_2' as EvidenceArtifactRefId,
      kind: 'screenshot',
      // @ts-expect-error executionEvidenceId é proibido para screenshot
      executionEvidenceId: 'exec_123' as ExecutionEvidenceId,
      capturedAt: '2026-08-21T12:00:00Z',
    });

    assert.ok(true);
  });

  it('J: Freshness não altera o status de revisão automaticamente (eixos ortogonais)', () => {
    const promoReview: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_1' as ReviewEventId,
      actor: {
        kind: 'human',
        humanId: 'user_lucas',
        authorityRef: 'AUTH_LEGAL_2026',
      },
      targetObservationIds: ['obs_100' as ObservationRecordId],
      decision: 'canonical_promoted',
      canonicalEffect: {
        action: 'promote',
        targetCanonicalState: { status: 'approved' },
      },
      justification: 'Aprovado após análise de contrato físico',
      reviewedAt: '2026-01-10T10:00:00Z',
    };

    const freshness: FreshnessInfo = {
      state: 'stale',
      evaluatedAt: '2026-08-21T12:00:00Z',
      recheckAfter: '2026-06-01T00:00:00Z',
      reason: 'Prazo semestral de revalidação expirado',
    };

    assert.equal(promoReview.decision, 'canonical_promoted');
    assert.equal(freshness.state, 'stale');
  });

  it('K: Confiança alta de assessment não substitui revisão e não promove canônico', () => {
    const confidence: ConfidenceAssessment = {
      level: 'high',
      assessedAt: '2026-08-21T12:00:00Z',
      basis: '3 fontes independentes convergentes com correlação de 99.4%',
      limitations: ['Variação cambial não verificada nas últimas 24h'],
    };

    const maxReview: NonCanonicalReviewEvent = {
      reviewId: 'rev_max_1' as ReviewEventId,
      actor: {
        kind: 'max',
        maxVersion: 'max-1.0-gov',
      },
      targetObservationIds: ['obs_200' as ObservationRecordId],
      decision: 'corroborated',
      justification: 'Evidência estatisticamente sólida com confiança alta',
      reviewedAt: '2026-08-21T12:05:00Z',
    };

    assert.equal(confidence.level, 'high');
    assert.equal(maxReview.decision, 'corroborated');
    assert.equal(maxReview.canonicalEffect, undefined);
  });

  it('Type-level Negative Tests: ReviewEvent combinations', () => {
    // @ts-expect-error canonical_promoted exige canonicalEffect action promote
    checkType<CanonicalPromotedReviewEvent>({
      reviewId: 'rev_invalid_1' as ReviewEventId,
      actor: { kind: 'human', humanId: 'user_lucas', authorityRef: 'AUTH_1' },
      targetObservationIds: ['obs_1' as ObservationRecordId],
      decision: 'canonical_promoted',
      justification: 'Faltando canonicalEffect',
      reviewedAt: '2026-08-21T10:00:00Z',
    });

    checkType<NonCanonicalReviewEvent>({
      reviewId: 'rev_invalid_2' as ReviewEventId,
      actor: { kind: 'max', maxVersion: '1.0' },
      targetObservationIds: ['obs_1' as ObservationRecordId],
      decision: 'provisional',
      // @ts-expect-error canonicalEffect é proibido em non-canonical decision
      canonicalEffect: { action: 'promote', targetCanonicalState: {} },
      justification: 'Canonical effect em non-canonical decision',
      reviewedAt: '2026-08-21T10:00:00Z',
    });

    assert.ok(true);
  });

  it('L e M: ReconciliationCase discriminated union por lifecycle (open vs resolved)', () => {
    const openDivergentCase: OpenReconciliationCase = {
      caseId: 'case_div_1' as ReconciliationCaseId,
      subject: {
        domain: 'suppliers',
        entityType: 'supplier_price',
        entityId: 'item_camiseta_preta',
      },
      lifecycle: 'open',
      status: 'divergent',
      observationIds: ['obs_site_1' as ObservationRecordId, 'obs_pdf_2' as ObservationRecordId],
      reviewIds: ['rev_max_comp_1' as ReviewEventId],
      openedAt: '2026-08-21T09:00:00Z',
      resolutionSummary: 'Anotação corrente: divergência em investigação',
      // resolvedAt é proibido aqui
    };

    const resolvedInconclusiveCase: ResolvedReconciliationCase = {
      caseId: 'case_inc_2' as ReconciliationCaseId,
      subject: {
        domain: 'stock',
        entityType: 'sku',
        entityId: 'sku_dtf_tape',
      },
      lifecycle: 'resolved',
      status: 'inconclusive',
      observationIds: ['obs_stock_1' as ObservationRecordId],
      reviewIds: [],
      openedAt: '2026-08-21T11:00:00Z',
      resolvedAt: '2026-08-21T11:30:00Z', // Obrigatório
      resolutionSummary: 'Evidência fotográfica ilegível para contagem de rolos; caso arquivado.', // Obrigatório
    };

    assert.equal(openDivergentCase.lifecycle, 'open');
    assert.equal(openDivergentCase.status, 'divergent');
    assert.equal(resolvedInconclusiveCase.lifecycle, 'resolved');
    assert.equal(resolvedInconclusiveCase.status, 'inconclusive');
  });

  it('Type-level Negative Tests: ReconciliationCase lifecycle', () => {
    checkType<OpenReconciliationCase>({
      caseId: 'case_inv_1' as ReconciliationCaseId,
      subject: { domain: 'a', entityType: 'b', entityId: 'c' },
      lifecycle: 'open',
      status: 'open',
      observationIds: ['obs_1' as ObservationRecordId],
      reviewIds: [],
      openedAt: '2026-08-21T10:00:00Z',
      // @ts-expect-error resolvedAt é proibido em OpenReconciliationCase
      resolvedAt: '2026-08-21T10:30:00Z',
    });

    // @ts-expect-error resolvedAt e resolutionSummary são obrigatórios em ResolvedReconciliationCase
    checkType<ResolvedReconciliationCase>({
      caseId: 'case_inv_2' as ReconciliationCaseId,
      subject: { domain: 'a', entityType: 'b', entityId: 'c' },
      lifecycle: 'resolved',
      status: 'validated',
      observationIds: ['obs_1' as ObservationRecordId],
      reviewIds: [],
      openedAt: '2026-08-21T10:00:00Z',
    });

    assert.ok(true);
  });

  it('O: Precedente contextual mantém vínculo com a revisão sem virar policy automática', () => {
    const precedent: ContextualPrecedent = {
      precedentId: 'prec_001' as ContextualPrecedentRefId,
      reviewEventId: 'rev_human_88' as ReviewEventId,
      contextSummary: 'Desconto de 10% aceito para compras acima de 100 unidades à vista',
      applicabilityConditions: [
        'fornecedor == "Textil Bauru"',
        'quantidade >= 100',
        'pagamento == "a_vista"',
      ],
      policyProposalRef: 'PROP_POLICY_DISCOUNT_RULES_2026',
    };

    assert.equal(precedent.precedentId, 'prec_001');
    assert.equal(precedent.reviewEventId, 'rev_human_88');
    assert.equal(precedent.policyProposalRef, 'PROP_POLICY_DISCOUNT_RULES_2026');
  });

  it('N: CanonicalProjection materializa o histórico e preserva a cadeia explicável', () => {
    const projection: CanonicalProjection = {
      projectionRevisionId: 'proj_rev_01' as CanonicalProjectionRevisionId,
      subject: {
        domain: 'catalog',
        entityType: 'product_base',
        entityId: 'camisao_algodao_m',
      },
      canonicalState: {
        material: '100% algodão',
        basePrice: 45.0,
        status: 'approved_for_sale',
      },
      underlyingObservationIds: ['obs_amostra_1' as ObservationRecordId],
      authorizingReviewIds: ['rev_aprovacao_lucas_1' as ReviewEventId],
      reconciliationCaseId: undefined,
      supersedesRevisionId: undefined,
      materializedAt: '2026-08-21T15:00:00Z',
      explanation: 'Aprovado por Lucas após validação presencial da amostra física.',
    };

    assert.equal(projection.canonicalState.basePrice, 45.0);
    assert.equal(projection.underlyingObservationIds.length, 1);
    assert.equal(projection.authorizingReviewIds.length, 1);
  });
});
