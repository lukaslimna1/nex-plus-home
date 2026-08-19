/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Testes Determinísticos de L0 — Escopo 0.5 (Bloco 0.5D)
 *
 * Suíte Completa: 45 Testes de Aceitação Obrigatórios.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  FactProvenance,
} from '../../capabilities/contracts';

import type {
  PolicyKey,
  PolicyRevision,
  PolicyRevisionId,
  PolicyDecision,
  HumanAuthorizationDecision,
} from '../../policy/contracts';

import type {
  DecisionId,
  RouteEvaluationId,
  AttemptId,
  ExecutionSignalId,
  ExecutionEvidenceId,
  OutcomeAssessmentId,
  ReceiptId,
  AttemptCreatedEvent,
  AttemptStartedEvent,
  AttemptTerminalEvent,
  ExecutionSignal,
  ExecutionEvidence,
} from '../contracts';

import {
  projectSafePayload,
  canonicalizeSignalToEvidence,
} from '../evidence';

import { assessOutcome } from '../outcome';

import {
  materializeExecutionReceipt,
  materializePolicyDenialReceipt,
  materializeAuthorizationDenialReceipt,
  materializeNoEligibleRouteReceipt,
  materializeCancelledReceipt,
} from '../receipt';

import {
  createExecutionLedgerStore,
  DuplicateIdError,
  InvalidAttemptTransitionError,
  InvalidAttemptReferenceError,
  InvalidSignalReferenceError,
  InvalidAssessmentReferenceError,
  CrossAttemptReferenceError,
} from '../ledger';

const defaultProvenance: FactProvenance = {
  source: 'direct_probe',
  acquisitionBasis: 'measured',
  verificationStatus: 'corroborated',
  observedAt: '2026-08-19T18:40:00.000Z',
};

describe('NEX+ L0 ExecutionEvidence & Attempt Ledger (Bloco 0.5D)', () => {
  // 1. Attempt created válido
  it('1. Attempt created válido', () => {
    const ledger = createExecutionLedgerStore();
    const event: AttemptCreatedEvent = {
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    ledger.appendAttemptEvent(event);
    const attempt = ledger.getAttempt('att_01' as AttemptId);

    assert.ok(attempt);
    assert.equal(attempt.status, 'created');
    assert.equal(attempt.attemptId, 'att_01');
  });

  // 2. created → running válido
  it('2. created → running válido', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    const startEvent: AttemptStartedEvent = {
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    };
    ledger.appendAttemptEvent(startEvent);

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'running');
    assert.equal(attempt?.startedAt, '2026-08-19T18:40:01.000Z');
  });

  // 3. running → succeeded válido
  it('3. running → succeeded válido', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'succeeded',
      finishedAt: '2026-08-19T18:40:02.000Z',
    });

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'succeeded');
    assert.equal(attempt?.finishedAt, '2026-08-19T18:40:02.000Z');
  });

  // 4. running → failed válido
  it('4. running → failed válido', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'failed',
      terminalReason: 'ECONNREFUSED',
      finishedAt: '2026-08-19T18:40:02.000Z',
    });

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'failed');
    assert.equal(attempt?.terminalReason, 'ECONNREFUSED');
  });

  // 5. running → timed_out válido
  it('5. running → timed_out válido', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'timed_out',
      terminalReason: 'Execution exceeded 5000ms deadline',
      finishedAt: '2026-08-19T18:40:06.000Z',
    });

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'timed_out');
  });

  // 6. running → cancelled válido
  it('6. running → cancelled válido', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'cancelled',
      terminalReason: 'User aborted stream',
      finishedAt: '2026-08-19T18:40:03.000Z',
    });

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'cancelled');
  });

  // 7. running → unknown_completion válido
  it('7. running → unknown_completion válido', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'unknown_completion',
      terminalReason: 'Process crashed abruptly',
      finishedAt: '2026-08-19T18:40:04.000Z',
    });

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'unknown_completion');
  });

  // 8. created → succeeded direto rejeitado
  it('8. created → succeeded direto rejeitado', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    assert.throws(
      () =>
        ledger.appendAttemptEvent({
          type: 'AttemptTerminal',
          attemptId: 'att_01' as AttemptId,
          terminalStatus: 'succeeded',
          finishedAt: '2026-08-19T18:40:02.000Z',
        }),
      InvalidAttemptTransitionError,
    );
  });

  // 9. terminal → running rejeitado
  it('9. terminal → running rejeitado', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'succeeded',
      finishedAt: '2026-08-19T18:40:02.000Z',
    });

    assert.throws(
      () =>
        ledger.appendAttemptEvent({
          type: 'AttemptStarted',
          attemptId: 'att_01' as AttemptId,
          startedAt: '2026-08-19T18:40:03.000Z',
        }),
      InvalidAttemptTransitionError,
    );
  });

  // 10. segundo terminal rejeitado
  it('10. segundo terminal rejeitado', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'succeeded',
      finishedAt: '2026-08-19T18:40:02.000Z',
    });

    assert.throws(
      () =>
        ledger.appendAttemptEvent({
          type: 'AttemptTerminal',
          attemptId: 'att_01' as AttemptId,
          terminalStatus: 'failed',
          finishedAt: '2026-08-19T18:40:03.000Z',
        }),
      InvalidAttemptTransitionError,
    );
  });

  // 11. duplicate AttemptId rejeitado
  it('11. duplicate AttemptId rejeitado', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    assert.throws(
      () =>
        ledger.appendAttemptEvent({
          type: 'AttemptCreated',
          attemptId: 'att_01' as AttemptId,
          decisionId: 'dec_02' as DecisionId,
          routeEvaluationId: 'eval_02' as RouteEvaluationId,
          capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
          bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
          routeRevisionId: 'route_rev_01' as RouteRevisionId,
          createdAt: '2026-08-19T18:40:05.000Z',
        }),
      DuplicateIdError,
    );
  });

  // 12. Signal sem Attempt rejeitado
  it('12. Signal sem Attempt rejeitado', () => {
    const ledger = createExecutionLedgerStore();
    const signal: ExecutionSignal = {
      signalId: 'sig_01' as ExecutionSignalId,
      attemptId: 'att_non_existent' as AttemptId,
      kind: 'dispatch_confirmed',
      safeMetadata: {},
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:01.000Z',
    };

    assert.throws(() => ledger.appendExecutionSignal(signal), InvalidAttemptReferenceError);
  });

  // 13. Signal durante running aceito
  it('13. Signal durante running aceito', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });

    const signal: ExecutionSignal = {
      signalId: 'sig_01' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'dispatch_confirmed',
      safeMetadata: { httpStatus: 200 },
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:02.000Z',
    };
    ledger.appendExecutionSignal(signal);

    const retrieved = ledger.getExecutionSignal('sig_01' as ExecutionSignalId);
    assert.equal(retrieved?.signalId, 'sig_01');
    assert.equal(retrieved?.kind, 'dispatch_confirmed');
  });

  // 14. late Signal após terminal aceito
  it('14. late Signal após terminal aceito', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'timed_out',
      finishedAt: '2026-08-19T18:40:06.000Z',
    });

    // Late signal chegando após o timeout
    const lateSignal: ExecutionSignal = {
      signalId: 'sig_late' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'effect_observed',
      safeMetadata: { remoteMutationId: 'tx_999' },
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:10.000Z',
    };

    assert.doesNotThrow(() => ledger.appendExecutionSignal(lateSignal));
    assert.equal(ledger.getExecutionSignal('sig_late' as ExecutionSignalId)?.kind, 'effect_observed');
  });

  // 15. late Signal não altera technical outcome
  it('15. late Signal não altera technical outcome', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptStarted',
      attemptId: 'att_01' as AttemptId,
      startedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptTerminal',
      attemptId: 'att_01' as AttemptId,
      terminalStatus: 'timed_out',
      finishedAt: '2026-08-19T18:40:06.000Z',
    });

    ledger.appendExecutionSignal({
      signalId: 'sig_late' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'effect_observed',
      safeMetadata: {},
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:10.000Z',
    });

    const attempt = ledger.getAttempt('att_01' as AttemptId);
    assert.equal(attempt?.status, 'timed_out');
  });

  // 16. raw payload não entra no Signal canônico por default
  it('16. raw payload não entra no Signal canônico por default', () => {
    const rawPayload = {
      apiKey: 'sk-live-12345',
      userEmail: 'alice@example.com',
      statusCode: 200,
    };

    const safeMeta = projectSafePayload(rawPayload); // Sem allowlist
    assert.deepEqual(safeMeta, {});
  });

  // 17. allowlist preserva somente safe fields
  it('17. allowlist preserva somente safe fields', () => {
    const rawPayload = {
      apiKey: 'secret_token',
      statusCode: 200,
      requestId: 'req_abc123',
    };

    const safeMeta = projectSafePayload(rawPayload, ['statusCode', 'requestId']);
    assert.deepEqual(safeMeta, {
      statusCode: 200,
      requestId: 'req_abc123',
    });
    assert.equal((safeMeta as Record<string, unknown>).apiKey, undefined);
  });

  // 18. campo secret não allowlisted é descartado
  it('18. campo secret não allowlisted é descartado', () => {
    const rawPayload = {
      bearerToken: 'eyJh...',
      password: 'password123',
      observedRowsCount: 42,
    };

    const safeMeta = projectSafePayload(rawPayload, ['observedRowsCount']);
    assert.deepEqual(safeMeta, { observedRowsCount: 42 });
    assert.equal((safeMeta as Record<string, unknown>).bearerToken, undefined);
    assert.equal((safeMeta as Record<string, unknown>).password, undefined);
  });

  // 19. Evidence referencia Attempt correto
  it('19. Evidence referencia Attempt correto', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendExecutionSignal({
      signalId: 'sig_01' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'effect_observed',
      safeMetadata: {},
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:01.000Z',
    });

    const evidence: ExecutionEvidence = {
      evidenceId: 'evi_01' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'effect_observed',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };

    ledger.appendExecutionEvidence(evidence);
    const retrieved = ledger.getExecutionEvidence('evi_01' as ExecutionEvidenceId);
    assert.equal(retrieved?.attemptId, 'att_01');
  });

  // 20. Evidence com Signal de outro Attempt rejeitada
  it('20. Evidence com Signal de outro Attempt rejeitada', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_02' as AttemptId,
      decisionId: 'dec_02' as DecisionId,
      routeEvaluationId: 'eval_02' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendExecutionSignal({
      signalId: 'sig_from_att_02' as ExecutionSignalId,
      attemptId: 'att_02' as AttemptId,
      kind: 'effect_observed',
      safeMetadata: {},
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:01.000Z',
    });

    const crossEvidence: ExecutionEvidence = {
      evidenceId: 'evi_cross' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_from_att_02' as ExecutionSignalId],
      kind: 'effect_observed',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };

    assert.throws(() => ledger.appendExecutionEvidence(crossEvidence), CrossAttemptReferenceError);
  });

  // 21. technical succeeded + zero factual evidence → indeterminate mutation
  it('21. technical succeeded + zero factual evidence → indeterminate mutation', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'succeeded' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'indeterminate');
    assert.equal(assessment.reasonCode, 'TECHNICAL_SUCCESS_WITHOUT_FACTUAL_EVIDENCE');
  });

  // 22. technical success signal sozinho → indeterminate mutation
  it('22. technical success signal sozinho → indeterminate mutation', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'succeeded' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const signal: ExecutionSignal = {
      signalId: 'sig_tech' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'technical_success',
      safeMetadata: { httpStatus: 200 },
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:01.000Z',
    };
    const evidence = canonicalizeSignalToEvidence('evi_tech' as ExecutionEvidenceId, signal, '2026-08-19T18:40:02.000Z');

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [evidence],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'indeterminate');
  });

  // 23. effect_observed válido → confirmed_mutation
  it('23. effect_observed válido → confirmed_mutation', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'succeeded' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const evidence: ExecutionEvidence = {
      evidenceId: 'evi_effect' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'effect_observed',
      safeFacts: { modifiedRowId: 'row_123' },
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [evidence],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'confirmed_mutation');
    assert.equal(assessment.reasonCode, 'MUTATION_EFFECT_OBSERVED');
  });

  // 24. no_effect_verified válido → confirmed_no_mutation
  it('24. no_effect_verified válido → confirmed_no_mutation', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'failed' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const evidence: ExecutionEvidence = {
      evidenceId: 'evi_no_effect' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'no_effect_verified',
      safeFacts: { rollbackConfirmed: true },
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [evidence],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'confirmed_no_mutation');
    assert.equal(assessment.reasonCode, 'MUTATION_NO_EFFECT_VERIFIED');
  });

  // 25. pre_dispatch_failure + guaranteed no side effect → confirmed_no_mutation
  it('25. pre_dispatch_failure + guaranteed no side effect → confirmed_no_mutation', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'failed' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const evidence: ExecutionEvidence = {
      evidenceId: 'evi_pre_fail' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'pre_dispatch_failure',
      safeFacts: { error: 'SchemaValidationErrorBeforeSocketOpen' },
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [evidence],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'confirmed_no_mutation');
    assert.equal(assessment.reasonCode, 'PRE_DISPATCH_FAILURE_NO_MUTATION');
  });

  // 26. technical failure pós-dispatch → indeterminate
  it('26. technical failure pós-dispatch → indeterminate', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'failed' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    // Falha ocorreu pós-dispatch sem prova de rollback
    const evidence: ExecutionEvidence = {
      evidenceId: 'evi_post_fail' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'dispatch_confirmed',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [evidence],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'indeterminate');
    assert.equal(assessment.reasonCode, 'FAILURE_POST_DISPATCH_INDETERMINATE');
  });

  // 27. timeout pós-dispatch → indeterminate
  it('27. timeout pós-dispatch → indeterminate', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'timed_out' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'indeterminate');
    assert.equal(assessment.reasonCode, 'TIMEOUT_POST_DISPATCH_INDETERMINATE');
  });

  // 28. unknown_completion → indeterminate
  it('28. unknown_completion → indeterminate', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'unknown_completion' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attempt,
      evidenceList: [],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'indeterminate');
    assert.equal(assessment.reasonCode, 'MUTATION_OUTCOME_INDETERMINATE');
  });

  // 29. effect + no_effect conflitantes → indeterminate
  it('29. effect + no_effect conflitantes → indeterminate', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      status: 'succeeded' as const,
      createdAt: '2026-08-19T18:40:00.000Z',
    };

    const e1: ExecutionEvidence = {
      evidenceId: 'evi_eff' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'effect_observed',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };
    const e2: ExecutionEvidence = {
      evidenceId: 'evi_no_eff' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_02' as ExecutionSignalId],
      kind: 'no_effect_verified',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:03.000Z',
    };

    const assessment = assessOutcome({
      assessmentId: 'ass_conflict' as OutcomeAssessmentId,
      attempt,
      evidenceList: [e1, e2],
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    assert.equal(assessment.verdict, 'indeterminate');
    assert.equal(assessment.reasonCode, 'MUTATION_EVIDENCE_CONFLICT');
  });

  // 30. late evidence gera novo Assessment sem modificar A1
  it('30. late evidence gera novo Assessment sem modificar A1', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    const a1 = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate' as const,
      reasonCode: 'TIMEOUT_POST_DISPATCH_INDETERMINATE',
      assessedAt: '2026-08-19T18:40:05.000Z',
    };
    ledger.appendOutcomeAssessment(a1);

    const a2 = {
      assessmentId: 'ass_02' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: ['evi_late' as ExecutionEvidenceId],
      verdict: 'confirmed_mutation' as const,
      reasonCode: 'MUTATION_EFFECT_OBSERVED',
      supersedesAssessmentId: 'ass_01' as OutcomeAssessmentId,
      assessedAt: '2026-08-19T18:40:15.000Z',
    };
    ledger.appendOutcomeAssessment(a2);

    const retrievedA1 = ledger.getOutcomeAssessment('ass_01' as OutcomeAssessmentId);
    assert.equal(retrievedA1?.verdict, 'indeterminate');

    const retrievedA2 = ledger.getOutcomeAssessment('ass_02' as OutcomeAssessmentId);
    assert.equal(retrievedA2?.verdict, 'confirmed_mutation');
    assert.equal(retrievedA2?.supersedesAssessmentId, 'ass_01');
  });

  // 31. A2 supersede A1 do mesmo Attempt
  it('31. A2 supersede A1 do mesmo Attempt', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    ledger.appendOutcomeAssessment({
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate',
      reasonCode: 'INITIAL',
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    ledger.appendOutcomeAssessment({
      assessmentId: 'ass_02' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_mutation',
      reasonCode: 'LATE_OBSERVED',
      supersedesAssessmentId: 'ass_01' as OutcomeAssessmentId,
      assessedAt: '2026-08-19T18:40:10.000Z',
    });

    const latest = ledger.getLatestOutcomeAssessment('att_01' as AttemptId);
    assert.equal(latest?.assessmentId, 'ass_02');
  });

  // 32. Assessment não pode superseder Assessment de outro Attempt
  it('32. Assessment não pode superseder Assessment de outro Attempt', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_02' as AttemptId,
      decisionId: 'dec_02' as DecisionId,
      routeEvaluationId: 'eval_02' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    ledger.appendOutcomeAssessment({
      assessmentId: 'ass_on_att1' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate',
      reasonCode: 'INITIAL',
      assessedAt: '2026-08-19T18:40:05.000Z',
    });

    // Tentativa de ass_on_att2 superseder ass_on_att1
    const crossAssessment = {
      assessmentId: 'ass_on_att2' as OutcomeAssessmentId,
      attemptId: 'att_02' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_mutation' as const,
      reasonCode: 'CROSS',
      supersedesAssessmentId: 'ass_on_att1' as OutcomeAssessmentId,
      assessedAt: '2026-08-19T18:40:10.000Z',
    };

    assert.throws(() => ledger.appendOutcomeAssessment(crossAssessment), CrossAttemptReferenceError);
  });

  // 33. Receipt execution outcome materializado
  it('33. Receipt execution outcome materializado', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: ['evi_01' as ExecutionEvidenceId],
      verdict: 'confirmed_mutation' as const,
      reasonCode: 'MUTATION_EFFECT_OBSERVED',
      assessedAt: '2026-08-19T18:40:05.000Z',
    };

    const receipt = materializeExecutionReceipt({
      receiptId: 'rcpt_01' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      attemptId: 'att_01' as AttemptId,
      outcomeAssessment: assessment,
      safeStructuredFacts: { rowsAffected: 1 },
      materializedAt: '2026-08-19T18:40:06.000Z',
    });

    assert.equal(receipt.receiptId, 'rcpt_01');
    assert.equal(receipt.kind, 'execution_outcome');
    assert.equal(receipt.verdictSummary, 'confirmed_mutation');
    assert.equal(receipt.reasonCode, 'MUTATION_EFFECT_OBSERVED');
  });

  // 34. Receipt indeterminate não declara factual success
  it('34. Receipt indeterminate não declara factual success', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate' as const,
      reasonCode: 'TECHNICAL_SUCCESS_WITHOUT_FACTUAL_EVIDENCE',
      assessedAt: '2026-08-19T18:40:05.000Z',
    };

    const receipt = materializeExecutionReceipt({
      receiptId: 'rcpt_01' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      attemptId: 'att_01' as AttemptId,
      outcomeAssessment: assessment,
      materializedAt: '2026-08-19T18:40:06.000Z',
    });

    assert.equal(receipt.verdictSummary, 'indeterminate');
    assert.notEqual(receipt.verdictSummary, 'done');
    assert.notEqual(receipt.verdictSummary, 'success');
  });

  // 35. Policy denial Receipt sem Attempt
  it('35. Policy denial Receipt sem Attempt', () => {
    const policyDecision: PolicyDecision = {
      policyRevisionId: 'policy_rev_01' as PolicyRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      effectiveSensitivity: 'LOCAL_ONLY',
      containsSecretMaterial: false,
      egressAxis: { verdict: 'deny', reasonCode: 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER' },
      zeroCostAxis: { verdict: 'allow', reasonCode: 'ZERO_COST_NOT_REQUIRED' },
      requiredRuntimeRequirements: [],
      evaluatedAt: '2026-08-19T18:40:00.000Z',
    };

    const receipt = materializePolicyDenialReceipt({
      receiptId: 'rcpt_pol_denied' as ReceiptId,
      decisionId: 'dec_denied' as DecisionId,
      policyDecision,
      materializedAt: '2026-08-19T18:40:01.000Z',
    });

    assert.equal(receipt.kind, 'policy_denial');
    assert.equal(receipt.attemptId, undefined);
    assert.equal(receipt.outcomeAssessmentId, undefined);
    assert.equal(receipt.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER');
  });

  // 36. Authorization denial Receipt sem Attempt
  it('36. Authorization denial Receipt sem Attempt', () => {
    const authDecision: HumanAuthorizationDecision = {
      actorRef: 'user_anonymous',
      operation: 'admin_delete',
      verdict: 'denied',
      reasonCode: 'PERMISSION_DENIED_ROLE',
    };

    const receipt = materializeAuthorizationDenialReceipt({
      receiptId: 'rcpt_auth_denied' as ReceiptId,
      decisionId: 'dec_auth' as DecisionId,
      authDecision,
      materializedAt: '2026-08-19T18:40:01.000Z',
    });

    assert.equal(receipt.kind, 'authorization_denial');
    assert.equal(receipt.attemptId, undefined);
    assert.equal(receipt.reasonCode, 'PERMISSION_DENIED_ROLE');
  });

  // 37. No eligible route Receipt sem Attempt
  it('37. No eligible route Receipt sem Attempt', () => {
    const receipt = materializeNoEligibleRouteReceipt({
      receiptId: 'rcpt_no_route' as ReceiptId,
      decisionId: 'dec_no_route' as DecisionId,
      reasonCode: 'NO_ELIGIBLE_ROUTE_FOR_CAPABILITY',
      materializedAt: '2026-08-19T18:40:01.000Z',
    });

    assert.equal(receipt.kind, 'no_eligible_route');
    assert.equal(receipt.attemptId, undefined);
    assert.equal(receipt.reasonCode, 'NO_ELIGIBLE_ROUTE_FOR_CAPABILITY');
  });

  // 38. Cancelled Decision Receipt sem Attempt quando nenhum dispatch ocorreu
  it('38. Cancelled Decision Receipt sem Attempt quando nenhum dispatch ocorreu', () => {
    const receipt = materializeCancelledReceipt({
      receiptId: 'rcpt_cancel' as ReceiptId,
      decisionId: 'dec_cancel' as DecisionId,
      reasonCode: 'USER_CANCELLED_PRE_DISPATCH',
      materializedAt: '2026-08-19T18:40:01.000Z',
    });

    assert.equal(receipt.kind, 'cancelled');
    assert.equal(receipt.attemptId, undefined);
    assert.equal(receipt.reasonCode, 'USER_CANCELLED_PRE_DISPATCH');
  });

  // 39. Receipt permanece igual depois de mudanças simuladas de PolicyRevision
  it('39. Receipt permanece igual depois de mudanças simuladas de PolicyRevision', () => {
    const initialPolicy: PolicyRevision = {
      policyKey: 'policy.test' as PolicyKey,
      policyRevisionId: 'rev_pol_v1' as PolicyRevisionId,
      supersedesRevisionIds: [],
      defaultSensitivity: 'NORMAL',
      zeroCostRequired: true,
    };

    const policyDecision: PolicyDecision = {
      policyRevisionId: initialPolicy.policyRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      effectiveSensitivity: 'NORMAL',
      containsSecretMaterial: false,
      egressAxis: { verdict: 'deny', reasonCode: 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER' },
      zeroCostAxis: { verdict: 'allow', reasonCode: 'ZERO_COST_NOT_REQUIRED' },
      requiredRuntimeRequirements: [],
      evaluatedAt: '2026-08-19T18:40:00.000Z',
    };

    const receipt = materializePolicyDenialReceipt({
      receiptId: 'rcpt_historical' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      policyDecision,
      materializedAt: '2026-08-19T18:40:01.000Z',
    });

    // Simulando nova revisão de policy que mudaria a regra no futuro
    const updatedPolicy: PolicyRevision = {
      policyKey: 'policy.test' as PolicyKey,
      policyRevisionId: 'rev_pol_v2' as PolicyRevisionId,
      supersedesRevisionIds: ['rev_pol_v1' as PolicyRevisionId],
      defaultSensitivity: 'LOCAL_ONLY',
      zeroCostRequired: false,
    };

    assert.equal(receipt.safeStructuredFacts.policyRevisionId, 'rev_pol_v1');
    assert.equal(receipt.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER');
    assert.notEqual(receipt.safeStructuredFacts.policyRevisionId, updatedPolicy.policyRevisionId);
  });

  // 40. Receipt não contém raw executor payload
  it('40. Receipt não contém raw executor payload', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_result' as const,
      reasonCode: 'NON_MUTATING_TECHNICAL_SUCCESS',
      assessedAt: '2026-08-19T18:40:05.000Z',
    };

    const receipt = materializeExecutionReceipt({
      receiptId: 'rcpt_01' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      attemptId: 'att_01' as AttemptId,
      outcomeAssessment: assessment,
      safeStructuredFacts: { status: 'ok' },
      materializedAt: '2026-08-19T18:40:06.000Z',
    });

    const untyped = (receipt as unknown) as Record<string, unknown>;
    assert.equal(untyped.rawPayload, undefined);
    assert.equal(untyped.rawResponse, undefined);
  });

  // 41. Ledger não expõe update/delete
  it('41. Ledger não expõe update/delete', () => {
    const ledger = createExecutionLedgerStore();
    const untyped = (ledger as unknown) as Record<string, unknown>;
    assert.equal(untyped.updateAttempt, undefined);
    assert.equal(untyped.deleteAttempt, undefined);
    assert.equal(untyped.updateReceipt, undefined);
    assert.equal(untyped.deleteReceipt, undefined);
    assert.equal(untyped.updateSignal, undefined);
    assert.equal(untyped.deleteSignal, undefined);
  });

  // 42. não existe API canRetry
  it('42. não existe API canRetry', () => {
    const ledger = createExecutionLedgerStore();
    const untyped = (ledger as unknown) as Record<string, unknown>;
    assert.equal(untyped.canRetry, undefined);
    assert.equal(untyped.retry, undefined);
    assert.equal(untyped.retryAllowed, undefined);
  });

  // 43. rejected/ineligible Route não exige Attempt
  it('43. rejected/ineligible Route não exige Attempt', () => {
    const ledger = createExecutionLedgerStore();

    // Rota rejeitada cria recibo diretamente no ledger sem nenhum Attempt
    const denialReceipt = materializeNoEligibleRouteReceipt({
      receiptId: 'rcpt_no_route' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      reasonCode: 'ALL_ROUTES_FILTERED_BY_POLICY',
      materializedAt: '2026-08-19T18:40:01.000Z',
    });

    ledger.appendReceipt(denialReceipt);

    assert.equal(ledger.listAttempts('dec_01' as DecisionId).length, 0);
    assert.equal(ledger.listReceipts('dec_01' as DecisionId).length, 1);
  });

  // 44. signal/evidence/receipt IDs duplicados são rejeitados
  it('44. signal/evidence/receipt IDs duplicados são rejeitados', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });

    const sig: ExecutionSignal = {
      signalId: 'sig_dup' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'dispatch_confirmed',
      safeMetadata: {},
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:01.000Z',
    };
    ledger.appendExecutionSignal(sig);
    assert.throws(() => ledger.appendExecutionSignal(sig), DuplicateIdError);

    const evi: ExecutionEvidence = {
      evidenceId: 'evi_dup' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_dup' as ExecutionSignalId],
      kind: 'dispatch_confirmed',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    };
    ledger.appendExecutionEvidence(evi);
    assert.throws(() => ledger.appendExecutionEvidence(evi), DuplicateIdError);

    const rcpt = materializeNoEligibleRouteReceipt({
      receiptId: 'rcpt_dup' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      reasonCode: 'REASON',
      materializedAt: '2026-08-19T18:40:03.000Z',
    });
    ledger.appendReceipt(rcpt);
    assert.throws(() => ledger.appendReceipt(rcpt), DuplicateIdError);
  });

  // 45. snapshot export preserva correlação causal
  it('45. snapshot export preserva correlação causal', () => {
    const ledger = createExecutionLedgerStore();
    ledger.appendAttemptEvent({
      type: 'AttemptCreated',
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T18:40:00.000Z',
    });
    ledger.appendExecutionSignal({
      signalId: 'sig_01' as ExecutionSignalId,
      attemptId: 'att_01' as AttemptId,
      kind: 'dispatch_confirmed',
      safeMetadata: {},
      provenance: defaultProvenance,
      observedAt: '2026-08-19T18:40:01.000Z',
    });
    ledger.appendExecutionEvidence({
      evidenceId: 'evi_01' as ExecutionEvidenceId,
      attemptId: 'att_01' as AttemptId,
      signalRefs: ['sig_01' as ExecutionSignalId],
      kind: 'dispatch_confirmed',
      safeFacts: {},
      provenance: defaultProvenance,
      recordedAt: '2026-08-19T18:40:02.000Z',
    });

    const snapshot = ledger.exportSnapshot();
    assert.equal(snapshot.attemptEvents.length, 1);
    assert.equal(snapshot.signals.length, 1);
    assert.equal(snapshot.evidence.length, 1);
    assert.equal(snapshot.evidence[0].signalRefs[0], 'sig_01');

    // Inicializar novo ledger a partir do snapshot exportado
    const restoredLedger = createExecutionLedgerStore(snapshot);
    assert.equal(restoredLedger.getAttempt('att_01' as AttemptId)?.attemptId, 'att_01');
    assert.equal(restoredLedger.getExecutionSignal('sig_01' as ExecutionSignalId)?.signalId, 'sig_01');
    assert.equal(restoredLedger.getExecutionEvidence('evi_01' as ExecutionEvidenceId)?.evidenceId, 'evi_01');
  });
});
