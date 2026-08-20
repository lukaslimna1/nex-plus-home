/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Testes Unitários do Resolver — Escopo 0.7A
 *
 * Cenários B1 a B10:
 * - Resolução unívoca de papel e binding ativo
 * - Rejeição de papéis e bindings ausentes ou inativos
 * - Detecção de ambiguidade em múltiplos heads
 * - Correlação cruzada e seleção por ID explícito
 * - Independência estrita da ordem de inserção
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RouteRevisionId } from '../../capabilities/contracts';

import type {
  AiRoleBindingKey,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRevisionId,
} from '../contracts';
import { createAiRoleRegistry } from '../registry';
import { resolveAiRole } from '../resolver';

describe('NEX+ AI Role Registry · Resolver Logic (0.7A)', () => {
  // B1. role inexistente → role_not_found
  it('B1. role inexistente retorna status role_not_found', () => {
    const registry = createAiRoleRegistry();
    const result = resolveAiRole({
      roleKey: 'non_existent_role' as AiRoleKey,
      registry,
    });

    assert.equal(result.status, 'role_not_found');
    if (result.status === 'role_not_found') {
      assert.equal(result.roleKey, 'non_existent_role');
    }
  });

  // B2. um role head + um binding head → resolved
  it('B2. um role head + um binding head ativo resolve com sucesso', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident',
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_res_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'ministral-3:3b' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    const result = resolveAiRole({
      roleKey: 'local_resident' as AiRoleKey,
      registry,
    });

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.roleRevision.roleKey, 'local_resident');
      assert.equal(result.bindingRevision.bindingRevisionId, 'bind_res_rev_01');
      assert.equal(result.routeRevisionId, 'route_ollama_01');
      assert.equal(result.target.kind, 'local_model');
    }
  });

  // B3. múltiplos role heads sem pin → role_ambiguous
  it('B3. múltiplos role heads sem pin retorna role_ambiguous', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Variant A',
    });
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_02' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Variant B',
    });

    const result = resolveAiRole({
      roleKey: 'local_resident' as AiRoleKey,
      registry,
    });

    assert.equal(result.status, 'role_ambiguous');
    if (result.status === 'role_ambiguous') {
      assert.equal(result.candidateRoleRevisionIds.length, 2);
    }
  });

  // B4. múltiplos binding heads sem pin → binding_ambiguous
  it('B4. múltiplos binding heads sem pin retorna binding_ambiguous', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident',
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_res_a' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_1' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_res_b' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_02' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_2' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    const result = resolveAiRole({
      roleKey: 'local_resident' as AiRoleKey,
      registry,
    });

    assert.equal(result.status, 'binding_ambiguous');
    if (result.status === 'binding_ambiguous') {
      assert.equal(result.candidateBindingRevisionIds.length, 2);
    }
  });

  // B5. bindingRevisionId explícito válido → seleciona exatamente ele
  it('B5. bindingRevisionId explícito válido seleciona a revisão especificada', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident',
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_res' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_1' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_res' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_02' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_2' },
      lifecycle: 'active',
      supersedesRevisionIds: ['bind_res_rev_01' as AiRoleBindingRevisionId],
    });

    const result = resolveAiRole({
      roleKey: 'local_resident' as AiRoleKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId, // pinned explicitly
      registry,
    });

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.bindingRevision.bindingRevisionId, 'bind_res_rev_01');
    }
  });

  // B6. binding de outro role → invalid_correlation
  it('B6. binding de outro role retorna invalid_correlation', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident',
    });
    registry.appendRoleRevision({
      roleKey: 'local_heavy' as AiRoleKey,
      roleRevisionId: 'role_heavy_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Heavy',
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_heavy' as AiRoleBindingKey,
      bindingRevisionId: 'bind_heavy_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_heavy' as AiRoleKey,
      roleRevisionId: 'role_heavy_01' as AiRoleRevisionId,
      routeRevisionId: 'route_heavy_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'heavy_model' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    // Pede local_resident mas fornece binding do local_heavy
    const result = resolveAiRole({
      roleKey: 'local_resident' as AiRoleKey,
      bindingRevisionId: 'bind_heavy_rev_01' as AiRoleBindingRevisionId,
      registry,
    });

    assert.equal(result.status, 'invalid_correlation');
  });

  // B7. role retired não resolve operacionalmente
  it('B7. role retired retorna role_not_active', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'legacy_role' as AiRoleKey,
      roleRevisionId: 'role_legacy_01' as AiRoleRevisionId,
      lifecycle: 'retired',
      supersedesRevisionIds: [],
      title: 'Legacy Role',
    });

    const result = resolveAiRole({
      roleKey: 'legacy_role' as AiRoleKey,
      registry,
    });

    assert.equal(result.status, 'role_not_active');
  });

  // B8. binding retired não resolve operacionalmente
  it('B8. binding retired retorna binding_not_active', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident',
    });
    registry.appendBindingRevision({
      bindingKey: 'bind_res' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_ollama_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_1' },
      lifecycle: 'retired',
      supersedesRevisionIds: [],
    });

    const result = resolveAiRole({
      roleKey: 'local_resident' as AiRoleKey,
      bindingRevisionId: 'bind_res_rev_01' as AiRoleBindingRevisionId,
      registry,
    });

    assert.equal(result.status, 'binding_not_active');
  });

  // B9. papel sem binding → binding_not_found / unbound
  it('B9. papel sem binding retorna binding_not_found (unbound)', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'future_r2_role' as AiRoleKey,
      roleRevisionId: 'role_r2_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Future R2 Capability Role',
    });

    const result = resolveAiRole({
      roleKey: 'future_r2_role' as AiRoleKey,
      registry,
    });

    assert.equal(result.status, 'binding_not_found');
    if (result.status === 'binding_not_found') {
      assert.equal(result.roleRevision.roleKey, 'future_r2_role');
    }
  });

  // B10. ordem do array não altera resultado
  it('B10. ordem do array não altera resultado de resolução', () => {
    const regA = createAiRoleRegistry();
    const regB = createAiRoleRegistry();

    const role: any = {
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident',
    };
    regA.appendRoleRevision(role);
    regB.appendRoleRevision(role);

    const b1: any = {
      bindingKey: 'bind_res' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_1' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    };

    const b2: any = {
      bindingKey: 'bind_res' as AiRoleBindingKey,
      bindingRevisionId: 'bind_res_02' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_res_01' as AiRoleRevisionId,
      routeRevisionId: 'route_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_2' },
      lifecycle: 'active',
      supersedesRevisionIds: ['bind_res_01' as AiRoleBindingRevisionId],
    };

    // regA: b1 then b2
    regA.appendBindingRevision(b1);
    regA.appendBindingRevision(b2);

    // regB: b2 then b1
    regB.appendBindingRevision(b2);
    regB.appendBindingRevision(b1);

    const resA = resolveAiRole({ roleKey: 'local_resident' as AiRoleKey, registry: regA });
    const resB = resolveAiRole({ roleKey: 'local_resident' as AiRoleKey, registry: regB });

    assert.deepEqual(resA, resB);
  });
});
