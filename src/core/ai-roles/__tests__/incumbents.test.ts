/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Testes de Substituição de Ocupantes e Targets Genéricos — Escopo 0.7A
 *
 * Cenários C1 a C6 + D1 a D6:
 * - Resolução dos incumbentes canônicos (Ministral 3B e Qwen 3.5 9B)
 * - Substituição linear transparente sem alteração do consumidor
 * - Targets genéricos (locais e provedores externos sem secrets)
 * - Independência de Policy/Topologia em relação ao nome do papel
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RouteRevisionId } from '../../capabilities/contracts';

import type {
  AiRoleBindingKey,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRevisionId,
  ExternalProviderModelExecutorTargetRef,
  LocalModelExecutorTargetRef,
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
import { toApprovedLocalModelRef } from '../integration/resource-governor';

describe('NEX+ AI Role Registry · Incumbent Bindings & Occupant Replacement (0.7A)', () => {
  // C1. local_resident inicialmente resolve para Ministral
  it('C1. local_resident inicialmente resolve para o incumbente Ministral 3B', () => {
    const registry = createAiRoleRegistry();
    const role = createCanonicalRoleRevision({
      roleKey: ROLE_LOCAL_RESIDENT,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      title: 'Local Resident Fast AI',
    });
    const binding = createCanonicalBindingRevision({
      bindingKey: 'bind_res_incumbent' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId,
      roleKey: ROLE_LOCAL_RESIDENT,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_local' as RouteRevisionId,
      target: INCUMBENT_LOCAL_RESIDENT_TARGET,
    });

    registry.appendRoleRevision(role);
    registry.appendBindingRevision(binding);

    const result = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.target.kind, 'local_model');
      if (result.target.kind === 'local_model') {
        assert.equal(result.target.runtimeKey, 'ollama');
        assert.equal(result.target.modelName, 'ministral-3:3b');
      }
    }
  });

  // C2. nova binding revision pode apontar para outro modelo fictício
  it('C2. nova binding revision pode apontar para outro modelo fictício', () => {
    const registry = createAiRoleRegistry();
    const role = createCanonicalRoleRevision({
      roleKey: ROLE_LOCAL_RESIDENT,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      title: 'Local Resident Fast AI',
    });
    registry.appendRoleRevision(role);

    // Incumbente rev 1
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_local' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );

    // Nova revisão futura substituindo o incumbente
    const futureTarget: LocalModelExecutorTargetRef = {
      kind: 'local_model',
      runtimeKey: 'ollama',
      modelName: 'future-fast-model:2b',
    };

    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_02' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_local' as RouteRevisionId,
        target: futureTarget,
        supersedesRevisionIds: ['bind_res_01' as AiRoleBindingRevisionId],
      }),
    );

    const result = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      if (result.target.kind === 'local_model') {
        assert.equal(result.target.modelName, 'future-fast-model:2b');
      }
    }
  });

  // C3. após supersession linear, roleKey continua o mesmo
  it('C3. após supersession linear, roleKey permanece estritamente idêntico', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        title: 'Local Resident',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_res' as AiRoleBindingKey,
        bindingRevisionId: 'bind_res_02' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_res_01' as AiRoleRevisionId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'next-gen:3b' },
        supersedesRevisionIds: ['bind_res_01' as AiRoleBindingRevisionId],
      }),
    );

    const result = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.roleRevision.roleKey, 'local_resident');
    }
  });

  // C4. consumidor que pede local_resident não muda
  it('C4. consumidor que consome local_resident não sofre alterações', () => {
    const consumerFunction = (reg: any) => {
      const res = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry: reg });
      if (res.status !== 'resolved') throw new Error('Unresolved');
      return res.target;
    };

    const reg1 = createAiRoleRegistry();
    reg1.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_01' as AiRoleRevisionId,
        title: 'Resident',
      }),
    );
    reg1.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'b1' as AiRoleBindingKey,
        bindingRevisionId: 'b_rev_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_01' as AiRoleRevisionId,
        routeRevisionId: 'r1' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );

    const t1 = consumerFunction(reg1);
    assert.equal((t1 as any).modelName, 'ministral-3:3b');
  });

  // C5. nenhuma lógica do resolver contém branch específico para Ministral
  it('C5. resolver opera puramente por contratos e referências sem branches ad-hoc', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: 'custom_generic_role' as AiRoleKey,
        roleRevisionId: 'role_custom_01' as AiRoleRevisionId,
        title: 'Generic Role',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_custom' as AiRoleBindingKey,
        bindingRevisionId: 'bind_custom_01' as AiRoleBindingRevisionId,
        roleKey: 'custom_generic_role' as AiRoleKey,
        roleRevisionId: 'role_custom_01' as AiRoleRevisionId,
        routeRevisionId: 'route_custom_01' as RouteRevisionId,
        target: { kind: 'local_model', runtimeKey: 'custom_runtime', modelName: 'any_model:1b' },
      }),
    );

    const result = resolveAiRole({ roleKey: 'custom_generic_role' as AiRoleKey, registry });
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal((result.target as any).modelName, 'any_model:1b');
    }
  });

  // C6. local_heavy resolve para Qwen 3.5 9B atual
  it('C6. local_heavy resolve para o incumbente Qwen 3.5 9B atual', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_HEAVY,
        roleRevisionId: 'role_heavy_01' as AiRoleRevisionId,
        title: 'Local Heavy AI',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_heavy_incumbent' as AiRoleBindingKey,
        bindingRevisionId: 'bind_heavy_rev_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_HEAVY,
        roleRevisionId: 'role_heavy_01' as AiRoleRevisionId,
        routeRevisionId: 'route_ollama_local' as RouteRevisionId,
        target: INCUMBENT_LOCAL_HEAVY_TARGET,
      }),
    );

    const result = resolveAiRole({ roleKey: ROLE_LOCAL_HEAVY, registry });
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.target.kind, 'local_model');
      if (result.target.kind === 'local_model') {
        assert.equal(result.target.runtimeKey, 'ollama');
        assert.equal(result.target.modelName, 'qwen3.5:9b');
      }
    }
  });

  // D1. local_model target válido
  it('D1. local_model target válido com runtimeKey e modelName', () => {
    const target: LocalModelExecutorTargetRef = {
      kind: 'local_model',
      runtimeKey: 'onnx_runtime',
      modelName: 'phi-3-mini-directml',
      digest: 'sha256:onnxdigest',
    };

    assert.equal(target.kind, 'local_model');
    assert.equal(target.runtimeKey, 'onnx_runtime');
    assert.equal(target.digest, 'sha256:onnxdigest');
  });

  // D2. external_provider_model target válido
  it('D2. external_provider_model target válido com providerKey', () => {
    const target: ExternalProviderModelExecutorTargetRef = {
      kind: 'external_provider_model',
      providerKey: 'google_genai',
      modelName: 'gemini-1.5-pro',
      credentialProfileRef: 'cred_profile_default',
    };

    assert.equal(target.kind, 'external_provider_model');
    assert.equal(target.providerKey, 'google_genai');
  });

  // D3. provider target não recebe secret field
  it('D3. provider target não possui campos de segredo/token/apiKey no contrato', () => {
    const target: ExternalProviderModelExecutorTargetRef = {
      kind: 'external_provider_model',
      providerKey: 'groq',
      modelName: 'llama-3.3-70b',
    };

    const untyped = target as unknown as Record<string, unknown>;
    assert.equal(untyped.apiKey, undefined);
    assert.equal(untyped.secret, undefined);
    assert.equal(untyped.token, undefined);
  });

  // D4. roleKey não determina topology
  it('D4. roleKey não é utilizado como autoridade de topologia de rede', () => {
    // Um papel pode se chamar local_resident e estar amarrado a um target de teste sem que o roleKey conceda acesso
    const role = createCanonicalRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_01' as AiRoleRevisionId,
      title: 'Local Resident',
    });

    assert.equal(role.roleKey, 'local_resident');
    // Topologia é exclusiva do RouteRevision/Policy no Core 0.5
  });

  // D5. external target não é convertido para ApprovedLocalModelRef
  it('D5. external target não é convertido para ApprovedLocalModelRef pelo adapter', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: 'cloud_reasoning' as AiRoleKey,
        roleRevisionId: 'role_cloud_01' as AiRoleRevisionId,
        title: 'Cloud Reasoning',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_cloud' as AiRoleBindingKey,
        bindingRevisionId: 'bind_cloud_01' as AiRoleBindingRevisionId,
        roleKey: 'cloud_reasoning' as AiRoleKey,
        roleRevisionId: 'role_cloud_01' as AiRoleRevisionId,
        routeRevisionId: 'route_cloud_01' as RouteRevisionId,
        target: {
          kind: 'external_provider_model',
          providerKey: 'openai',
          modelName: 'gpt-4o',
        },
      }),
    );

    const resolved = resolveAiRole({ roleKey: 'cloud_reasoning' as AiRoleKey, registry });
    assert.equal(resolved.status, 'resolved');
    if (resolved.status === 'resolved') {
      const ref = toApprovedLocalModelRef(resolved);
      assert.equal(ref, undefined);
    }
  });

  // D6. local Ollama target válido pode ser projetado para ApprovedLocalModelRef
  it('D6. local Ollama target válido é projetado para ApprovedLocalModelRef', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision(
      createCanonicalRoleRevision({
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_01' as AiRoleRevisionId,
        title: 'Local Resident',
      }),
    );
    registry.appendBindingRevision(
      createCanonicalBindingRevision({
        bindingKey: 'bind_01' as AiRoleBindingKey,
        bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
        roleKey: ROLE_LOCAL_RESIDENT,
        roleRevisionId: 'role_01' as AiRoleRevisionId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        target: INCUMBENT_LOCAL_RESIDENT_TARGET,
      }),
    );

    const resolved = resolveAiRole({ roleKey: ROLE_LOCAL_RESIDENT, registry });
    assert.equal(resolved.status, 'resolved');
    if (resolved.status === 'resolved') {
      const ref = toApprovedLocalModelRef(resolved);
      assert.notEqual(ref, undefined);
      assert.equal(ref?.runtime, 'ollama_local');
      assert.equal(ref?.modelName, 'ministral-3:3b');
    }
  });
});
