/**
 * NEX+ · Testes de Integração da Camada de Reconciliação, Precedentes & Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D · Checkpoint 1)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type {
  ObservationRecord,
  ObservationRecordId,
  ObservationSubject,
  ReviewEvent,
  ReviewEventId,
  NonCanonicalReviewEvent,
  CanonicalPromotedReviewEvent,
  CanonicalProjection,
  CanonicalProjectionRevisionId,
  ReconciliationCase,
  ReconciliationCaseId,
  OpenReconciliationCase,
  ResolvedReconciliationCase,
  ContextualPrecedent,
  ContextualPrecedentRefId,
  HumanActor,
  MaxActor,
} from '../../contracts';
import { PgObservationPersistenceAdapter } from '../../persistence/postgres';
import { PgReconciliationPersistenceAdapter } from '../postgres';
import { ReconciliationCoordinator } from '../coordinator';
import {
  ReconciliationCaseConflictError,
  StaleReconciliationVersionConflictError,
  ReconciliationCaseCoherenceError,
  ContextualPrecedentConflictError,
  ContextualPrecedentInvalidReviewError,
  CanonicalPromotionAuthorityError,
} from '../errors';
import type { HumanAuthorizationDecision } from '../../../policy/contracts';

const databaseUrl = process.env.DATABASE_URL;

describe('Escopo 0.85D · Reconciliação Persistente, Precedente Contextual & Gates de Autoridade', { skip: !databaseUrl }, () => {
  let pool: Pool;
  let obsPersistence: PgObservationPersistenceAdapter;
  let recPersistence: PgReconciliationPersistenceAdapter;
  let coordinator: ReconciliationCoordinator;

  const testSubject: ObservationSubject = {
    domain: 'supplier_product',
    entityType: 'product',
    entityId: 'prod_test_085d_100',
  };

  const humanLucas: HumanActor = {
    kind: 'human',
    humanId: 'user_lucas_master',
    role: 'admin_dev',
    authorityRef: 'AUTH_NEX_085D_DEV',
  };

  const maxAgent: MaxActor = {
    kind: 'max',
    maxVersion: 'MAX_3.0_LOCAL',
  };

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    obsPersistence = new PgObservationPersistenceAdapter(pool);
    recPersistence = new PgReconciliationPersistenceAdapter(pool);
    coordinator = new ReconciliationCoordinator(obsPersistence, recPersistence);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  describe('1. ReconciliationCase Persistência & Heads Monotônicas', () => {
    it('D1-1: create case registra versão 1 e materializa head operacional atual', async () => {
      const caseId = `case_d1_1_${Date.now()}` as ReconciliationCaseId;

      // 1. Cria uma observação prévia
      const obsId = `obs_d1_1_${Date.now()}` as ObservationRecordId;
      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Price observation 150',
        rawValue: { price: 150.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const initialCase: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
        resolutionSummary: 'Initial ingestion divergence detected',
      };

      const result = await recPersistence.createReconciliationCase({ case: initialCase });

      assert.equal(result.case.caseId, caseId);
      assert.equal(result.head.currentVersion, 1);
      assert.equal(result.head.lifecycle, 'open');
      assert.equal(result.head.status, 'open');

      const fetchedCase = await recPersistence.getCurrentReconciliationCase(caseId);
      assert.ok(fetchedCase);
      assert.equal(fetchedCase.caseId, caseId);
      assert.equal(fetchedCase.lifecycle, 'open');
      assert.equal(fetchedCase.status, 'open');

      const fetchedHead = await recPersistence.getCurrentReconciliationHead(caseId);
      assert.ok(fetchedHead);
      assert.equal(fetchedHead.currentVersion, 1);

      // Idempotência estrita: chamada idêntica retorna o existente sem criar versão 2
      const idempResult = await recPersistence.createReconciliationCase({ case: initialCase });
      assert.equal(idempResult.head.currentVersion, 1);
    });

    it('D1-2: append revision preserva versão anterior no histórico append-only', async () => {
      const caseId = `case_d1_2_${Date.now()}` as ReconciliationCaseId;
      const obsId1 = `obs_d1_2_a_${Date.now()}` as ObservationRecordId;
      const obsId2 = `obs_d1_2_b_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId1,
        subject: testSubject,
        observedClaim: 'Feed A price 100',
        rawValue: { price: 100.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordObservation({
        observationId: obsId2,
        subject: testSubject,
        observedClaim: 'Feed B price 110',
        rawValue: { price: 110.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:05:00.000Z',
        observedAt: '2026-08-21T23:05:00.000Z',
      });

      // Versão 1: open / awaiting_evidence
      const v1Case: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId1],
        reviewIds: [],
        lifecycle: 'open',
        status: 'awaiting_evidence',
        openedAt: '2026-08-21T23:00:00.000Z',
      };
      await recPersistence.createReconciliationCase({ case: v1Case });

      // Versão 2: open / divergent com obsId2 adicionada
      const v2Case: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId1, obsId2],
        reviewIds: [],
        lifecycle: 'open',
        status: 'divergent',
        openedAt: '2026-08-21T23:00:00.000Z',
        resolutionSummary: 'Added conflicting observation from Feed B',
      };
      const v2Result = await recPersistence.appendReconciliationRevision({
        case: v2Case,
        expectedVersion: 1,
      });

      assert.equal(v2Result.head.currentVersion, 2);
      assert.equal(v2Result.head.status, 'divergent');

      // Versão 3: resolved / validated
      const v3Case: ResolvedReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId1, obsId2],
        reviewIds: [],
        lifecycle: 'resolved',
        status: 'validated',
        openedAt: '2026-08-21T23:00:00.000Z',
        resolvedAt: '2026-08-21T23:10:00.000Z',
        resolutionSummary: 'Validated by human review: Feed B was a delayed promotional rate',
      };
      const v3Result = await recPersistence.appendReconciliationRevision({
        case: v3Case,
        expectedVersion: 2,
      });

      assert.equal(v3Result.head.currentVersion, 3);
      assert.equal(v3Result.head.lifecycle, 'resolved');
      assert.equal(v3Result.head.status, 'validated');

      // Prova que o histórico completo contém todas as 3 versões intactas
      const history = await recPersistence.listReconciliationHistory(caseId);
      assert.equal(history.length, 3);
      assert.equal(history[0].status, 'awaiting_evidence');
      assert.equal(history[1].status, 'divergent');
      assert.equal(history[2].status, 'validated');
      assert.equal(history[2].lifecycle, 'resolved');
    });

    it('D1-3: expectedVersion obsoleta gera StaleReconciliationVersionConflictError', async () => {
      const caseId = `case_d1_3_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_d1_3_${Date.now()}` as ObservationRecordId;

      const v1Case: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };
      await recPersistence.createReconciliationCase({ case: v1Case });

      // Avança para versão 2
      const v2Case: OpenReconciliationCase = {
        ...v1Case,
        status: 'awaiting_evidence',
      };
      await recPersistence.appendReconciliationRevision({
        case: v2Case,
        expectedVersion: 1,
      });

      // Tentativa de append informando expectedVersion = 1 (stale) deve falhar
      const staleCase: OpenReconciliationCase = {
        ...v1Case,
        status: 'divergent',
      };

      await assert.rejects(
        async () => {
          await recPersistence.appendReconciliationRevision({
            case: staleCase,
            expectedVersion: 1, // Stale! Versão atual é 2
          });
        },
        (err: any) => {
          assert.ok(err instanceof StaleReconciliationVersionConflictError);
          assert.equal(err.expectedVersion, 1);
          assert.equal(err.actualVersion, 2);
          return true;
        }
      );
    });

    it('D1-12: histórico do case reconstrói deterministamente o estado da head atual', async () => {
      const caseId = `case_d1_12_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_d1_12_${Date.now()}` as ObservationRecordId;

      const v1Case: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };
      await recPersistence.createReconciliationCase({ case: v1Case });

      const v2Case: OpenReconciliationCase = {
        ...v1Case,
        status: 'divergent',
        resolutionSummary: 'Divergence identified',
      };
      await recPersistence.appendReconciliationRevision({ case: v2Case, expectedVersion: 1 });

      const v3Case: ResolvedReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId],
        reviewIds: [],
        lifecycle: 'resolved',
        status: 'inconclusive',
        openedAt: '2026-08-21T23:00:00.000Z',
        resolvedAt: '2026-08-21T23:30:00.000Z',
        resolutionSummary: 'Closed as inconclusive after timeout',
      };
      await recPersistence.appendReconciliationRevision({ case: v3Case, expectedVersion: 2 });

      const history = await recPersistence.listReconciliationHistory(caseId);
      const head = await recPersistence.getCurrentReconciliationHead(caseId);

      assert.ok(head);
      assert.equal(history.length, head.currentVersion);
      assert.equal(history[history.length - 1].lifecycle, head.lifecycle);
      assert.equal(history[history.length - 1].status, head.status);
    });
  });

  describe('2. Gates de Autoridade: MAX vs Humano em Revisões & Promoção Canônica', () => {
    it('D1-4: MAX divergent não altera canonical head e ambas as observações coexistem', async () => {
      const now = Date.now();
      const obsId1 = `obs_d1_4_a_${now}` as ObservationRecordId;
      const obsId2 = `obs_d1_4_b_${now}` as ObservationRecordId;
      const revId = `rev_d1_4_max_${now}` as ReviewEventId;

      await obsPersistence.recordObservation({
        observationId: obsId1,
        subject: testSubject,
        observedClaim: 'Site A price 200',
        rawValue: { price: 200.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordObservation({
        observationId: obsId2,
        subject: testSubject,
        observedClaim: 'Site B price 250',
        rawValue: { price: 250.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:02:00.000Z',
        observedAt: '2026-08-21T23:02:00.000Z',
      });

      // MAX registra uma revisão de divergência
      const maxReview: NonCanonicalReviewEvent = {
        reviewId: revId,
        actor: maxAgent,
        targetObservationIds: [obsId1, obsId2],
        decision: 'divergent',
        justification: 'Price discrepancy detected between Site A ($200) and Site B ($250)',
        reviewedAt: '2026-08-21T23:05:00.000Z',
      };

      const recordedRev = await coordinator.submitReview(maxReview);
      assert.equal(recordedRev.reviewId, revId);

      // Abre o ReconciliationCase
      const caseId = `case_d1_4_${now}` as ReconciliationCaseId;
      await coordinator.createReconciliationCase({
        case: {
          caseId,
          subject: testSubject,
          observationIds: [obsId1, obsId2],
          reviewIds: [revId],
          lifecycle: 'open',
          status: 'divergent',
          openedAt: '2026-08-21T23:05:00.000Z',
        },
      });

      // Prova que ambas as observações continuam existindo
      const obsList = await obsPersistence.listObservationsBySubject(testSubject);
      assert.ok(obsList.some((o) => o.observationId === obsId1));
      assert.ok(obsList.some((o) => o.observationId === obsId2));

      // Prova que a head canônica NÃO foi alterada ou criada automaticamente
      const currentHead = await obsPersistence.getCurrentCanonicalHead(testSubject);
      assert.equal(currentHead, null);
    });

    it('D1-5: MAX tentando canonical promotion é bloqueado runtime antes de qualquer escrita', async () => {
      const now = Date.now();
      const obsId = `obs_d1_5_${now}` as ObservationRecordId;
      const revId = `rev_d1_5_max_${now}` as ReviewEventId;
      const projId = `proj_d1_5_${now}` as CanonicalProjectionRevisionId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Internal price 300',
        rawValue: { price: 300.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      // Objeto malicioso forjando promoção com ator MAX
      const forgedReview: any = {
        reviewId: revId,
        actor: maxAgent, // MAX tentando promover!
        targetObservationIds: [obsId],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { verifiedPrice: 300.0 },
        },
        justification: 'MAX trying to auto-promote without human authority',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const forgedProjection: CanonicalProjection = {
        projectionRevisionId: projId,
        subject: testSubject,
        canonicalState: { verifiedPrice: 300.0 },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [revId],
        materializedAt: '2026-08-21T23:00:00.000Z',
        explanation: 'Forged canonical projection',
      };

      const dummyAuth: HumanAuthorizationDecision = {
        actorRef: 'user_lucas_master',
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      // 1. Rejeitado pelo submitReview
      await assert.rejects(
        async () => {
          await coordinator.submitReview(forgedReview);
        },
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          return true;
        }
      );

      // 2. Rejeitado pelo submitCanonicalPromotion
      await assert.rejects(
        async () => {
          await coordinator.submitCanonicalPromotion({
            review: forgedReview,
            projection: forgedProjection,
            authorization: dummyAuth,
          });
        },
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'UNAUTHORIZED_ACTOR_KIND');
          return true;
        }
      );

      // Prova que NENHUMA linha foi gravada no PostgreSQL
      const revCheck = await obsPersistence.getReview(revId);
      assert.equal(revCheck, null);

      const projCheck = await obsPersistence.getCanonicalProjectionRevision(projId);
      assert.equal(projCheck, null);

      const headCheck = await obsPersistence.getCurrentCanonicalHead(testSubject);
      assert.equal(headCheck, null);
    });

    it('D1-6: human canonical promotion sem autorização ou com verdict denied é bloqueada fail-closed', async () => {
      const now = Date.now();
      const obsId = `obs_d1_6_${now}` as ObservationRecordId;
      const revId = `rev_d1_6_${now}` as ReviewEventId;
      const projId = `proj_d1_6_${now}` as CanonicalProjectionRevisionId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Manual price 500',
        rawValue: { price: 500.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const humanReview: CanonicalPromotedReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { verifiedPrice: 500.0 },
        },
        justification: 'Human review valid',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const projection: CanonicalProjection = {
        projectionRevisionId: projId,
        subject: testSubject,
        canonicalState: { verifiedPrice: 500.0 },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [revId],
        materializedAt: '2026-08-21T23:00:00.000Z',
        explanation: 'Canonical projection with denied auth',
      };

      // Sem autorização
      await assert.rejects(
        async () => {
          await coordinator.submitCanonicalPromotion({
            review: humanReview,
            projection,
            authorization: undefined as any,
          });
        },
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'MISSING_AUTHORIZATION');
          return true;
        }
      );

      // Com autorização denied
      const deniedAuth: HumanAuthorizationDecision = {
        actorRef: humanLucas.humanId,
        operation: 'canonical_promotion',
        verdict: 'denied',
        reasonCode: 'INSUFFICIENT_PRIVILEGE',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await coordinator.submitCanonicalPromotion({
            review: humanReview,
            projection,
            authorization: deniedAuth,
          });
        },
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'AUTHORIZATION_DENIED');
          return true;
        }
      );

      // Prova que nada foi gravado
      const revCheck = await obsPersistence.getReview(revId);
      assert.equal(revCheck, null);
    });

    it('D1-7: human canonical promotion com authorization authorized executa atômico no PostgreSQL', async () => {
      const now = Date.now();
      const obsId = `obs_d1_7_${now}` as ObservationRecordId;
      const revId = `rev_d1_7_${now}` as ReviewEventId;
      const projId = `proj_d1_7_${now}` as CanonicalProjectionRevisionId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Invoice price 420',
        rawValue: { price: 420.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const humanReview: CanonicalPromotedReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 420.0 },
        },
        justification: 'Approved based on certified supplier invoice',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const projection: CanonicalProjection = {
        projectionRevisionId: projId,
        subject: testSubject,
        canonicalState: { price: 420.0 },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [revId],
        materializedAt: '2026-08-21T23:00:00.000Z',
        explanation: 'Certified price promotion',
      };

      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanLucas.humanId,
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'MASTER_DEV_OVERRIDE',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      const result = await coordinator.submitCanonicalPromotion({
        review: humanReview,
        projection,
        authorization: validAuth,
      });

      assert.equal(result.review.reviewId, revId);
      assert.equal(result.projection.projectionRevisionId, projId);
      assert.equal(result.head.currentProjectionRevisionId, projId);
      assert.equal(result.head.version, BigInt(1));

      const currentProj = await obsPersistence.getCurrentCanonicalProjection(testSubject);
      assert.ok(currentProj);
      assert.equal(currentProj.projectionRevisionId, projId);
      assert.deepEqual(currentProj.canonicalState, { price: 420.0 });
    });
  });

  describe('3. ContextualPrecedent & Segregação de Policy', () => {
    it('D1-8: precedent explícito a partir de review humana persiste com integridade e pode ser recuperado', async () => {
      const now = Date.now();
      const obsId = `obs_d1_8_${now}` as ObservationRecordId;
      const revId = `rev_d1_8_${now}` as ReviewEventId;
      const precId = `prec_d1_8_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Web price 80',
        rawValue: { price: 80.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      // Humano registra uma revisão não-canônica (ou canônica)
      const humanRev: NonCanonicalReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'corroborated',
        justification: 'Price of $80 is valid exclusively for batch purchases over 100 units',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };
      await obsPersistence.recordNonCanonicalReview(humanRev);

      const precedent: ContextualPrecedent = {
        precedentId: precId,
        reviewEventId: revId,
        contextSummary: 'Wholesale tier pricing exemption rule',
        applicabilityConditions: ['quantity >= 100', 'payment_terms == 30_days'],
        policyProposalRef: 'PROP_POLICY_2026_TIER_PRICING',
      };

      const recorded = await coordinator.createContextualPrecedent({ precedent });
      assert.equal(recorded.precedentId, precId);

      const fetched = await recPersistence.getContextualPrecedent(precId);
      assert.ok(fetched);
      assert.equal(fetched.precedentId, precId);
      assert.equal(fetched.reviewEventId, revId);
      assert.deepEqual(fetched.applicabilityConditions, ['quantity >= 100', 'payment_terms == 30_days']);
    });

    it('D1-9: criação de precedente NÃO cria nem altera PolicyRevision (Precedente != Policy)', async () => {
      const now = Date.now();
      const obsId = `obs_d1_9_${now}` as ObservationRecordId;
      const revId = `rev_d1_9_${now}` as ReviewEventId;
      const precId = `prec_d1_9_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'API price 90',
        rawValue: { price: 90.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const humanRev: NonCanonicalReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'corroborated',
        justification: 'Special vendor agreement',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };
      await obsPersistence.recordNonCanonicalReview(humanRev);

      const precedent: ContextualPrecedent = {
        precedentId: precId,
        reviewEventId: revId,
        contextSummary: 'Vendor agreement context',
        applicabilityConditions: ['supplier == sup_alpha'],
        policyProposalRef: 'PROP_POLICY_SUP_ALPHA',
      };

      await coordinator.createContextualPrecedent({ precedent });

      // Prova que a proposta de policy não virou policy ativa e nenhuma tabela de policy foi criada/mutada
      const fetched = await recPersistence.getContextualPrecedent(precId);
      assert.ok(fetched);
      assert.equal(fetched.policyProposalRef, 'PROP_POLICY_SUP_ALPHA');
    });

    it('D1-10: tentativa de criar precedente a partir de review de MAX/System é rejeitada', async () => {
      const now = Date.now();
      const obsId = `obs_d1_10_${now}` as ObservationRecordId;
      const revId = `rev_d1_10_max_${now}` as ReviewEventId;
      const precId = `prec_d1_10_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Web price 95',
        rawValue: { price: 95.0 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const maxRev: NonCanonicalReviewEvent = {
        reviewId: revId,
        actor: maxAgent, // MAX actor!
        targetObservationIds: [obsId],
        decision: 'divergent',
        justification: 'Automated discrepancy note',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };
      await obsPersistence.recordNonCanonicalReview(maxRev);

      const precedent: ContextualPrecedent = {
        precedentId: precId,
        reviewEventId: revId,
        contextSummary: 'Attempted precedent from MAX',
        applicabilityConditions: ['condition == true'],
      };

      await assert.rejects(
        async () => {
          await coordinator.createContextualPrecedent({ precedent });
        },
        (err: any) => {
          assert.ok(err instanceof ContextualPrecedentInvalidReviewError);
          return true;
        }
      );

      const check = await recPersistence.getContextualPrecedent(precId);
      assert.equal(check, null);
    });

    it('D1-11: case inconclusivo permanece sem canonical head inventada', async () => {
      const now = Date.now();
      const caseId = `case_d1_11_${now}` as ReconciliationCaseId;
      const obsId = `obs_d1_11_${now}` as ObservationRecordId;
      const revId = `rev_d1_11_${now}` as ReviewEventId;

      const unverifiedSubject: ObservationSubject = {
        domain: 'supplier_product',
        entityType: 'product',
        entityId: `prod_inconclusive_${now}`,
      };

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: unverifiedSubject,
        observedClaim: 'Ambiguous claim',
        rawValue: { rawNote: 'Ambiguous payload' },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const maxRev: NonCanonicalReviewEvent = {
        reviewId: revId,
        actor: maxAgent,
        targetObservationIds: [obsId],
        decision: 'inconclusive',
        justification: 'Evidence is insufficient and conflicting. Cannot determine authentic state.',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };
      await obsPersistence.recordNonCanonicalReview(maxRev);

      await coordinator.createReconciliationCase({
        case: {
          caseId,
          subject: unverifiedSubject,
          observationIds: [obsId],
          reviewIds: [revId],
          lifecycle: 'resolved',
          status: 'inconclusive',
          openedAt: '2026-08-21T23:00:00.000Z',
          resolvedAt: '2026-08-21T23:15:00.000Z',
          resolutionSummary: 'Closed as inconclusive without guessing state',
        },
      });

      // Prova que nenhuma Projeção Canônica foi inventada para o subject
      const head = await obsPersistence.getCurrentCanonicalHead(unverifiedSubject);
      assert.equal(head, null);

      const proj = await obsPersistence.getCurrentCanonicalProjection(unverifiedSubject);
      assert.equal(proj, null);
    });
  });

  describe('4. Proteção Estrutural Append-Only no PostgreSQL (Triggers de Rejeição)', () => {
    it('SQL direto UPDATE em nex_reconciliation_case_revisions é rejeitado pelo trigger', async () => {
      const caseId = `case_trg_test_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_trg_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Trigger observation',
        rawValue: { price: 100 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await recPersistence.createReconciliationCase({
        case: {
          caseId,
          subject: testSubject,
          observationIds: [obsId],
          reviewIds: [],
          lifecycle: 'open',
          status: 'open',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
      });

      await assert.rejects(
        async () => {
          await pool.query(
            `UPDATE nex_reconciliation_case_revisions SET status = 'reclassified' WHERE case_id = $1`,
            [caseId]
          );
        },
        (err: any) => {
          assert.match(err.message, /NEX_PERSISTENCE_APPEND_ONLY_VIOLATION/);
          return true;
        }
      );
    });

    it('SQL direto DELETE em nex_contextual_precedents é rejeitado pelo trigger', async () => {
      const now = Date.now();
      const obsId = `obs_prec_trg_${now}` as ObservationRecordId;
      const revId = `rev_prec_trg_${now}` as ReviewEventId;
      const precId = `prec_trg_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Trigger observation',
        rawValue: { value: 10 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordNonCanonicalReview({
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'corroborated',
        justification: 'Valid trigger test review',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      await recPersistence.recordContextualPrecedent({
        precedentId: precId,
        reviewEventId: revId,
        contextSummary: 'Trigger protection test',
        applicabilityConditions: ['test == 1'],
      });

      await assert.rejects(
        async () => {
          await pool.query(`DELETE FROM nex_contextual_precedents WHERE precedent_id = $1`, [precId]);
        },
        (err: any) => {
          assert.match(err.message, /NEX_PERSISTENCE_APPEND_ONLY_VIOLATION/);
          return true;
        }
      );
    });
  });
});
