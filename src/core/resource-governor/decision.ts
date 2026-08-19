/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Motor Determinístico de Decisão do Resource Governor — Escopo 0.6
 *
 * Avalia se um workload local pode utilizar recursos físicos no momento e sob o perfil configurado.
 * Função pura, sem relógio interno, sem IDs aleatórios internos.
 * Proíbe auto-eviction, ordenação incidental de candidatos e double-counting de modelos já carregados.
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

import { normalizeModelName } from './ollama/lifecycle';

export class ProfileRevisionMismatchError extends Error {
  readonly code: string;
  constructor(message: string) {
    super(`[ResourceGovernor] ${message}`);
    this.name = 'ProfileRevisionMismatchError';
    this.code = 'PROFILE_REVISION_MISMATCH';
  }
}

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

  // 0. PROFILE REVISION PINNING (Validação Causal Estrutural Obrigatória)
  if (request.profileRevisionId !== profile.profileRevisionId) {
    throw new ProfileRevisionMismatchError(
      `Profile revision mismatch: request specifies '${request.profileRevisionId}', but evaluation profile is '${profile.profileRevisionId}'.`,
    );
  }

  // 1. FRESHNESS GATE
  const snapshotEpoch = Date.parse(snapshot.collectedAt);
  const evalEpoch = Date.parse(evaluatedAt);
  const ageMs = evalEpoch - snapshotEpoch;

  if (isNaN(snapshotEpoch) || ageMs < 0 || ageMs > profile.maximumTelemetryAgeMs) {
    return {
      disposition: 'defer',
      reasonCode: 'SNAPSHOT_STALE',
      requestId: request.requestId,
      profileRevisionId: profile.profileRevisionId,
      resourceSnapshotId: snapshot.snapshotId,
      materialFacts: {
        snapshotFreshness: 'stale',
      },
      evaluatedAt,
    };
  }

  // 2. TARGET MODEL APPROVAL GATE
  const targetModel = request.targetModel;
  const targetNorm = targetModel ? normalizeModelName(targetModel) : '';

  let approvedEntry: ApprovedLocalModelRef | undefined = undefined;
  if (targetModel) {
    approvedEntry = approvedCatalog.find(
      (c) => c.runtime === 'ollama_local' && normalizeModelName(c.modelName) === targetNorm,
    );

    if (!approvedEntry) {
      return {
        disposition: 'deny',
        reasonCode: 'MODEL_NOT_APPROVED',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: {
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }
  }

  // 3. OLLAMA TELEMETRY STATE CHECK (Material para intents de lifecycle)
  const isLifecycleIntent =
    request.intent === 'ensure_model_loaded' || request.intent === 'ensure_model_unloaded';

  if (isLifecycleIntent && snapshot.ollama.status !== 'available') {
    return {
      disposition: 'defer',
      reasonCode: 'OLLAMA_STATE_UNAVAILABLE',
      requestId: request.requestId,
      profileRevisionId: profile.profileRevisionId,
      resourceSnapshotId: snapshot.snapshotId,
      materialFacts: {
        snapshotFreshness: 'fresh',
      },
      evaluatedAt,
    };
  }

  // 4. DETECÇÃO DE ESTADO DO TARGET & CÁLCULO DE CONSUMO ADICIONAL REAL
  const isTargetLoaded = Boolean(
    targetNorm &&
    snapshot.ollama.status === 'available' &&
    snapshot.ollama.loadedModels.some((m) => normalizeModelName(m.modelName) === targetNorm),
  );

  let additionalRamRequired: number | undefined = undefined;
  let additionalVramRequired: number | undefined = undefined;

  if (request.intent === 'ensure_model_loaded') {
    if (isTargetLoaded) {
      // Modelo já está carregado na memória; footprint já refletido na telemetria.
      // Consumo adicional = 0 para evitar double-counting.
      additionalRamRequired = 0;
      additionalVramRequired = 0;
    } else {
      // Modelo não está carregado; novo consumo adicional será exigido.
      additionalRamRequired =
        request.estimatedAdditionalRamBytes !== undefined
          ? request.estimatedAdditionalRamBytes
          : approvedEntry?.estimatedRamBytes;

      additionalVramRequired =
        request.estimatedAdditionalVramBytes !== undefined
          ? request.estimatedAdditionalVramBytes
          : approvedEntry?.estimatedVramBytes;
    }
  } else if (request.intent === 'ensure_model_unloaded') {
    // Unload libera memória e não consome footprint adicional.
    additionalRamRequired = 0;
    additionalVramRequired = 0;
  } else if (request.intent === 'use_current_state') {
    additionalRamRequired = request.estimatedAdditionalRamBytes !== undefined ? request.estimatedAdditionalRamBytes : 0;
    additionalVramRequired = request.estimatedAdditionalVramBytes !== undefined ? request.estimatedAdditionalVramBytes : 0;
  }

  // 5. SYSTEM RAM & CPU GATE
  if (snapshot.system.status !== 'available') {
    return {
      disposition: 'defer',
      reasonCode: 'SYSTEM_TELEMETRY_UNAVAILABLE',
      requestId: request.requestId,
      profileRevisionId: profile.profileRevisionId,
      resourceSnapshotId: snapshot.snapshotId,
      materialFacts: {
        snapshotFreshness: 'fresh',
      },
      evaluatedAt,
    };
  }

  // Headroom de RAM (Desconta apenas leases pendentes em estado 'reserved')
  let pendingReservedRamBytes = 0;
  for (const lease of leases) {
    if (lease.state === 'reserved') {
      pendingReservedRamBytes += lease.reservedRamBytes || 0;
    }
  }

  const effectiveFreeRamBytes = snapshot.system.freeRamBytes - pendingReservedRamBytes;
  const availableRamHeadroom = effectiveFreeRamBytes - profile.minimumFreeSystemRamBytes;

  if (additionalRamRequired !== undefined && additionalRamRequired > 0) {
    if (availableRamHeadroom < additionalRamRequired) {
      return {
        disposition: 'defer',
        reasonCode: 'INSUFFICIENT_SYSTEM_RAM',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: {
          freeRamBytes: snapshot.system.freeRamBytes,
          pendingReservedRamBytes: pendingReservedRamBytes > 0 ? pendingReservedRamBytes : undefined,
          effectiveEstimatedRamBytes: additionalRamRequired,
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
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: {
          freeRamBytes: snapshot.system.freeRamBytes,
          pendingReservedRamBytes: pendingReservedRamBytes > 0 ? pendingReservedRamBytes : undefined,
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }

    if (snapshot.system.cpuUtilizationPercent > profile.maximumCpuUtilizationPercent) {
      return {
        disposition: 'defer',
        reasonCode: 'CPU_UTILIZATION_EXCEEDED',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: {
          cpuUtilizationPercent: snapshot.system.cpuUtilizationPercent,
          freeRamBytes: snapshot.system.freeRamBytes,
          pendingReservedRamBytes: pendingReservedRamBytes > 0 ? pendingReservedRamBytes : undefined,
          snapshotFreshness: 'fresh',
        },
        evaluatedAt,
      };
    }
  }

  // 6. GPU & VRAM GATE COM ESCOPO DE DISPOSITIVO
  let selectedGpu: GpuDeviceTelemetry | undefined = undefined;
  let pendingReservedVramBytes = 0;

  const isGpuMaterial =
    request.requiresGpu === true ||
    request.targetGpuUuid !== undefined ||
    (additionalVramRequired !== undefined && additionalVramRequired > 0) ||
    (request.intent === 'ensure_model_loaded' && !isTargetLoaded);

  if (isGpuMaterial) {
    if (snapshot.gpu.status !== 'available' || snapshot.gpu.devices.length === 0) {
      return {
        disposition: 'defer',
        reasonCode: 'GPU_TELEMETRY_UNAVAILABLE',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
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
          requestId: request.requestId,
          profileRevisionId: profile.profileRevisionId,
          resourceSnapshotId: snapshot.snapshotId,
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
          requestId: request.requestId,
          profileRevisionId: profile.profileRevisionId,
          resourceSnapshotId: snapshot.snapshotId,
          materialFacts: {
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }

      // Em host multi-GPU: reservas pendentes devem ser atribuídas estritamente ao device
      for (const lease of leases) {
        if (lease.state === 'reserved' && (lease.reservedVramBytes || 0) > 0) {
          if (!lease.targetGpuUuid) {
            // Reserva sem GPU-target em ambiente multi-GPU é ambígua
            return {
              disposition: 'defer',
              reasonCode: 'AMBIGUOUS_VRAM_RESERVATION',
              requestId: request.requestId,
              profileRevisionId: profile.profileRevisionId,
              resourceSnapshotId: snapshot.snapshotId,
              materialFacts: {
                snapshotFreshness: 'fresh',
              },
              evaluatedAt,
            };
          }
          if (lease.targetGpuUuid === selectedGpu.uuid) {
            pendingReservedVramBytes += lease.reservedVramBytes;
          }
        }
      }
    } else {
      // Exatamente 1 GPU no host
      const single = devices[0];
      if (request.targetGpuUuid && request.targetGpuUuid !== single.uuid) {
        return {
          disposition: 'deny',
          reasonCode: 'TARGET_GPU_NOT_FOUND',
          requestId: request.requestId,
          profileRevisionId: profile.profileRevisionId,
          resourceSnapshotId: snapshot.snapshotId,
          materialFacts: {
            snapshotFreshness: 'fresh',
          },
          evaluatedAt,
        };
      }
      selectedGpu = single;

      // Em single-GPU: debita reservas sem target ou com target da GPU
      for (const lease of leases) {
        if (lease.state === 'reserved') {
          if (!lease.targetGpuUuid || lease.targetGpuUuid === single.uuid) {
            pendingReservedVramBytes += lease.reservedVramBytes || 0;
          }
        }
      }
    }

    // Validação de Headroom de VRAM no dispositivo selecionado
    const effectiveFreeVramBytes = selectedGpu.memoryFreeBytes - pendingReservedVramBytes;
    const availableVramHeadroom = effectiveFreeVramBytes - profile.minimumFreeVramBytes;

    if (additionalVramRequired !== undefined && additionalVramRequired > 0) {
      if (availableVramHeadroom < additionalVramRequired) {
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
          requestId: request.requestId,
          profileRevisionId: profile.profileRevisionId,
          resourceSnapshotId: snapshot.snapshotId,
          materialFacts: {
            freeVramBytes: selectedGpu.memoryFreeBytes,
            pendingReservedVramBytes: pendingReservedVramBytes > 0 ? pendingReservedVramBytes : undefined,
            effectiveEstimatedVramBytes: additionalVramRequired,
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
          requestId: request.requestId,
          profileRevisionId: profile.profileRevisionId,
          resourceSnapshotId: snapshot.snapshotId,
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

  // 7. INTENT EVALUATION
  const baseMaterialFacts: ResourceMaterialFacts = {
    freeRamBytes: snapshot.system.freeRamBytes,
    freeVramBytes: selectedGpu?.memoryFreeBytes,
    cpuUtilizationPercent: snapshot.system.cpuUtilizationPercent,
    gpuUtilizationPercent: selectedGpu?.gpuUtilizationPercent,
    targetModelLoaded: targetModel ? isTargetLoaded : undefined,
    pendingReservedRamBytes: pendingReservedRamBytes > 0 ? pendingReservedRamBytes : undefined,
    pendingReservedVramBytes: pendingReservedVramBytes > 0 ? pendingReservedVramBytes : undefined,
    effectiveEstimatedRamBytes: additionalRamRequired !== undefined && additionalRamRequired > 0 ? additionalRamRequired : undefined,
    effectiveEstimatedVramBytes: additionalVramRequired !== undefined && additionalVramRequired > 0 ? additionalVramRequired : undefined,
    snapshotFreshness: 'fresh',
  };

  // 7.1 Intent: use_current_state
  if (request.intent === 'use_current_state') {
    return {
      disposition: 'admit',
      reasonCode: 'RESOURCES_ADMITTED',
      requestId: request.requestId,
      profileRevisionId: profile.profileRevisionId,
      resourceSnapshotId: snapshot.snapshotId,
      materialFacts: baseMaterialFacts,
      evaluatedAt,
    };
  }

  // 7.2 Intent: ensure_model_loaded
  if (request.intent === 'ensure_model_loaded') {
    if (!targetModel) {
      return {
        disposition: 'deny',
        reasonCode: 'TARGET_MODEL_REQUIRED',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    if (isTargetLoaded) {
      return {
        disposition: 'admit',
        reasonCode: 'MODEL_ALREADY_LOADED',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    // Modelo não carregado: checa se perfil permite preload
    if (!profile.allowModelPreload) {
      return {
        disposition: 'deny',
        reasonCode: 'PRELOAD_PROHIBITED_BY_PROFILE',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    // Se exige GPU e a estimativa de VRAM não está disponível no request nem no catálogo
    if (isGpuMaterial && additionalVramRequired === undefined) {
      return {
        disposition: 'defer',
        reasonCode: 'ESTIMATED_RESOURCES_MISSING',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    return {
      disposition: 'action_required',
      reasonCode: 'PRELOAD_REQUIRED',
      requestId: request.requestId,
      profileRevisionId: profile.profileRevisionId,
      resourceSnapshotId: snapshot.snapshotId,
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

  // 7.3 Intent: ensure_model_unloaded
  if (request.intent === 'ensure_model_unloaded') {
    if (!targetModel) {
      return {
        disposition: 'deny',
        reasonCode: 'TARGET_MODEL_REQUIRED',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    if (!isTargetLoaded) {
      return {
        disposition: 'admit',
        reasonCode: 'MODEL_ALREADY_UNLOADED',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
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
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    if (!profile.allowModelUnload) {
      return {
        disposition: 'deny',
        reasonCode: 'UNLOAD_PROHIBITED_BY_PROFILE',
        requestId: request.requestId,
        profileRevisionId: profile.profileRevisionId,
        resourceSnapshotId: snapshot.snapshotId,
        materialFacts: baseMaterialFacts,
        evaluatedAt,
      };
    }

    return {
      disposition: 'action_required',
      reasonCode: 'UNLOAD_REQUIRED',
      requestId: request.requestId,
      profileRevisionId: profile.profileRevisionId,
      resourceSnapshotId: snapshot.snapshotId,
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
    requestId: request.requestId,
    profileRevisionId: profile.profileRevisionId,
    resourceSnapshotId: snapshot.snapshotId,
    materialFacts: baseMaterialFacts,
    evaluatedAt,
  };
}
