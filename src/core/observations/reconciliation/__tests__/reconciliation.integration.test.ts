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
import * as migration085B from '../../../../migrations/20260821_210000_observation_persistence';
import * as migration085D from '../../../../migrations/20260821_230000_reconciliation_and_precedents';

const databaseUrl = process.env.DATABASE_URL;

function createMigrationDb(client: { query: (q: string, params?: any[]) => Promise<any> }) {
  return {
    execute: async (statement: any) => {
      let queryStr = '';
      if (typeof statement === 'string') {
        queryStr = statement;
      } else if (statement && typeof statement.toQuery === 'function') {
        const compiled = statement.toQuery({
          escapeName: (n: string) => `"${n}"`,
          escapeParam: (_: number, v: any) => v,
        });
        queryStr = compiled.sql;
      } else if (statement && Array.isArray(statement.queryChunks)) {
        queryStr = statement.queryChunks
          .map((c: any) => {
            if (typeof c === 'string') return c;
            if (c && typeof c.value === 'string') return c.value;
            if (c && typeof c.value !== 'undefined') return String(c.value);
            return String(c);
          })
          .join('');
      } else {
        queryStr = String(statement);
      }
      await client.query(queryStr);
    },
  };
}

describe('Escopo 0.85D · Reconciliação Persistente, Precedente Contextual & Gates de Autoridade (Micro-Hardening B)', { skip: !databaseUrl }, () => {
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

  describe('8. Compatibilidade da Migration 0.85D com ReconciliationCase Legado (B1..B8)', () => {
    const schemaLegacy = 'test_rec_legacy_b1';
    const schemaClean = 'test_rec_clean_b6';
    const schemaValidPre = 'test_rec_valid_b7';

    after(async () => {
      if (!pool) return;
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaLegacy} CASCADE;`);
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaClean} CASCADE;`);
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaValidPre} CASCADE;`);
    });

    it('B1: Legacy orphan migra com sucesso e preserva todos os campos históricos', async () => {
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schemaLegacy} CASCADE;`);
        await client.query(`CREATE SCHEMA ${schemaLegacy};`);
        await client.query(`SET search_path TO ${schemaLegacy}, public;`);

        const migrationDb = createMigrationDb(client);
        await migration085B.up({ db: migrationDb } as any);

        // Criar dados históricos válidos pré-0.85D (sem tabela de cases)
        const obsId = 'obs_legacy_b1';
        const revId = 'rev_legacy_b1';
        const projId = 'proj_legacy_b1';
        const legacyCaseId = 'legacy_case_missing_123';

        await client.query(
          `INSERT INTO nex_observation_records (
            observation_id, domain, entity_type, entity_id, observed_claim,
            raw_value, actor_kind, actor_payload, observed_at, captured_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
          [
            obsId,
            'supplier_product',
            'product',
            'prod_legacy_100',
            'Preço legacy',
            JSON.stringify({ price: 100 }),
            'human',
            JSON.stringify(humanLucas),
            '2026-08-21T21:00:00.000Z',
            '2026-08-21T21:00:00.000Z',
          ]
        );

        await client.query(
          `INSERT INTO nex_review_events (
            review_id, actor_kind, actor_payload, decision, canonical_action,
            target_canonical_state, justification, reviewed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
          [
            revId,
            'human',
            JSON.stringify(humanLucas),
            'canonical_promoted',
            'promote',
            JSON.stringify({ price: 100, currency: 'BRL' }),
            'Promoção histórica válida pré-0.85D',
            '2026-08-21T21:10:00.000Z',
          ]
        );

        await client.query(
          `INSERT INTO nex_canonical_projection_revisions (
            projection_revision_id, domain, entity_type, entity_id, canonical_state,
            reconciliation_case_id, supersedes_revision_id, materialized_at, explanation
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
          [
            projId,
            'supplier_product',
            'product',
            'prod_legacy_100',
            JSON.stringify({ price: 100, currency: 'BRL' }),
            legacyCaseId,
            null,
            '2026-08-21T21:15:00.000Z',
            'Projeção histórica com reconciliation_case_id não-nulo sem tabela de cases',
          ]
        );

        await client.query(
          `INSERT INTO nex_canonical_projection_observations (projection_revision_id, observation_id) VALUES ($1, $2);`,
          [projId, obsId]
        );

        await client.query(
          `INSERT INTO nex_canonical_projection_reviews (projection_revision_id, review_id) VALUES ($1, $2);`,
          [projId, revId]
        );

        await client.query(
          `INSERT INTO nex_canonical_projection_heads (domain, entity_type, entity_id, current_projection_revision_id, version, updated_at) VALUES ($1, $2, $3, $4, 1, $5);`,
          ['supplier_product', 'product', 'prod_legacy_100', projId, '2026-08-21T21:15:00.000Z']
        );

        // Executar migration 0.85D
        await migration085D.up({ db: migrationDb } as any);

        // B1: Confirmar integridade absoluta dos dados legados
        const res = await client.query(
          `SELECT * FROM nex_canonical_projection_revisions WHERE projection_revision_id = $1;`,
          [projId]
        );

        assert.equal(res.rows.length, 1);
        const row = res.rows[0];
        assert.equal(row.projection_revision_id, projId);
        assert.equal(row.domain, 'supplier_product');
        assert.equal(row.entity_type, 'product');
        assert.equal(row.entity_id, 'prod_legacy_100');
        assert.deepEqual(row.canonical_state, { price: 100, currency: 'BRL' });
        assert.equal(row.reconciliation_case_id, legacyCaseId);
        assert.equal(row.supersedes_revision_id, null);
        assert.equal(
          row.explanation,
          'Projeção histórica com reconciliation_case_id não-nulo sem tabela de cases'
        );

        const obsLinks = await client.query(
          `SELECT * FROM nex_canonical_projection_observations WHERE projection_revision_id = $1;`,
          [projId]
        );
        assert.equal(obsLinks.rows.length, 1);
        assert.equal(obsLinks.rows[0].observation_id, obsId);

        const revLinks = await client.query(
          `SELECT * FROM nex_canonical_projection_reviews WHERE projection_revision_id = $1;`,
          [projId]
        );
        assert.equal(revLinks.rows.length, 1);
        assert.equal(revLinks.rows[0].review_id, revId);
      } finally {
        client.release();
      }
    });

    it('B2: Constraint legacy fica convalidated = false e existe no catálogo', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaLegacy}, public;`);
        const res = await client.query(`
          SELECT conname, convalidated, contype
          FROM pg_constraint
          WHERE conname = 'nex_proj_reconciliation_case_fk'
            AND conrelid = '${schemaLegacy}.nex_canonical_projection_revisions'::regclass;
        `);

        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].conname, 'nex_proj_reconciliation_case_fk');
        assert.equal(res.rows[0].convalidated, false);
        assert.equal(res.rows[0].contype, 'f');
      } finally {
        client.release();
      }
    });

    it('B3: Novo registro órfão é rejeitado por violação de foreign key (SQLSTATE 23503)', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaLegacy}, public;`);

        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO nex_canonical_projection_revisions (
                projection_revision_id, domain, entity_type, entity_id, canonical_state,
                reconciliation_case_id, supersedes_revision_id, materialized_at, explanation
              ) VALUES (
                'proj_new_orphan', 'supplier_product', 'product', 'prod_legacy_100', '{"price": 110}'::jsonb,
                'another_missing_case', 'proj_legacy_b1', now(), 'Tentativa de novo órfão'
              );
            `);
          },
          (err: any) => {
            assert.equal(err.code, '23503');
            assert.match(err.message, /nex_proj_reconciliation_case_fk/);
            return true;
          }
        );
      } finally {
        client.release();
      }
    });

    it('B4: Novo case persistente válido é aceito e referenciado por nova projection', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaLegacy}, public;`);

        const validCaseId = 'case_valid_085d_test';
        await client.query(`
          INSERT INTO nex_reconciliation_case_revisions (
            case_id, version, subject_domain, subject_entity_type, subject_entity_id,
            observation_ids, review_ids, lifecycle, status, opened_at
          ) VALUES (
            $1, 1, 'supplier_product', 'product', 'prod_legacy_100',
            '["obs_legacy_b1"]'::jsonb, '["rev_legacy_b1"]'::jsonb, 'open', 'open', now()
          );
        `, [validCaseId]);

        await client.query(`
          INSERT INTO nex_reconciliation_case_heads (case_id, current_version, updated_at)
          VALUES ($1, 1, now());
        `, [validCaseId]);

        await client.query(`
          INSERT INTO nex_canonical_projection_revisions (
            projection_revision_id, domain, entity_type, entity_id, canonical_state,
            reconciliation_case_id, supersedes_revision_id, materialized_at, explanation
          ) VALUES (
            'proj_valid_with_case', 'supplier_product', 'product', 'prod_legacy_100', '{"price": 120}'::jsonb,
            $1, 'proj_legacy_b1', now(), 'Nova projeção com case válido existente'
          );
        `, [validCaseId]);

        const check = await client.query(
          `SELECT * FROM nex_canonical_projection_revisions WHERE projection_revision_id = 'proj_valid_with_case';`
        );
        assert.equal(check.rows.length, 1);
        assert.equal(check.rows[0].reconciliation_case_id, validCaseId);
      } finally {
        client.release();
      }
    });

    it('B5: Projection com reconciliation_case_id = NULL continua válida', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaLegacy}, public;`);

        await client.query(`
          INSERT INTO nex_canonical_projection_revisions (
            projection_revision_id, domain, entity_type, entity_id, canonical_state,
            reconciliation_case_id, supersedes_revision_id, materialized_at, explanation
          ) VALUES (
            'proj_null_case', 'supplier_product', 'product', 'prod_legacy_100', '{"price": 130}'::jsonb,
            NULL, 'proj_legacy_b1', now(), 'Nova projeção com reconciliation_case_id NULL'
          );
        `);

        const check = await client.query(
          `SELECT * FROM nex_canonical_projection_revisions WHERE projection_revision_id = 'proj_null_case';`
        );
        assert.equal(check.rows.length, 1);
        assert.equal(check.rows[0].reconciliation_case_id, null);
      } finally {
        client.release();
      }
    });

    it('B6: Banco limpo termina com constraint validada (convalidated = true)', async () => {
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schemaClean} CASCADE;`);
        await client.query(`CREATE SCHEMA ${schemaClean};`);
        await client.query(`SET search_path TO ${schemaClean}, public;`);

        const migrationDb = createMigrationDb(client);
        await migration085B.up({ db: migrationDb } as any);

        // Projeção com reconciliation_case_id = NULL (sem órfãos)
        await client.query(`
          INSERT INTO nex_canonical_projection_revisions (
            projection_revision_id, domain, entity_type, entity_id, canonical_state,
            reconciliation_case_id, supersedes_revision_id, materialized_at, explanation
          ) VALUES (
            'proj_clean_1', 'supplier_product', 'product', 'prod_clean_1', '{"price": 50}'::jsonb,
            NULL, NULL, now(), 'Projeção sem reconciliation case'
          );
        `);

        // Executar 0.85D
        await migration085D.up({ db: migrationDb } as any);

        const res = await client.query(`
          SELECT conname, convalidated
          FROM pg_constraint
          WHERE conname = 'nex_proj_reconciliation_case_fk'
            AND conrelid = '${schemaClean}.nex_canonical_projection_revisions'::regclass;
        `);

        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].convalidated, true);
      } finally {
        client.release();
      }
    });

    it('B7: Referências preexistentes válidas terminam com constraint validada (convalidated = true)', async () => {
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schemaValidPre} CASCADE;`);
        await client.query(`CREATE SCHEMA ${schemaValidPre};`);
        await client.query(`SET search_path TO ${schemaValidPre}, public;`);

        const migrationDb = createMigrationDb(client);
        await migration085B.up({ db: migrationDb } as any);

        const validPreCaseId = 'case_pre_valid_123';

        // Projeção pré-existente referenciando case que existirá antes do VALIDATE
        await client.query(`
          INSERT INTO nex_canonical_projection_revisions (
            projection_revision_id, domain, entity_type, entity_id, canonical_state,
            reconciliation_case_id, supersedes_revision_id, materialized_at, explanation
          ) VALUES (
            'proj_pre_valid_1', 'supplier_product', 'product', 'prod_pre_1', '{"price": 75}'::jsonb,
            $1, NULL, now(), 'Projeção pré-existente com case correspondente'
          );
        `, [validPreCaseId]);

        // Criar tabelas 0.85D e head válido correspondente antes da validação
        await client.query(`
          CREATE TABLE IF NOT EXISTS nex_reconciliation_case_revisions (
            case_id varchar NOT NULL,
            version integer NOT NULL CHECK (version >= 1),
            subject_domain varchar NOT NULL,
            subject_entity_type varchar NOT NULL,
            subject_entity_id varchar NOT NULL,
            observation_ids jsonb NOT NULL,
            review_ids jsonb NOT NULL,
            lifecycle varchar NOT NULL CHECK (lifecycle IN ('open', 'resolved')),
            status varchar NOT NULL,
            opened_at timestamp(3) with time zone NOT NULL,
            resolved_at timestamp(3) with time zone,
            resolution_summary text,
            materialized_at timestamp(3) with time zone DEFAULT now() NOT NULL,
            PRIMARY KEY (case_id, version)
          );
          CREATE TABLE IF NOT EXISTS nex_reconciliation_case_heads (
            case_id varchar PRIMARY KEY NOT NULL,
            current_version integer NOT NULL,
            updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
            FOREIGN KEY (case_id, current_version) REFERENCES nex_reconciliation_case_revisions(case_id, version) ON DELETE RESTRICT
          );
          CREATE TABLE IF NOT EXISTS nex_contextual_precedents (
            precedent_id varchar PRIMARY KEY NOT NULL,
            review_event_id varchar NOT NULL,
            context_summary text NOT NULL,
            applicability_conditions jsonb NOT NULL,
            policy_proposal_ref varchar,
            created_at timestamp(3) with time zone DEFAULT now() NOT NULL
          );
          INSERT INTO nex_reconciliation_case_revisions (
            case_id, version, subject_domain, subject_entity_type, subject_entity_id,
            observation_ids, review_ids, lifecycle, status, opened_at
          ) VALUES (
            '${validPreCaseId}', 1, 'supplier_product', 'product', 'prod_pre_1',
            '[]'::jsonb, '[]'::jsonb, 'open', 'open', now()
          );
          INSERT INTO nex_reconciliation_case_heads (case_id, current_version, updated_at)
          VALUES ('${validPreCaseId}', 1, now());
        `);

        // Executar 0.85D UP
        await migration085D.up({ db: migrationDb } as any);

        const res = await client.query(`
          SELECT conname, convalidated
          FROM pg_constraint
          WHERE conname = 'nex_proj_reconciliation_case_fk'
            AND conrelid = '${schemaValidPre}.nex_canonical_projection_revisions'::regclass;
        `);

        assert.equal(res.rows.length, 1);
        assert.equal(res.rows[0].convalidated, true);
      } finally {
        client.release();
      }
    });

    it('B8: Ciclo UP -> DOWN -> re-UP preserva dados legados e restaura constraint NOT VALID', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schemaLegacy}, public;`);
        const migrationDb = createMigrationDb(client);

        // 1. Executar DOWN
        await migration085D.down({ db: migrationDb } as any);

        // Tabelas 0.85D não devem mais existir
        const checkTablesDown = await client.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = '${schemaLegacy}'
            AND table_name IN ('nex_reconciliation_case_revisions', 'nex_reconciliation_case_heads', 'nex_contextual_precedents');
        `);
        assert.equal(checkTablesDown.rows.length, 0);

        // FK constraint não deve mais existir
        const checkFkDown = await client.query(`
          SELECT conname FROM pg_constraint
          WHERE conname = 'nex_proj_reconciliation_case_fk'
            AND conrelid = '${schemaLegacy}.nex_canonical_projection_revisions'::regclass;
        `);
        assert.equal(checkFkDown.rows.length, 0);

        // Projeção histórica original continua 100% intacta
        const checkProjDown = await client.query(
          `SELECT * FROM nex_canonical_projection_revisions WHERE projection_revision_id = 'proj_legacy_b1';`
        );
        assert.equal(checkProjDown.rows.length, 1);
        assert.equal(checkProjDown.rows[0].reconciliation_case_id, 'legacy_case_missing_123');

        // 2. Executar re-UP
        await migration085D.up({ db: migrationDb } as any);

        // Tabelas 0.85D existem novamente
        const checkTablesReUp = await client.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = '${schemaLegacy}'
            AND table_name IN ('nex_reconciliation_case_revisions', 'nex_reconciliation_case_heads', 'nex_contextual_precedents');
        `);
        assert.equal(checkTablesReUp.rows.length, 3);

        // FK constraint foi recriada como NOT VALID (convalidated = false)
        const checkFkReUp = await client.query(`
          SELECT conname, convalidated FROM pg_constraint
          WHERE conname = 'nex_proj_reconciliation_case_fk'
            AND conrelid = '${schemaLegacy}.nex_canonical_projection_revisions'::regclass;
        `);
        assert.equal(checkFkReUp.rows.length, 1);
        assert.equal(checkFkReUp.rows[0].convalidated, false);

        // Projeção histórica original continua 100% intacta
        const checkProjReUp = await client.query(
          `SELECT * FROM nex_canonical_projection_revisions WHERE projection_revision_id = 'proj_legacy_b1';`
        );
        assert.equal(checkProjReUp.rows.length, 1);
        assert.equal(checkProjReUp.rows[0].reconciliation_case_id, 'legacy_case_missing_123');
      } finally {
        client.release();
      }
    });
  });
});
