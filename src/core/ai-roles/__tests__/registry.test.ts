/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Testes Unitários do Registry — Escopo 0.7A
 *
 * Cenários A1 a A10:
 * - Append de revisões de Role e Binding
 * - Rejeição de IDs duplicados
 * - Rejeição de referências inexistentes
 * - DAG de supersessão explícita
 * - Preservação de múltiplos heads
 * - Imutabilidade e ausência de relógio interno
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RouteRevisionId } from '../../capabilities/contracts';

import type {
  AiRoleBindingKey,
  AiRoleBindingRevision,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRevision,
  AiRoleRevisionId,
} from '../contracts';
import { createAiRoleRegistry, AiRoleRegistryError } from '../registry';

describe('NEX+ AI Role Registry · Registry Storage & Supersession (0.7A)', () => {
  // A1. append role revision
  it('A1. append role revision armazena revisão imutável com sucesso', () => {
    const registry = createAiRoleRegistry();
    const role: AiRoleRevision = {
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident Fast AI',
      description: 'Papel de baixa latência e footprint contido.',
    };

    registry.appendRoleRevision(role);
    const retrieved = registry.getRoleRevision('role_rev_01' as AiRoleRevisionId);

    assert.equal(retrieved?.roleKey, 'local_resident');
    assert.equal(retrieved?.roleRevisionId, 'role_rev_01');
    assert.equal(retrieved?.lifecycle, 'active');
  });

  // A2. duplicate RoleRevisionId rejeitado
  it('A2. duplicate RoleRevisionId é rejeitado deterministicamente', () => {
    const registry = createAiRoleRegistry();
    const role: AiRoleRevision = {
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident Fast AI',
    };

    registry.appendRoleRevision(role);

    assert.throws(() => {
      registry.appendRoleRevision({
        ...role,
        title: 'Mutated Title',
      });
    }, (err: any) => err instanceof AiRoleRegistryError && err.code === 'DUPLICATE_ROLE_REVISION_ID');
  });

  // A3. append binding revision
  it('A3. append binding revision armazena binding correlacionado com role existente', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Local Resident Fast AI',
    });

    const binding: AiRoleBindingRevision = {
      bindingKey: 'bind_local_resident' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_ollama_01' as RouteRevisionId,
      target: {
        kind: 'local_model',
        runtimeKey: 'ollama',
        modelName: 'ministral-3:3b',
      },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    };

    registry.appendBindingRevision(binding);
    const retrieved = registry.getBindingRevision('bind_rev_01' as AiRoleBindingRevisionId);

    assert.equal(retrieved?.bindingKey, 'bind_local_resident');
    assert.equal(retrieved?.target.kind, 'local_model');
  });

  // A4. duplicate BindingRevisionId rejeitado
  it('A4. duplicate BindingRevisionId é rejeitado deterministicamente', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Role 01',
    });

    const binding: AiRoleBindingRevision = {
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_a' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    };

    registry.appendBindingRevision(binding);

    assert.throws(() => {
      registry.appendBindingRevision(binding);
    }, (err: any) => err instanceof AiRoleRegistryError && err.code === 'DUPLICATE_BINDING_REVISION_ID');
  });

  // A5. binding referencia role inexistente → rejeitado
  it('A5. binding que referencia role inexistente é rejeitado', () => {
    const registry = createAiRoleRegistry();
    const binding: AiRoleBindingRevision = {
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_NON_EXISTENT' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_a' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    };

    assert.throws(() => {
      registry.appendBindingRevision(binding);
    }, (err: any) => err instanceof AiRoleRegistryError && err.code === 'REFERENCED_ROLE_NOT_FOUND');
  });

  // A6. primeiro binding sem supersedes válido
  it('A6. primeiro binding sem supersedes é registrado como head', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Role 01',
    });

    registry.appendBindingRevision({
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_a' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    const heads = registry.getBindingHeadsForRole('role_rev_01' as AiRoleRevisionId);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].bindingRevisionId, 'bind_rev_01');
  });

  // A7. segundo binding pode superseder head atual
  it('A7. segundo binding pode superseder head anterior de forma linear', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Role 01',
    });

    registry.appendBindingRevision({
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_a' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    registry.appendBindingRevision({
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_02' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_b' },
      lifecycle: 'active',
      supersedesRevisionIds: ['bind_rev_01' as AiRoleBindingRevisionId],
    });

    const heads = registry.getBindingHeadsForRole('role_rev_01' as AiRoleRevisionId);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].bindingRevisionId, 'bind_rev_02');
  });

  // A8. superseder revisão stale não define current silenciosamente
  it('A8. superseder revisão stale cria múltiplos heads', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Role 01',
    });

    // rev 01
    registry.appendBindingRevision({
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_a' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    // rev 02 supersedes rev 01
    registry.appendBindingRevision({
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_02' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_b' },
      lifecycle: 'active',
      supersedesRevisionIds: ['bind_rev_01' as AiRoleBindingRevisionId],
    });

    // rev 03 supersedes rev 01 (bifurcação / concurrent edit)
    registry.appendBindingRevision({
      bindingKey: 'bind_01' as AiRoleBindingKey,
      bindingRevisionId: 'bind_rev_03' as AiRoleBindingRevisionId,
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_c' },
      lifecycle: 'active',
      supersedesRevisionIds: ['bind_rev_01' as AiRoleBindingRevisionId],
    });

    const heads = registry.getBindingHeadsForRole('role_rev_01' as AiRoleRevisionId);
    assert.equal(heads.length, 2);
    assert.equal(heads.some((h) => h.bindingRevisionId === 'bind_rev_02'), true);
    assert.equal(heads.some((h) => h.bindingRevisionId === 'bind_rev_03'), true);
  });

  // A9. múltiplos heads são preservados
  it('A9. múltiplos heads são preservados no registry', () => {
    const registry = createAiRoleRegistry();
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Branch A',
    });
    registry.appendRoleRevision({
      roleKey: 'local_resident' as AiRoleKey,
      roleRevisionId: 'role_rev_02' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Branch B',
    });

    const heads = registry.getRoleHeads('local_resident' as AiRoleKey);
    assert.equal(heads.length, 2);
  });

  // A10. registry não usa createdAt como current
  it('A10. registry não infere heads por ordem ou tempo', () => {
    const registry = createAiRoleRegistry();
    const role: AiRoleRevision = {
      roleKey: 'local_heavy' as AiRoleKey,
      roleRevisionId: 'role_h_01' as AiRoleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Heavy Role',
    };
    registry.appendRoleRevision(role);

    // Inserção em ordem arbitrária
    registry.appendBindingRevision({
      bindingKey: 'bind_h' as AiRoleBindingKey,
      bindingRevisionId: 'bind_h_rev_02' as AiRoleBindingRevisionId,
      roleKey: 'local_heavy' as AiRoleKey,
      roleRevisionId: 'role_h_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_2' },
      lifecycle: 'active',
      supersedesRevisionIds: ['bind_h_rev_01' as AiRoleBindingRevisionId],
    });

    registry.appendBindingRevision({
      bindingKey: 'bind_h' as AiRoleBindingKey,
      bindingRevisionId: 'bind_h_rev_01' as AiRoleBindingRevisionId,
      roleKey: 'local_heavy' as AiRoleKey,
      roleRevisionId: 'role_h_01' as AiRoleRevisionId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      target: { kind: 'local_model', runtimeKey: 'ollama', modelName: 'model_1' },
      lifecycle: 'active',
      supersedesRevisionIds: [],
    });

    const heads = registry.getBindingHeadsForRole('role_h_01' as AiRoleRevisionId);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].bindingRevisionId, 'bind_h_rev_02');
  });
});
