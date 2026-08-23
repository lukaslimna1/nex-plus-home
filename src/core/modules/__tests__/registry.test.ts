/**
 * NEX+ · Módulos, Referências & Eventos
 * Testes Unitários de ModuleRegistry & ResourceRef — Escopo 0.86 (Bloco 0.86A)
 *
 * Cenários MR-1 a MR-9 + RR-1 a RR-4:
 * 1. Estabilidade de ModuleRef através de revisões (V1 -> V2).
 * 2. Validação rigorosa de supersession (Anti-Self, Anti-Cross, Anti-Ciclo, Missing Ref).
 * 3. Resolução determinística de Heads e detecção de ambiguidades.
 * 4. Imutabilidade e preservação de ownership de ResourceRef.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ModuleKey,
  ModuleManifestRevision,
  ModuleRevisionId,
  ResourceId,
  ResourceType,
} from '../contracts';
import {
  createModuleRegistry,
  DuplicateModuleRevisionError,
  SelfSupersessionError,
  CrossModuleSupersessionError,
  SupersededRevisionNotFoundError,
  SupersessionCycleError,
  AmbiguousModuleHeadError,
  InvalidIdentifierError,
} from '../registry';

describe('NEX+ Module Registry & ResourceRef (0.86A)', () => {
  // ==========================================================================
  // 1. MODULE REGISTRY & SUPERSESSION (MR-1 .. MR-9)
  // ==========================================================================

  it('MR-1: ModuleRef permanece estável entre revision V1 e V2', () => {
    const registry = createModuleRegistry();

    const rev1: ModuleManifestRevision = {
      moduleKey: 'module.catalog' as ModuleKey,
      moduleRevisionId: 'mod_rev_catalog_v1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Catalog Module',
      description: 'Manages items and categories v1',
      ownedResourceTypes: ['item' as ResourceType, 'category' as ResourceType],
      emittedEventTypes: [],
    };

    const rev2: ModuleManifestRevision = {
      moduleKey: 'module.catalog' as ModuleKey,
      moduleRevisionId: 'mod_rev_catalog_v2' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['mod_rev_catalog_v1' as ModuleRevisionId],
      title: 'Catalog Module V2',
      description: 'Manages items and categories v2 with enhanced schemas',
      ownedResourceTypes: ['item' as ResourceType, 'category' as ResourceType, 'tag' as ResourceType],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(rev1);
    const refBefore = registry.createModuleRef('module.catalog');

    registry.registerModuleRevision(rev2);
    const refAfter = registry.createModuleRef('module.catalog');

    // A identidade do módulo é estável
    assert.equal(refBefore.moduleKey, 'module.catalog');
    assert.equal(refAfter.moduleKey, 'module.catalog');
    assert.deepEqual(refBefore, refAfter);

    // O head ativo evoluiu para V2
    const activeHead = registry.getActiveHead('module.catalog' as ModuleKey);
    assert.ok(activeHead);
    assert.equal(activeHead.moduleRevisionId, 'mod_rev_catalog_v2');
  });

  it('MR-2: Revision ID duplicada é rejeitada fail-visible com DuplicateModuleRevisionError', () => {
    const registry = createModuleRegistry();

    const rev: ModuleManifestRevision = {
      moduleKey: 'module.auth' as ModuleKey,
      moduleRevisionId: 'mod_rev_auth_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Auth Module',
      description: 'Authentication',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(rev);

    assert.throws(
      () => {
        registry.registerModuleRevision({
          ...rev,
          title: 'Tampered Title',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DuplicateModuleRevisionError);
        assert.equal(err.revisionId, 'mod_rev_auth_1');
        return true;
      },
    );
  });

  it('MR-3: Self-supersession é estritamente proibida e rejeitada com SelfSupersessionError', () => {
    const registry = createModuleRegistry();

    const rev: ModuleManifestRevision = {
      moduleKey: 'module.self' as ModuleKey,
      moduleRevisionId: 'mod_rev_self_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['mod_rev_self_1' as ModuleRevisionId],
      title: 'Self Module',
      description: 'Self supersession test',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    assert.throws(
      () => {
        registry.registerModuleRevision(rev);
      },
      (err: any) => {
        assert.ok(err instanceof SelfSupersessionError);
        assert.equal(err.revisionId, 'mod_rev_self_1');
        return true;
      },
    );
  });

  it('MR-4: Cross-module supersession é estritamente proibida e rejeitada com CrossModuleSupersessionError', () => {
    const registry = createModuleRegistry();

    const revAlpha: ModuleManifestRevision = {
      moduleKey: 'module.alpha' as ModuleKey,
      moduleRevisionId: 'mod_rev_alpha_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Alpha',
      description: 'Module Alpha',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(revAlpha);

    const revBeta: ModuleManifestRevision = {
      moduleKey: 'module.beta' as ModuleKey,
      moduleRevisionId: 'mod_rev_beta_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['mod_rev_alpha_1' as ModuleRevisionId], // Tentativa de superseder alpha
      title: 'Beta',
      description: 'Module Beta',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    assert.throws(
      () => {
        registry.registerModuleRevision(revBeta);
      },
      (err: any) => {
        assert.ok(err instanceof CrossModuleSupersessionError);
        assert.equal(err.sourceModuleKey, 'module.beta');
        assert.equal(err.targetModuleKey, 'module.alpha');
        return true;
      },
    );
  });

  it('MR-5: Aciclicidade do grafo de supersession é garantida por construção (impossibilidade de referência futura ou redefinição retroativa)', () => {
    const registry = createModuleRegistry();

    const rev1: ModuleManifestRevision = {
      moduleKey: 'module.acyclic' as ModuleKey,
      moduleRevisionId: 'mod_rev_ac_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Acyclic 1',
      description: 'First revision',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(rev1);

    const rev2: ModuleManifestRevision = {
      moduleKey: 'module.acyclic' as ModuleKey,
      moduleRevisionId: 'mod_rev_ac_2' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['mod_rev_ac_1' as ModuleRevisionId],
      title: 'Acyclic 2',
      description: 'Second revision superseding first',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(rev2);

    // Vetor de ataque 1: Tentar criar ciclo apontando para uma revisão futura/inexistente que depois apontaria de volta
    assert.throws(
      () => {
        registry.registerModuleRevision({
          moduleKey: 'module.acyclic' as ModuleKey,
          moduleRevisionId: 'mod_rev_future' as ModuleRevisionId,
          lifecycle: 'active',
          supersedesRevisionIds: ['mod_rev_not_yet_created' as ModuleRevisionId],
          title: 'Future',
          description: 'Forward reference',
          ownedResourceTypes: [],
          emittedEventTypes: [],
        });
      },
      (err: any) => {
        assert.ok(err instanceof SupersededRevisionNotFoundError);
        assert.equal(err.missingSupersededId, 'mod_rev_not_yet_created');
        return true;
      },
    );

    // Vetor de ataque 2: Tentar reescrever uma revisão antiga (rev1) para criar back-edge apontando para rev2 (ciclo rev1 -> rev2 -> rev1)
    assert.throws(
      () => {
        registry.registerModuleRevision({
          moduleKey: 'module.acyclic' as ModuleKey,
          moduleRevisionId: 'mod_rev_ac_1' as ModuleRevisionId, // Tenta redefinir rev1
          lifecycle: 'active',
          supersedesRevisionIds: ['mod_rev_ac_2' as ModuleRevisionId], // Back-edge para rev2
          title: 'Tampered Rev1',
          description: 'Attempting to create cycle',
          ownedResourceTypes: [],
          emittedEventTypes: [],
        });
      },
      (err: any) => {
        assert.ok(err instanceof DuplicateModuleRevisionError);
        assert.equal(err.revisionId, 'mod_rev_ac_1');
        return true;
      },
    );

    // Grafo legítimo permanece como DAG acíclico
    const rev3: ModuleManifestRevision = {
      moduleKey: 'module.acyclic' as ModuleKey,
      moduleRevisionId: 'mod_rev_ac_3' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['mod_rev_ac_2' as ModuleRevisionId],
      title: 'Acyclic 3',
      description: 'Third revision in chain',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };
    registry.registerModuleRevision(rev3);

    assert.equal(registry.getActiveHead('module.acyclic' as ModuleKey)?.moduleRevisionId, 'mod_rev_ac_3');
  });

  it('MR-6: Superseded revision inexistente é rejeitada fail-visible com SupersededRevisionNotFoundError', () => {
    const registry = createModuleRegistry();

    const rev: ModuleManifestRevision = {
      moduleKey: 'module.ghost' as ModuleKey,
      moduleRevisionId: 'mod_rev_ghost_2' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['mod_rev_ghost_1_non_existent' as ModuleRevisionId],
      title: 'Ghost',
      description: 'Ghost supersession',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    assert.throws(
      () => {
        registry.registerModuleRevision(rev);
      },
      (err: any) => {
        assert.ok(err instanceof SupersededRevisionNotFoundError);
        assert.equal(err.missingSupersededId, 'mod_rev_ghost_1_non_existent');
        return true;
      },
    );
  });

  it('MR-7: Uma única head ativa resolve deterministicamente no getActiveHead', () => {
    const registry = createModuleRegistry();

    const rev1: ModuleManifestRevision = {
      moduleKey: 'module.single' as ModuleKey,
      moduleRevisionId: 'mod_rev_s1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'S1',
      description: 'Single head test',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(rev1);

    const head = registry.getActiveHead('module.single' as ModuleKey);
    assert.ok(head);
    assert.equal(head.moduleRevisionId, 'mod_rev_s1');
  });

  it('MR-8: Duas heads ativas paralelas resultam em AmbiguousModuleHeadError', () => {
    const registry = createModuleRegistry();

    const branchA: ModuleManifestRevision = {
      moduleKey: 'module.fork' as ModuleKey,
      moduleRevisionId: 'mod_rev_fork_a' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Fork A',
      description: 'Branch A',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    const branchB: ModuleManifestRevision = {
      moduleKey: 'module.fork' as ModuleKey,
      moduleRevisionId: 'mod_rev_fork_b' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [], // Nenhuma supersedes a outra
      title: 'Fork B',
      description: 'Branch B',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(branchA);
    registry.registerModuleRevision(branchB);

    assert.throws(
      () => {
        registry.getActiveHead('module.fork' as ModuleKey);
      },
      (err: any) => {
        assert.ok(err instanceof AmbiguousModuleHeadError);
        assert.equal(err.moduleKey, 'module.fork');
        assert.equal(err.activeHeadRevisionIds.length, 2);
        return true;
      },
    );

    // getAllHeads retorna ambas as heads sem erro
    const allHeads = registry.getAllHeads('module.fork' as ModuleKey);
    assert.equal(allHeads.length, 2);
  });

  it('MR-9: Deprecated e Retired não são escolhidos silenciosamente como active head', () => {
    const registry = createModuleRegistry();

    const revDep: ModuleManifestRevision = {
      moduleKey: 'module.dep' as ModuleKey,
      moduleRevisionId: 'mod_rev_dep_1' as ModuleRevisionId,
      lifecycle: 'deprecated',
      supersedesRevisionIds: [],
      title: 'Deprecated Module',
      description: 'Deprecated',
      ownedResourceTypes: [],
      emittedEventTypes: [],
    };

    registry.registerModuleRevision(revDep);

    // getActiveHead retorna undefined quando a única head é deprecated
    assert.equal(registry.getActiveHead('module.dep' as ModuleKey), undefined);

    // getAllHeads ainda retorna a revisão
    assert.equal(registry.getAllHeads('module.dep' as ModuleKey).length, 1);
  });

  // ==========================================================================
  // 2. RESOURCE REF (RR-1 .. RR-4)
  // ==========================================================================

  it('RR-1: ResourceRef válido mantém ownerModule, resourceType e resourceId', () => {
    const registry = createModuleRegistry();
    const ref = registry.createResourceRef('module.catalog', 'product', 'prod-12345');

    assert.equal(ref.ownerModule.moduleKey, 'module.catalog');
    assert.equal(ref.resourceType, 'product');
    assert.equal(ref.resourceId, 'prod-12345');
  });

  it('RR-2: module.beta referencia recurso de module.alpha sem transferir ownership', () => {
    const registry = createModuleRegistry();
    const alphaResource = registry.createResourceRef('module.alpha', 'invoice', 'inv-999');

    // Módulo beta consome a referência de alpha
    const consumerContext = {
      consumerModule: registry.createModuleRef('module.beta'),
      targetResource: alphaResource,
    };

    assert.equal(consumerContext.consumerModule.moduleKey, 'module.beta');
    // O owner do recurso permanece sendo estritamente module.alpha
    assert.equal(consumerContext.targetResource.ownerModule.moduleKey, 'module.alpha');
    assert.equal(consumerContext.targetResource.resourceType, 'invoice');
    assert.equal(consumerContext.targetResource.resourceId, 'inv-999');
  });

  it('RR-3: ResourceRef é imutável (Object.freeze) e alterações lançam erro ou não afetam o objeto', () => {
    const registry = createModuleRegistry();
    const ref = registry.createResourceRef('module.alpha', 'record', 'rec-1');

    assert.throws(() => {
      (ref as any).resourceId = 'rec-hacked';
    });
    assert.throws(() => {
      (ref.ownerModule as any).moduleKey = 'module.beta';
    });
  });

  it('RR-4: Identificadores vazios, com whitespace ou inválidos são rejeitados com InvalidIdentifierError', () => {
    const registry = createModuleRegistry();

    assert.throws(
      () => registry.createModuleRef(''),
      (err: any) => err instanceof InvalidIdentifierError,
    );

    assert.throws(
      () => registry.createModuleRef(' module.spaced '),
      (err: any) => err instanceof InvalidIdentifierError,
    );

    assert.throws(
      () => registry.createResourceRef('module.ok', '', 'id-1'),
      (err: any) => err instanceof InvalidIdentifierError,
    );

    assert.throws(
      () => registry.createResourceRef('module.ok', 'type-1', '  id-with-spaces  '),
      (err: any) => err instanceof InvalidIdentifierError,
    );
  });
});
