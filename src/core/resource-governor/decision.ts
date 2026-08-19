/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Motor Determinístico de Decisão do Resource Governor — Escopo 0.6 (Fase B)
 *
 * Avalia se um workload local pode utilizar recursos físicos no momento e sob o perfil configurado.
 * Função pura, sem relógio interno, sem IDs aleatórios internos.
 * Proíbe auto-eviction e ordenação incidental de candidatos.
 */

import type {
  ApprovedLocalModelRef,
  GovernorDecision,
  GpuDeviceTelemetry,
  ResourceLease,
  ResourceMaterialFacts,
  ResourceProfileRevision,
  ResourceRequest,
  ResourceSnapshot,
} from './contracts';

import { isModelApproved, normalizeModelName } from './ollama/lifecycle';

export interface EvaluateResourceRequestParams {
  readonly request: ResourceRequest;
  readonly snapshot: ResourceSnapshot;
  readonly profile: ResourceProfileRevision;
  readonly leases: readonly ResourceLease[];
  readonly approvedCatalog: readonly ApprovedLocalModelRef[];
  readonly evaluatedAt: string; // Timestamp explícito de avaliação (ISO 8601 UTC)
}

export function evaluateResourceRequest(
  params: EvaluateResourceRequestParams,
): GovernorDecision {
  const {
    request,
    snapshot,
    profile,
    leases,
    approvedCatalog,
    evaluatedAt,
  } = params;

  if (!evaluatedAt || isNaN(Date.parse(evaluatedAt))) {
    throw new Error('[ResourceGovernor] evaluatedAt must be a valid ISO 8601 timestamp.');
  }

  // 1. FRESHNESS GATE
  const snapshotEpoch = Date.parse(snapshot.collectedAt);
  const evalEpoch = Date.parse(evaluatedAt);
  const ageMs = evalEpoch - snapshotEpoch;

  if (isNaN(snapshotEpoch) || ageMs < 0 || ageMs > profile.maximumTelemetryAgeMs) {
    return {
      disposition: 'defer',
      reasonCode: 'SNAPSHOT_STALE',
      materialFacts: {
        snapshotFreshness: 'stale',
      },
      evaluatedAt,
    };
  }

  // 2. TARGET MODEL APPROVAL GATE
  if (request.targetModel) {
    if (!isModelApproved(approvedCatalog, request.targetModel)) {
      return {
        disposition: 'deny',
        reasonCode: 'MODEL_NOT_APPROVED',
        materialFacts: {
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }
  }

  // 3. HEADROOM & PENDING RESERVED LEASES (Apenas 'reserved' pendente; 'active' já está na telemetria)
  let pendingReservedRamBytes = 0;
  let pendingReservedVramBytes = 0;

  for (const lease of leases) {
    if (lease.state === 'reserved') {
      pendingReservedRamBytes += lease.reservedRamBytes || 0;
      pendingReservedVramBytes += lease.reservedVramBytes || 0;
    }
  }

  // 4. SYSTEM RAM & CPU GATE
  if (snapshot.system.status !== 'available') {
    return {
      disposition: 'defer',
      reasonCode: 'SYSTEM_TELEMETRY_UNAVAILABLE',
      materialFacts: {
        snapshotFreshness: 'fresh',
        pendingReservedRamBytes,
      },
      evaluatedAt,
    };
  }

  const effectiveFreeRamBytes = snapshot.system.freeRamBytes - pendingReservedRamBytes;
  const availableRamHeadroom = effectiveFreeRamBytes - profile.minimumFreeSystemRamBytes;

  const estimatedRam = request.estimatedAdditionalRamBytes;
  if (estimatedRam !== undefined && estimatedRam > 0) {
    if (availableRamHeadroom < estimatedRam) {
      return {
        disposition: 'defer',
        reasonCode: 'INSUFFICIENT_SYSTEM_RAM',
        materialFacts: {
          freeRamBytes: snapshot.system.freeRamBytes,
          pendingReservedRamBytes,
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }
  }

  if (profile.maximumCpuUtilizationPercent !== undefined) {
    if (snapshot.system.cpuUtilizationPercent === undefined) {
      return {
        disposition: 'defer',
        reasonCode: 'CPU_UTILIZATION_UNKNOWN',
        materialFacts: {
          freeRamBytes: snapshot.system.freeRamBytes,
          pendingReservedRamBytes,
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }

    if (snapshot.system.cpuUtilizationPercent > profile.maximumCpuUtilizationPercent) {
      return {
        disposition: 'defer',
        reasonCode: 'CPU_UTILIZATION_EXCEEDED',
        materialFacts: {
          cpuUtilizationPercent: snapshot.system.cpuUtilizationPercent,
          freeRamBytes: snapshot.system.freeRamBytes,
          pendingReservedRamBytes,
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }
  }

  // 5. GPU & VRAM GATE
  let selectedGpu: GpuDeviceTelemetry | undefined = undefined;
  const isGpuMaterial =
    request.requiresGpu === true ||
    request.targetGpuUuid !== undefined ||
    (request.estimatedAdditionalVramBytes !== undefined && request.estimatedAdditionalVramBytes > 0);

  if (isGpuMaterial) {
    if (snapshot.gpu.status !== 'available' || snapshot.gpu.devices.length === 0) {
      return {
        disposition: 'defer',
        reasonCode: 'GPU_TELEMETRY_UNAVAILABLE',
        materialFacts: {
          snapshotFreshness: 'fresh',
          freeRamBytes: snapshot.system.freeRamBytes,
        },
        evaluatedAt,
      };
    }

    const devices = snapshot.gpu.devices;
    if (devices.length > 1) {
      if (!request.targetGpuUuid) {
        return {
          disposition: 'defer',
          reasonCode: 'MULTIPLE_GPUS_REQUIRE_TARGET',
          materialFacts: {
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }

      selectedGpu = devices.find((d) => d.uuid === request.targetGpuUuid);
      if (!selectedGpu) {
        return {
          disposition: 'deny',
          reasonCode: 'TARGET_GPU_NOT_FOUND',
          materialFacts: {
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }
    } else {
      // Exatamente 1 GPU
      const single = devices[0];
      if (request.targetGpuUuid && request.targetGpuUuid !== single.uuid) {
        return {
          disposition: 'deny',
          reasonCode: 'TARGET_GPU_NOT_FOUND',
          materialFacts: {
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }
      selectedGpu = single;
    }

    // Validação de Headroom de VRAM no dispositivo selecionado
    const effectiveFreeVramBytes = selectedGpu.memoryFreeBytes - pendingReservedVramBytes;
    const availableVramHeadroom = effectiveFreeVramBytes - profile.minimumFreeVramBytes;

    const estimatedVram = request.estimatedAdditionalVramBytes;
    if (estimatedVram !== undefined && estimatedVram > 0) {
      if (availableVramHeadroom < estimatedVram) {
        // Coleta candidatos a descarregamento (fatos neutros, sem ordenação de auto-eviction)
        const evictionCandidates: string[] = [];
        if (snapshot.ollama.status === 'available') {
          for (const loaded of snapshot.ollama.loadedModels) {
            const isProtected = leases.some(
              (l) =>
                (l.state === 'reserved' || l.state === 'active') &&
                l.targetModel &&
                normalizeModelName(l.targetModel) === normalizeModelName(loaded.modelName),
            );
            if (!isProtected) {
              evictionCandidates.push(loaded.modelName);
            }
          }
        }

        return {
          disposition: 'defer',
          reasonCode: 'INSUFFICIENT_VRAM',
          materialFacts: {
            freeVramBytes: selectedGpu.memoryFreeBytes,
            pendingReservedVramBytes,
            evictionCandidates: evictionCandidates.length > 0 ? Object.freeze(evictionCandidates) : undefined,
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }
    }

    if (profile.maximumGpuUtilizationPercent !== undefined) {
      if (selectedGpu.gpuUtilizationPercent > profile.maximumGpuUtilizationPercent) {
        return {
          disposition: 'defer',
          reasonCode: 'GPU_UTILIZATION_EXCEEDED',
          materialFacts: {
            gpuUtilizationPercent: selectedGpu.gpuUtilizationPercent,
            freeVramBytes: selectedGpu.memoryFreeBytes,
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }
    }
  }

  // 6. INTENT EVALUATION
  const targetModel = request.targetModel;
  const targetNorm = targetModel ? normalizeModelName(targetModel) : '';
  const isTargetLoaded = targetNorm
    ? snapshot.ollama.loadedModels.some((m) => normalizeModelName(m.modelName) === targetNorm)
    : false;

  const baseMaterialFacts: ResourceMaterialFacts = {
    freeRamBytes: snapshot.system.freeRamBytes,
    freeVramBytes: selectedGpu?.memoryFreeBytes,
    cpuUtilizationPercent: snapshot.system.cpuUtilizationPercent,
    gpuUtilizationPercent: selectedGpu?.gpuUtilizationPercent,
    targetModelLoaded: targetModel ? isTargetLoaded : undefined,
    pendingReservedRamBytes: pendingReservedRamBytes > 0 ? pendingReservedRamBytes : undefined,
    pendingReservedVramBytes: pendingReservedVramBytes > 0 ? pendingReservedVramBytes : undefined,
    snapshotFreshness: 'fresh',
  };

  // 6.1 Intent: use_current_state
  if (request.intent === 'use_current_state') {
    return {
      disposition: 'admit',
      reasonCode: 'RESOURCES_ADMITTED',
      materialFacts: baseMaterialFacts,
      evaluatedAt,
    };
  }

  // 6.2 Intent: ensure_model_loaded
  if (request.intent === 'ensure_model_loaded') {
    if (!targetModel) {
      return {
        disposition: 'deny',
        reasonCode: 'TARGET_MODEL_REQUIRED',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    if (isTargetLoaded) {
      return {
        disposition: 'admit',
        reasonCode: 'MODEL_ALREADY_LOADED',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    // Modelo não carregado: checa se perfil permite preload
    if (!profile.allowModelPreload) {
      return {
        disposition: 'deny',
        reasonCode: 'PRELOAD_PROHIBITED_BY_PROFILE',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    // Se exige estimativas e não foram fornecidas no request nem no catálogo
    if (request.requiresGpu && request.estimatedAdditionalVramBytes === undefined) {
      const catalogEntry = approvedCatalog.find((c) => normalizeModelName(c.modelName) === targetNorm);
      if (!catalogEntry?.estimatedVramBytes) {
        return {
          disposition: 'defer',
          reasonCode: 'ESTIMATED_RESOURCES_MISSING',
          materialFacts: baseMaterialFacts,
          evaluatedAt,
        };
      }
    }

    return {
      disposition: 'action_required',
      reasonCode: 'PRELOAD_REQUIRED',
      requiredAction: {
        kind: 'preload_model',
        targetModel,
        targetGpuUuid: selectedGpu?.uuid,
        reasonCode: 'PRELOAD_REQUIRED',
      },
      materialFacts: baseMaterialFacts,
      evaluatedAt,
    };
  }

  // 6.3 Intent: ensure_model_unloaded
  if (request.intent === 'ensure_model_unloaded') {
    if (!targetModel) {
      return {
        disposition: 'deny',
        reasonCode: 'TARGET_MODEL_REQUIRED',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    if (!isTargetLoaded) {
      return {
        disposition: 'admit',
        reasonCode: 'MODEL_ALREADY_UNLOADED',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    // Modelo carregado: checa se está protegido por lease
    const isProtected = leases.some(
      (l) =>
        (l.state === 'reserved' || l.state === 'active') &&
        l.targetModel &&
        normalizeModelName(l.targetModel) === targetNorm,
    );

    if (isProtected) {
      return {
        disposition: 'deny',
        reasonCode: 'MODEL_PROTECTED_BY_ACTIVE_LEASE',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    if (!profile.allowModelUnload) {
      return {
        disposition: 'deny',
        reasonCode: 'UNLOAD_PROHIBITED_BY_PROFILE',
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    return {
      disposition: 'action_required',
      reasonCode: 'UNLOAD_REQUIRED',
      requiredAction: {
        kind: 'unload_model',
        targetModel,
        targetGpuUuid: selectedGpu?.uuid,
        reasonCode: 'UNLOAD_REQUIRED',
      },
      materialFacts: baseMaterialFacts,
      evaluatedAt,
    };
  }

  return {
    disposition: 'deny',
    reasonCode: 'UNSUPPORTED_INTENT',
    materialFacts: baseMaterialFacts,
    evaluatedAt,
  };
}
