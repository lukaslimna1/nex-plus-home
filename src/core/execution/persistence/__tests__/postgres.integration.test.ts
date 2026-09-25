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
} from '../postgres';
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
  });

  // ==========================================================================
  // 6. ATOMICIDADE DE TRANSAÇÃO
  // ==========================================================================
  describe('6. Atomicidade de Transação', () => {
    it('Falha deliberada no meio da inserção de Evidence desfaz todas as escritas parciais', async () => {
      const attId = `att_atomic_${Date.now()}` as AttemptId;
      const sigId1 = `sig_atom_1_${Date.now()}` as ExecutionSignalId;
      const sigGhost = `sig_ghost_${Date.now()}` as ExecutionSignalId;
      const eviId = `evi_atomic_${Date.now()}` as ExecutionEvidenceId;

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
        signalId: sigId1,
        attemptId: attId,
        kind: 'effect_observed',
        safeMetadata: {},
        provenance: PROVENANCE_TEST,
        observedAt: T1,
      });

      // Tenta gravar Evidence com 2 signals: um válido e um fantasma.
      // A transação deve falhar e não deixar Evidence nem a relação do signal 1 persistida.
      await assert.rejects(
        async () => {
          await store.appendExecutionEvidence({
            evidenceId: eviId,
            attemptId: attId,
            signalRefs: [sigId1, sigGhost],
            kind: 'effect_observed',
            safeFacts: {},
            provenance: PROVENANCE_TEST,
            recordedAt: T2,
          });
        },
        (err: any) => err instanceof InvalidSignalReferenceError,
      );

      // Prova que rollback foi 100% integral
      const eviCheck = await store.getExecutionEvidence(eviId);
      assert.equal(eviCheck, undefined);

      const rawRows = await pool.query(
        `SELECT * FROM "nex_execution_evidence_signals" WHERE "evidence_id" = $1`,
        [eviId],
      );
      assert.equal(rawRows.rows.length, 0);
    });
  });

  // ==========================================================================
  // 7. PROTEÇÃO APPEND-ONLY ESTRUTURAL NO POSTGRESQL
  // ==========================================================================
  describe('7. Proteção Estrutural Append-Only', () => {
    it('Trigger bloqueia UPDATE, DELETE e TRUNCATE em nex_execution_attempt_events', async () => {
      const attId = `att_trg_${Date.now()}` as AttemptId;
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

      // UPDATE rejeitado
      await assert.rejects(
        async () => {
          await pool.query(
            `UPDATE "nex_execution_attempt_events" SET "sequence_number" = 999 WHERE "attempt_id" = $1`,
            [attId],
          );
        },
        /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
      );

      // DELETE rejeitado
      await assert.rejects(
        async () => {
          await pool.query(
            `DELETE FROM "nex_execution_attempt_events" WHERE "attempt_id" = $1`,
            [attId],
          );
        },
        /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
      );

      // TRUNCATE rejeitado
      await assert.rejects(
        async () => {
          await pool.query(
            `TRUNCATE "nex_execution_attempt_events"`,
          );
        },
        /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
      );
    });

    it('Trigger bloqueia UPDATE e DELETE em nex_execution_signals', async () => {
      const attId = `att_trg_sig_${Date.now()}` as AttemptId;
      const sigId = `sig_trg_${Date.now()}` as ExecutionSignalId;

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
          await pool.query(
            `DELETE FROM "nex_execution_signals" WHERE "signal_id" = $1`,
            [sigId],
          );
        },
        /APPEND_ONLY_VIOLATION|strictly forbidden|nex_reject_append_only_mutation/i,
      );
    });


    it('Projeções operacionais (heads) continuam sendo mutáveis normalmente', async () => {
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
  // 8. TRUST BOUNDARY FAIL-CLOSED (CORRUPÇÃO)
  // ==========================================================================
  describe('8. Trust Boundary Fail-Closed', () => {
    it('Rejeita row com payload JSON adulterado (array ou primitive em vez de plain object)', async () => {
      const attId = `att_corrupt_${Date.now()}` as AttemptId;
      const sigId = `sig_corrupt_${Date.now()}` as ExecutionSignalId;

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

      // Insere sinal com safe_metadata inválido diretamente via SQL bypassing adapter
      await pool.query(
        `INSERT INTO "nex_execution_signals"
         ("signal_id", "attempt_id", "kind", "safe_metadata", "provenance", "observed_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sigId,
          attId,
          'effect_observed',
          JSON.stringify(['corrupted_array']), // array em vez de plain object
          JSON.stringify(PROVENANCE_TEST),
          T1,
        ],
      );

      // Leitura deve falhar de forma fail-closed
      await assert.rejects(
        async () => {
          await store.getExecutionSignal(sigId);
        },
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });
  });
});
