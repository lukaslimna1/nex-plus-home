/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes Determinísticos do Motor do Governor — Escopo 0.6 (Fase B)
 *
 * Cenários B14 a B40: Matriz completa de admissão, deferral, denial, lifecycle actions,
 * gating de modelos locais, isolamento de GPU/VRAM e proibição de auto-eviction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionId, RouteEvaluationId } from '../../execution/contracts';
import type { RouteRevisionId } from '../../capabilities/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';

import type {
  ApprovedLocalModelRef,
  ResourceLease,
  ResourceProfileKey,
  ResourceProfileRevision,
  ResourceProfileRevisionId,
  ResourceRequest,
  ResourceRequestId,
  ResourceSnapshot,
  ResourceSnapshotId,
} from '../contracts';

import { createResourceProfileRevision } from '../profiles';
import { evaluateResourceRequest } from '../decision';

const mockCatalog: readonly ApprovedLocalModelRef[] = [
  { modelName: 'llama3:8b', runtime: 'ollama_local', estimatedVramBytes: 6 * 1024 * 1024 * 1024 },
  { modelName: 'mistral:7b', runtime: 'ollama_local', estimatedVramBytes: 5 * 1024 * 1024 * 1024 },
  { modelName: 'phi3:mini', runtime: 'ollama_local', estimatedVramBytes: 3 * 1024 * 1024 * 1024 },
];

const mockProfile: ResourceProfileRevision = createResourceProfileRevision({
  profileKey: 'prof_std' as ResourceProfileKey,
  profileRevisionId: 'prof_rev_std' as ResourceProfileRevisionId,
  minimumFreeSystemRamBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  minimumFreeVramBytes: 1 * 1024 * 1024 * 1024,      // 1 GiB
  maximumCpuUtilizationPercent: 90,
  maximumGpuUtilizationPercent: 95,
  maximumTelemetryAgeMs: 5000,
  allowModelPreload: true,
  allowModelUnload: true,
});

function createBaseSnapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    snapshotId: 'snap_01' as ResourceSnapshotId,
    collectedAt: '2026-08-19T20:00:00.000Z',
    system: {
      status: 'available',
      totalRamBytes: 32 * 1024 * 1024 * 1024,
      freeRamBytes: 16 * 1024 * 1024 * 1024,
      usedRamBytes: 16 * 1024 * 1024 * 1024,
      logicalCpuCount: 16,
      cpuUtilizationPercent: 25,
      observedAt: '2026-08-19T20:00:00.000Z',
    },
    gpu: {
      status: 'available',
      devices: [
        {
          index: 0,
          uuid: 'GPU-single-01',
          name: 'NVIDIA RTX 4090',
          memoryTotalBytes: 24 * 1024 * 1024 * 1024,
          memoryUsedBytes: 4 * 1024 * 1024 * 1024,
          memoryFreeBytes: 20 * 1024 * 1024 * 1024,
          gpuUtilizationPercent: 10,
          memoryUtilizationPercent: 16,
          temperatureCelsius: 45,
        },
      ],
      observedAt: '2026-08-19T20:00:00.000Z',
    },
    ollama: {
      status: 'available',
      loadedModels: [],
      observedAt: '2026-08-19T20:00:00.000Z',
    },
    ...overrides,
  };
}

function createBaseRequest(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
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

describe('NEX+ Resource Governor · Decision Engine (Fase B)', () => {
  // B14. snapshot fresh + recursos suficientes → admit
  it('B14. snapshot fresh + recursos suficientes → admit', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest(),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'admit');
    assert.equal(decision.reasonCode, 'RESOURCES_ADMITTED');
  });

  // B15. snapshot stale → defer
  it('B15. snapshot stale → defer', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest(),
      snapshot: createBaseSnapshot({ collectedAt: '2026-08-19T20:00:00.000Z' }),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:10.000Z', // 10s > 5s max age
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'SNAPSHOT_STALE');
    assert.equal(decision.materialFacts.snapshotFreshness, 'stale');
  });

  // B16. RAM insuficiente → defer
  it('B16. RAM insuficiente → defer', () => {
    const snap = createBaseSnapshot();
    // Free RAM = 3 GiB. Minimum free profile = 2 GiB. Available headroom = 1 GiB.
    const customSnap: ResourceSnapshot = {
      ...snap,
      system: { ...snap.system, freeRamBytes: 3 * 1024 * 1024 * 1024 },
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ estimatedAdditionalRamBytes: 2 * 1024 * 1024 * 1024 }), // Needs 2 GiB
      snapshot: customSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'INSUFFICIENT_SYSTEM_RAM');
  });

  // B17. VRAM insuficiente → defer
  it('B17. VRAM insuficiente → defer', () => {
    const snap = createBaseSnapshot();
    // GPU Free VRAM = 2 GiB. Profile minimum = 1 GiB. Available = 1 GiB.
    const customSnap: ResourceSnapshot = {
      ...snap,
      gpu: {
        ...snap.gpu,
        devices: [{ ...snap.gpu.devices[0], memoryFreeBytes: 2 * 1024 * 1024 * 1024 }],
      },
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        requiresGpu: true,
        estimatedAdditionalVramBytes: 3 * 1024 * 1024 * 1024, // Needs 3 GiB
      }),
      snapshot: customSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'INSUFFICIENT_VRAM');
  });

  // B18. CPU acima do profile → defer
  it('B18. CPU acima do profile → defer', () => {
    const snap = createBaseSnapshot();
    const customSnap: ResourceSnapshot = {
      ...snap,
      system: { ...snap.system, cpuUtilizationPercent: 95 }, // > 90%
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest(),
      snapshot: customSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'CPU_UTILIZATION_EXCEEDED');
  });

  // B19. GPU acima do profile → defer
  it('B19. GPU acima do profile → defer', () => {
    const snap = createBaseSnapshot();
    const customSnap: ResourceSnapshot = {
      ...snap,
      gpu: {
        ...snap.gpu,
        devices: [{ ...snap.gpu.devices[0], gpuUtilizationPercent: 98 }], // > 95%
      },
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ requiresGpu: true }),
      snapshot: customSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'GPU_UTILIZATION_EXCEEDED');
  });

  // B20. CPU unknown quando threshold é material → defer
  it('B20. CPU unknown quando threshold é material → defer', () => {
    const snap = createBaseSnapshot();
    const customSnap: ResourceSnapshot = {
      ...snap,
      system: { ...snap.system, cpuUtilizationPercent: undefined },
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest(),
      snapshot: customSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'CPU_UTILIZATION_UNKNOWN');
  });

  // B21. GPU telemetry ausente quando VRAM é material → defer
  it('B21. GPU telemetry ausente quando VRAM é material → defer', () => {
    const snap = createBaseSnapshot({
      gpu: { status: 'unavailable', devices: [], observedAt: '2026-08-19T20:00:00.000Z' },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ requiresGpu: true }),
      snapshot: snap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'GPU_TELEMETRY_UNAVAILABLE');
  });

  // B22. rota CPU-only não exige GPU telemetry
  it('B22. rota CPU-only não exige GPU telemetry', () => {
    const snap = createBaseSnapshot({
      gpu: { status: 'unavailable', devices: [], observedAt: '2026-08-19T20:00:00.000Z' },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ requiresGpu: false }),
      snapshot: snap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'admit');
  });

  // B23. estimativa RAM necessária ausente / insuficiente
  it('B23. estimativa RAM faltante ao exceder headroom → defer', () => {
    const snap = createBaseSnapshot();
    const customSnap: ResourceSnapshot = {
      ...snap,
      system: { ...snap.system, freeRamBytes: 2.5 * 1024 * 1024 * 1024 }, // Headroom = 0.5 GiB
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ estimatedAdditionalRamBytes: 1 * 1024 * 1024 * 1024 }),
      snapshot: customSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'INSUFFICIENT_SYSTEM_RAM');
  });

  // B24. estimativa VRAM necessária ausente quando exigida → defer
  it('B24. estimativa VRAM necessária ausente no request e no catálogo → defer', () => {
    const catalogWithoutVram: readonly ApprovedLocalModelRef[] = [
      { modelName: 'llama3:8b', runtime: 'ollama_local' }, // sem estimatedVramBytes
    ];

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_loaded',
        targetModel: 'llama3:8b',
        requiresGpu: true,
      }),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: catalogWithoutVram,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'ESTIMATED_RESOURCES_MISSING');
  });

  // B25. não usa disk model size como VRAM estimate
  it('B25. catálogo factual é a fonte de estimativa de VRAM', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_loaded',
        targetModel: 'llama3:8b',
        requiresGpu: true,
      }),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog, // mockCatalog has estimatedVramBytes: 6 GiB
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'action_required');
    assert.equal(decision.requiredAction?.kind, 'preload_model');
  });

  // B26. modelo aprovado já loaded → não pede preload (admit)
  it('B26. modelo aprovado já loaded → não pede preload', () => {
    const snap = createBaseSnapshot({
      ollama: {
        status: 'available',
        loadedModels: [
          {
            modelName: 'llama3:8b',
            sizeVramBytes: 6 * 1024 * 1024 * 1024,
            observedAt: '2026-08-19T20:00:00.000Z',
          },
        ],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_loaded',
        targetModel: 'llama3:8b',
      }),
      snapshot: snap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'admit');
    assert.equal(decision.reasonCode, 'MODEL_ALREADY_LOADED');
    assert.equal(decision.requiredAction, undefined);
  });

  // B27. modelo aprovado não loaded recursos suficientes → action_required preload
  it('B27. modelo aprovado não loaded recursos suficientes → action_required preload', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_loaded',
        targetModel: 'mistral:7b',
        requiresGpu: true,
      }),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'action_required');
    assert.equal(decision.requiredAction?.kind, 'preload_model');
    assert.equal(decision.requiredAction?.targetModel, 'mistral:7b');
  });

  // B28. profile proíbe preload → deny
  it('B28. profile proíbe preload → deny', () => {
    const strictProfile = createResourceProfileRevision({
      ...mockProfile,
      allowModelPreload: false,
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_loaded',
        targetModel: 'mistral:7b',
      }),
      snapshot: createBaseSnapshot(),
      profile: strictProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'deny');
    assert.equal(decision.reasonCode, 'PRELOAD_PROHIBITED_BY_PROFILE');
  });

  // B29. explicit unload de modelo livre → action_required unload
  it('B29. explicit unload de modelo livre → action_required unload', () => {
    const snap = createBaseSnapshot({
      ollama: {
        status: 'available',
        loadedModels: [{ modelName: 'llama3:8b', observedAt: '2026-08-19T20:00:00.000Z' }],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_unloaded',
        targetModel: 'llama3:8b',
      }),
      snapshot: snap,
      profile: mockProfile,
      leases: [], // Nenhum lease ativo
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'action_required');
    assert.equal(decision.requiredAction?.kind, 'unload_model');
    assert.equal(decision.requiredAction?.targetModel, 'llama3:8b');
  });

  // B30. explicit unload de modelo leased → deny
  it('B30. explicit unload de modelo leased → deny', () => {
    const snap = createBaseSnapshot({
      ollama: {
        status: 'available',
        loadedModels: [{ modelName: 'llama3:8b', observedAt: '2026-08-19T20:00:00.000Z' }],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const activeLease: ResourceLease = {
      leaseId: 'lease_active_01' as any,
      requestId: 'req_01' as any,
      decisionId: 'dec_01' as any,
      materialContextId: 'ctx_01' as any,
      routeRevisionId: 'route_rev_01' as any,
      targetModel: 'llama3:8b',
      reservedRamBytes: 0,
      reservedVramBytes: 0,
      state: 'active',
      createdAt: '2026-08-19T20:00:00.000Z',
    };

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_unloaded',
        targetModel: 'llama3:8b',
      }),
      snapshot: snap,
      profile: mockProfile,
      leases: [activeLease],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'deny');
    assert.equal(decision.reasonCode, 'MODEL_PROTECTED_BY_ACTIVE_LEASE');
  });

  // B31. modelo já unloaded → no action necessária
  it('B31. modelo já unloaded → no action necessária', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_unloaded',
        targetModel: 'llama3:8b',
      }),
      snapshot: createBaseSnapshot(), // loadedModels: []
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'admit');
    assert.equal(decision.reasonCode, 'MODEL_ALREADY_UNLOADED');
  });

  // B32. pressão VRAM não escolhe eviction target (defer com evictionCandidates neutros)
  it('B32. pressão VRAM não escolhe eviction target', () => {
    const snap = createBaseSnapshot({
      gpu: {
        status: 'available',
        devices: [
          {
            index: 0,
            uuid: 'GPU-01',
            name: 'RTX 4090',
            memoryTotalBytes: 24 * 1024 * 1024 * 1024,
            memoryUsedBytes: 22 * 1024 * 1024 * 1024,
            memoryFreeBytes: 2 * 1024 * 1024 * 1024, // 2 GiB free (minimum 1 GiB -> 1 GiB headroom)
            gpuUtilizationPercent: 10,
            memoryUtilizationPercent: 90,
          },
        ],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
      ollama: {
        status: 'available',
        loadedModels: [
          { modelName: 'llama3:8b', sizeVramBytes: 6 * 1024 * 1024 * 1024, observedAt: '2026-08-19T20:00:00.000Z' },
          { modelName: 'phi3:mini', sizeVramBytes: 3 * 1024 * 1024 * 1024, observedAt: '2026-08-19T20:00:00.000Z' },
        ],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        requiresGpu: true,
        estimatedAdditionalVramBytes: 5 * 1024 * 1024 * 1024, // Needs 5 GiB
      }),
      snapshot: snap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'INSUFFICIENT_VRAM');
    // Candidates reportados neutramente como fatos, sem escolher vencedor
    assert.equal(decision.materialFacts.evictionCandidates?.length, 2);
  });

  // B33. dois eviction candidates não usam array order
  it('B33. evictionCandidates lista ambos os modelos livres sem ordenar como autoridade', () => {
    const snap = createBaseSnapshot({
      gpu: {
        status: 'available',
        devices: [{ ...createBaseSnapshot().gpu.devices[0], memoryFreeBytes: 1 * 1024 * 1024 * 1024 }],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
      ollama: {
        status: 'available',
        loadedModels: [
          { modelName: 'phi3:mini', observedAt: '2026-08-19T20:00:00.000Z' },
          { modelName: 'llama3:8b', observedAt: '2026-08-19T20:00:00.000Z' },
        ],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        requiresGpu: true,
        estimatedAdditionalVramBytes: 4 * 1024 * 1024 * 1024,
      }),
      snapshot: snap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.materialFacts.evictionCandidates?.includes('phi3:mini'), true);
    assert.equal(decision.materialFacts.evictionCandidates?.includes('llama3:8b'), true);
  });

  // B34. múltiplas GPUs sem target explícito → defer
  it('B34. múltiplas GPUs sem target explícito → defer', () => {
    const multiGpuSnap = createBaseSnapshot({
      gpu: {
        status: 'available',
        devices: [
          { ...createBaseSnapshot().gpu.devices[0], uuid: 'GPU-AAA' },
          { ...createBaseSnapshot().gpu.devices[0], uuid: 'GPU-BBB' },
        ],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ requiresGpu: true }), // targetGpuUuid omitted
      snapshot: multiGpuSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.reasonCode, 'MULTIPLE_GPUS_REQUIRE_TARGET');
  });

  // B35. GPU target explícita válida → usa aquela GPU
  it('B35. GPU target explícita válida → usa aquela GPU', () => {
    const multiGpuSnap = createBaseSnapshot({
      gpu: {
        status: 'available',
        devices: [
          { ...createBaseSnapshot().gpu.devices[0], uuid: 'GPU-AAA', memoryFreeBytes: 20 * 1024 * 1024 * 1024 },
          { ...createBaseSnapshot().gpu.devices[0], uuid: 'GPU-BBB', memoryFreeBytes: 1 * 1024 * 1024 * 1024 },
        ],
        observedAt: '2026-08-19T20:00:00.000Z',
      },
    });

    const decision = evaluateResourceRequest({
      request: createBaseRequest({ requiresGpu: true, targetGpuUuid: 'GPU-AAA' }),
      snapshot: multiGpuSnap,
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'admit');
    assert.equal(decision.materialFacts.freeVramBytes, 20 * 1024 * 1024 * 1024);
  });

  // B36. GPU target inexistente → deny
  it('B36. GPU target inexistente → deny', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest({ requiresGpu: true, targetGpuUuid: 'GPU-NON_EXISTENT' }),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'deny');
    assert.equal(decision.reasonCode, 'TARGET_GPU_NOT_FOUND');
  });

  // B37. modelo não aprovado → deny
  it('B37. modelo não aprovado → deny', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest({
        intent: 'ensure_model_loaded',
        targetModel: 'unapproved_deepseek:70b',
      }),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    assert.equal(decision.disposition, 'deny');
    assert.equal(decision.reasonCode, 'MODEL_NOT_APPROVED');
  });

  // B38. mesmos inputs → mesma GovernorDecision
  it('B38. determinismo estrito: mesmos inputs → mesma GovernorDecision', () => {
    const params = {
      request: createBaseRequest(),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    };

    const dec1 = evaluateResourceRequest(params);
    const dec2 = evaluateResourceRequest(params);

    assert.deepEqual(dec1, dec2);
  });

  // B39. Decision não usa clock interno
  it('B39. evaluatedAt inválido lança erro explícito', () => {
    assert.throws(() => {
      evaluateResourceRequest({
        request: createBaseRequest(),
        snapshot: createBaseSnapshot(),
        profile: mockProfile,
        leases: [],
        approvedCatalog: mockCatalog,
        evaluatedAt: 'invalid-date',
      });
    }, /evaluatedAt must be a valid ISO 8601/);
  });

  // B40. material facts não copiam telemetria irrelevante
  it('B40. material facts preservam apenas fatos essenciais', () => {
    const decision = evaluateResourceRequest({
      request: createBaseRequest(),
      snapshot: createBaseSnapshot(),
      profile: mockProfile,
      leases: [],
      approvedCatalog: mockCatalog,
      evaluatedAt: '2026-08-19T20:00:01.000Z',
    });

    const untyped = decision.materialFacts as Record<string, unknown>;
    assert.equal(untyped.devices, undefined);
    assert.equal(untyped.installedModels, undefined);
    assert.equal(untyped.loadedModels, undefined);
  });
});
