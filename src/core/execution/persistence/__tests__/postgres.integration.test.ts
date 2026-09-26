/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Testes de Integração PostgreSQL para Durable Execution Ledger — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 *
 * Provas Obrigatórias (Seção 21):
 * 1. Restart / Rehydration idêntico após nova instância de adapter e pool.
 * 2. Attempt Lifecycle completo (created -> running -> terminal) e rejeição de transições inválidas.
 * 3. Detecção determinística de IDs duplicados (DuplicateIdError para Attempt, Signal, Evidence, Assessment, Receipt).
 * 4. Causalidade e integridade referencial estrita (Cross-Attempt, ausência de refs, Receipt estrutural).
 * 5. Concorrência segura (apenas uma assessment vence em corrida de supersedes, rejeitando second-write).
 * 6. Atomicidade de transação: rollback integral se falhar operação parcial.
 * 7. Proteção estrutural append-only: triggers rejeitam UPDATE, DELETE e TRUNCATE em tabelas históricas.
 * 8. Trust Boundary fail-closed: linhas adulteradas/corrompidas lançam CorruptedLedgerRowError.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type {
  AttemptEvent,
  AttemptCreatedEvent,
  AttemptStartedEvent,
  AttemptTerminalEvent,
  AttemptId,
  DecisionId,
  RouteEvaluationId,
  ExecutionSignal,
  ExecutionSignalId,
  ExecutionEvidence,
  ExecutionEvidenceId,
  OutcomeAssessment,
  OutcomeAssessmentId,
  Receipt,
  ReceiptId,
  ExecutionOutcomeReceipt,
  PolicyDenialReceipt,
  AuthorizationDenialReceipt,
  CancelledReceipt,
  NoEligibleRouteReceipt,
} from '../../contracts';
import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  FactProvenance,
} from '../../../capabilities/contracts';
import {
  PostgresExecutionLedgerStore,
  createPostgresExecutionLedgerStore,
  type PgTransactionalExecutor,
  type PgTransactionalClient,
  type PgQueryResult,
} from '../postgres';
import { createExecutionLedgerStore } from '../../ledger';
import {
  DuplicateIdError,
  InvalidAttemptTransitionError,
  InvalidAttemptReferenceError,
  InvalidSignalReferenceError,
  InvalidEvidenceReferenceError,
  InvalidAssessmentReferenceError,
  InvalidAssessmentLineageError,
  CrossAttemptReferenceError,
  InvalidReceiptStructureError,
  CorruptedLedgerRowError,
} from '../errors';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (process.env.NEX_REQUIRE_EXECUTION_LEDGER_DB === '1' && !databaseUrl) {
  throw new Error('NEX_REQUIRE_EXECUTION_LEDGER_DB=1 is set but DATABASE_URL is missing. Aborting test suite to prevent accidental green skip.');
}

describe('0.86C-2A · Persistência PostgreSQL de Execution Ledger L0', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let store: PostgresExecutionLedgerStore;

  const DECISION_A = 'dec_01' as DecisionId;
  const ROUTE_EVAL_A = 'rte_01' as RouteEvaluationId;
  const CAP_REV_A = 'cap_rev_01' as CapabilityRevisionId;
  const BIND_REV_A = 'bind_rev_01' as BindingRevisionId;
  const ROUTE_REV_A = 'route_rev_01' as RouteRevisionId;

  const PROVENANCE_TEST: FactProvenance = {
    source: 'direct_probe',
    acquisitionBasis: 'measured',
    verificationStatus: 'corroborated',
    observedAt: '2026-09-25T12:00:00.000Z',
  };

  const T0 = '2026-09-25T12:00:00.000Z';
  const T1 = '2026-09-25T12:01:00.000Z';
  const T2 = '2026-09-25T12:02:00.000Z';
  const T3 = '2026-09-25T12:03:00.000Z';
  const T4 = '2026-09-25T12:04:00.000Z';

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    store = new PostgresExecutionLedgerStore(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // ==========================================================================
  // 1. RESTART / REHYDRATION
  // ==========================================================================
  describe('1. Restart & Rehydration Idêntico', () => {
    it('Persiste ecossistema completo no store A e reidrata perfeitamente no store B com nova pool', async () => {
      const attId = `att_rehydrate_${Date.now()}` as AttemptId;
      const sigId = `sig_rehydrate_${Date.now()}` as ExecutionSignalId;
      const eviId = `evi_rehydrate_${Date.now()}` as ExecutionEvidenceId;
      const assId1 = `ass_rehydrate_1_${Date.now()}` as OutcomeAssessmentId;
      const assId2 = `ass_rehydrate_2_${Date.now()}` as OutcomeAssessmentId;
      const rcpId = `rcp_rehydrate_${Date.now()}` as ReceiptId;

      // 1. Grava no Store A
      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendAttemptEvent({
        type: 'AttemptStarted',
        attemptId: attId,
        startedAt: T1,
      });

      await store.appendExecutionSignal({
        signalId: sigId,
        attemptId: attId,
        kind: 'effect_observed',
        safeMetadata: { durationMs: 142 },
        provenance: PROVENANCE_TEST,
        observedAt: T1,
      });

      await store.appendExecutionEvidence({
        evidenceId: eviId,
        attemptId: attId,
        signalRefs: [sigId],
        kind: 'effect_observed',
        safeFacts: { status: 'mutated', keysCount: 1 },
        provenance: PROVENANCE_TEST,
        recordedAt: T2,
        noSideEffectGuarantee: 'none',
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId1,
        attemptId: attId,
        evidenceRefs: [eviId],
        verdict: 'confirmed_mutation',
        reasonCode: 'MUTATION_EFFECT_OBSERVED',
        assessedAt: T2,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId2,
        attemptId: attId,
        evidenceRefs: [eviId],
        verdict: 'confirmed_mutation',
        reasonCode: 'MUTATION_CONFIRMED_SECOND_PASS',
        supersedesAssessmentId: assId1,
        assessedAt: T3,
      });

      await store.appendAttemptEvent({
        type: 'AttemptTerminal',
        attemptId: attId,
        terminalStatus: 'succeeded',
        terminalReason: 'Completed flawlessly',
        finishedAt: T3,
      });

      await store.appendReceipt({
        receiptId: rcpId,
        decisionId: DECISION_A,
        kind: 'execution_outcome',
        routeEvaluationId: ROUTE_EVAL_A,
        attemptId: attId,
        outcomeAssessmentId: assId2,
        verdictSummary: 'confirmed_mutation',
        reasonCode: 'MUTATION_CONFIRMED_SECOND_PASS',
        safeStructuredFacts: { executionTimeMs: 142 },
        materializedAt: T4,
      });

      // 2. Cria Store B com novo Pool isolado
      const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
      try {
        const storeB = createPostgresExecutionLedgerStore(poolB);

        // Valida Attempt e Eventos
        const attState = await storeB.getAttempt(attId);
        assert.ok(attState);
        assert.equal(attState.attemptId, attId);
        assert.equal(attState.status, 'succeeded');
        assert.equal(attState.createdAt, T0);
        assert.equal(attState.startedAt, T1);
        assert.equal(attState.finishedAt, T3);
        assert.equal(attState.terminalReason, 'Completed flawlessly');

        const events = await storeB.listAttemptEvents(attId);
        assert.equal(events.length, 3);
        assert.equal(events[0].type, 'AttemptCreated');
        assert.equal(events[1].type, 'AttemptStarted');
        assert.equal(events[2].type, 'AttemptTerminal');

        // Valida Signals
        const sig = await storeB.getExecutionSignal(sigId);
        assert.ok(sig);
        assert.equal(sig.signalId, sigId);
        assert.equal(sig.kind, 'effect_observed');
        assert.deepEqual(sig.safeMetadata, { durationMs: 142 });

        // Valida Evidence
        const evi = await storeB.getExecutionEvidence(eviId);
        assert.ok(evi);
        assert.equal(evi.evidenceId, eviId);
        assert.deepEqual(evi.signalRefs, [sigId]);
        assert.deepEqual(evi.safeFacts, { status: 'mutated', keysCount: 1 });

        // Valida Outcome Assessments e Latest Head
        const latestAss = await storeB.getLatestOutcomeAssessment(attId);
        assert.ok(latestAss);
        assert.equal(latestAss.assessmentId, assId2);
        assert.equal(latestAss.supersedesAssessmentId, assId1);

        const assList = await storeB.listOutcomeAssessments(attId);
        assert.equal(assList.length, 2);
        assert.equal(assList[0].assessmentId, assId1);
        assert.equal(assList[1].assessmentId, assId2);

        // Valida Receipt
        const rcp = await storeB.getReceipt(rcpId);
        assert.ok(rcp);
        assert.equal(rcp.receiptId, rcpId);
        assert.equal(rcp.kind, 'execution_outcome');
        if (rcp.kind === 'execution_outcome') {
          assert.equal(rcp.outcomeAssessmentId, assId2);
          assert.equal(rcp.attemptId, attId);
        }
      } finally {
        await poolB.end();
      }
    });
  });

  // ==========================================================================
  // 2. ATTEMPT LIFECYCLE & TRANSIÇÕES
  // ==========================================================================
  describe('2. Attempt Lifecycle & Transições', () => {
    it('Permite todas as variantes de status terminal a partir de running', async () => {
      const terminalStatuses = [
        'succeeded',
        'failed',
        'timed_out',
        'cancelled',
        'unknown_completion',
      ] as const;

      for (const tStatus of terminalStatuses) {
        const attId = `att_term_${tStatus}_${Date.now()}` as AttemptId;
        await store.appendAttemptEvent({
          type: 'AttemptCreated',
          attemptId: attId,
          decisionId: DECISION_A,
          routeEvaluationId: ROUTE_EVAL_A,
          capabilityRevisionId: CAP_REV_A,
          bindingRevisionId: BIND_REV_A,
          routeRevisionId: ROUTE_REV_A,
          createdAt: T0,
        });

        await store.appendAttemptEvent({
          type: 'AttemptStarted',
          attemptId: attId,
          startedAt: T1,
        });

        await store.appendAttemptEvent({
          type: 'AttemptTerminal',
          attemptId: attId,
          terminalStatus: tStatus,
          finishedAt: T2,
        });

        const att = await store.getAttempt(attId);
        assert.equal(att?.status, tStatus);
      }
    });

    it('Rejeita transição created -> succeeded direto com InvalidAttemptTransitionError', async () => {
      const attId = `att_invalid_jump_${Date.now()}` as AttemptId;
      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await assert.rejects(
        async () => {
          await store.appendAttemptEvent({
            type: 'AttemptTerminal',
            attemptId: attId,
            terminalStatus: 'succeeded',
            finishedAt: T1,
          });
        },
        (err: any) => err instanceof InvalidAttemptTransitionError && err.fromStatus === 'created',
      );
    });

    it('Rejeita tentativa de reiniciar/ressuscitar Attempt terminal', async () => {
      const attId = `att_resurrect_${Date.now()}` as AttemptId;
      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendAttemptEvent({
        type: 'AttemptStarted',
        attemptId: attId,
        startedAt: T1,
      });

      await store.appendAttemptEvent({
        type: 'AttemptTerminal',
        attemptId: attId,
        terminalStatus: 'succeeded',
        finishedAt: T2,
      });

      await assert.rejects(
        async () => {
          await store.appendAttemptEvent({
            type: 'AttemptStarted',
            attemptId: attId,
            startedAt: T3,
          });
        },
        (err: any) => err instanceof InvalidAttemptTransitionError && err.fromStatus === 'succeeded',
      );
    });
  });

  // ==========================================================================
  // 3. DETECÇÃO DETERMINÍSTICA DE DUPLICATE ID
  // ==========================================================================
  describe('3. Detecção Determinística de DuplicateIdError', () => {
    it('Duplicate AttemptId lança DuplicateIdError', async () => {
      const attId = `att_dup_${Date.now()}` as AttemptId;
      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await assert.rejects(
        async () => {
          await store.appendAttemptEvent({
            type: 'AttemptCreated',
            attemptId: attId,
            decisionId: DECISION_A,
            routeEvaluationId: ROUTE_EVAL_A,
            capabilityRevisionId: CAP_REV_A,
            bindingRevisionId: BIND_REV_A,
            routeRevisionId: ROUTE_REV_A,
            createdAt: T1,
          });
        },
        (err: any) => err instanceof DuplicateIdError && err.id === attId,
      );
    });

    it('Duplicate SignalId lança DuplicateIdError', async () => {
      const attId = `att_sig_dup_${Date.now()}` as AttemptId;
      const sigId = `sig_dup_${Date.now()}` as ExecutionSignalId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendExecutionSignal({
        signalId: sigId,
        attemptId: attId,
        kind: 'effect_observed',
        safeMetadata: {},
        provenance: PROVENANCE_TEST,
        observedAt: T1,
      });

      await assert.rejects(
        async () => {
          await store.appendExecutionSignal({
            signalId: sigId,
            attemptId: attId,
            kind: 'effect_observed',
            safeMetadata: {},
            provenance: PROVENANCE_TEST,
            observedAt: T2,
          });
        },
        (err: any) => err instanceof DuplicateIdError && err.id === sigId,
      );
    });

    it('Duplicate EvidenceId lança DuplicateIdError', async () => {
      const attId = `att_evi_dup_${Date.now()}` as AttemptId;
      const sigId = `sig_evi_dup_${Date.now()}` as ExecutionSignalId;
      const eviId = `evi_dup_${Date.now()}` as ExecutionEvidenceId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendExecutionSignal({
        signalId: sigId,
        attemptId: attId,
        kind: 'effect_observed',
        safeMetadata: {},
        provenance: PROVENANCE_TEST,
        observedAt: T1,
      });

      await store.appendExecutionEvidence({
        evidenceId: eviId,
        attemptId: attId,
        signalRefs: [sigId],
        kind: 'effect_observed',
        safeFacts: {},
        provenance: PROVENANCE_TEST,
        recordedAt: T2,
      });

      await assert.rejects(
        async () => {
          await store.appendExecutionEvidence({
            evidenceId: eviId,
            attemptId: attId,
            signalRefs: [sigId],
            kind: 'effect_observed',
            safeFacts: {},
            provenance: PROVENANCE_TEST,
            recordedAt: T3,
          });
        },
        (err: any) => err instanceof DuplicateIdError && err.id === eviId,
      );
    });

    it('Duplicate AssessmentId lança DuplicateIdError', async () => {
      const attId = `att_ass_dup_${Date.now()}` as AttemptId;
      const assId = `ass_dup_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'CLEAN',
        assessedAt: T1,
      });

      await assert.rejects(
        async () => {
          await store.appendOutcomeAssessment({
            assessmentId: assId,
            attemptId: attId,
            evidenceRefs: [],
            verdict: 'confirmed_no_mutation',
            reasonCode: 'CLEAN',
            assessedAt: T2,
          });
        },
        (err: any) => err instanceof DuplicateIdError && err.id === assId,
      );
    });

    it('Duplicate ReceiptId lança DuplicateIdError', async () => {
      const rcpId = `rcp_dup_${Date.now()}` as ReceiptId;

      const rcp: PolicyDenialReceipt = {
        receiptId: rcpId,
        decisionId: DECISION_A,
        kind: 'policy_denial',
        verdictSummary: 'policy_denied',
        reasonCode: 'ZERO_COST_VIOLATION',
        safeStructuredFacts: {},
        materializedAt: T0,
      };

      await store.appendReceipt(rcp);

      await assert.rejects(
        async () => {
          await store.appendReceipt(rcp);
        },
        (err: any) => err instanceof DuplicateIdError && err.id === rcpId,
      );
    });
  });

  // ==========================================================================
  // 4. CAUSALIDADE & INTEGRIDADE REFERENCIAL
  // ==========================================================================
  describe('4. Causalidade e Integridade Referencial', () => {
    it('Evidence referenciando Signal inexistente lança InvalidSignalReferenceError', async () => {
      const attId = `att_sig_missing_${Date.now()}` as AttemptId;
      const eviId = `evi_sig_missing_${Date.now()}` as ExecutionEvidenceId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await assert.rejects(
        async () => {
          await store.appendExecutionEvidence({
            evidenceId: eviId,
            attemptId: attId,
            signalRefs: ['sig_ghost' as ExecutionSignalId],
            kind: 'effect_observed',
            safeFacts: {},
            provenance: PROVENANCE_TEST,
            recordedAt: T1,
          });
        },
        (err: any) => err instanceof InvalidSignalReferenceError,
      );
    });

    it('Evidence referenciando Signal de OUTRO Attempt lança CrossAttemptReferenceError', async () => {
      const att1 = `att_cross1_${Date.now()}` as AttemptId;
      const att2 = `att_cross2_${Date.now()}` as AttemptId;
      const sig1 = `sig_cross1_${Date.now()}` as ExecutionSignalId;
      const evi2 = `evi_cross2_${Date.now()}` as ExecutionEvidenceId;

      // Cria att1 e att2
      for (const id of [att1, att2]) {
        await store.appendAttemptEvent({
          type: 'AttemptCreated',
          attemptId: id,
          decisionId: DECISION_A,
          routeEvaluationId: ROUTE_EVAL_A,
          capabilityRevisionId: CAP_REV_A,
          bindingRevisionId: BIND_REV_A,
          routeRevisionId: ROUTE_REV_A,
          createdAt: T0,
        });
      }

      // Signal pertence ao att1
      await store.appendExecutionSignal({
        signalId: sig1,
        attemptId: att1,
        kind: 'effect_observed',
        safeMetadata: {},
        provenance: PROVENANCE_TEST,
        observedAt: T1,
      });

      // Evidence de att2 tenta referenciar sig1 de att1
      await assert.rejects(
        async () => {
          await store.appendExecutionEvidence({
            evidenceId: evi2,
            attemptId: att2,
            signalRefs: [sig1],
            kind: 'effect_observed',
            safeFacts: {},
            provenance: PROVENANCE_TEST,
            recordedAt: T2,
          });
        },
        (err: any) => err instanceof CrossAttemptReferenceError,
      );
    });

    it('Assessment referenciando Evidence de OUTRO Attempt lança CrossAttemptReferenceError', async () => {
      const att1 = `att_ass_cross1_${Date.now()}` as AttemptId;
      const att2 = `att_ass_cross2_${Date.now()}` as AttemptId;
      const evi1 = `evi_ass_cross1_${Date.now()}` as ExecutionEvidenceId;
      const ass2 = `ass_cross2_${Date.now()}` as OutcomeAssessmentId;

      for (const id of [att1, att2]) {
        await store.appendAttemptEvent({
          type: 'AttemptCreated',
          attemptId: id,
          decisionId: DECISION_A,
          routeEvaluationId: ROUTE_EVAL_A,
          capabilityRevisionId: CAP_REV_A,
          bindingRevisionId: BIND_REV_A,
          routeRevisionId: ROUTE_REV_A,
          createdAt: T0,
        });
      }

      await store.appendExecutionEvidence({
        evidenceId: evi1,
        attemptId: att1,
        signalRefs: [],
        kind: 'no_effect_verified',
        safeFacts: {},
        provenance: PROVENANCE_TEST,
        recordedAt: T1,
      });

      await assert.rejects(
        async () => {
          await store.appendOutcomeAssessment({
            assessmentId: ass2,
            attemptId: att2,
            evidenceRefs: [evi1],
            verdict: 'confirmed_no_mutation',
            reasonCode: 'CHECK',
            assessedAt: T2,
          });
        },
        (err: any) => err instanceof CrossAttemptReferenceError,
      );
    });

    it('Primeira assessment tentando superseder lança InvalidAssessmentLineageError', async () => {
      const att = `att_first_super_${Date.now()}` as AttemptId;
      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: att,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await assert.rejects(
        async () => {
          await store.appendOutcomeAssessment({
            assessmentId: `ass_first_${Date.now()}` as OutcomeAssessmentId,
            attemptId: att,
            evidenceRefs: [],
            verdict: 'confirmed_no_mutation',
            reasonCode: 'CHECK',
            supersedesAssessmentId: 'ass_ghost' as OutcomeAssessmentId,
            assessedAt: T1,
          });
        },
        (err: any) => err instanceof InvalidAssessmentReferenceError || err instanceof InvalidAssessmentLineageError,
      );
    });

    it('Segunda assessment sem superseder a head atual lança InvalidAssessmentLineageError', async () => {
      const att = `att_second_no_super_${Date.now()}` as AttemptId;
      const ass1 = `ass_1_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: att,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendOutcomeAssessment({
        assessmentId: ass1,
        attemptId: att,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'CHECK_1',
        assessedAt: T1,
      });

      await assert.rejects(
        async () => {
          await store.appendOutcomeAssessment({
            assessmentId: `ass_2_${Date.now()}` as OutcomeAssessmentId,
            attemptId: att,
            evidenceRefs: [],
            verdict: 'confirmed_no_mutation',
            reasonCode: 'CHECK_2',
            assessedAt: T2,
          });
        },
        (err: any) => err instanceof InvalidAssessmentLineageError,
      );
    });

    it('Receipt execution_outcome com routeEvaluationId divergente lança InvalidReceiptStructureError', async () => {
      const attId = `att_rcp_mismatch_${Date.now()}` as AttemptId;
      const assId = `ass_rcp_mismatch_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_mutation',
        reasonCode: 'MUTATED',
        assessedAt: T1,
      });

      await assert.rejects(
        async () => {
          await store.appendReceipt({
            receiptId: `rcp_err_${Date.now()}` as ReceiptId,
            decisionId: DECISION_A,
            kind: 'execution_outcome',
            routeEvaluationId: 'rte_divergent' as RouteEvaluationId,
            attemptId: attId,
            outcomeAssessmentId: assId,
            verdictSummary: 'confirmed_mutation',
            reasonCode: 'MUTATED',
            safeStructuredFacts: {},
            materializedAt: T2,
          });
        },
        (err: any) => err instanceof InvalidReceiptStructureError,
      );
    });

    it('Receipt execution_outcome com decisionId divergente lança InvalidReceiptStructureError (C3)', async () => {
      const attId = `att_rcp_dec_mismatch_${Date.now()}` as AttemptId;
      const assId = `ass_rcp_dec_mismatch_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_mutation',
        reasonCode: 'MUTATED',
        assessedAt: T1,
      });

      await assert.rejects(
        async () => {
          await store.appendReceipt({
            receiptId: `rcp_err_dec_${Date.now()}` as ReceiptId,
            decisionId: 'dec_divergent' as DecisionId,
            kind: 'execution_outcome',
            routeEvaluationId: ROUTE_EVAL_A,
            attemptId: attId,
            outcomeAssessmentId: assId,
            verdictSummary: 'confirmed_mutation',
            reasonCode: 'MUTATED',
            safeStructuredFacts: {},
            materializedAt: T2,
          });
        },
        (err: any) => err instanceof InvalidReceiptStructureError,
      );
    });

    it('SQL direto tentando inserir Receipt com decision_id ou route_evaluation_id divergente é rejeitado pelo DB via FK composta (C3)', async () => {
      const attId = `att_c3_fk_${Date.now()}` as AttemptId;
      const assId = `ass_c3_fk_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_mutation',
        reasonCode: 'MUT',
        assessedAt: T1,
      });

      // SQL direto com decision_id divergente ('dec_divergent')
      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO "nex_execution_receipts"
             ("receipt_id", "decision_id", "kind", "route_evaluation_id", "attempt_id", "outcome_assessment_id", "verdict_summary", "reason_code", "safe_structured_facts", "materialized_at")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              `rcp_c3_bad_dec_${Date.now()}`,
              'dec_divergent',
              'execution_outcome',
              ROUTE_EVAL_A,
              attId,
              assId,
              'confirmed_mutation',
              'MUT',
              JSON.stringify({}),
              T2,
            ],
          );
        },
        (err: any) => err?.code === '23503',
      );

      // SQL direto com route_evaluation_id divergente ('rte_divergent')
      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO "nex_execution_receipts"
             ("receipt_id", "decision_id", "kind", "route_evaluation_id", "attempt_id", "outcome_assessment_id", "verdict_summary", "reason_code", "safe_structured_facts", "materialized_at")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              `rcp_c3_bad_rte_${Date.now()}`,
              DECISION_A,
              'execution_outcome',
              'rte_divergent',
              attId,
              assId,
              'confirmed_mutation',
              'MUT',
              JSON.stringify({}),
              T2,
            ],
          );
        },
        (err: any) => err?.code === '23503',
      );
    });

    it('SQL direto tentando apontar outcome head de Attempt A para assessment de Attempt B é rejeitado pelo DB via FK composta (C2)', async () => {
      const attA = `att_c2_a_${Date.now()}` as AttemptId;
      const attB = `att_c2_b_${Date.now()}` as AttemptId;
      const assA = `ass_c2_a_${Date.now()}` as OutcomeAssessmentId;
      const assB = `ass_c2_b_${Date.now()}` as OutcomeAssessmentId;

      for (const att of [attA, attB]) {
        await store.appendAttemptEvent({
          type: 'AttemptCreated',
          attemptId: att,
          decisionId: DECISION_A,
          routeEvaluationId: ROUTE_EVAL_A,
          capabilityRevisionId: CAP_REV_A,
          bindingRevisionId: BIND_REV_A,
          routeRevisionId: ROUTE_REV_A,
          createdAt: T0,
        });
      }

      await store.appendOutcomeAssessment({
        assessmentId: assA,
        attemptId: attA,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'A_OK',
        assessedAt: T1,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assB,
        attemptId: attB,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'B_OK',
        assessedAt: T1,
      });

      // Tenta apontar head de attA para assB (que pertence a attB)
      await assert.rejects(
        async () => {
          await pool.query(
            `UPDATE "nex_execution_outcome_heads"
             SET "latest_assessment_id" = $1
             WHERE "attempt_id" = $2`,
            [assB, attA],
          );
        },
        (err: any) => err?.code === '23503',
      );
    });

    it('Refs repetidas em signalRefs e evidenceRefs preservam posição e reidratam identicamente ao in-memory (C7)', async () => {
      const attId = `att_c7_dup_refs_${Date.now()}` as AttemptId;
      const sig1 = `sig_c7_1_${Date.now()}` as ExecutionSignalId;
      const sig2 = `sig_c7_2_${Date.now()}` as ExecutionSignalId;
      const evi1 = `evi_c7_1_${Date.now()}` as ExecutionEvidenceId;
      const ass1 = `ass_c7_1_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      for (const sId of [sig1, sig2]) {
        await store.appendExecutionSignal({
          signalId: sId,
          attemptId: attId,
          kind: 'effect_observed',
          safeMetadata: {},
          provenance: PROVENANCE_TEST,
          observedAt: T1,
        });
      }

      // Evidence com signalRefs contendo duplicatas preservando posição: [sig1, sig2, sig1]
      await store.appendExecutionEvidence({
        evidenceId: evi1,
        attemptId: attId,
        signalRefs: [sig1, sig2, sig1],
        kind: 'effect_observed',
        safeFacts: {},
        provenance: PROVENANCE_TEST,
        recordedAt: T2,
      });

      const rehydratedEvi = await store.getExecutionEvidence(evi1);
      assert.ok(rehydratedEvi);
      assert.deepEqual(rehydratedEvi.signalRefs, [sig1, sig2, sig1]);

      // Assessment com evidenceRefs contendo duplicatas preservando posição: [evi1, evi1]
      await store.appendOutcomeAssessment({
        assessmentId: ass1,
        attemptId: attId,
        evidenceRefs: [evi1, evi1],
        verdict: 'confirmed_mutation',
        reasonCode: 'REPEAT_OK',
        assessedAt: T3,
      });

      const rehydratedAss = await store.getOutcomeAssessment(ass1);
      assert.ok(rehydratedAss);
      assert.deepEqual(rehydratedAss.evidenceRefs, [evi1, evi1]);
    });

    it('SQL direto não consegue inserir event de Attempt inexistente (FK violation) (C8)', async () => {
      const ghostAttemptId = 'att_ghost_non_existent' as AttemptId;
      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO "nex_execution_attempt_events"
             ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
             VALUES ($1, $2, $3, $4, $5)`,
            [
              ghostAttemptId,
              1,
              'AttemptCreated',
              JSON.stringify({
                type: 'AttemptCreated',
                attemptId: ghostAttemptId,
                decisionId: DECISION_A,
                routeEvaluationId: ROUTE_EVAL_A,
                capabilityRevisionId: CAP_REV_A,
                bindingRevisionId: BIND_REV_A,
                routeRevisionId: ROUTE_REV_A,
                createdAt: T0,
              }),
              T0,
            ],
          );
        },
        (err: any) => err?.code === '23503',
      );
    });
  });

  // ==========================================================================
  // 5. CONCORRÊNCIA SEGURA EM OUTCOME ASSESSMENTS
  // ==========================================================================
  describe('5. Concorrência Segura em Outcome Assessments', () => {
    it('Duas assessments concorrentes tentando superseder a mesma head: apenas uma avança', async () => {
      const attId = `att_race_${Date.now()}` as AttemptId;
      const assInitial = `ass_initial_${Date.now()}` as OutcomeAssessmentId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assInitial,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'indeterminate',
        reasonCode: 'PENDING_CONFIRMATION',
        assessedAt: T1,
      });

      const assCandidateA: OutcomeAssessment = {
        assessmentId: `ass_race_A_${Date.now()}` as OutcomeAssessmentId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_mutation',
        reasonCode: 'A_WON',
        supersedesAssessmentId: assInitial,
        assessedAt: T2,
      };

      const assCandidateB: OutcomeAssessment = {
        assessmentId: `ass_race_B_${Date.now()}` as OutcomeAssessmentId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'B_WON',
        supersedesAssessmentId: assInitial,
        assessedAt: T2,
      };

      // Dispara em paralelo contra a mesma head
      const results = await Promise.allSettled([
        store.appendOutcomeAssessment(assCandidateA),
        store.appendOutcomeAssessment(assCandidateB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exatamente uma escrita deve ter sucesso.');
      assert.equal(rejected.length, 1, 'A escrita concorrente deve falhar.');

      const err = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        err instanceof InvalidAssessmentLineageError || err?.code === '23505',
        `Esperado erro de lineage ou unique, recebido: ${err?.message}`,
      );

      // Confirma que a head atual é unívoca
      const latest = await store.getLatestOutcomeAssessment(attId);
      assert.ok(latest);
      assert.ok(latest.assessmentId === assCandidateA.assessmentId || latest.assessmentId === assCandidateB.assessmentId);
    });

    it('Duas primeiras assessments concorrentes sem supersedes: exatamente uma vence e head fica unívoca (C9)', async () => {
      const attId = `att_race_first_${Date.now()}` as AttemptId;
      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      const assCandidateA: OutcomeAssessment = {
        assessmentId: `ass_first_A_${Date.now()}` as OutcomeAssessmentId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_mutation',
        reasonCode: 'FIRST_A',
        assessedAt: T1,
      };

      const assCandidateB: OutcomeAssessment = {
        assessmentId: `ass_first_B_${Date.now()}` as OutcomeAssessmentId,
        attemptId: attId,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'FIRST_B',
        assessedAt: T1,
      };

      // Dispara em paralelo como duas primeiras assessments (ambas sem supersedesAssessmentId)
      const results = await Promise.allSettled([
        store.appendOutcomeAssessment(assCandidateA),
        store.appendOutcomeAssessment(assCandidateB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exatamente uma primeira assessment deve vencer.');
      assert.equal(rejected.length, 1, 'A concorrente deve falhar deterministicamente.');

      const err = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        err instanceof InvalidAssessmentLineageError || err?.code === '23505',
        `Esperado erro de lineage ou unique na head, recebido: ${err?.message}`,
      );

      // Confirma que existe uma única head
      const latest = await store.getLatestOutcomeAssessment(attId);
      assert.ok(latest);
      assert.ok(latest.assessmentId === assCandidateA.assessmentId || latest.assessmentId === assCandidateB.assessmentId);

      // Confirma que assessment_count e histórico estão coerentes (exatamente 1 assessment registrada)
      const allAssessments = await store.listOutcomeAssessments(attId);
      assert.equal(allAssessments.length, 1);
      assert.equal(allAssessments[0].assessmentId, latest.assessmentId);

      const headRow = await pool.query(
        `SELECT assessment_count, latest_assessment_id FROM nex_execution_outcome_heads WHERE attempt_id = $1`,
        [attId],
      );
      assert.equal(headRow.rows.length, 1);
      assert.equal(headRow.rows[0].assessment_count, 1);
      assert.equal(headRow.rows[0].latest_assessment_id, latest.assessmentId);
    });
  });

  // ==========================================================================
  // 6. ATOMICIDADE DE TRANSAÇÃO (FAULT INJECTION REAL) (C6)
  // ==========================================================================
  describe('6. Atomicidade de Transação (Fault Injection Real)', () => {
    it('Fault injection real na segunda relation desfaz integralmente o header e a primeira relation (C6)', async () => {
      const attId = `att_fault_inj_${Date.now()}` as AttemptId;
      const sigId1 = `sig_fault_1_${Date.now()}` as ExecutionSignalId;
      const sigId2 = `sig_fault_2_${Date.now()}` as ExecutionSignalId;
      const eviId = `evi_fault_atomic_${Date.now()}` as ExecutionEvidenceId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      for (const sId of [sigId1, sigId2]) {
        await store.appendExecutionSignal({
          signalId: sId,
          attemptId: attId,
          kind: 'effect_observed',
          safeMetadata: {},
          provenance: PROVENANCE_TEST,
          observedAt: T1,
        });
      }

      // Cria executor com fault injection real:
      // Permite o INSERT do header de Evidence e o INSERT da primeira relation de sinal.
      // No INSERT da segunda relation dentro da mesma transação, injeta falha sintética.
      const faultExecutor: PgTransactionalExecutor = {
        query: async <T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> => {
          const res = await pool.query<any>(sql, params as any[]);
          return { rows: res.rows, rowCount: res.rowCount };
        },
        connect: async (): Promise<PgTransactionalClient> => {
          const client = await pool.connect();
          let relationCount = 0;
          const origQuery = client.query.bind(client);

          const wrappedClient: PgTransactionalClient = {
            query: async <T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> => {
              if (sql.includes('nex_execution_evidence_signals')) {
                relationCount++;
                if (relationCount === 2) {
                  // Falha forçada na segunda relation, após header e primeira relation terem sido enviados
                  throw new Error('FAULT_INJECTION_MID_TRANSACTION_SECOND_RELATION');
                }
              }
              const res = await (origQuery as any)(sql, params);
              return { rows: res.rows, rowCount: res.rowCount };
            },
            release: () => client.release(),
          };

          return wrappedClient;
        },
      };

      const faultStore = new PostgresExecutionLedgerStore(faultExecutor);

      await assert.rejects(
        async () => {
          await faultStore.appendExecutionEvidence({
            evidenceId: eviId,
            attemptId: attId,
            signalRefs: [sigId1, sigId2],
            kind: 'effect_observed',
            safeFacts: {},
            provenance: PROVENANCE_TEST,
            recordedAt: T2,
          });
        },
        (err: any) => err?.message === 'FAULT_INJECTION_MID_TRANSACTION_SECOND_RELATION',
      );

      // Prova com consulta direta fora da transação que o rollback foi 100% integral:
      // O header de evidence não existe
      const rawHeader = await pool.query(
        `SELECT * FROM "nex_execution_evidence" WHERE "evidence_id" = $1`,
        [eviId],
      );
      assert.equal(rawHeader.rows.length, 0, 'Header de Evidence deve ter sido removido pelo rollback.');

      // A primeira relation (que havia sido executada antes do erro) também foi removida pelo rollback
      const rawRelations = await pool.query(
        `SELECT * FROM "nex_execution_evidence_signals" WHERE "evidence_id" = $1`,
        [eviId],
      );
      assert.equal(rawRelations.rows.length, 0, 'Relations parciais devem ter sido removidas pelo rollback.');
    });
  });

  // ==========================================================================
  // 7. PROTEÇÃO APPEND-ONLY ESTRUTURAL NO POSTGRESQL (C10)
  // ==========================================================================
  describe('7. Proteção Estrutural Append-Only em Todas as 7 Tabelas (C10)', () => {
    const historicalTables = [
      { name: 'nex_execution_attempt_events', identCol: 'attempt_id' },
      { name: 'nex_execution_signals', identCol: 'signal_id' },
      { name: 'nex_execution_evidence', identCol: 'evidence_id' },
      { name: 'nex_execution_evidence_signals', identCol: 'position' },
      { name: 'nex_execution_outcome_assessments', identCol: 'assessment_id' },
      { name: 'nex_execution_outcome_evidence', identCol: 'position' },
      { name: 'nex_execution_receipts', identCol: 'receipt_id' },
    ];

    before(async () => {
      // Popula dados para que todas as 7 tabelas históricas tenham pelo menos 1 linha
      const attId = `att_trg_suite_${Date.now()}` as AttemptId;
      const sigId = `sig_trg_suite_${Date.now()}` as ExecutionSignalId;
      const eviId = `evi_trg_suite_${Date.now()}` as ExecutionEvidenceId;
      const assId = `ass_trg_suite_${Date.now()}` as OutcomeAssessmentId;
      const rcpId = `rcp_trg_suite_${Date.now()}` as ReceiptId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await store.appendExecutionSignal({
        signalId: sigId,
        attemptId: attId,
        kind: 'effect_observed',
        safeMetadata: {},
        provenance: PROVENANCE_TEST,
        observedAt: T1,
      });

      await store.appendExecutionEvidence({
        evidenceId: eviId,
        attemptId: attId,
        signalRefs: [sigId],
        kind: 'effect_observed',
        safeFacts: {},
        provenance: PROVENANCE_TEST,
        recordedAt: T2,
      });

      await store.appendOutcomeAssessment({
        assessmentId: assId,
        attemptId: attId,
        evidenceRefs: [eviId],
        verdict: 'confirmed_mutation',
        reasonCode: 'TRIGGER_SUITE',
        assessedAt: T3,
      });

      await store.appendReceipt({
        receiptId: rcpId,
        decisionId: DECISION_A,
        kind: 'execution_outcome',
        routeEvaluationId: ROUTE_EVAL_A,
        attemptId: attId,
        outcomeAssessmentId: assId,
        verdictSummary: 'confirmed_mutation',
        reasonCode: 'TRIGGER_SUITE',
        safeStructuredFacts: {},
        materializedAt: T4,
      });
    });

    for (const table of historicalTables) {
      it(`Tabela histórica ${table.name} rejeita UPDATE, DELETE e TRUNCATE via trigger append-only`, async () => {
        // UPDATE rejeitado
        await assert.rejects(
          async () => {
            await pool.query(`UPDATE "${table.name}" SET "${table.identCol}" = "${table.identCol}"`);
          },
          /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
        );

        // DELETE rejeitado
        await assert.rejects(
          async () => {
            await pool.query(`DELETE FROM "${table.name}"`);
          },
          /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
        );

        // TRUNCATE rejeitado
        await assert.rejects(
          async () => {
            await pool.query(`TRUNCATE "${table.name}" CASCADE`);
          },
          /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
        );
      });
    }

    it('Projeções operacionais (heads) continuam sendo mutáveis normalmente via adapter', async () => {
      const attId = `att_head_mut_${Date.now()}` as AttemptId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      // Transita para running (atualiza head)
      await store.appendAttemptEvent({
        type: 'AttemptStarted',
        attemptId: attId,
        startedAt: T1,
      });

      const head = await store.getAttempt(attId);
      assert.equal(head?.status, 'running');
      assert.equal(head?.startedAt, T1);
    });
  });

  // ==========================================================================
  // 8. TRUST BOUNDARY FAIL-CLOSED (CORRUPÇÃO) (C4)
  // ==========================================================================
  describe('8. Trust Boundary Fail-Closed (Corrupção Adversarial) (C4)', () => {
    it('Rejeita FactProvenance com source vazia', async () => {
      const attId = `att_c4_src_${Date.now()}` as AttemptId;
      const sigId = `sig_c4_src_${Date.now()}` as ExecutionSignalId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      const badProvenance = { ...PROVENANCE_TEST, source: '' };
      await pool.query(
        `INSERT INTO "nex_execution_signals"
         ("signal_id", "attempt_id", "kind", "safe_metadata", "provenance", "observed_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sigId, attId, 'effect_observed', JSON.stringify({}), JSON.stringify(badProvenance), T1],
      );

      await assert.rejects(
        async () => {
          await store.getExecutionSignal(sigId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita FactProvenance com acquisitionBasis inválido', async () => {
      const attId = `att_c4_acq_${Date.now()}` as AttemptId;
      const sigId = `sig_c4_acq_${Date.now()}` as ExecutionSignalId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      const badProvenance = { ...PROVENANCE_TEST, acquisitionBasis: 'telepathy' };
      await pool.query(
        `INSERT INTO "nex_execution_signals"
         ("signal_id", "attempt_id", "kind", "safe_metadata", "provenance", "observed_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sigId, attId, 'effect_observed', JSON.stringify({}), JSON.stringify(badProvenance), T1],
      );

      await assert.rejects(
        async () => {
          await store.getExecutionSignal(sigId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita FactProvenance com observedAt não-ISO ou inválido', async () => {
      const attId = `att_c4_obs_${Date.now()}` as AttemptId;
      const sigId = `sig_c4_obs_${Date.now()}` as ExecutionSignalId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      const badProvenance = { ...PROVENANCE_TEST, observedAt: 'invalid-date' };
      await pool.query(
        `INSERT INTO "nex_execution_signals"
         ("signal_id", "attempt_id", "kind", "safe_metadata", "provenance", "observed_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sigId, attId, 'effect_observed', JSON.stringify({}), JSON.stringify(badProvenance), T1],
      );

      await assert.rejects(
        async () => {
          await store.getExecutionSignal(sigId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita AttemptEvent com payload.type divergente de event_type', async () => {
      const attId = `att_c4_type_${Date.now()}` as AttemptId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      // Insere evento com event_type = AttemptStarted mas payload.type = AttemptTerminal
      await pool.query(
        `INSERT INTO "nex_execution_attempt_events"
         ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          attId,
          2,
          'AttemptStarted',
          JSON.stringify({
            type: 'AttemptTerminal',
            attemptId: attId,
            terminalStatus: 'succeeded',
            finishedAt: T1,
          }),
          T1,
        ],
      );

      await assert.rejects(
        async () => {
          await store.listAttemptEvents(attId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita AttemptStarted com divergência material de timestamp entre payload e occurred_at', async () => {
      const attId = `att_c4_drift_${Date.now()}` as AttemptId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await pool.query(
        `INSERT INTO "nex_execution_attempt_events"
         ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          attId,
          2,
          'AttemptStarted',
          JSON.stringify({
            type: 'AttemptStarted',
            attemptId: attId,
            startedAt: '2026-09-25T15:00:00.000Z', // Divergência material contra occurred_at
          }),
          '2026-09-25T12:00:00.000Z',
        ],
      );

      await assert.rejects(
        async () => {
          await store.listAttemptEvents(attId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita AttemptTerminal com terminalStatus inválido no payload', async () => {
      const attId = `att_c4_term_${Date.now()}` as AttemptId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await pool.query(
        `INSERT INTO "nex_execution_attempt_events"
         ("attempt_id", "sequence_number", "event_type", "event_payload", "occurred_at")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          attId,
          2,
          'AttemptTerminal',
          JSON.stringify({
            type: 'AttemptTerminal',
            attemptId: attId,
            terminalStatus: 'exploded_into_space', // Status inválido
            finishedAt: T1,
          }),
          T1,
        ],
      );

      await assert.rejects(
        async () => {
          await store.listAttemptEvents(attId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('DB rejeita noSideEffectGuarantee fora da restrição CHECK estrutural (C4)', async () => {
      const attId = `att_c4_side_${Date.now()}` as AttemptId;
      const eviId = `evi_c4_side_${Date.now()}` as ExecutionEvidenceId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO "nex_execution_evidence"
             ("evidence_id", "attempt_id", "kind", "safe_facts", "provenance", "no_side_effect_guarantee", "recorded_at")
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              eviId,
              attId,
              'effect_observed',
              JSON.stringify({}),
              JSON.stringify(PROVENANCE_TEST),
              'maybe_safe', // valor inválido rejeitado pelo CHECK
              T1,
            ],
          );
        },
        (err: any) => err?.code === '23514',
      );
    });

    it('Rejeita Evidence com safeFacts adulterado no DB (C4)', async () => {
      const attId = `att_c4_facts_${Date.now()}` as AttemptId;
      const eviId = `evi_c4_facts_${Date.now()}` as ExecutionEvidenceId;

      await store.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attId,
        decisionId: DECISION_A,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T0,
      });

      await pool.query(
        `INSERT INTO "nex_execution_evidence"
         ("evidence_id", "attempt_id", "kind", "safe_facts", "provenance", "no_side_effect_guarantee", "recorded_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          eviId,
          attId,
          'effect_observed',
          JSON.stringify(['corrupted_array']), // array em vez de plain object
          JSON.stringify(PROVENANCE_TEST),
          'structural',
          T1,
        ],
      );

      await assert.rejects(
        async () => {
          await store.getExecutionEvidence(eviId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });
  });

  // ==========================================================================
  // 9. PRESERVAÇÃO DE ORDEM OBSERVÁVEL DO STORE VIGENTE (C5)
  // ==========================================================================
  describe('9. Preservação de Ordem Observável (C5)', () => {
    it('Preserva estritamente a ordem de append com timestamps não-monotônicos e idênticos, compatível com store in-memory', async () => {
      const memStore = createExecutionLedgerStore();

      // 1. Attempts com timestamps fora de ordem
      const attId1 = `att_c5_seq1_${Date.now()}` as AttemptId;
      const attId2 = `att_c5_seq2_${Date.now()}` as AttemptId;
      const attId3 = `att_c5_seq3_${Date.now()}` as AttemptId;

      const attDefs = [
        { id: attId1, time: T3 }, // Criado com timestamp futuro
        { id: attId2, time: T1 }, // Criado com timestamp passado
        { id: attId3, time: T1 }, // Criado com timestamp idêntico
      ];

      for (const def of attDefs) {
        const evt: AttemptCreatedEvent = {
          type: 'AttemptCreated',
          attemptId: def.id,
          decisionId: DECISION_A,
          routeEvaluationId: ROUTE_EVAL_A,
          capabilityRevisionId: CAP_REV_A,
          bindingRevisionId: BIND_REV_A,
          routeRevisionId: ROUTE_REV_A,
          createdAt: def.time,
        };
        await memStore.appendAttemptEvent(evt);
        await store.appendAttemptEvent(evt);
      }

      // 2. Signals no attId1 com timestamps fora de ordem
      const sig1 = `sig_c5_1_${Date.now()}` as ExecutionSignalId;
      const sig2 = `sig_c5_2_${Date.now()}` as ExecutionSignalId;
      const sig3 = `sig_c5_3_${Date.now()}` as ExecutionSignalId;

      const sigDefs: ExecutionSignal[] = [
        {
          signalId: sig1,
          attemptId: attId1,
          kind: 'effect_observed',
          safeMetadata: {},
          provenance: PROVENANCE_TEST,
          observedAt: T4, // T4
        },
        {
          signalId: sig2,
          attemptId: attId1,
          kind: 'effect_observed',
          safeMetadata: {},
          provenance: PROVENANCE_TEST,
          observedAt: T1, // T1
        },
        {
          signalId: sig3,
          attemptId: attId1,
          kind: 'effect_observed',
          safeMetadata: {},
          provenance: PROVENANCE_TEST,
          observedAt: T2, // T2
        },
      ];

      for (const sig of sigDefs) {
        await memStore.appendExecutionSignal(sig);
        await store.appendExecutionSignal(sig);
      }

      const memSignals = await memStore.listExecutionSignals(attId1);
      const pgSignals = await store.listExecutionSignals(attId1);

      assert.deepEqual(
        pgSignals.map((s) => s.signalId),
        [sig1, sig2, sig3],
        'Postgres listExecutionSignals deve respeitar ordem de append, não observedAt.',
      );
      assert.deepEqual(
        pgSignals.map((s) => s.signalId),
        memSignals.map((s) => s.signalId),
        'Ordem observável do Postgres deve ser idêntica ao store in-memory.',
      );

      // 3. Evidence no attId1 com timestamps fora de ordem
      const evi1 = `evi_c5_1_${Date.now()}` as ExecutionEvidenceId;
      const evi2 = `evi_c5_2_${Date.now()}` as ExecutionEvidenceId;
      const eviDefs: ExecutionEvidence[] = [
        {
          evidenceId: evi1,
          attemptId: attId1,
          signalRefs: [sig1],
          kind: 'effect_observed',
          safeFacts: {},
          provenance: PROVENANCE_TEST,
          recordedAt: T4,
        },
        {
          evidenceId: evi2,
          attemptId: attId1,
          signalRefs: [sig2],
          kind: 'effect_observed',
          safeFacts: {},
          provenance: PROVENANCE_TEST,
          recordedAt: T1,
        },
      ];

      for (const evi of eviDefs) {
        await memStore.appendExecutionEvidence(evi);
        await store.appendExecutionEvidence(evi);
      }

      const memEvi = await memStore.listExecutionEvidence(attId1);
      const pgEvi = await store.listExecutionEvidence(attId1);

      assert.deepEqual(
        pgEvi.map((e) => e.evidenceId),
        [evi1, evi2],
      );
      assert.deepEqual(
        pgEvi.map((e) => e.evidenceId),
        memEvi.map((e) => e.evidenceId),
      );

      // 4. OutcomeAssessments no attId1 com supersedes e timestamps não-monotônicos
      const ass1 = `ass_c5_1_${Date.now()}` as OutcomeAssessmentId;
      const ass2 = `ass_c5_2_${Date.now()}` as OutcomeAssessmentId;

      const assDefs: OutcomeAssessment[] = [
        {
          assessmentId: ass1,
          attemptId: attId1,
          evidenceRefs: [evi1],
          verdict: 'indeterminate',
          reasonCode: 'INIT',
          assessedAt: T2,
        },
        {
          assessmentId: ass2,
          attemptId: attId1,
          evidenceRefs: [evi1],
          verdict: 'confirmed_mutation',
          reasonCode: 'SECOND',
          supersedesAssessmentId: ass1,
          assessedAt: T1, // Anterior no timestamp ao ass1, mas inserido depois
        },
      ];

      for (const ass of assDefs) {
        await memStore.appendOutcomeAssessment(ass);
        await store.appendOutcomeAssessment(ass);
      }

      const memAss = await memStore.listOutcomeAssessments(attId1);
      const pgAss = await store.listOutcomeAssessments(attId1);

      assert.deepEqual(
        pgAss.map((a) => a.assessmentId),
        [ass1, ass2],
      );
      assert.deepEqual(
        pgAss.map((a) => a.assessmentId),
        memAss.map((a) => a.assessmentId),
      );
    });

    it('C5 Pós-Restart: Persiste Attempts, Signals, Evidence, OutcomeAssessments e Receipts em ordem de append conhecida com timestamps iguais/não-monotônicos, encerra Pool/Store e reidrata provando append_sequence em todas as listagens', async () => {
      // 1. Store e Pool de Escrita dedicado
      const poolWriter = new Pool({ connectionString: databaseUrl, max: 5 });
      const storeWriter = createPostgresExecutionLedgerStore(poolWriter);

      const decC5 = `dec_c5_restart_${Date.now()}` as DecisionId;
      const attA = `att_c5_rst_a_${Date.now()}` as AttemptId;
      const attB = `att_c5_rst_b_${Date.now()}` as AttemptId;
      const attC = `att_c5_rst_c_${Date.now()}` as AttemptId;

      // A. Attempts: append em ordem A, B, C com timestamps não-monotônicos e iguais
      await storeWriter.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attA,
        decisionId: decC5,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T3, // Futuro
      });

      await storeWriter.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attB,
        decisionId: decC5,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T1, // Passado (não monotônico)
      });

      await storeWriter.appendAttemptEvent({
        type: 'AttemptCreated',
        attemptId: attC,
        decisionId: decC5,
        routeEvaluationId: ROUTE_EVAL_A,
        capabilityRevisionId: CAP_REV_A,
        bindingRevisionId: BIND_REV_A,
        routeRevisionId: ROUTE_REV_A,
        createdAt: T1, // Timestamp idêntico a attB
      });

      // B. Events de attA com timestamps iguais e transições de ciclo de vida
      await storeWriter.appendAttemptEvent({
        type: 'AttemptStarted',
        attemptId: attA,
        startedAt: T0,
      });

      await storeWriter.appendAttemptEvent({
        type: 'AttemptTerminal',
        attemptId: attA,
        terminalStatus: 'succeeded',
        finishedAt: T0, // Idêntico a startedAt
      });

      // C. Signals em attA: ordem de append sig1, sig2, sig3, sig4 com timestamps não-monotônicos e iguais
      const sig1 = `sig_c5_rst_1_${Date.now()}` as ExecutionSignalId;
      const sig2 = `sig_c5_rst_2_${Date.now()}` as ExecutionSignalId;
      const sig3 = `sig_c5_rst_3_${Date.now()}` as ExecutionSignalId;
      const sig4 = `sig_c5_rst_4_${Date.now()}` as ExecutionSignalId;

      await storeWriter.appendExecutionSignal({
        signalId: sig1,
        attemptId: attA,
        kind: 'effect_observed',
        safeMetadata: { seq: 1 },
        provenance: PROVENANCE_TEST,
        observedAt: T4, // Mais recente
      });

      await storeWriter.appendExecutionSignal({
        signalId: sig2,
        attemptId: attA,
        kind: 'effect_observed',
        safeMetadata: { seq: 2 },
        provenance: PROVENANCE_TEST,
        observedAt: T1, // Anterior (não monotônico)
      });

      await storeWriter.appendExecutionSignal({
        signalId: sig3,
        attemptId: attA,
        kind: 'effect_observed',
        safeMetadata: { seq: 3 },
        provenance: PROVENANCE_TEST,
        observedAt: T2,
      });

      await storeWriter.appendExecutionSignal({
        signalId: sig4,
        attemptId: attA,
        kind: 'effect_observed',
        safeMetadata: { seq: 4 },
        provenance: PROVENANCE_TEST,
        observedAt: T2, // Timestamp idêntico a sig3
      });

      // D. Evidence em attA: ordem evi1, evi2, evi3, evi4 com timestamps não-monotônicos e iguais
      const evi1 = `evi_c5_rst_1_${Date.now()}` as ExecutionEvidenceId;
      const evi2 = `evi_c5_rst_2_${Date.now()}` as ExecutionEvidenceId;
      const evi3 = `evi_c5_rst_3_${Date.now()}` as ExecutionEvidenceId;
      const evi4 = `evi_c5_rst_4_${Date.now()}` as ExecutionEvidenceId;

      await storeWriter.appendExecutionEvidence({
        evidenceId: evi1,
        attemptId: attA,
        signalRefs: [sig1],
        kind: 'effect_observed',
        safeFacts: { seq: 1 },
        provenance: PROVENANCE_TEST,
        recordedAt: T4,
      });

      await storeWriter.appendExecutionEvidence({
        evidenceId: evi2,
        attemptId: attA,
        signalRefs: [sig2],
        kind: 'effect_observed',
        safeFacts: { seq: 2 },
        provenance: PROVENANCE_TEST,
        recordedAt: T1, // Não monotônico
      });

      await storeWriter.appendExecutionEvidence({
        evidenceId: evi3,
        attemptId: attA,
        signalRefs: [sig3],
        kind: 'effect_observed',
        safeFacts: { seq: 3 },
        provenance: PROVENANCE_TEST,
        recordedAt: T2,
      });

      await storeWriter.appendExecutionEvidence({
        evidenceId: evi4,
        attemptId: attA,
        signalRefs: [sig4],
        kind: 'effect_observed',
        safeFacts: { seq: 4 },
        provenance: PROVENANCE_TEST,
        recordedAt: T2, // Timestamp idêntico
      });

      // E. OutcomeAssessments em attA: ordem ass1, ass2, ass3 com timestamps não-monotônicos
      const ass1 = `ass_c5_rst_1_${Date.now()}` as OutcomeAssessmentId;
      const ass2 = `ass_c5_rst_2_${Date.now()}` as OutcomeAssessmentId;
      const ass3 = `ass_c5_rst_3_${Date.now()}` as OutcomeAssessmentId;

      await storeWriter.appendOutcomeAssessment({
        assessmentId: ass1,
        attemptId: attA,
        evidenceRefs: [evi1],
        verdict: 'indeterminate',
        reasonCode: 'INITIAL_PASS',
        assessedAt: T4,
      });

      await storeWriter.appendOutcomeAssessment({
        assessmentId: ass2,
        attemptId: attA,
        evidenceRefs: [evi2],
        verdict: 'confirmed_mutation',
        reasonCode: 'SECOND_PASS',
        supersedesAssessmentId: ass1,
        assessedAt: T1, // Não monotônico
      });

      await storeWriter.appendOutcomeAssessment({
        assessmentId: ass3,
        attemptId: attA,
        evidenceRefs: [evi3, evi4],
        verdict: 'confirmed_mutation',
        reasonCode: 'FINAL_PASS',
        supersedesAssessmentId: ass2,
        assessedAt: T2,
      });

      // F. Receipts em decC5: ordem rcp1..rcp5 com timestamps variados/iguais
      const rcp1 = `rcp_c5_rst_1_${Date.now()}` as ReceiptId;
      const rcp2 = `rcp_c5_rst_2_${Date.now()}` as ReceiptId;
      const rcp3 = `rcp_c5_rst_3_${Date.now()}` as ReceiptId;
      const rcp4 = `rcp_c5_rst_4_${Date.now()}` as ReceiptId;
      const rcp5 = `rcp_c5_rst_5_${Date.now()}` as ReceiptId;

      await storeWriter.appendReceipt({
        receiptId: rcp1,
        decisionId: decC5,
        kind: 'policy_denial',
        verdictSummary: 'denied',
        reasonCode: 'POLICY_LIMIT',
        safeStructuredFacts: { seq: 1 },
        materializedAt: T3,
      });

      await storeWriter.appendReceipt({
        receiptId: rcp2,
        decisionId: decC5,
        kind: 'authorization_denial',
        verdictSummary: 'auth_denied',
        reasonCode: 'AUTH_REQUIRED',
        safeStructuredFacts: { seq: 2 },
        materializedAt: T1, // Não monotônico
      });

      await storeWriter.appendReceipt({
        receiptId: rcp3,
        decisionId: decC5,
        kind: 'cancelled',
        verdictSummary: 'cancelled_user',
        reasonCode: 'USER_ABORT',
        safeStructuredFacts: { seq: 3 },
        materializedAt: T4,
      });

      await storeWriter.appendReceipt({
        receiptId: rcp4,
        decisionId: decC5,
        kind: 'no_eligible_route',
        verdictSummary: 'no_route',
        reasonCode: 'CAPABILITY_UNAVAILABLE',
        safeStructuredFacts: { seq: 4 },
        materializedAt: T2,
      });

      await storeWriter.appendReceipt({
        receiptId: rcp5,
        decisionId: decC5,
        kind: 'execution_outcome',
        routeEvaluationId: ROUTE_EVAL_A,
        attemptId: attA,
        outcomeAssessmentId: ass3,
        verdictSummary: 'confirmed_mutation',
        reasonCode: 'MUTATION_EXECUTED',
        safeStructuredFacts: { seq: 5 },
        materializedAt: T2, // Timestamp idêntico a rcp4
      });

      // 7. DESCARTE / ENCERRAMENTO COMPLETO da instância/pool de escrita
      await poolWriter.end();

      // 8. CRIAÇÃO DE NOVA POOL/STORE INDEPENDENTE para reidratação exclusiva do PostgreSQL
      const poolReader = new Pool({ connectionString: databaseUrl, max: 5 });
      try {
        const storeReader = createPostgresExecutionLedgerStore(poolReader);

        // A. Prova de Attempts (listAttempts preserva append_sequence)
        const rehydratedAttempts = await storeReader.listAttempts(decC5);
        assert.deepEqual(
          rehydratedAttempts.map((a) => a.attemptId),
          [attA, attB, attC],
          'listAttempts deve preservar estritamente a ordem de append via append_sequence.',
        );

        // B. Prova de Attempt Events (listAttemptEvents preserva sequence_number)
        const rehydratedEvents = await storeReader.listAttemptEvents(attA);
        assert.deepEqual(
          rehydratedEvents.map((e) => e.type),
          ['AttemptCreated', 'AttemptStarted', 'AttemptTerminal'],
          'listAttemptEvents deve preservar estritamente a sequência histórica.',
        );

        // C. Prova de Signals (listExecutionSignals preserva append_sequence)
        const rehydratedSignals = await storeReader.listExecutionSignals(attA);
        assert.deepEqual(
          rehydratedSignals.map((s) => s.signalId),
          [sig1, sig2, sig3, sig4],
          'listExecutionSignals deve preservar estritamente a ordem de append via append_sequence.',
        );

        // D. Prova de Evidence (listExecutionEvidence preserva append_sequence)
        const rehydratedEvidence = await storeReader.listExecutionEvidence(attA);
        assert.deepEqual(
          rehydratedEvidence.map((e) => e.evidenceId),
          [evi1, evi2, evi3, evi4],
          'listExecutionEvidence deve preservar estritamente a ordem de append via append_sequence.',
        );

        // E. Prova de OutcomeAssessments (listOutcomeAssessments preserva append_sequence)
        const rehydratedAssessments = await storeReader.listOutcomeAssessments(attA);
        assert.deepEqual(
          rehydratedAssessments.map((a) => a.assessmentId),
          [ass1, ass2, ass3],
          'listOutcomeAssessments deve preservar estritamente a ordem de append via append_sequence.',
        );

        const latestAssessment = await storeReader.getLatestOutcomeAssessment(attA);
        assert.equal(
          latestAssessment?.assessmentId,
          ass3,
          'getLatestOutcomeAssessment deve retornar a head mais recente da linhagem.',
        );

        // F. Prova de Receipts (listReceipts preserva append_sequence)
        const rehydratedReceipts = await storeReader.listReceipts(decC5);
        assert.deepEqual(
          rehydratedReceipts.map((r) => r.receiptId),
          [rcp1, rcp2, rcp3, rcp4, rcp5],
          'listReceipts deve preservar estritamente a ordem de append via append_sequence.',
        );
      } finally {
        await poolReader.end();
      }
    });
  });

  // ==========================================================================
  // 10. HARDENING ADICIONAL DE RECEIPTS & FAIL-CLOSED
  // ==========================================================================
  describe('10. Hardening Adicional de Receipts & Fail-Closed', () => {
    it('Roundtrip de policy_denial, authorization_denial, cancelled e no_eligible_route confirmando materializedAt e refs ausentes', async () => {
      const decId = `dec_roundtrip_${Date.now()}` as DecisionId;

      const nonOutcomeReceipts: Receipt[] = [
        {
          receiptId: `rcp_pol_${Date.now()}` as ReceiptId,
          decisionId: decId,
          kind: 'policy_denial',
          verdictSummary: 'policy_violation',
          reasonCode: 'POLICY_DISALLOWED',
          safeStructuredFacts: { rule: 'P01' },
          materializedAt: T1,
        },
        {
          receiptId: `rcp_auth_${Date.now()}` as ReceiptId,
          decisionId: decId,
          kind: 'authorization_denial',
          verdictSummary: 'auth_required',
          reasonCode: 'INSUFFICIENT_SCOPE',
          safeStructuredFacts: { scope: 'admin' },
          materializedAt: T2,
        },
        {
          receiptId: `rcp_canc_${Date.now()}` as ReceiptId,
          decisionId: decId,
          kind: 'cancelled',
          verdictSummary: 'user_cancelled',
          reasonCode: 'ABORTED',
          safeStructuredFacts: { caller: 'client' },
          materializedAt: T3,
        },
        {
          receiptId: `rcp_noroute_${Date.now()}` as ReceiptId,
          decisionId: decId,
          kind: 'no_eligible_route',
          verdictSummary: 'no_route_found',
          reasonCode: 'ROUTING_FAILED',
          safeStructuredFacts: { attemptedCandidates: 0 },
          materializedAt: T4,
        },
      ];

      for (const rcp of nonOutcomeReceipts) {
        await store.appendReceipt(rcp);

        const loaded = await store.getReceipt(rcp.receiptId);
        assert.ok(loaded, `Receipt ${rcp.receiptId} deve ser encontrado no PostgreSQL`);
        assert.equal(loaded.receiptId, rcp.receiptId);
        assert.equal(loaded.decisionId, decId);
        assert.equal(loaded.kind, rcp.kind);
        assert.equal(loaded.verdictSummary, rcp.verdictSummary);
        assert.equal(loaded.reasonCode, rcp.reasonCode);
        assert.equal(loaded.materializedAt, rcp.materializedAt);
        assert.deepEqual(loaded.safeStructuredFacts, rcp.safeStructuredFacts);

        // Confirma estritamente ausência de referências a Attempt
        const untyped = loaded as any;
        assert.equal(untyped.attemptId, undefined, `Receipt ${rcp.kind} não deve ter attemptId`);
        assert.equal(untyped.outcomeAssessmentId, undefined, `Receipt ${rcp.kind} não deve ter outcomeAssessmentId`);
        assert.equal(untyped.routeEvaluationId, undefined, `Receipt ${rcp.kind} não deve ter routeEvaluationId`);
      }
    });

    it('Fail-closed do getLatestOutcomeAssessment para head estruturalmente incoerente', async () => {
      const attId = 'att_stub_incoherent' as AttemptId;

      // 1. Head aponta para assessment_id inexistente (null retornado pelo LEFT JOIN)
      const stubExecutorMissingAss: PgTransactionalExecutor = {
        async query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> {
          if (sql.includes('nex_execution_outcome_heads')) {
            return {
              rows: [{
                latest_assessment_id: 'ass_ghost_id',
                assessment_id: null,
                assessment_attempt_id: null,
              }] as any,
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        async connect(): Promise<PgTransactionalClient> {
          return {
            async query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> {
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
      };

      const storeMissingAss = new PostgresExecutionLedgerStore(stubExecutorMissingAss);
      await assert.rejects(
        async () => {
          await storeMissingAss.getLatestOutcomeAssessment(attId);
        },
        (err: any) => {
          assert.ok(err instanceof CorruptedLedgerRowError);
          assert.equal(err.table, 'nex_execution_outcome_heads');
          assert.equal(err.entityId, attId);
          assert.match(err.message, /references non-existent assessment/i);
          return true;
        },
      );

      // 2. Head aponta para assessment pertencente a outro attempt
      const stubExecutorCrossAttempt: PgTransactionalExecutor = {
        async query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> {
          if (sql.includes('nex_execution_outcome_heads')) {
            return {
              rows: [{
                latest_assessment_id: 'ass_alien_id',
                assessment_id: 'ass_alien_id',
                assessment_attempt_id: 'att_other_alien_attempt',
              }] as any,
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        async connect(): Promise<PgTransactionalClient> {
          return {
            async query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> {
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
      };

      const storeCrossAttempt = new PostgresExecutionLedgerStore(stubExecutorCrossAttempt);
      await assert.rejects(
        async () => {
          await storeCrossAttempt.getLatestOutcomeAssessment(attId);
        },
        (err: any) => {
          assert.ok(err instanceof CrossAttemptReferenceError);
          assert.match(err.message, /Outcome head for Attempt.*points to assessment.*belonging to Attempt/i);
          return true;
        },
      );
    });
  });
});
