/**
 * NEX+ · Testes de Integração da Camada de Reconciliação, Precedentes & Gates de Autoridade
 * Escopo 0.85 (Bloco 0.85D · Micro-Hardening A)
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
  CanonicalReclassifiedReviewEvent,
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
  SystemActor,
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

describe('Escopo 0.85D · Reconciliação Persistente, Precedente Contextual & Gates de Autoridade (Micro-Hardening A)', { skip: !databaseUrl }, () => {
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

  const systemAgent: SystemActor = {
    kind: 'system',
    component: 'test_runner',
  };

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    obsPersistence = new PgObservationPersistenceAdapter(pool);
    recPersistence = new PgReconciliationPersistenceAdapter(pool, obsPersistence);
    coordinator = new ReconciliationCoordinator(obsPersistence, recPersistence);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  describe('1. Coerência de Referências no Persistence Boundary (A1..A4, AF-1, AF-2)', () => {
    it('A1: observation inexistente é rejeitada antes de qualquer write', async () => {
      const caseId = `case_a1_${Date.now()}` as ReconciliationCaseId;
      const nonExistentObsId = `obs_non_existent_${Date.now()}` as ObservationRecordId;

      const caseObj: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [nonExistentObsId],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: caseObj });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'OBSERVATION_NOT_FOUND');
          return true;
        }
      );
    });

    it('A2: review inexistente é rejeitada antes de qualquer write', async () => {
      const caseId = `case_a2_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_a2_${Date.now()}` as ObservationRecordId;
      const nonExistentRevId = `rev_non_existent_${Date.now()}` as ReviewEventId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Claim A2',
        rawValue: { price: 10 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const caseObj: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId],
        reviewIds: [nonExistentRevId],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: caseObj });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'REVIEW_NOT_FOUND');
          return true;
        }
      );
    });

    it('A3: observation pertencente a outro subject é rejeitada', async () => {
      const caseId = `case_a3_${Date.now()}` as ReconciliationCaseId;
      const obsIdOther = `obs_a3_other_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsIdOther,
        subject: { domain: 'other_domain', entityType: 'product', entityId: 'prod_999' },
        observedClaim: 'Claim other domain',
        rawValue: { price: 10 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const caseObj: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsIdOther],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: caseObj });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'CROSS_SUBJECT_OBSERVATION_MISMATCH');
          return true;
        }
      );
    });

    it('AF-1: case [A] com review targetando B do mesmo subject é rejeitado fail-closed e deixa zero registro', async () => {
      const caseId = `case_af1_${Date.now()}` as ReconciliationCaseId;
      const obsIdA = `obs_af1_a_${Date.now()}` as ObservationRecordId;
      const obsIdB = `obs_af1_b_${Date.now()}` as ObservationRecordId;
      const revIdTargetsB = `rev_af1_b_${Date.now()}` as ReviewEventId;

      await obsPersistence.recordObservation({
        observationId: obsIdA,
        subject: testSubject,
        observedClaim: 'Obs A',
        rawValue: { price: 10 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordObservation({
        observationId: obsIdB,
        subject: testSubject,
        observedClaim: 'Obs B',
        rawValue: { price: 20 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordNonCanonicalReview({
        reviewId: revIdTargetsB,
        actor: humanLucas,
        targetObservationIds: [obsIdB],
        decision: 'divergent',
        justification: 'Comparison with B',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      const caseObj: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsIdA], // Contém apenas A, NÃO contém B!
        reviewIds: [revIdTargetsB],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: caseObj });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'REVIEW_OBSERVATION_NOT_IN_CASE');
          return true;
        }
      );

      // Prova que zero revision e zero head foram persistidos
      const headCheck = await pool.query(`SELECT * FROM nex_reconciliation_case_heads WHERE case_id = $1`, [caseId]);
      assert.equal(headCheck.rows.length, 0);

      const revCheck = await pool.query(`SELECT * FROM nex_reconciliation_case_revisions WHERE case_id = $1`, [caseId]);
      assert.equal(revCheck.rows.length, 0);
    });

    it('AF-2: case [A] com review targetando A é aceito normalmente', async () => {
      const caseId = `case_af2_${Date.now()}` as ReconciliationCaseId;
      const obsIdA = `obs_af2_a_${Date.now()}` as ObservationRecordId;
      const revIdTargetsA = `rev_af2_a_${Date.now()}` as ReviewEventId;

      await obsPersistence.recordObservation({
        observationId: obsIdA,
        subject: testSubject,
        observedClaim: 'Obs A',
        rawValue: { price: 10 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordNonCanonicalReview({
        reviewId: revIdTargetsA,
        actor: humanLucas,
        targetObservationIds: [obsIdA],
        decision: 'corroborated',
        justification: 'Approved obs A',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      const caseObj: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsIdA],
        reviewIds: [revIdTargetsA],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      const result = await recPersistence.createReconciliationCase({ case: caseObj });
      assert.equal(result.case.caseId, caseId);
      assert.equal(result.head.currentVersion, 1);
    });

    it('AF-3: create com observationIds [A, A] é rejeitado e deixa zero registro', async () => {
      const caseId = `case_af3_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_af3_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs AF3',
        rawValue: {},
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const duplicateCase: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId, obsId], // Duplicata!
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: duplicateCase });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'DUPLICATE_OBSERVATION_REFERENCES');
          return true;
        }
      );

      const headCheck = await pool.query(`SELECT * FROM nex_reconciliation_case_heads WHERE case_id = $1`, [caseId]);
      assert.equal(headCheck.rows.length, 0);

      const revCheck = await pool.query(`SELECT * FROM nex_reconciliation_case_revisions WHERE case_id = $1`, [caseId]);
      assert.equal(revCheck.rows.length, 0);
    });

    it('AF-4: create com reviewIds [R, R] é rejeitado e deixa zero registro', async () => {
      const caseId = `case_af4_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_af4_${Date.now()}` as ObservationRecordId;
      const revId = `rev_af4_${Date.now()}` as ReviewEventId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs AF4',
        rawValue: {},
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
        decision: 'divergent',
        justification: 'Divergent review',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      const duplicateCase: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId],
        reviewIds: [revId, revId], // Duplicata!
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: duplicateCase });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'DUPLICATE_REVIEW_REFERENCES');
          return true;
        }
      );

      const headCheck = await pool.query(`SELECT * FROM nex_reconciliation_case_heads WHERE case_id = $1`, [caseId]);
      assert.equal(headCheck.rows.length, 0);

      const revCheck = await pool.query(`SELECT * FROM nex_reconciliation_case_revisions WHERE case_id = $1`, [caseId]);
      assert.equal(revCheck.rows.length, 0);
    });
  });

  describe('2. Continuidade, Imutabilidade e Regras de Lifecycle (A5..A9, A13)', () => {
    it('A5: subject não pode mudar no append', async () => {
      const caseId = `case_a5_${Date.now()}` as ReconciliationCaseId;
      const obsId1 = `obs_a5_1_${Date.now()}` as ObservationRecordId;
      const obsId2 = `obs_a5_2_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId1,
        subject: testSubject,
        observedClaim: 'Claim 1',
        rawValue: {},
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordObservation({
        observationId: obsId2,
        subject: { domain: 'mutated_domain', entityType: 'product', entityId: 'prod_test_085d_100' },
        observedClaim: 'Claim 2',
        rawValue: {},
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
          observationIds: [obsId1],
          reviewIds: [],
          lifecycle: 'open',
          status: 'open',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
      });

      await assert.rejects(
        async () => {
          await recPersistence.appendReconciliationRevision({
            case: {
              caseId,
              subject: { domain: 'mutated_domain', entityType: 'product', entityId: 'prod_test_085d_100' },
              observationIds: [obsId1, obsId2],
              reviewIds: [],
              lifecycle: 'open',
              status: 'awaiting_evidence',
              openedAt: '2026-08-21T23:00:00.000Z',
            },
            expectedVersion: 1,
          });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.ok(
            err.code === 'MUTATION_SUBJECT_PROHIBITED' ||
            err.code === 'CROSS_SUBJECT_OBSERVATION_MISMATCH'
          );
          return true;
        }
      );
    });

    it('A6: openedAt não pode mudar no append', async () => {
      const caseId = `case_a6_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_a6_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Claim A6',
        rawValue: {},
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
          await recPersistence.appendReconciliationRevision({
            case: {
              caseId,
              subject: testSubject,
              observationIds: [obsId],
              reviewIds: [],
              lifecycle: 'open',
              status: 'awaiting_evidence',
              openedAt: '2026-08-21T23:59:59.000Z', // Mutated!
            },
            expectedVersion: 1,
          });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'MUTATION_OPENED_AT_PROHIBITED');
          return true;
        }
      );
    });

    it('A7: observation histórica não pode ser removida no append', async () => {
      const caseId = `case_a7_${Date.now()}` as ReconciliationCaseId;
      const obsId1 = `obs_a7_1_${Date.now()}` as ObservationRecordId;
      const obsId2 = `obs_a7_2_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId1,
        subject: testSubject,
        observedClaim: 'Obs 1',
        rawValue: {},
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordObservation({
        observationId: obsId2,
        subject: testSubject,
        observedClaim: 'Obs 2',
        rawValue: {},
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
          observationIds: [obsId1, obsId2],
          reviewIds: [],
          lifecycle: 'open',
          status: 'open',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
      });

      // Tentativa de remover obsId1
      await assert.rejects(
        async () => {
          await recPersistence.appendReconciliationRevision({
            case: {
              caseId,
              subject: testSubject,
              observationIds: [obsId2], // obsId1 removida!
              reviewIds: [],
              lifecycle: 'open',
              status: 'awaiting_evidence',
              openedAt: '2026-08-21T23:00:00.000Z',
            },
            expectedVersion: 1,
          });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'HISTORICAL_OBSERVATIONS_CANNOT_BE_REMOVED');
          return true;
        }
      );
    });

    it('A8: review histórica não pode ser removida no append', async () => {
      const caseId = `case_a8_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_a8_${Date.now()}` as ObservationRecordId;
      const revId = `rev_a8_${Date.now()}` as ReviewEventId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs',
        rawValue: {},
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
        decision: 'divergent',
        justification: 'Divergent note',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      await recPersistence.createReconciliationCase({
        case: {
          caseId,
          subject: testSubject,
          observationIds: [obsId],
          reviewIds: [revId],
          lifecycle: 'open',
          status: 'divergent',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
      });

      // Tentativa de remover revId
      await assert.rejects(
        async () => {
          await recPersistence.appendReconciliationRevision({
            case: {
              caseId,
              subject: testSubject,
              observationIds: [obsId],
              reviewIds: [], // revId removida!
              lifecycle: 'open',
              status: 'awaiting_evidence',
              openedAt: '2026-08-21T23:00:00.000Z',
            },
            expectedVersion: 1,
          });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'HISTORICAL_REVIEWS_CANNOT_BE_REMOVED');
          return true;
        }
      );
    });

    it('A9: transição de resolved para open é rejeitada (resolved não reabre)', async () => {
      const caseId = `case_a9_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_a9_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs',
        rawValue: {},
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
          lifecycle: 'resolved',
          status: 'validated',
          openedAt: '2026-08-21T23:00:00.000Z',
          resolvedAt: '2026-08-21T23:10:00.000Z',
          resolutionSummary: 'Validated completely',
        },
      });

      // Tentativa de reabrir
      await assert.rejects(
        async () => {
          await recPersistence.appendReconciliationRevision({
            case: {
              caseId,
              subject: testSubject,
              observationIds: [obsId],
              reviewIds: [],
              lifecycle: 'open',
              status: 'divergent',
              openedAt: '2026-08-21T23:00:00.000Z',
            },
            expectedVersion: 1,
          });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseCoherenceError);
          assert.equal(err.code, 'RESOLVED_CASE_CANNOT_BE_REOPENED');
          return true;
        }
      );
    });

    it('A13: create idempotente após evolução para v2 não retorna combinação contraditória e lança conflito', async () => {
      const caseId = `case_a13_${Date.now()}` as ReconciliationCaseId;
      const obsId1 = `obs_a13_1_${Date.now()}` as ObservationRecordId;
      const obsId2 = `obs_a13_2_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId1,
        subject: testSubject,
        observedClaim: 'Obs 1',
        rawValue: {},
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordObservation({
        observationId: obsId2,
        subject: testSubject,
        observedClaim: 'Obs 2',
        rawValue: {},
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const initialCase: OpenReconciliationCase = {
        caseId,
        subject: testSubject,
        observationIds: [obsId1],
        reviewIds: [],
        lifecycle: 'open',
        status: 'open',
        openedAt: '2026-08-21T23:00:00.000Z',
      };

      await recPersistence.createReconciliationCase({ case: initialCase });

      // Evolui para v2
      await recPersistence.appendReconciliationRevision({
        case: {
          caseId,
          subject: testSubject,
          observationIds: [obsId1, obsId2],
          reviewIds: [],
          lifecycle: 'open',
          status: 'divergent',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
        expectedVersion: 1,
      });

      // Tenta chamar createReconciliationCase com initialCase novamente
      await assert.rejects(
        async () => {
          await recPersistence.createReconciliationCase({ case: initialCase });
        },
        (err: any) => {
          assert.ok(err instanceof ReconciliationCaseConflictError);
          assert.match(err.message, /evolved to version 2/);
          return true;
        }
      );
    });
  });

  describe('3. Concorrência e Ausência de Pool Starvation / Deadlock (AF-5..AF-7)', () => {
    it('AF-5: append com Pool max=1 executa rapidamente sem deadlock e deixa waitingCount=0', async () => {
      const singleConnPool = new Pool({ connectionString: databaseUrl, max: 1 });
      const singleObsAdapter = new PgObservationPersistenceAdapter(singleConnPool);
      const singleRecAdapter = new PgReconciliationPersistenceAdapter(singleConnPool, singleObsAdapter);

      try {
        const caseId = `case_af5_${Date.now()}` as ReconciliationCaseId;
        const obsId1 = `obs_af5_1_${Date.now()}` as ObservationRecordId;
        const obsId2 = `obs_af5_2_${Date.now()}` as ObservationRecordId;

        await singleObsAdapter.recordObservation({
          observationId: obsId1,
          subject: testSubject,
          observedClaim: 'Obs AF5 1',
          rawValue: {},
          actor: humanLucas,
          sourceRefs: [],
          evidenceRefs: [],
          capturedAt: '2026-08-21T23:00:00.000Z',
          observedAt: '2026-08-21T23:00:00.000Z',
        });

        await singleObsAdapter.recordObservation({
          observationId: obsId2,
          subject: testSubject,
          observedClaim: 'Obs AF5 2',
          rawValue: {},
          actor: humanLucas,
          sourceRefs: [],
          evidenceRefs: [],
          capturedAt: '2026-08-21T23:00:00.000Z',
          observedAt: '2026-08-21T23:00:00.000Z',
        });

        await singleRecAdapter.createReconciliationCase({
          case: {
            caseId,
            subject: testSubject,
            observationIds: [obsId1],
            reviewIds: [],
            lifecycle: 'open',
            status: 'open',
            openedAt: '2026-08-21T23:00:00.000Z',
          },
        });

        // Append com timeout de segurança rígido de 5000ms
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: Pool max=1 deadlock detected!')), 5000)
        );

        const appendPromise = singleRecAdapter.appendReconciliationRevision({
          case: {
            caseId,
            subject: testSubject,
            observationIds: [obsId1, obsId2],
            reviewIds: [],
            lifecycle: 'open',
            status: 'awaiting_evidence',
            openedAt: '2026-08-21T23:00:00.000Z',
          },
          expectedVersion: 1,
        });

        const result = (await Promise.race([appendPromise, timeoutPromise])) as any;
        assert.equal(result.case.caseId, caseId);
        assert.equal(result.head.currentVersion, 2);
        assert.equal(singleConnPool.waitingCount, 0);
      } finally {
        await singleConnPool.end();
      }
    });

    it('AF-6: concorrência pressionada (15 appends paralelos) não entra em starvation', async () => {
      const pressuredPool = new Pool({ connectionString: databaseUrl, max: 5 });
      const pressuredObsAdapter = new PgObservationPersistenceAdapter(pressuredPool);
      const pressuredRecAdapter = new PgReconciliationPersistenceAdapter(pressuredPool, pressuredObsAdapter);

      try {
        const parallelCount = 15;
        const caseIds: ReconciliationCaseId[] = [];

        for (let i = 0; i < parallelCount; i++) {
          const cid = `case_af6_${i}_${Date.now()}` as ReconciliationCaseId;
          const oid = `obs_af6_${i}_${Date.now()}` as ObservationRecordId;
          caseIds.push(cid);

          await pressuredObsAdapter.recordObservation({
            observationId: oid,
            subject: testSubject,
            observedClaim: `Obs ${i}`,
            rawValue: {},
            actor: humanLucas,
            sourceRefs: [],
            evidenceRefs: [],
            capturedAt: '2026-08-21T23:00:00.000Z',
            observedAt: '2026-08-21T23:00:00.000Z',
          });

          await pressuredRecAdapter.createReconciliationCase({
            case: {
              caseId: cid,
              subject: testSubject,
              observationIds: [oid],
              reviewIds: [],
              lifecycle: 'open',
              status: 'open',
              openedAt: '2026-08-21T23:00:00.000Z',
            },
          });
        }

        // Executa 15 appends simultâneos
        const promises = caseIds.map(async (cid) => {
          const current = await pressuredRecAdapter.getCurrentReconciliationCase(cid);
          return pressuredRecAdapter.appendReconciliationRevision({
            case: {
              caseId: cid,
              subject: testSubject,
              observationIds: current!.observationIds,
              reviewIds: [],
              lifecycle: 'open',
              status: 'awaiting_evidence',
              openedAt: current!.openedAt,
            },
            expectedVersion: 1,
          });
        });

        const results = await Promise.all(promises);
        assert.equal(results.length, parallelCount);
        for (const res of results) {
          assert.equal(res.head.currentVersion, 2);
        }
        assert.equal(pressuredPool.waitingCount, 0);
      } finally {
        await pressuredPool.end();
      }
    });

    it('AF-7: concorrência same-case resulta em exatamente 1 vitória e 1 stale rejection', async () => {
      const caseId = `case_af7_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_af7_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs AF7',
        rawValue: {},
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

      const append1 = recPersistence.appendReconciliationRevision({
        case: {
          caseId,
          subject: testSubject,
          observationIds: [obsId],
          reviewIds: [],
          lifecycle: 'open',
          status: 'awaiting_evidence',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
        expectedVersion: 1,
      });

      const append2 = recPersistence.appendReconciliationRevision({
        case: {
          caseId,
          subject: testSubject,
          observationIds: [obsId],
          reviewIds: [],
          lifecycle: 'open',
          status: 'divergent',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
        expectedVersion: 1,
      });

      const outcomes = await Promise.allSettled([append1, append2]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(rejectionReason instanceof StaleReconciliationVersionConflictError);
      assert.equal(rejectionReason.caseId, caseId);
      assert.equal(rejectionReason.expectedVersion, 1);
      assert.equal(rejectionReason.actualVersion, 2);
    });
  });

  describe('4. Schema & CHECK Constraints no PostgreSQL (A10, A11, A12)', () => {
    it('A10: SQL direto open + validated é rejeitado pelo PostgreSQL', async () => {
      const caseId = `case_sql_a10_${Date.now()}`;
      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO nex_reconciliation_case_revisions (
              case_id, version, subject_domain, subject_entity_type, subject_entity_id,
              observation_ids, review_ids, lifecycle, status, opened_at
            ) VALUES ($1, 1, 'domain', 'type', 'id', '[]'::jsonb, '[]'::jsonb, 'open', 'validated', now())`,
            [caseId]
          );
        },
        (err: any) => {
          assert.match(err.message, /nex_rec_lifecycle_chk/);
          return true;
        }
      );
    });

    it('A11: SQL direto resolved + open é rejeitado pelo PostgreSQL', async () => {
      const caseId = `case_sql_a11_${Date.now()}`;
      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO nex_reconciliation_case_revisions (
              case_id, version, subject_domain, subject_entity_type, subject_entity_id,
              observation_ids, review_ids, lifecycle, status, opened_at, resolved_at, resolution_summary
            ) VALUES ($1, 1, 'domain', 'type', 'id', '[]'::jsonb, '[]'::jsonb, 'resolved', 'open', now(), now(), 'Summary')`,
            [caseId]
          );
        },
        (err: any) => {
          assert.match(err.message, /nex_rec_lifecycle_chk/);
          return true;
        }
      );
    });

    it('A12: nex_reconciliation_case_heads armazena apenas ponteiro operacional e deriva estado via JOIN', async () => {
      const caseId = `case_a12_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_a12_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A12',
        rawValue: {},
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
          status: 'awaiting_evidence',
          openedAt: '2026-08-21T23:00:00.000Z',
        },
      });

      // Checa as colunas físicas da tabela head
      const headRawRes = await pool.query(
        `SELECT * FROM nex_reconciliation_case_heads WHERE case_id = $1`,
        [caseId]
      );
      const row = headRawRes.rows[0];

      assert.equal(row.case_id, caseId);
      assert.equal(row.current_version, 1);
      // Confirma que não existem colunas desnormalizadas de subject/lifecycle/status na tabela head
      assert.equal(row.subject_domain, undefined);
      assert.equal(row.lifecycle, undefined);
      assert.equal(row.status, undefined);

      // getCurrentReconciliationHead deriva os dados corretamente via JOIN
      const head = await recPersistence.getCurrentReconciliationHead(caseId);
      assert.ok(head);
      assert.equal(head.currentVersion, 1);
      assert.equal(head.status, 'awaiting_evidence');
      assert.equal(head.lifecycle, 'open');
      assert.equal(head.subject.domain, testSubject.domain);
    });
  });

  describe('5. Gates de Autoridade & Operação Exata (A14..A16)', () => {
    it('A14: canonical_promoted + canonical_promotion = permitido', async () => {
      const now = Date.now();
      const obsId = `obs_a14_${now}` as ObservationRecordId;
      const revId = `rev_a14_${now}` as ReviewEventId;
      const projId = `proj_a14_${now}` as CanonicalProjectionRevisionId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A14',
        rawValue: { price: 100 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const promoReview: CanonicalPromotedReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 100 },
        },
        justification: 'Promoted with exact auth operation',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const projection: CanonicalProjection = {
        projectionRevisionId: projId,
        subject: testSubject,
        canonicalState: { price: 100 },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [revId],
        materializedAt: '2026-08-21T23:00:00.000Z',
        explanation: 'Canonical projection',
      };

      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanLucas.humanId,
        operation: 'canonical_promotion',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      const result = await coordinator.submitCanonicalPromotion({
        review: promoReview,
        projection,
        authorization: validAuth,
      });

      assert.equal(result.review.reviewId, revId);
      assert.equal(result.head.currentProjectionRevisionId, projId);
    });

    it('A15: canonical_reclassified + canonical_reclassification = permitido', async () => {
      const now = Date.now();
      const obsId = `obs_a15_${now}` as ObservationRecordId;
      const revId = `rev_a15_${now}` as ReviewEventId;
      const projId = `proj_a15_${now}` as CanonicalProjectionRevisionId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A15',
        rawValue: { price: 120 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const currentHead = await obsPersistence.getCurrentCanonicalHead(testSubject);

      const reclassReview: CanonicalReclassifiedReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        targetBaseRevisionId: currentHead?.currentProjectionRevisionId,
        decision: 'canonical_reclassified',
        canonicalEffect: {
          action: 'reclassify',
          targetCanonicalState: { price: 120 },
        },
        justification: 'Reclassified with exact auth operation',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const projection: CanonicalProjection = {
        projectionRevisionId: projId,
        subject: testSubject,
        canonicalState: { price: 120 },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [revId],
        supersedesRevisionId: currentHead?.currentProjectionRevisionId,
        materializedAt: '2026-08-21T23:00:00.000Z',
        explanation: 'Canonical projection reclassification',
      };

      const validAuth: HumanAuthorizationDecision = {
        actorRef: humanLucas.humanId,
        operation: 'canonical_reclassification',
        verdict: 'authorized',
        reasonCode: 'VALIDATED',
        authorizedAt: '2026-08-21T23:00:00.000Z',
      };

      const result = await coordinator.submitCanonicalPromotion({
        review: reclassReview,
        projection,
        expectedBaseRevisionId: currentHead?.currentProjectionRevisionId,
        authorization: validAuth,
      });

      assert.equal(result.review.reviewId, revId);
      assert.equal(result.head.currentProjectionRevisionId, projId);
    });

    it('A16: combinações cruzadas e aliases (promote, reclassify, cruzado) são rejeitadas', async () => {
      const now = Date.now();
      const obsId = `obs_a16_${now}` as ObservationRecordId;
      const revId = `rev_a16_${now}` as ReviewEventId;
      const projId = `proj_a16_${now}` as CanonicalProjectionRevisionId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A16',
        rawValue: { price: 130 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      const promoReview: CanonicalPromotedReviewEvent = {
        reviewId: revId,
        actor: humanLucas,
        targetObservationIds: [obsId],
        decision: 'canonical_promoted',
        canonicalEffect: {
          action: 'promote',
          targetCanonicalState: { price: 130 },
        },
        justification: 'Promotion attempt',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      };

      const projection: CanonicalProjection = {
        projectionRevisionId: projId,
        subject: testSubject,
        canonicalState: { price: 130 },
        underlyingObservationIds: [obsId],
        authorizingReviewIds: [revId],
        materializedAt: '2026-08-21T23:00:00.000Z',
        explanation: 'Canonical projection',
      };

      // 1. Cruzado: canonical_promoted com canonical_reclassification
      await assert.rejects(
        async () => {
          await coordinator.submitCanonicalPromotion({
            review: promoReview,
            projection,
            authorization: {
              actorRef: humanLucas.humanId,
              operation: 'canonical_reclassification',
              verdict: 'authorized',
              reasonCode: 'TEST',
            },
          });
        },
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'OPERATION_MISMATCH');
          return true;
        }
      );

      // 2. Alias: 'promote'
      await assert.rejects(
        async () => {
          await coordinator.submitCanonicalPromotion({
            review: promoReview,
            projection,
            authorization: {
              actorRef: humanLucas.humanId,
              operation: 'promote',
              verdict: 'authorized',
              reasonCode: 'TEST',
            },
          });
        },
        (err: any) => {
          assert.ok(err instanceof CanonicalPromotionAuthorityError);
          assert.equal(err.code, 'OPERATION_MISMATCH');
          return true;
        }
      );
    });
  });

  describe('6. Contextual Precedent & Actor Payload Canônico (A17..A19)', () => {
    it('A17: precedent de review humana com actor_payload real é persistido e recuperado', async () => {
      const now = Date.now();
      const obsId = `obs_a17_${now}` as ObservationRecordId;
      const revId = `rev_a17_${now}` as ReviewEventId;
      const precId = `prec_a17_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A17',
        rawValue: { price: 100 },
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
        justification: 'Approved vendor terms discount precedent',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      const precedent: ContextualPrecedent = {
        precedentId: precId,
        reviewEventId: revId,
        contextSummary: 'Tier 1 volume discount rule',
        applicabilityConditions: ['volume >= 50'],
        policyProposalRef: 'PROP_DISCOUNT_TIER1',
      };

      const result = await recPersistence.recordContextualPrecedent(precedent);
      assert.equal(result.precedentId, precId);

      const fetched = await recPersistence.getContextualPrecedent(precId);
      assert.ok(fetched);
      assert.equal(fetched.precedentId, precId);
      assert.equal(fetched.reviewEventId, revId);
    });

    it('A18: review com coluna actor_kind human mas actor_payload MAX é rejeitada fail-closed', async () => {
      const now = Date.now();
      const obsId = `obs_a18_${now}` as ObservationRecordId;
      const corruptedRevId = `rev_a18_corrupt_${now}` as ReviewEventId;
      const precId = `prec_a18_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A18',
        rawValue: { price: 100 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      // Insere diretamente um registro inconsistente no banco
      await pool.query(
        `INSERT INTO nex_review_events (
          review_id, actor_kind, actor_payload, decision, justification, reviewed_at
        ) VALUES ($1, 'human', $2, 'corroborated', 'Forged note', now())`,
        [corruptedRevId, JSON.stringify({ kind: 'max', maxVersion: 'MAX_3.0' })]
      );

      const precedent: ContextualPrecedent = {
        precedentId: precId,
        reviewEventId: corruptedRevId,
        contextSummary: 'Forged precedent attempt',
        applicabilityConditions: ['true'],
      };

      await assert.rejects(
        async () => {
          await recPersistence.recordContextualPrecedent(precedent);
        },
        (err: any) => {
          assert.ok(err instanceof ContextualPrecedentInvalidReviewError);
          assert.match(err.message, /strictly requires a human actor/);
          return true;
        }
      );
    });

    it('A19: precedent de review MAX ou System é estritamente rejeitado', async () => {
      const now = Date.now();
      const obsId = `obs_a19_${now}` as ObservationRecordId;
      const maxRevId = `rev_a19_max_${now}` as ReviewEventId;
      const precId = `prec_a19_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Obs A19',
        rawValue: { price: 100 },
        actor: humanLucas,
        sourceRefs: [],
        evidenceRefs: [],
        capturedAt: '2026-08-21T23:00:00.000Z',
        observedAt: '2026-08-21T23:00:00.000Z',
      });

      await obsPersistence.recordNonCanonicalReview({
        reviewId: maxRevId,
        actor: maxAgent,
        targetObservationIds: [obsId],
        decision: 'divergent',
        justification: 'Automated note',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      const precedent: ContextualPrecedent = {
        precedentId: precId,
        reviewEventId: maxRevId,
        contextSummary: 'MAX precedent attempt',
        applicabilityConditions: ['true'],
      };

      await assert.rejects(
        async () => {
          await recPersistence.recordContextualPrecedent(precedent);
        },
        (err: any) => {
          assert.ok(err instanceof ContextualPrecedentInvalidReviewError);
          return true;
        }
      );
    });
  });

  describe('7. Proteção Append-Only Direta no PostgreSQL', () => {
    it('UPDATE direto em nex_reconciliation_case_revisions é rejeitado pelo trigger', async () => {
      const caseId = `case_trg_test_${Date.now()}` as ReconciliationCaseId;
      const obsId = `obs_trg_${Date.now()}` as ObservationRecordId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Trigger obs',
        rawValue: { price: 10 },
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

    it('DELETE direto em nex_contextual_precedents é rejeitado pelo trigger', async () => {
      const now = Date.now();
      const obsId = `obs_prec_trg_${now}` as ObservationRecordId;
      const revId = `rev_prec_trg_${now}` as ReviewEventId;
      const precId = `prec_trg_${now}` as ContextualPrecedentRefId;

      await obsPersistence.recordObservation({
        observationId: obsId,
        subject: testSubject,
        observedClaim: 'Trigger obs',
        rawValue: { price: 10 },
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
        justification: 'Valid review',
        reviewedAt: '2026-08-21T23:00:00.000Z',
      });

      await recPersistence.recordContextualPrecedent({
        precedentId: precId,
        reviewEventId: revId,
        contextSummary: 'Trigger precedent',
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
