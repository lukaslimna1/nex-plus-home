/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Testes de Integração com Resource Governor — Escopo 0.7A
 *
 * Cenários E1 a E6:
 * - Projeção de target local resolvido para ResourceRequest (targetModel derivado)
 * - Rejeição de targets externos para requisições de recursos físicos locais
 * - Comportamento com papéis unbound ou ambíguos
 * - Preservação estrita das fronteiras de admissão do Core 0.6
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RouteRevisionId } from '../../capabilities/contracts';
import type { DecisionId, RouteEvaluationId } from '../../execution/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';
import type {
  ResourceProfileRevisionId,
  ResourceRequestId,
} from '../../resource-governor/contracts';

import type {
  AiRoleBindingKey,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRevisionId,
} from '../contracts';
import { createAiRoleRegistry } from '../registry';
import { resolveAiRole } from '../resolver';
import {
  createCanonicalBindingRevision,
  createCanonicalRoleRevision,
  INCUMBENT_LOCAL_HEAVY_TARGET,
  INCUMBENT_LOCAL_RESIDENT_TARGET,
  ROLE_LOCAL_HEAVY,
  ROLE_LOCAL_RESIDENT,
} from '../incumbents';
import {
  AiRoleResourceGovernorIntegrationError,
  createResourceRequestFromResolvedRole,
  toApprovedLocalModelRef,
} from '../integration/resource-governor';

describe('NEX+ AI Role Registry · Resource Governor Integration (0.7A)', () => {
  // E1. resolved local_resident → targetModel ministral-3:3b via adapter
  it('E1. resolved local_resident gera ResourceRequest com targetModel ministral-3:3b', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        title: 'Resident',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );

    const resolved = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      const request = createResourceRequestFromResolvedRole({
        requestId: 'req_01' as ResourceRequestId,
        resolvedRole: resolved,
        decisionId: 'dec_01' as DecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        routeEvaluationId: 'eval_01' as RouteEvaluationId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
        intent: 'ensure_model_loaded',
        requestedAt: '2026-08-19T20:00:00.000Z',
      });

      assert.equal(request.targetModel, 'ministral-3:3b');
      assert.equal(request.intent, 'ensure_model_loaded');
      assert.equal(request.routeRevisionId, 'route_ollama_01');
    }
  });

  // E2. resolved local_heavy → targetModel qwen3.5:9b via adapter
  it('E2. resolved local_heavy gera ResourceRequest com targetModel qwen3.5:9b', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_HEAVY,
        roleRevisionId: 'role_heavy_01' as AiRoleRevisionId,
        title: 'Heavy',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_heavy' as AiRoleBindingKey,
        bindingRevisionId: 'bind_heavy_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_HEAVY,
        roleRevisionId: 'role_heavy_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        target: INCUMBENT_LOCAL_HEAVY_TARGET,
      }),
    );

    const resolved = resolveAiRole({ roleKey: ROLE_LOCAL_HEAVY, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      const request = createResourceRequestFromResolvedRole({
        requestId: 'req_02' as ResourceRequestId,
        resolvedRole: resolved,
        decisionId: 'dec_02' as DecisionId,
        materialContextId: 'ctx_02' as DecisionMaterialContextId,
        routeEvaluationId: 'eval_02' as RouteEvaluationId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
        intent: 'ensure_model_loaded',
        requestedAt: '2026-08-19T20:00:00.000Z',
      });

      assert.equal(request.targetModel, 'qwen3.5:9b');
    }
  });

  // E3. external target → adapter rejeita como non-local
  it('E3. external target é rejeitado pelo adapter ao tentar criar ResourceRequest local', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: 'cloud_role' as AiRoleKey,
        roleRevisionId: 'role_cloud_01' as AiRoleRevisionId,
        title: 'Cloud Role',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_cloud' as AiRoleBindingKey,
        bindingRevisionId: 'bind_cloud_01' as AiRoleBindingRevisionId,
        roleKey: 'cloud_role' as AiRoleKey,
        roleRevisionId: 'role_cloud_01' as AiRoleRevisionId,
        routeRevisionId: 'route_cloud_01' as RouteRevisionId,
        target: {
          kind: 'external_provider_model',
          providerKey: 'groq',
          modelName: 'llama-3.3-70b',
        },
      }),
    );

    const resolved = resolveAiRole({ roleKey: 'cloud_role' as AiRoleKey, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      assert.throws(() => {
        createResourceRequestFromResolvedRole({
          requestId: 'req_03' as ResourceRequestId,
          resolvedRole: resolved,
          decisionId: 'dec_03' as DecisionId,
          materialContextId: 'ctx_03' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_03' as RouteEvaluationId,
          routeRevisionId: 'route_cloud_01' as RouteRevisionId,
          profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
          intent: 'ensure_model_loaded',
          requestedAt: '2026-08-19T20:00:00.000Z',
        });
      }, (err: any) => err instanceof AiRoleResourceGovernorIntegrationError && err.code === 'NON_LOCAL_EXECUTOR_TARGET');
    }
  });

  // E4. unbound role não produz ResourceRequest
  it('E4. unbound role não produz ResourceRequest e permanece bloqueado no resolver', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: 'unbound_role' as AiRoleKey,
        roleRevisionId: 'role_unbound_01' as AiRoleRevisionId,
        title: 'Unbound Role',
      }),
    );

    const resolved = resolveAiRole({ roleKey: 'unbound_role' as AiRoleKey, registry });
    assert.equal(resolved.status, 'binding_not_found');

    assert.throws(() => {
      createResourceRequestFromResolvedRole({
        requestId: 'req_04' as ResourceRequestId,
        resolvedRole: resolved as any,
        decisionId: 'dec_04' as DecisionId,
        materialContextId: 'ctx_04' as DecisionMaterialContextId,
        routeEvaluationId: 'eval_04' as RouteEvaluationId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
        intent: 'ensure_model_loaded',
        requestedAt: '2026-08-19T20:00:00.000Z',
      });
    }, (err: any) => err instanceof AiRoleResourceGovernorIntegrationError && err.code === 'UNRESOLVED_AI_ROLE');
  });

  // E5. ambiguous binding não produz ResourceRequest
  it('E5. ambiguous binding não produz ResourceRequest', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        title: 'Resident',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_a' as AiRoleBindingKey,
        bindingRevisionId: 'bind_a_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_b' as AiRoleBindingKey,
        bindingRevisionId: 'bind_b_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_b' },
      }),
    );

    const resolved = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(resolved.status, 'binding_ambiguous');
  });

  // E6. nenhum helper cria ResourceAdmission ou Attempt
  it('E6. helper produz puramente ResourceRequest e não fabrica ResourceAdmission nem AttemptCreatedEvent', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        title: 'Resident',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );

    const resolved = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      const request = createResourceRequestFromResolvedRole({
        requestId: 'req_01' as ResourceRequestId,
        resolvedRole: resolved,
        decisionId: 'dec_01' as DecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        routeEvaluationId: 'eval_01' as RouteEvaluationId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
        intent: 'ensure_model_loaded',
        requestedAt: '2026-08-19T20:00:00.000Z',
      });

      const untyped = request as unknown as Record<string, unknown>;
      assert.equal(untyped.admissionId, undefined);
      assert.equal(untyped.attemptId, undefined);
      assert.equal(untyped.disposition, undefined);
    }
  });

  // F10. local_model runtime ollama → ResourceRequest continua válido
  it('F10. local_model runtime ollama continua válido e gera ResourceRequest normal', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        title: 'Resident',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'ministral-3:3b' },
      }),
    );

    const resolved = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      const request = createResourceRequestFromResolvedRole({
        requestId: 'req_01' as ResourceRequestId,
        resolvedRole: resolved,
        decisionId: 'dec_01' as DecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        routeEvaluationId: 'eval_01' as RouteEvaluationId,
        routeRevisionId: 'route_ollama_01' as RouteRevisionId,
        profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
        intent: 'ensure_model_loaded',
        requestedAt: '2026-08-19T20:00:00.000Z',
      });

      assert.equal(request.targetModel, 'ministral-3:3b');
    }
  });

  // F11. local_model runtime onnx_runtime → UNSUPPORTED_LOCAL_RUNTIME
  it('F11. local_model runtime onnx_runtime é rejeitado pelo adapter com UNSUPPORTED_LOCAL_RUNTIME', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: 'r2_candidate' as AiRoleKey,
        roleRevisionId: 'role_r2_01' as AiRoleRevisionId,
        title: 'R2 Candidate Role',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_onnx' as AiRoleBindingKey,
        bindingRevisionId: 'bind_onnx_01' as AiRoleBindingRevisionId,
        roleKey: 'r2_candidate' as AiRoleKey,
        roleRevisionId: 'role_r2_01' as AiRoleRevisionId,
        routeRevisionId: 'route_onnx_01' as RouteRevisionId,
        target: {
          kind: 'local_model',
          runtimeKey: 'onnx_runtime',
          modelName: 'phi-3-mini-directml',
        },
      }),
    );

    const resolved = resolveAiRole({ roleKey: 'r2_candidate' as AiRoleKey, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      assert.throws(() => {
        createResourceRequestFromResolvedRole({
          requestId: 'req_onnx' as ResourceRequestId,
          resolvedRole: resolved,
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_01' as RouteEvaluationId,
          routeRevisionId: 'route_onnx_01' as RouteRevisionId,
          profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
          intent: 'ensure_model_loaded',
          requestedAt: '2026-08-19T20:00:00.000Z',
        });
      }, (err: any) => err instanceof AiRoleResourceGovernorIntegrationError && err.code === 'UNSUPPORTED_LOCAL_RUNTIME');
    }
  });

  // F12. local_model runtime mlc → UNSUPPORTED_LOCAL_RUNTIME
  it('F12. local_model runtime mlc é rejeitado pelo adapter com UNSUPPORTED_LOCAL_RUNTIME', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: 'mlc_candidate' as AiRoleKey,
        roleRevisionId: 'role_mlc_01' as AiRoleRevisionId,
        title: 'MLC Candidate Role',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_mlc' as AiRoleBindingKey,
        bindingRevisionId: 'bind_mlc_01' as AiRoleBindingRevisionId,
        roleKey: 'mlc_candidate' as AiRoleKey,
        roleRevisionId: 'role_mlc_01' as AiRoleRevisionId,
        routeRevisionId: 'route_mlc_01' as RouteRevisionId,
        target: {
          kind: 'local_model',
          runtimeKey: 'mlc',
          modelName: 'llama-3-8b-q4f16_1',
        },
      }),
    );

    const resolved = resolveAiRole({ roleKey: 'mlc_candidate' as AiRoleKey, registry });
    assert.equal(resolved.status, 'resolved');

    if (resolved.status === 'resolved') {
      assert.throws(() => {
        createResourceRequestFromResolvedRole({
          requestId: 'req_mlc' as ResourceRequestId,
          resolvedRole: resolved,
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_01' as RouteEvaluationId,
          routeRevisionId: 'route_mlc_01' as RouteRevisionId,
          profileRevisionId: 'prof_std' as ResourceProfileRevisionId,
          intent: 'ensure_model_loaded',
          requestedAt: '2026-08-19T20:00:00.000Z',
        });
      }, (err: any) => err instanceof AiRoleResourceGovernorIntegrationError && err.code === 'UNSUPPORTED_LOCAL_RUNTIME');
    }
  });
});
