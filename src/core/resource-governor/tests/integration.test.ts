/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes de Integração com o Core 0.5 (DispatchAdmission & L0 Attempt) — Escopo 0.6 (Hardening)
 *
 * Cenários B41 a B50 + G1 a G7: Correlação causal rigorosa entre DispatchAdmission,
 * GovernorDecision e ResourceAdmission.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AttemptId,
  DecisionId,
  RouteEvaluationId,
} from '../../execution/contracts';
import type {
  BindingRevisionId,
  CapabilityRevisionId,
  RouteRevisionId,
} from '../../capabilities/contracts';
import type {
  DecisionMaterialContextId,
  DispatchAdmission,
  DispatchAdmissionId,
} from '../../evaluation/contracts';
import type { PolicyRevisionId } from '../../policy/contracts';

import type {
  GovernorDecision,
  ResourceAdmission,
  ResourceAdmissionId,
  ResourceProfileRevisionId,
  ResourceRequest,
  ResourceRequestId,
  ResourceSnapshotId,
} from '../contracts';

import {
  buildResourceGovernedAttemptCreatedEvent,
  materializeResourceAdmission,
  ResourceAdmissionMismatchError,
} from '../integration/attempt-admission';

function createMockDispatchAdmission(overrides: Partial<DispatchAdmission> = {}): DispatchAdmission {
  return {
    admissionId: 'disp_adm_01' as DispatchAdmissionId,
    decisionId: 'dec_01' as DecisionId,
    materialContextId: 'ctx_01' as DecisionMaterialContextId,
    routeEvaluationId: 'eval_01' as RouteEvaluationId,
    capabilityRevisionId: 'cap_rev_01' as CapabilityRevisionId,
    bindingRevisionId: 'bind_rev_01' as BindingRevisionId,
    routeRevisionId: 'route_rev_01' as RouteRevisionId,
    policyRevisionId: 'pol_rev_01' as PolicyRevisionId,
    admittedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
}

function createMockRequest(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return {
    requestId: 'req_01' as ResourceRequestId,
    decisionId: 'dec_01' as DecisionId,
    materialContextId: 'ctx_01' as DecisionMaterialContextId,
    routeEvaluationId: 'eval_01' as RouteEvaluationId,
    routeRevisionId: 'route_rev_01' as RouteRevisionId,
    profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
    intent: 'use_current_state',
    requestedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
}

function createMockGovernorDecision(overrides: Partial<GovernorDecision> = {}): GovernorDecision {
  return {
    disposition: 'admit',
    reasonCode: 'RESOURCES_ADMITTED',
    requestId: 'req_01' as ResourceRequestId,
    profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
    resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
    materialFacts: { freeRamBytes: 16000000000 },
    evaluatedAt: '2026-08-19T20:00:01.000Z',
    ...overrides,
  };
}

function createMockResourceAdmission(overrides: Partial<ResourceAdmission> = {}): ResourceAdmission {
  return {
    admissionId: 'res_adm_01' as ResourceAdmissionId,
    requestId: 'req_01' as ResourceRequestId,
    decisionId: 'dec_01' as DecisionId,
    materialContextId: 'ctx_01' as DecisionMaterialContextId,
    routeEvaluationId: 'eval_01' as RouteEvaluationId,
    routeRevisionId: 'route_rev_01' as RouteRevisionId,
    profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
    resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
    materialFacts: { freeRamBytes: 16000000000 },
    admittedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
}

describe('NEX+ Resource Governor · Core 0.5 Integration (Fase B & Hardening)', () => {
  // G1. GovernorDecision admit + refs corretas → ResourceAdmission
  it('G1. GovernorDecision admit + refs corretas materializa ResourceAdmission', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision();

    const adm = materializeResourceAdmission({
      admissionId: 'res_adm_01' as ResourceAdmissionId,
      request,
      governorDecision: decision,
      dispatchAdmission: dispatch,
      profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
      resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
      materialFacts: { freeRamBytes: 16000000000 },
      admittedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(adm.admissionId, 'res_adm_01');
    assert.equal(adm.decisionId, dispatch.decisionId);
    assert.equal(adm.materialContextId, dispatch.materialContextId);
  });

  // G2. GovernorDecision defer → não materializa admission
  it('G2. GovernorDecision defer rejeita materialização de ResourceAdmission', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision({ disposition: 'defer', reasonCode: 'INSUFFICIENT_VRAM' });

    assert.throws(() => {
      materializeResourceAdmission({
        admissionId: 'res_adm_01' as ResourceAdmissionId,
        request,
        governorDecision: decision,
        dispatchAdmission: dispatch,
        profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
        resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
        materialFacts: {},
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /GovernorDecision disposition is 'defer'/);
  });

  // G3. GovernorDecision deny → não materializa admission
  it('G3. GovernorDecision deny rejeita materialização de ResourceAdmission', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision({ disposition: 'deny', reasonCode: 'MODEL_NOT_APPROVED' });

    assert.throws(() => {
      materializeResourceAdmission({
        admissionId: 'res_adm_01' as ResourceAdmissionId,
        request,
        governorDecision: decision,
        dispatchAdmission: dispatch,
        profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
        resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
        materialFacts: {},
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /GovernorDecision disposition is 'deny'/);
  });

  // G4. GovernorDecision action_required → não materializa admission
  it('G4. GovernorDecision action_required rejeita materialização de ResourceAdmission', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision({ disposition: 'action_required', reasonCode: 'PRELOAD_REQUIRED' });

    assert.throws(() => {
      materializeResourceAdmission({
        admissionId: 'res_adm_01' as ResourceAdmissionId,
        request,
        governorDecision: decision,
        dispatchAdmission: dispatch,
        profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
        resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
        materialFacts: {},
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /GovernorDecision disposition is 'action_required'/);
  });

  // G5. Decision de Request A usada em Request B → rejeita
  it('G5. Decision de Request A usada em Request B rejeita por requestId mismatch', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest({ requestId: 'req_A' as ResourceRequestId });
    const decision = createMockGovernorDecision({ requestId: 'req_B' as ResourceRequestId });

    assert.throws(() => {
      materializeResourceAdmission({
        admissionId: 'res_adm_01' as ResourceAdmissionId,
        request,
        governorDecision: decision,
        dispatchAdmission: dispatch,
        profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
        resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
        materialFacts: {},
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /requestId mismatch/);
  });

  // G6. snapshot mismatch → rejeita
  it('G6. snapshot mismatch rejeita por resourceSnapshotId mismatch', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision({ resourceSnapshotId: 'snap_01' as ResourceSnapshotId });

    assert.throws(() => {
      materializeResourceAdmission({
        admissionId: 'res_adm_01' as ResourceAdmissionId,
        request,
        governorDecision: decision,
        dispatchAdmission: dispatch,
        profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
        resourceSnapshotId: 'snap_DIVERGENT' as ResourceSnapshotId,
        materialFacts: {},
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /resourceSnapshotId mismatch/);
  });

  // G7. profile mismatch → rejeita
  it('G7. profile mismatch rejeita por profileRevisionId mismatch', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest({ profileRevisionId: 'prof_A' as ResourceProfileRevisionId });
    const decision = createMockGovernorDecision({ profileRevisionId: 'prof_B' as ResourceProfileRevisionId });

    assert.throws(() => {
      materializeResourceAdmission({
        admissionId: 'res_adm_01' as ResourceAdmissionId,
        request,
        governorDecision: decision,
        dispatchAdmission: dispatch,
        profileRevisionId: 'prof_A' as ResourceProfileRevisionId,
        resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
        materialFacts: {},
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /profileRevisionId mismatch/);
  });

  // B41. ResourceAdmission + DispatchAdmission com Decision mismatch → rejeita
  it('B41. ResourceAdmission + DispatchAdmission com Decision mismatch → rejeita', () => {
    const dispatch = createMockDispatchAdmission({ decisionId: 'dec_01' as DecisionId });
    const resource = createMockResourceAdmission({ decisionId: 'dec_OTHER' as DecisionId });

    assert.throws(() => {
      buildResourceGovernedAttemptCreatedEvent({
        dispatchAdmission: dispatch,
        resourceAdmission: resource,
        attemptId: 'att_01' as AttemptId,
        createdAt: '2026-08-19T20:00:01.000Z',
        currentMaterialContextId: 'ctx_01' as DecisionMaterialContextId,
      });
    }, ResourceAdmissionMismatchError);
  });

  // B42. materialContext mismatch → rejeita
  it('B42. materialContext mismatch → rejeita', () => {
    const dispatch = createMockDispatchAdmission({ materialContextId: 'ctx_01' as DecisionMaterialContextId });
    const resource = createMockResourceAdmission({ materialContextId: 'ctx_DIVERGENT' as DecisionMaterialContextId });

    assert.throws(() => {
      buildResourceGovernedAttemptCreatedEvent({
        dispatchAdmission: dispatch,
        resourceAdmission: resource,
        attemptId: 'att_01' as AttemptId,
        createdAt: '2026-08-19T20:00:01.000Z',
        currentMaterialContextId: 'ctx_01' as DecisionMaterialContextId,
      });
    }, ResourceAdmissionMismatchError);
  });

  // B43. routeEvaluationId mismatch → rejeita
  it('B43. routeEvaluationId mismatch → rejeita', () => {
    const dispatch = createMockDispatchAdmission({ routeEvaluationId: 'eval_01' as RouteEvaluationId });
    const resource = createMockResourceAdmission({ routeEvaluationId: 'eval_OTHER' as RouteEvaluationId });

    assert.throws(() => {
      buildResourceGovernedAttemptCreatedEvent({
        dispatchAdmission: dispatch,
        resourceAdmission: resource,
        attemptId: 'att_01' as AttemptId,
        createdAt: '2026-08-19T20:00:01.000Z',
        currentMaterialContextId: 'ctx_01' as DecisionMaterialContextId,
      });
    }, ResourceAdmissionMismatchError);
  });

  // B44. routeRevisionId mismatch → rejeita
  it('B44. routeRevisionId mismatch → rejeita', () => {
    const dispatch = createMockDispatchAdmission({ routeRevisionId: 'route_rev_01' as RouteRevisionId });
    const resource = createMockResourceAdmission({ routeRevisionId: 'route_rev_OTHER' as RouteRevisionId });

    assert.throws(() => {
      buildResourceGovernedAttemptCreatedEvent({
        dispatchAdmission: dispatch,
        resourceAdmission: resource,
        attemptId: 'att_01' as AttemptId,
        createdAt: '2026-08-19T20:00:01.000Z',
        currentMaterialContextId: 'ctx_01' as DecisionMaterialContextId,
      });
    }, ResourceAdmissionMismatchError);
  });

  // B45. refs coincidentes → AttemptCreatedEvent correto
  it('B45. refs coincidentes → AttemptCreatedEvent correto', () => {
    const dispatch = createMockDispatchAdmission();
    const resource = createMockResourceAdmission();

    const event = buildResourceGovernedAttemptCreatedEvent({
      dispatchAdmission: dispatch,
      resourceAdmission: resource,
      attemptId: 'att_01' as AttemptId,
      createdAt: '2026-08-19T20:00:01.000Z',
      currentMaterialContextId: 'ctx_01' as DecisionMaterialContextId,
    });

    assert.equal(event.type, 'AttemptCreated');
    assert.equal(event.attemptId, 'att_01');
    assert.equal(event.decisionId, 'dec_01');
    assert.equal(event.routeEvaluationId, 'eval_01');
    assert.equal(event.routeRevisionId, 'route_rev_01');
    assert.equal(event.createdAt, '2026-08-19T20:00:01.000Z');
  });

  // B47. context mismatch entre currentMaterialContextId e admissão é rejeitado
  it('B47. context mismatch entre currentMaterialContextId e admissão é rejeitado', () => {
    const dispatch = createMockDispatchAdmission();
    const resource = createMockResourceAdmission();

    assert.throws(() => {
      buildResourceGovernedAttemptCreatedEvent({
        dispatchAdmission: dispatch,
        resourceAdmission: resource,
        attemptId: 'att_01' as AttemptId,
        createdAt: '2026-08-19T20:00:01.000Z',
        currentMaterialContextId: 'ctx_MUTATED' as DecisionMaterialContextId,
      });
    }, /DispatchAdmission material context mismatch/);
  });

  // B48. ResourceAdmission é imutável
  it('B48. ResourceAdmission é imutável', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision();

    const adm = materializeResourceAdmission({
      admissionId: 'res_adm_01' as ResourceAdmissionId,
      request,
      governorDecision: decision,
      dispatchAdmission: dispatch,
      profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
      resourceSnapshotId: 'snap_01' as ResourceSnapshotId,
      materialFacts: { freeRamBytes: 8000 },
      admittedAt: '2026-08-19T20:00:00.000Z',
    });

    assert.throws(() => {
      (adm as any).targetModel = 'hacked';
    });
  });

  // B50. Resource Governor não altera PolicyDecision
  it('B50. Resource Governor opera como gate ortogonal sem mutar L0 Policy', () => {
    const dispatch = createMockDispatchAdmission({ policyRevisionId: 'pol_rev_original' as PolicyRevisionId });
    const resource = createMockResourceAdmission();

    const event = buildResourceGovernedAttemptCreatedEvent({
      dispatchAdmission: dispatch,
      resourceAdmission: resource,
      attemptId: 'att_01' as AttemptId,
      createdAt: '2026-08-19T20:00:01.000Z',
      currentMaterialContextId: 'ctx_01' as DecisionMaterialContextId,
    });

    assert.equal(event.policyRevisionId, 'pol_rev_original');
  });
});
