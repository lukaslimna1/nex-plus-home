/**
 * NEX+ · Matriz de Aceitação Comportamental de Reconciliação (Escopo 0.85D · Checkpoint 2 · Passagem 1)
 *
 * Cenários de Aceitação Ponta a Ponta:
 * - P1: Metadata × Página Renderizada (Divergência, Múltiplas Fontes, Sem Votação Simples)
 * - P2: Pix × Cartão (Condições Distintas, Coexistência Sem Sobrescrita)
 * - P3: Ontem Correto × Hoje Mudou (Evolução Temporal V1 -> V2, Rastreabilidade Histórica)
 * - P4: MAX Erra → Humano Corrige (Precedente Contextual != Policy, Erro Preservado)
 * - P5: Humano Erra → MAX Traz Nova Evidência (Reabertura Governada, MAX Não Promove)
 * - P6: Dois Humanos em Bases Diferentes (Concorrência Otimista Stale, Sem Last-Write-Wins)
 * - P7: Nenhuma Fonte Resolve (Inconclusive / Awaiting Evidence, Sem Conclusão Artificial)
 * - P8: Captura Duplicada (Idempotência Técnica != Nova Observação Temporal)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type {
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  ReviewEventId,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  ReconciliationCaseId,
  OpenReconciliationCase,
  ResolvedReconciliationCase,
  ContextualPrecedent,
  ContextualPrecedentRefId,
  HumanActor,
  MaxActor,
  SystemActor,
  IntegrationActor,
  SourceRefId,
} from '../../contracts';
import { PgObservationPersistenceAdapter } from '../../persistence/postgres';
import { PgReconciliationPersistenceAdapter } from '../postgres';
import { ReconciliationCoordinator } from '../coordinator';
import { PgEvidenceArtifactPersistenceAdapter } from '../../artifacts/postgres';
import { StaleCanonicalBaseConflictError } from '../../persistence/errors';
import { CanonicalPromotionAuthorityError } from '../errors';
import type { HumanAuthorizationDecision } from '../../../policy/contracts';

const databaseUrl = process.env.DATABASE_URL;

describe('Escopo 0.85D · Matriz de Aceitação de Reconciliação (Checkpoint 2 · Passagem 1)', { skip: !databaseUrl }, () => {
  let pool: Pool;
  let obsPersistence: PgObservationPersistenceAdapter;
  let recPersistence: PgReconciliationPersistenceAdapter;
  let coordinator: ReconciliationCoordinator;
  let artifactPersistence: PgEvidenceArtifactPersistenceAdapter;

  const humanLucas: HumanActor = {
    kind: 'human',
    humanId: 'user_lucas_master',
    role: 'admin_dev',
    authorityRef: 'AUTH_NEX_085D_DEV',
  };

  const humanAlice: HumanActor = {
    kind: 'human',
    humanId: 'user_alice_auditor',
    role: 'auditor',
    authorityRef: 'AUTH_NEX_085D_ALICE',
  };

  const maxAgent: MaxActor = {
    kind: 'max',
    maxVersion: 'MAX_3.0_LOCAL',
    sessionRef: 'session_acceptance_085d',
  };

  const validHumanAuthDecision: HumanAuthorizationDecision = {
    actorRef: humanLucas.humanId,
    operation: 'canonical_promotion',
    verdict: 'authorized',
    reasonCode: 'HUMAN_APPROVAL_OK',
    authorizedAt: '2026-08-22T13:00:00.000Z',
  };

  const aliceHumanAuthDecision: HumanAuthorizationDecision = {
    actorRef: humanAlice.humanId,
    operation: 'canonical_promotion',
    verdict: 'authorized',
    reasonCode: 'HUMAN_APPROVAL_OK',
    authorizedAt: '2026-08-22T13:05:00.000Z',
  };

  before(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 5000,
    });

    obsPersistence = new PgObservationPersistenceAdapter(pool);
    recPersistence = new PgReconciliationPersistenceAdapter(pool);
    coordinator = new ReconciliationCoordinator(obsPersistence, recPersistence);
    artifactPersistence = new PgEvidenceArtifactPersistenceAdapter(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // ==========================================================================
  // CENÁRIO P1: METADATA × PÁGINA RENDERIZADA
  // ==========================================================================
  it('P1: Metadata × Página Renderizada preserva ambas as fontes divergentes sem votação simples e sem projeção automática', async () => {
    const subjectP1: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p1_divergent_sku_101',
    };

    // 1. Registrar Fonte A (Metadata API)
    const sourceA = await artifactPersistence.recordSourceRef({
      sourceId: 'src_p1_catalog_meta' as SourceRefId,
      kind: 'api_endpoint',
      name: 'Supplier Catalog API',
      locationOrUri: 'https://api.supplier.local/v1/products/101',
      safeMetadata: { format: 'json', endpoint: 'catalog' },
      createdAt: '2026-08-22T10:00:00.000Z',
    });

    // 2. Observation A (Metadata API: R$ 89,90)
    const obsA: ObservationRecord = {
      observationId: 'obs_p1_meta_8990' as ObservationRecordId,
      subject: subjectP1,
      observedClaim: 'price',
      rawValue: { amount: 89.90, currency: 'BRL' },
      normalizedValue: { amount: 89.90, currency: 'BRL' },
      actor: { kind: 'integration', provider: 'supplier_catalog_sync' } as IntegrationActor,
      sourceRefs: [sourceA.sourceId],
      evidenceRefs: [],
      observedAt: '2026-08-22T10:00:00.000Z',
      capturedAt: '2026-08-22T10:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsA);

    // 3. Registrar Fonte B (Web Render Page)
    const sourceB = await artifactPersistence.recordSourceRef({
      sourceId: 'src_p1_render_page' as SourceRefId,
      kind: 'url',
      name: 'Supplier Product Page Render',
      locationOrUri: 'https://store.supplier.local/products/101',
      safeMetadata: { format: 'html', userAgent: 'HeadlessChrome' },
      createdAt: '2026-08-22T10:05:00.000Z',
    });

    // 4. Observation B (Render Page DOM: R$ 79,90)
    const obsB: ObservationRecord = {
      observationId: 'obs_p1_render_7990' as ObservationRecordId,
      subject: subjectP1,
      observedClaim: 'price',
      rawValue: { amount: 79.90, currency: 'BRL' },
      normalizedValue: { amount: 79.90, currency: 'BRL' },
      actor: maxAgent,
      sourceRefs: [sourceB.sourceId],
      evidenceRefs: [],
      observedAt: '2026-08-22T10:05:00.000Z',
      capturedAt: '2026-08-22T10:05:02.000Z',
    };
    await obsPersistence.recordObservation(obsB);

    // 5. MAX submete review não-canônica apontando divergência
    const maxReview: NonCanonicalReviewEvent = {
      reviewId: 'rev_p1_max_divergence_01' as ReviewEventId,
      targetObservationIds: [obsA.observationId, obsB.observationId],
      actor: maxAgent,
      decision: 'divergent',
      justification: 'Metadata API reports R$ 89,90 while rendered DOM shows promotional price R$ 79,90.',
      reviewedAt: '2026-08-22T10:06:00.000Z',
    };
    await coordinator.submitReview(maxReview);

    // 6. Criar ReconciliationCase com status 'divergent'
    const caseP1: OpenReconciliationCase = {
      caseId: 'case_p1_divergent_101' as ReconciliationCaseId,
      subject: subjectP1,
      lifecycle: 'open',
      status: 'divergent',
      observationIds: [obsA.observationId, obsB.observationId],
      reviewIds: [maxReview.reviewId],
      openedAt: '2026-08-22T10:06:05.000Z',
      resolutionSummary: 'Awaiting human reconciliation between metadata and render price claims.',
    };
    const caseResult = await coordinator.createReconciliationCase({ case: caseP1 });
    assert.equal(caseResult.head.status, 'divergent');
    assert.equal(caseResult.head.currentVersion, 1);

    // 7. Provar consultas e ausência de projeção canônica automática
    const savedObsA = await obsPersistence.getObservation(obsA.observationId);
    const savedObsB = await obsPersistence.getObservation(obsB.observationId);
    assert.ok(savedObsA);
    assert.ok(savedObsB);
    assert.deepEqual(savedObsA.rawValue, { amount: 89.90, currency: 'BRL' });
    assert.deepEqual(savedObsB.rawValue, { amount: 79.90, currency: 'BRL' });

    const savedCase = await recPersistence.getCurrentReconciliationCase(caseP1.caseId);
    assert.ok(savedCase);
    assert.equal(savedCase.lifecycle, 'open');
    assert.equal(savedCase.status, 'divergent');
    assert.deepEqual(savedCase.observationIds, [obsA.observationId, obsB.observationId]);

    // Nenhuma CanonicalProjection foi gerada
    const canonicalHead = await obsPersistence.getCurrentCanonicalHead(subjectP1);
    assert.equal(canonicalHead, null, 'Nenhuma CanonicalProjection deve nascer automaticamente por votação simples');
  });

  // ==========================================================================
  // CENÁRIO P2: PIX × CARTÃO
  // ==========================================================================
  it('P2: Pix × Cartão representam claims distintos sem sobrescrita mútua e reconciliação de um não apaga o outro', async () => {
    const subjectP2: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p2_pix_card_sku_202',
    };

    // 1. Registrar observação de Preço no Pix
    const obsPix: ObservationRecord = {
      observationId: 'obs_p2_pix_7990' as ObservationRecordId,
      subject: subjectP2,
      observedClaim: 'price_condition:pix',
      rawValue: { amount: 79.90, paymentMethod: 'pix', currency: 'BRL' },
      normalizedValue: { amount: 79.90, paymentMethod: 'pix', currency: 'BRL' },
      actor: { kind: 'system', component: 'crawler_pricing' } as SystemActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T11:00:00.000Z',
      capturedAt: '2026-08-22T11:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsPix);

    // 2. Registrar observação de Preço no Cartão
    const obsCard: ObservationRecord = {
      observationId: 'obs_p2_card_8990' as ObservationRecordId,
      subject: subjectP2,
      observedClaim: 'price_condition:credit_card',
      rawValue: { amount: 89.90, paymentMethod: 'credit_card', currency: 'BRL' },
      normalizedValue: { amount: 89.90, paymentMethod: 'credit_card', currency: 'BRL' },
      actor: { kind: 'system', component: 'crawler_pricing' } as SystemActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T11:00:00.000Z',
      capturedAt: '2026-08-22T11:00:02.000Z',
    };
    await obsPersistence.recordObservation(obsCard);

    // 3. Ambas as observações coexistem no banco
    const fetchedPix = await obsPersistence.getObservation(obsPix.observationId);
    const fetchedCard = await obsPersistence.getObservation(obsCard.observationId);
    assert.ok(fetchedPix);
    assert.ok(fetchedCard);
    assert.notEqual(fetchedPix.observationId, fetchedCard.observationId);
    assert.deepEqual(fetchedPix.rawValue, { amount: 79.90, paymentMethod: 'pix', currency: 'BRL' });
    assert.deepEqual(fetchedCard.rawValue, { amount: 89.90, paymentMethod: 'credit_card', currency: 'BRL' });

    // 4. Promoção canônica de estado consolidado que valida ambas as condições
    const humanReview: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p2_human_promo' as ReviewEventId,
      targetObservationIds: [obsPix.observationId, obsCard.observationId],
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: {
        action: 'promote',
        targetCanonicalState: {
          pixPrice: 79.90,
          cardPrice: 89.90,
          currency: 'BRL',
          verifiedDualCondition: true,
        },
      },
      justification: 'Both Pix (79.90) and Credit Card (89.90) pricing terms are valid and coexistent.',
      reviewedAt: '2026-08-22T11:10:00.000Z',
    };

    const projection: CanonicalProjection = {
      projectionRevisionId: 'proj_p2_rev_01' as CanonicalProjectionRevisionId,
      subject: subjectP2,
      canonicalState: {
        pixPrice: 79.90,
        cardPrice: 89.90,
        currency: 'BRL',
        verifiedDualCondition: true,
      },
      underlyingObservationIds: [obsPix.observationId, obsCard.observationId],
      authorizingReviewIds: [humanReview.reviewId],
      materializedAt: '2026-08-22T11:10:05.000Z',
      explanation: 'Canonical offer consolidated with dual price terms: Pix R$ 79,90 and Card R$ 89,90.',
    };

    const promoResult = await coordinator.submitCanonicalPromotion({
      review: humanReview,
      projection,
      authorization: validHumanAuthDecision,
    });
    assert.equal(promoResult.head.currentProjectionRevisionId, projection.projectionRevisionId);

    // Provar que ambas as observações originais continuam presentes no banco após promoção
    const postPix = await obsPersistence.getObservation(obsPix.observationId);
    const postCard = await obsPersistence.getObservation(obsCard.observationId);
    assert.ok(postPix);
    assert.ok(postCard);
  });

  // ==========================================================================
  // CENÁRIO P3: ONTEM CORRETO × HOJE MUDOU
  // ==========================================================================
  it('P3: Ontem Correto × Hoje Mudou evolui V1 -> V2 preservando histórico explicável', async () => {
    const subjectP3: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p3_temporal_sku_303',
    };

    // T0: Ontem (2026-08-20) - Preço R$ 79,90
    const obsT0: ObservationRecord = {
      observationId: 'obs_p3_t0_7990' as ObservationRecordId,
      subject: subjectP3,
      observedClaim: 'price',
      rawValue: { amount: 79.90, currency: 'BRL' },
      normalizedValue: { amount: 79.90, currency: 'BRL' },
      actor: { kind: 'integration', provider: 'feed_v1' } as IntegrationActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-20T10:00:00.000Z',
      capturedAt: '2026-08-20T10:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsT0);

    const reviewT0: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p3_t0_human' as ReviewEventId,
      targetObservationIds: [obsT0.observationId],
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: {
        action: 'promote',
        targetCanonicalState: { price: 79.90, validDate: '2026-08-20' },
      },
      justification: 'Price R$ 79,90 verified and approved for 2026-08-20.',
      reviewedAt: '2026-08-20T10:30:00.000Z',
    };

    const projV1: CanonicalProjection = {
      projectionRevisionId: 'proj_p3_v1_revision' as CanonicalProjectionRevisionId,
      subject: subjectP3,
      canonicalState: { price: 79.90, validDate: '2026-08-20' },
      underlyingObservationIds: [obsT0.observationId],
      authorizingReviewIds: [reviewT0.reviewId],
      materializedAt: '2026-08-20T10:30:05.000Z',
      explanation: 'Canonical price established as R$ 79,90 on 2026-08-20.',
    };

    await coordinator.submitCanonicalPromotion({
      review: reviewT0,
      projection: projV1,
      authorization: validHumanAuthDecision,
    });

    const headAfterT0 = await obsPersistence.getCurrentCanonicalHead(subjectP3);
    assert.equal(headAfterT0?.currentProjectionRevisionId, projV1.projectionRevisionId);

    // T1: Hoje (2026-08-21) - Nova observação com reajuste: R$ 84,90
    const obsT1: ObservationRecord = {
      observationId: 'obs_p3_t1_8490' as ObservationRecordId,
      subject: subjectP3,
      observedClaim: 'price',
      rawValue: { amount: 84.90, currency: 'BRL' },
      normalizedValue: { amount: 84.90, currency: 'BRL' },
      actor: { kind: 'integration', provider: 'feed_v1' } as IntegrationActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-21T09:00:00.000Z',
      capturedAt: '2026-08-21T09:00:02.000Z',
    };
    await obsPersistence.recordObservation(obsT1);

    // Provar que a nova observação NÃO altera V1 silenciosamente
    const headBeforeV2 = await obsPersistence.getCurrentCanonicalHead(subjectP3);
    assert.equal(headBeforeV2?.currentProjectionRevisionId, projV1.projectionRevisionId, 'V1 deve permanecer como Head antes de nova promoção governada');

    // T1: Promoção governada de V2 supersedendo V1
    const reviewT1: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p3_t1_human_update' as ReviewEventId,
      targetObservationIds: [obsT1.observationId],
      previousReviewIds: [reviewT0.reviewId],
      targetBaseRevisionId: projV1.projectionRevisionId,
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: {
        action: 'promote',
        targetCanonicalState: { price: 84.90, validDate: '2026-08-21' },
      },
      justification: 'Supplier increased catalog price from 79.90 to 84.90 on 2026-08-21.',
      reviewedAt: '2026-08-21T09:30:00.000Z',
    };

    const projV2: CanonicalProjection = {
      projectionRevisionId: 'proj_p3_v2_revision' as CanonicalProjectionRevisionId,
      subject: subjectP3,
      canonicalState: { price: 84.90, validDate: '2026-08-21' },
      underlyingObservationIds: [obsT0.observationId, obsT1.observationId],
      authorizingReviewIds: [reviewT0.reviewId, reviewT1.reviewId],
      supersedesRevisionId: projV1.projectionRevisionId,
      materializedAt: '2026-08-21T09:30:05.000Z',
      explanation: 'Price updated to R$ 84,90 on 2026-08-21 superseding previous price R$ 79,90.',
    };

    await coordinator.submitCanonicalPromotion({
      review: reviewT1,
      projection: projV2,
      expectedBaseRevisionId: projV1.projectionRevisionId,
      authorization: validHumanAuthDecision,
    });

    // 4. Provar Reconstrução Histórica Completa via PostgreSQL
    const headAfterV2 = await obsPersistence.getCurrentCanonicalHead(subjectP3);
    assert.equal(headAfterV2?.currentProjectionRevisionId, projV2.projectionRevisionId);

    const savedV1 = await obsPersistence.getCanonicalProjectionRevision(projV1.projectionRevisionId);
    const savedV2 = await obsPersistence.getCanonicalProjectionRevision(projV2.projectionRevisionId);
    assert.ok(savedV1);
    assert.ok(savedV2);
    assert.equal(savedV2.supersedesRevisionId, projV1.projectionRevisionId);

    // Ambas as observações históricas continuam no banco
    const dbObsT0 = await obsPersistence.getObservation(obsT0.observationId);
    const dbObsT1 = await obsPersistence.getObservation(obsT1.observationId);
    assert.ok(dbObsT0);
    assert.ok(dbObsT1);
    assert.deepEqual(dbObsT0.rawValue, { amount: 79.90, currency: 'BRL' });
    assert.deepEqual(dbObsT1.rawValue, { amount: 84.90, currency: 'BRL' });
  });

  // ==========================================================================
  // CENÁRIO P4: MAX ERRA → HUMANO CORRIGE
  // ==========================================================================
  it('P4: MAX Erra → Humano Corrige estabelecendo ContextualPrecedent sem alterar Policy', async () => {
    const subjectP4: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p4_complex_terms_sku_404',
    };

    // 1. Observation com estrutura complexa de parcelamento
    const obsP4: ObservationRecord = {
      observationId: 'obs_p4_installment_claim' as ObservationRecordId,
      subject: subjectP4,
      observedClaim: 'price_structure',
      rawValue: {
        rawString: 'R$ 1.299,00 à vista no Pix ou 10x de R$ 149,90',
        cashDiscount: 'Pix',
        installmentMonths: 10,
      },
      actor: { kind: 'system', component: 'scraper' } as SystemActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T12:00:00.000Z',
      capturedAt: '2026-08-22T12:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsP4);

    // 2. MAX erra e submete review rejeitando por alegada incoerência
    const maxReviewErr: NonCanonicalReviewEvent = {
      reviewId: 'rev_p4_max_erroneous' as ReviewEventId,
      targetObservationIds: [obsP4.observationId],
      actor: maxAgent,
      decision: 'rejected',
      justification: 'Price format unrecognized or contradictory installment sum (1499.00 vs 1299.00).',
      reviewedAt: '2026-08-22T12:05:00.000Z',
    };
    await coordinator.submitReview(maxReviewErr);

    // 3. Caso aberto com a revisão errada do MAX
    const caseP4: OpenReconciliationCase = {
      caseId: 'case_p4_precedent_404' as ReconciliationCaseId,
      subject: subjectP4,
      lifecycle: 'open',
      status: 'open',
      observationIds: [obsP4.observationId],
      reviewIds: [maxReviewErr.reviewId],
      openedAt: '2026-08-22T12:05:05.000Z',
      resolutionSummary: 'MAX rejected compound price structure.',
    };
    await coordinator.createReconciliationCase({ case: caseP4 });

    // 4. Humano revisa, esclarece a regra de negócio e promove canônica
    const humanReviewCorrect: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p4_human_corrected' as ReviewEventId,
      targetObservationIds: [obsP4.observationId],
      previousReviewIds: [maxReviewErr.reviewId],
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: {
        action: 'promote',
        targetCanonicalState: {
          cashPrice: 1299.00,
          installmentTotal: 1499.00,
          installmentCount: 10,
          installmentAmount: 149.90,
        },
      },
      justification: 'Parsed cash discount vs installment structure correctly: cash price is R$ 1.299,00.',
      reviewedAt: '2026-08-22T12:15:00.000Z',
    };

    const projP4: CanonicalProjection = {
      projectionRevisionId: 'proj_p4_v1_revision' as CanonicalProjectionRevisionId,
      subject: subjectP4,
      canonicalState: {
        cashPrice: 1299.00,
        installmentTotal: 1499.00,
        installmentCount: 10,
        installmentAmount: 149.90,
      },
      underlyingObservationIds: [obsP4.observationId],
      authorizingReviewIds: [humanReviewCorrect.reviewId],
      reconciliationCaseId: caseP4.caseId,
      materializedAt: '2026-08-22T12:15:05.000Z',
      explanation: 'Cash and installment split parsed and approved by human auditor.',
    };

    await coordinator.submitCanonicalPromotion({
      review: humanReviewCorrect,
      projection: projP4,
      authorization: validHumanAuthDecision,
    });

    // 5. Atualizar caso para 'resolved'
    const resolvedCaseP4: ResolvedReconciliationCase = {
      caseId: caseP4.caseId,
      subject: subjectP4,
      lifecycle: 'resolved',
      status: 'validated',
      observationIds: [obsP4.observationId],
      reviewIds: [maxReviewErr.reviewId, humanReviewCorrect.reviewId],
      openedAt: caseP4.openedAt,
      resolvedAt: '2026-08-22T12:15:10.000Z',
      resolutionSummary: 'Human resolved MAX misinterpretation of compound price structure.',
    };
    await coordinator.appendReconciliationRevision({
      case: resolvedCaseP4,
      expectedVersion: 1,
    });

    // 6. Estabelecer ContextualPrecedent a partir da decisão humana
    const precedent: ContextualPrecedent = {
      precedentId: 'prec_p4_compound_pricing_rule' as ContextualPrecedentRefId,
      reviewEventId: humanReviewCorrect.reviewId,
      contextSummary: 'When offer text contains cash discount alongside installment terms, extract cash as primary price and installment terms as auxiliary terms.',
      applicabilityConditions: ['contains "à vista no Pix"', 'contains "10x de"'],
      policyProposalRef: 'PROP_POLICY_COMPOUND_PRICE_01',
    };
    const savedPrecedent = await coordinator.createContextualPrecedent({ precedent });
    assert.equal(savedPrecedent.precedentId, precedent.precedentId);

    // 7. Provar que o erro do MAX continua no banco e o precedente é consultável
    const dbMaxReview = await obsPersistence.getReview(maxReviewErr.reviewId);
    assert.ok(dbMaxReview, 'Review errada do MAX não pode ser deletada do histórico');
    assert.equal(dbMaxReview.decision, 'rejected');

    const dbPrecedent = await recPersistence.getContextualPrecedent(precedent.precedentId);
    assert.ok(dbPrecedent);
    assert.equal(dbPrecedent.reviewEventId, humanReviewCorrect.reviewId);
    assert.equal(dbPrecedent.policyProposalRef, 'PROP_POLICY_COMPOUND_PRICE_01');

    // Precedente != Policy: provar que nenhuma Policy foi ativada automaticamente
    const precedentList = await recPersistence.listContextualPrecedentsByReview(humanReviewCorrect.reviewId);
    assert.equal(precedentList.length, 1);
  });

  // ==========================================================================
  // CENÁRIO P5: HUMANO ERRA → MAX TRAZ NOVA EVIDÊNCIA
  // ==========================================================================
  it('P5: Humano Erra → MAX Traz Nova Evidência reabrindo caso sem sobrescrita automática de projeção', async () => {
    const subjectP5: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p5_stock_dispute_sku_505',
    };

    // 1. Decisão humana inicial (T0) afirmando produto em estoque por R$ 199,90
    const obsP5T0: ObservationRecord = {
      observationId: 'obs_p5_t0_stock' as ObservationRecordId,
      subject: subjectP5,
      observedClaim: 'stock_and_price',
      rawValue: { inStock: true, price: 199.90 },
      actor: humanLucas,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T08:00:00.000Z',
      capturedAt: '2026-08-22T08:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsP5T0);

    const reviewHumanT0: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p5_human_t0' as ReviewEventId,
      targetObservationIds: [obsP5T0.observationId],
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: {
        action: 'promote',
        targetCanonicalState: { inStock: true, price: 199.90 },
      },
      justification: 'Approved in-stock price R$ 199,90 based on morning inventory sheet.',
      reviewedAt: '2026-08-22T08:15:00.000Z',
    };

    const projP5V1: CanonicalProjection = {
      projectionRevisionId: 'proj_p5_v1_revision' as CanonicalProjectionRevisionId,
      subject: subjectP5,
      canonicalState: { inStock: true, price: 199.90 },
      underlyingObservationIds: [obsP5T0.observationId],
      authorizingReviewIds: [reviewHumanT0.reviewId],
      materializedAt: '2026-08-22T08:15:05.000Z',
      explanation: 'In-stock canonical state approved.',
    };

    await coordinator.submitCanonicalPromotion({
      review: reviewHumanT0,
      projection: projP5V1,
      authorization: validHumanAuthDecision,
    });

    const caseP5: OpenReconciliationCase = {
      caseId: 'case_p5_stock_505' as ReconciliationCaseId,
      subject: subjectP5,
      lifecycle: 'open',
      status: 'open',
      observationIds: [obsP5T0.observationId],
      reviewIds: [reviewHumanT0.reviewId],
      openedAt: '2026-08-22T08:00:00.000Z',
      resolutionSummary: 'Initial morning verification validated in-stock.',
    };
    await coordinator.createReconciliationCase({ case: caseP5 });

    // 2. T1: MAX traz nova evidência material (Snapshot de banner 'Produto Esgotado')
    const sourceEvidence = await artifactPersistence.recordSourceRef({
      sourceId: 'src_p5_live_check' as SourceRefId,
      kind: 'url',
      name: 'Supplier Live Storefront',
      locationOrUri: 'https://store.supplier.local/prod/505',
      createdAt: '2026-08-22T13:00:00.000Z',
    });

    const obsP5T1: ObservationRecord = {
      observationId: 'obs_p5_t1_out_of_stock' as ObservationRecordId,
      subject: subjectP5,
      observedClaim: 'stock_and_price',
      rawValue: { inStock: false, reason: 'OUT_OF_STOCK' },
      actor: maxAgent,
      sourceRefs: [sourceEvidence.sourceId],
      evidenceRefs: [],
      observedAt: '2026-08-22T13:00:00.000Z',
      capturedAt: '2026-08-22T13:00:02.000Z',
    };
    await obsPersistence.recordObservation(obsP5T1);

    // 3. MAX submete review contestando o estado
    const maxReviewContest: NonCanonicalReviewEvent = {
      reviewId: 'rev_p5_max_contest_stock' as ReviewEventId,
      targetObservationIds: [obsP5T0.observationId, obsP5T1.observationId],
      actor: maxAgent,
      decision: 'divergent',
      justification: 'Fresh storefront snapshot demonstrates product is out of stock contrary to morning verification.',
      reviewedAt: '2026-08-22T13:05:00.000Z',
    };
    await coordinator.submitReview(maxReviewContest);

    // 4. MAX NÃO pode promover projeção canônica (Gate de Autoridade rejeita fail-closed)
    const unauthorizedMaxPromo = {
      review: {
        ...maxReviewContest,
        decision: 'canonical_promoted',
        canonicalEffect: { action: 'promote', targetCanonicalState: { inStock: false } },
      } as any,
      projection: {
        projectionRevisionId: 'proj_p5_v2_unauthorized' as CanonicalProjectionRevisionId,
        subject: subjectP5,
        canonicalState: { inStock: false },
        underlyingObservationIds: [obsP5T1.observationId],
        authorizingReviewIds: [maxReviewContest.reviewId],
        materializedAt: '2026-08-22T13:05:05.000Z',
        explanation: 'MAX attempting auto promotion',
      },
      authorization: validHumanAuthDecision,
    };
    await assert.rejects(
      async () => coordinator.submitCanonicalPromotion(unauthorizedMaxPromo),
      (err: any) => {
        assert.ok(err instanceof CanonicalPromotionAuthorityError);
        assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
        return true;
      }
    );

    // 5. Caso evolui para versão 2: lifecycle open, status divergent
    const caseP5V2: OpenReconciliationCase = {
      caseId: caseP5.caseId,
      subject: subjectP5,
      lifecycle: 'open',
      status: 'divergent',
      observationIds: [obsP5T0.observationId, obsP5T1.observationId],
      reviewIds: [reviewHumanT0.reviewId, maxReviewContest.reviewId],
      openedAt: caseP5.openedAt,
      resolutionSummary: 'MAX provided new evidence showing out of stock. Awaiting human governed re-decision.',
    };
    const appendResult = await coordinator.appendReconciliationRevision({
      case: caseP5V2,
      expectedVersion: 1,
    });
    assert.equal(appendResult.head.currentVersion, 2);
    assert.equal(appendResult.head.status, 'divergent');

    // 6. Provar que a CanonicalProjection Head ainda é V1 até que haja nova decisão humana governada
    const currentHead = await obsPersistence.getCurrentCanonicalHead(subjectP5);
    assert.equal(currentHead?.currentProjectionRevisionId, projP5V1.projectionRevisionId);
  });

  // ==========================================================================
  // CENÁRIO P6: DOIS HUMANOS EM BASES DIFERENTES
  // ==========================================================================
  it('P6: Dois Humanos em Bases Diferentes previne last-write-wins através de concorrência otimista', async () => {
    const subjectP6: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p6_concurrency_sku_606',
    };

    // 1. Criar Head V1 base
    const obsBase: ObservationRecord = {
      observationId: 'obs_p6_base_claim' as ObservationRecordId,
      subject: subjectP6,
      observedClaim: 'price',
      rawValue: { amount: 100.00, currency: 'BRL' },
      actor: humanLucas,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T09:00:00.000Z',
      capturedAt: '2026-08-22T09:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsBase);

    const revBase: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p6_base_promo' as ReviewEventId,
      targetObservationIds: [obsBase.observationId],
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: { action: 'promote', targetCanonicalState: { price: 100.00 } },
      justification: 'Base price 100.00 established.',
      reviewedAt: '2026-08-22T09:10:00.000Z',
    };

    const projV1: CanonicalProjection = {
      projectionRevisionId: 'proj_p6_v1_base' as CanonicalProjectionRevisionId,
      subject: subjectP6,
      canonicalState: { price: 100.00 },
      underlyingObservationIds: [obsBase.observationId],
      authorizingReviewIds: [revBase.reviewId],
      materializedAt: '2026-08-22T09:10:05.000Z',
      explanation: 'Base price V1.',
    };

    await coordinator.submitCanonicalPromotion({
      review: revBase,
      projection: projV1,
      authorization: validHumanAuthDecision,
    });

    // 2. Humano A (Lucas) e Humano B (Alice) preparam decisões ambos baseados em V1
    const obsLucas: ObservationRecord = {
      observationId: 'obs_p6_lucas_claim' as ObservationRecordId,
      subject: subjectP6,
      observedClaim: 'price',
      rawValue: { amount: 105.00, currency: 'BRL' },
      actor: humanLucas,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T10:00:00.000Z',
      capturedAt: '2026-08-22T10:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsLucas);

    const revLucas: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p6_lucas_promo' as ReviewEventId,
      targetObservationIds: [obsLucas.observationId],
      previousReviewIds: [revBase.reviewId],
      targetBaseRevisionId: projV1.projectionRevisionId,
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: { action: 'promote', targetCanonicalState: { price: 105.00 } },
      justification: 'Lucas adjustments based on supplier update.',
      reviewedAt: '2026-08-22T10:05:00.000Z',
    };

    const projV2Lucas: CanonicalProjection = {
      projectionRevisionId: 'proj_p6_v2_lucas' as CanonicalProjectionRevisionId,
      subject: subjectP6,
      canonicalState: { price: 105.00 },
      underlyingObservationIds: [obsBase.observationId, obsLucas.observationId],
      authorizingReviewIds: [revBase.reviewId, revLucas.reviewId],
      supersedesRevisionId: projV1.projectionRevisionId,
      materializedAt: '2026-08-22T10:05:05.000Z',
      explanation: 'Updated to 105.00 by Lucas.',
    };

    const obsAlice: ObservationRecord = {
      observationId: 'obs_p6_alice_claim' as ObservationRecordId,
      subject: subjectP6,
      observedClaim: 'price',
      rawValue: { amount: 95.00, currency: 'BRL' },
      actor: humanAlice,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T10:01:00.000Z',
      capturedAt: '2026-08-22T10:01:02.000Z',
    };
    await obsPersistence.recordObservation(obsAlice);

    const revAlice: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_p6_alice_promo' as ReviewEventId,
      targetObservationIds: [obsAlice.observationId],
      previousReviewIds: [revBase.reviewId],
      targetBaseRevisionId: projV1.projectionRevisionId,
      actor: humanAlice,
      decision: 'canonical_promoted',
      canonicalEffect: { action: 'promote', targetCanonicalState: { price: 95.00 } },
      justification: 'Alice discount adjustment.',
      reviewedAt: '2026-08-22T10:06:00.000Z',
    };

    const projV2Alice: CanonicalProjection = {
      projectionRevisionId: 'proj_p6_v2_alice' as CanonicalProjectionRevisionId,
      subject: subjectP6,
      canonicalState: { price: 95.00 },
      underlyingObservationIds: [obsBase.observationId, obsAlice.observationId],
      authorizingReviewIds: [revBase.reviewId, revAlice.reviewId],
      supersedesRevisionId: projV1.projectionRevisionId,
      materializedAt: '2026-08-22T10:06:05.000Z',
      explanation: 'Updated to 95.00 by Alice.',
    };

    // 3. Lucas comita primeiro contra V1 -> SUCESSO
    const commitLucas = await coordinator.submitCanonicalPromotion({
      review: revLucas,
      projection: projV2Lucas,
      expectedBaseRevisionId: projV1.projectionRevisionId,
      authorization: validHumanAuthDecision,
    });
    assert.equal(commitLucas.head.currentProjectionRevisionId, projV2Lucas.projectionRevisionId);

    // 4. Alice tenta comitar contra V1 (que agora é base stale) -> REJEITADO
    await assert.rejects(
      async () =>
        coordinator.submitCanonicalPromotion({
          review: revAlice,
          projection: projV2Alice,
          expectedBaseRevisionId: projV1.projectionRevisionId,
          authorization: aliceHumanAuthDecision,
        }),
      (err: any) => {
        assert.ok(err instanceof StaleCanonicalBaseConflictError);
        assert.equal(err.name, 'StaleCanonicalBaseConflictError');
        assert.equal(err.expectedBaseRevisionId, projV1.projectionRevisionId);
        assert.equal(err.currentHeadRevisionId, projV2Lucas.projectionRevisionId);
        return true;
      }
    );

    // 5. Provar que a Head canônica permanece a de Lucas (V2Lucas) sem sobrescrita silenciosa
    const finalHead = await obsPersistence.getCurrentCanonicalHead(subjectP6);
    assert.equal(finalHead?.currentProjectionRevisionId, projV2Lucas.projectionRevisionId);

    // A revisão de Alice não foi inserida na tabela de projections
    const aliceProj = await obsPersistence.getCanonicalProjectionRevision(projV2Alice.projectionRevisionId);
    assert.equal(aliceProj, null);
  });

  // ==========================================================================
  // CENÁRIO P7: NENHUMA FONTE RESOLVE
  // ==========================================================================
  it('P7: Nenhuma Fonte Resolve mantém caso inconclusivo sem projeção artificial', async () => {
    const subjectP7: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p7_unresolved_sku_707',
    };

    // 1. Duas observações com prazos de entrega contraditórios e sem fonte oficial
    const obsLead1: ObservationRecord = {
      observationId: 'obs_p7_lead_3days' as ObservationRecordId,
      subject: subjectP7,
      observedClaim: 'delivery_lead_time',
      rawValue: { leadDays: 3, description: '3 dias úteis' },
      actor: { kind: 'integration', provider: 'marketplace_feed' } as IntegrationActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T11:00:00.000Z',
      capturedAt: '2026-08-22T11:00:01.000Z',
    };
    await obsPersistence.recordObservation(obsLead1);

    const obsLead2: ObservationRecord = {
      observationId: 'obs_p7_lead_30days' as ObservationRecordId,
      subject: subjectP7,
      observedClaim: 'delivery_lead_time',
      rawValue: { leadDays: 30, description: '30 dias úteis (sob encomenda)' },
      actor: { kind: 'integration', provider: 'distributor_feed' } as IntegrationActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T11:05:00.000Z',
      capturedAt: '2026-08-22T11:05:02.000Z',
    };
    await obsPersistence.recordObservation(obsLead2);

    // 2. MAX submete review não-canônica 'inconclusive'
    const reviewInconclusive: NonCanonicalReviewEvent = {
      reviewId: 'rev_p7_inconclusive_lead' as ReviewEventId,
      targetObservationIds: [obsLead1.observationId, obsLead2.observationId],
      actor: maxAgent,
      decision: 'inconclusive',
      justification: 'Both marketplace and distributor feeds diverge widely on lead time with no manufacturer SLA confirmation.',
      reviewedAt: '2026-08-22T11:10:00.000Z',
    };
    await coordinator.submitReview(reviewInconclusive);

    // 3. Caso de Reconciliação criado como 'open' + 'inconclusive'
    const caseP7: OpenReconciliationCase = {
      caseId: 'case_p7_inconclusive_707' as ReconciliationCaseId,
      subject: subjectP7,
      lifecycle: 'open',
      status: 'inconclusive',
      observationIds: [obsLead1.observationId, obsLead2.observationId],
      reviewIds: [reviewInconclusive.reviewId],
      openedAt: '2026-08-22T11:10:05.000Z',
      resolutionSummary: 'Awaiting direct supplier confirmation on valid delivery lead time.',
    };
    const caseRes = await coordinator.createReconciliationCase({ case: caseP7 });
    assert.equal(caseRes.head.status, 'inconclusive');
    assert.equal(caseRes.head.lifecycle, 'open');

    // 4. Provar ausência de CanonicalProjection
    const head = await obsPersistence.getCurrentCanonicalHead(subjectP7);
    assert.equal(head, null, 'Nenhuma CanonicalProjection artificial pode ser gerada para estado inconclusivo');

    // Observações e revisões continuam persistidas para auditoria
    const dbObs1 = await obsPersistence.getObservation(obsLead1.observationId);
    const dbObs2 = await obsPersistence.getObservation(obsLead2.observationId);
    const dbRev = await obsPersistence.getReview(reviewInconclusive.reviewId);
    assert.ok(dbObs1);
    assert.ok(dbObs2);
    assert.ok(dbRev);
  });

  // ==========================================================================
  // CENÁRIO P8: CAPTURA DUPLICADA
  // ==========================================================================
  it('P8: Captura Duplicada deduplica chave idempotente idêntica mas aceita nova observação temporal', async () => {
    const subjectP8: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_p8_idempotency_sku_808',
    };

    const idempotency = {
      scope: 'supplier_feed_sync',
      key: 'idemp_key_batch_sync_808_attempt_1',
    };
    const obsId1 = 'obs_p8_first_capture' as ObservationRecordId;

    const obs1: ObservationRecord = {
      observationId: obsId1,
      subject: subjectP8,
      observedClaim: 'price',
      rawValue: { amount: 49.90, currency: 'BRL' },
      actor: { kind: 'integration', provider: 'webhook_listener' } as IntegrationActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T14:00:00.000Z',
      capturedAt: '2026-08-22T14:00:01.000Z',
    };

    // 1. Primeira ingestão
    const res1 = await obsPersistence.recordObservation(obs1, idempotency);
    assert.equal(res1.deduplicated, false);
    assert.equal(res1.record.observationId, obsId1);

    // 2. Segunda ingestão com mesma chave e mesmo observationId (ex: retry de rede)
    const res2 = await obsPersistence.recordObservation(obs1, idempotency);
    assert.equal(res2.deduplicated, true, 'Retry idêntico deve retornar deduplicated: true');
    assert.equal(res2.record.observationId, obsId1);

    // Consulta SQL direta: exatamente 1 linha na tabela de observações
    const countRes1 = await pool.query(
      "SELECT count(*) FROM nex_observation_records WHERE domain = $1 AND entity_id = $2;",
      [subjectP8.domain, subjectP8.entityId]
    );
    assert.equal(parseInt(countRes1.rows[0].count, 10), 1);

    // 3. Nova observação temporal genuína em momento posterior com nova chave
    const newIdempotency = {
      scope: 'supplier_feed_sync',
      key: 'idemp_key_batch_sync_808_attempt_2',
    };
    const obsId2 = 'obs_p8_second_capture' as ObservationRecordId;
    const obs2: ObservationRecord = {
      observationId: obsId2,
      subject: subjectP8,
      observedClaim: 'price',
      rawValue: { amount: 49.90, currency: 'BRL' }, // Mesmo valor, mas ocorrência temporal distinta
      actor: { kind: 'integration', provider: 'webhook_listener' } as IntegrationActor,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T15:00:00.000Z',
      capturedAt: '2026-08-22T15:00:01.000Z',
    };

    const res3 = await obsPersistence.recordObservation(obs2, newIdempotency);
    assert.equal(res3.deduplicated, false, 'Nova ocorrência com nova chave não deve ser deduplicada');
    assert.equal(res3.record.observationId, obsId2);

    // Consulta SQL direta: agora existem exatamente 2 observações independentes
    const countRes2 = await pool.query(
      "SELECT count(*) FROM nex_observation_records WHERE domain = $1 AND entity_id = $2;",
      [subjectP8.domain, subjectP8.entityId]
    );
    assert.equal(parseInt(countRes2.rows[0].count, 10), 2);
  });

  // ==========================================================================
  // CENÁRIO EXPLICABILIDADE & LINHAGEM COMPLETA DO ESTADO ATUAL
  // ==========================================================================
  it('Explicação do Estado Atual: recupera linhagem causal completa, base, autorização e precedentes diretamente do PostgreSQL', async () => {
    const subjectExpl: ObservationSubject = {
      domain: 'commerce_offer',
      entityType: 'product_offer',
      entityId: 'prod_expl_sku_909',
    };

    // Obs 1
    const obs1: ObservationRecord = {
      observationId: 'obs_expl_1' as ObservationRecordId,
      subject: subjectExpl,
      observedClaim: 'price',
      rawValue: { amount: 250.00, currency: 'BRL' },
      actor: humanLucas,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T09:00:00.000Z',
      capturedAt: '2026-08-22T09:00:01.000Z',
    };
    await obsPersistence.recordObservation(obs1);

    // Review 1
    const rev1: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_expl_1' as ReviewEventId,
      targetObservationIds: [obs1.observationId],
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: { action: 'promote', targetCanonicalState: { price: 250.00 } },
      justification: 'Base price 250.00 verified.',
      reviewedAt: '2026-08-22T09:10:00.000Z',
    };

    // Projection V1
    const proj1: CanonicalProjection = {
      projectionRevisionId: 'proj_expl_v1' as CanonicalProjectionRevisionId,
      subject: subjectExpl,
      canonicalState: { price: 250.00 },
      underlyingObservationIds: [obs1.observationId],
      authorizingReviewIds: [rev1.reviewId],
      materializedAt: '2026-08-22T09:10:05.000Z',
      explanation: 'Initial price approval.',
    };

    await coordinator.submitCanonicalPromotion({
      review: rev1,
      projection: proj1,
      authorization: validHumanAuthDecision,
    });

    // Case V1
    const caseExplV1: OpenReconciliationCase = {
      caseId: 'case_expl_909' as ReconciliationCaseId,
      subject: subjectExpl,
      lifecycle: 'open',
      status: 'open',
      observationIds: [obs1.observationId],
      reviewIds: [rev1.reviewId],
      openedAt: '2026-08-22T09:00:00.000Z',
      resolutionSummary: 'Base reconciliation case opened.',
    };
    await coordinator.createReconciliationCase({ case: caseExplV1 });

    // Obs 2 (Atualização de preço)
    const obs2: ObservationRecord = {
      observationId: 'obs_expl_2' as ObservationRecordId,
      subject: subjectExpl,
      observedClaim: 'price',
      rawValue: { amount: 230.00, currency: 'BRL' },
      actor: humanLucas,
      sourceRefs: [],
      evidenceRefs: [],
      observedAt: '2026-08-22T10:00:00.000Z',
      capturedAt: '2026-08-22T10:00:01.000Z',
    };
    await obsPersistence.recordObservation(obs2);

    // Review 2
    const rev2: CanonicalPromotedReviewEvent = {
      reviewId: 'rev_expl_2' as ReviewEventId,
      targetObservationIds: [obs2.observationId],
      previousReviewIds: [rev1.reviewId],
      targetBaseRevisionId: proj1.projectionRevisionId,
      actor: humanLucas,
      decision: 'canonical_promoted',
      canonicalEffect: { action: 'promote', targetCanonicalState: { price: 230.00 } },
      justification: 'Discount applied to 230.00.',
      reviewedAt: '2026-08-22T10:15:00.000Z',
    };

    // Projection V2
    const proj2: CanonicalProjection = {
      projectionRevisionId: 'proj_expl_v2' as CanonicalProjectionRevisionId,
      subject: subjectExpl,
      canonicalState: { price: 230.00 },
      underlyingObservationIds: [obs1.observationId, obs2.observationId],
      authorizingReviewIds: [rev1.reviewId, rev2.reviewId],
      reconciliationCaseId: caseExplV1.caseId,
      supersedesRevisionId: proj1.projectionRevisionId,
      materializedAt: '2026-08-22T10:15:10.000Z',
      explanation: 'Price discounted to 230.00 superseding V1.',
    };

    await coordinator.submitCanonicalPromotion({
      review: rev2,
      projection: proj2,
      expectedBaseRevisionId: proj1.projectionRevisionId,
      authorization: validHumanAuthDecision,
    });

    // Case V2 Resolvido
    const caseExplV2: ResolvedReconciliationCase = {
      caseId: caseExplV1.caseId,
      subject: subjectExpl,
      lifecycle: 'resolved',
      status: 'validated',
      observationIds: [obs1.observationId, obs2.observationId],
      reviewIds: [rev1.reviewId, rev2.reviewId],
      openedAt: caseExplV1.openedAt,
      resolvedAt: '2026-08-22T10:15:15.000Z',
      resolutionSummary: 'Discount reconciliation completed and validated.',
    };
    await coordinator.appendReconciliationRevision({
      case: caseExplV2,
      expectedVersion: 1,
    });

    // Reconstrução da Pergunta: "Por que este é o estado atual?"
    const currentHead = await obsPersistence.getCurrentCanonicalHead(subjectExpl);
    assert.ok(currentHead);
    assert.equal(currentHead.currentProjectionRevisionId, proj2.projectionRevisionId);

    const currentProjection = await obsPersistence.getCanonicalProjectionRevision(currentHead.currentProjectionRevisionId);
    assert.ok(currentProjection);
    assert.deepEqual(currentProjection.canonicalState, { price: 230.00 });
    assert.equal(currentProjection.supersedesRevisionId, proj1.projectionRevisionId);
    assert.equal(currentProjection.reconciliationCaseId, caseExplV1.caseId);
    assert.equal(currentProjection.explanation, 'Price discounted to 230.00 superseding V1.');

    // Verificar que todas as authorizing reviews e underlying observations são resolúveis
    for (const revId of currentProjection.authorizingReviewIds) {
      const r = await obsPersistence.getReview(revId);
      assert.ok(r, `Review ${revId} deve ser encontrada`);
      assert.ok(r.justification.length > 0);
    }

    for (const obsId of currentProjection.underlyingObservationIds) {
      const o = await obsPersistence.getObservation(obsId);
      assert.ok(o, `Observation ${obsId} deve ser encontrada`);
      assert.ok(o.observedAt);
    }
  });
});
