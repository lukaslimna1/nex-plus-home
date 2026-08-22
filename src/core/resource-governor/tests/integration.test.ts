/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes de Integração com o Core 0.5 (DispatchAdmission & L0 Attempt) — Escopo 0.6 (Hardening)
 *
 * Cenários B41 a B50 + G1 a G7 + H6 a H9: Correlação causal rigorosa entre DispatchAdmission,
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
import { defaultDispatchAdmissionAuthority } from '../../evaluation/admission-authority';

function createMockDispatchAdmission(overrides: Partial<DispatchAdmission> = {}): DispatchAdmission {
  const adm: DispatchAdmission = {
    admissionId: `disp_adm_${Math.random().toString(36).substring(2, 8)}` as DispatchAdmissionId,
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
  return defaultDispatchAdmissionAuthority.registerAdmission(adm);
}

function createMockRequest(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return {
    requestId: 'req_01' as ResourceRequestId,
    decisionId: 'dec_01' as DecisionId,
    materialContextId: 'ctx_01' as DecisionMaterialContextId,
    routeEvaluationId: 'eval_01' as RouteEvaluationId,
    routeRevisionId: 'route_rev_01' as RouteRevisionId,
    profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
    targetModel: 'llama3:8b',
    targetGpuUuid: 'GPU-01',
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
    targetModel: 'llama3:8b',
    targetGpuUuid: 'GPU-01',
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
      admittedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(adm.admissionId, 'res_adm_01');
    assert.equal(adm.decisionId, dispatch.decisionId);
    assert.equal(adm.materialContextId, dispatch.materialContextId);
    assert.equal(adm.profileRevisionId, decision.profileRevisionId);
    assert.equal(adm.resourceSnapshotId, decision.resourceSnapshotId);
    assert.equal(adm.targetModel, request.targetModel);
    assert.equal(adm.targetGpuUuid, request.targetGpuUuid);
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
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /requestId mismatch/);
  });

  // G7. profile mismatch entre request e decision → rejeita
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
        admittedAt: '2026-08-19T20:00:01.000Z',
      });
    }, /profileRevisionId mismatch/);
  });

  // H6. ResourceAdmission.materialFacts é exatamente projeção da GovernorDecision
  it('H6. ResourceAdmission.materialFacts é exatamente projeção da GovernorDecision', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision({
      materialFacts: {
        freeRamBytes: 123456,
        freeVramBytes: 654321,
        cpuUtilizationPercent: 42,
        snapshotFreshness: 'fresh',
      },
    });

    const adm = materializeResourceAdmission({
      admissionId: 'res_adm_01' as ResourceAdmissionId,
      request,
      governorDecision: decision,
      dispatchAdmission: dispatch,
      admittedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.deepEqual(adm.materialFacts, decision.materialFacts);
  });

  // H7. ResourceAdmission.targetModel vem do ResourceRequest
  it('H7. ResourceAdmission.targetModel vem do ResourceRequest', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest({ targetModel: 'custom-model:latest' });
    const decision = createMockGovernorDecision();

    const adm = materializeResourceAdmission({
      admissionId: 'res_adm_01' as ResourceAdmissionId,
      request,
      governorDecision: decision,
      dispatchAdmission: dispatch,
      admittedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(adm.targetModel, 'custom-model:latest');
  });

  // H8. ResourceAdmission.targetGpuUuid vem do ResourceRequest
  it('H8. ResourceAdmission.targetGpuUuid vem do ResourceRequest', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest({ targetGpuUuid: 'GPU-UUID-SPECIFIC' });
    const decision = createMockGovernorDecision();

    const adm = materializeResourceAdmission({
      admissionId: 'res_adm_01' as ResourceAdmissionId,
      request,
      governorDecision: decision,
      dispatchAdmission: dispatch,
      admittedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(adm.targetGpuUuid, 'GPU-UUID-SPECIFIC');
  });

  // H9. API de materialização não aceita facts/target paralelos como fonte de verdade
  it('H9. MaterializeResourceAdmissionParams não possui campos paralelos redundantes', () => {
    const dispatch = createMockDispatchAdmission();
    const request = createMockRequest();
    const decision = createMockGovernorDecision();

    const params = {
      admissionId: 'res_adm_01' as ResourceAdmissionId,
      request,
      governorDecision: decision,
      dispatchAdmission: dispatch,
      admittedAt: '2026-08-19T20:00:01.000Z',
    };

    const adm = materializeResourceAdmission(params);
    assert.equal(adm.profileRevisionId, decision.profileRevisionId);
    assert.equal(adm.resourceSnapshotId, decision.resourceSnapshotId);
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
