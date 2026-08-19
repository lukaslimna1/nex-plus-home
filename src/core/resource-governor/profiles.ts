/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Definições e Fábrica de Resource Profiles — Escopo 0.6 (Fase B)
 *
 * Perfis imutáveis de governança de recursos locais.
 * Define thresholds mínimos de RAM/VRAM, limites de CPU/GPU, tempo máximo de telemetria
 * e permissões de preload/unload de modelos.
 */

import type {
  ResourceProfileKey,
  ResourceProfileRevision,
  ResourceProfileRevisionId,
} from './contracts';

export interface CreateResourceProfileParams {
  readonly profileKey: ResourceProfileKey;
  readonly profileRevisionId: ResourceProfileRevisionId;
  readonly minimumFreeSystemRamBytes: number;
  readonly minimumFreeVramBytes: number;
  readonly maximumCpuUtilizationPercent?: number;
  readonly maximumGpuUtilizationPercent?: number;
  readonly maximumTelemetryAgeMs: number;
  readonly allowModelPreload: boolean;
  readonly allowModelUnload: boolean;
  readonly description?: string;
}

export function createResourceProfileRevision(
  params: CreateResourceProfileParams,
): ResourceProfileRevision {
  if (!params.profileKey || !params.profileRevisionId) {
    throw new Error('[ResourceProfile] profileKey and profileRevisionId are mandatory.');
  }
  if (params.minimumFreeSystemRamBytes < 0 || params.minimumFreeVramBytes < 0) {
    throw new Error('[ResourceProfile] Minimum free memory thresholds cannot be negative.');
  }
  if (params.maximumTelemetryAgeMs <= 0) {
    throw new Error('[ResourceProfile] maximumTelemetryAgeMs must be greater than zero.');
  }

  return Object.freeze({
    profileKey: params.profileKey,
    profileRevisionId: params.profileRevisionId,
    minimumFreeSystemRamBytes: params.minimumFreeSystemRamBytes,
    minimumFreeVramBytes: params.minimumFreeVramBytes,
    maximumCpuUtilizationPercent: params.maximumCpuUtilizationPercent,
    maximumGpuUtilizationPercent: params.maximumGpuUtilizationPercent,
    maximumTelemetryAgeMs: params.maximumTelemetryAgeMs,
    allowModelPreload: params.allowModelPreload,
    allowModelUnload: params.allowModelUnload,
    description: params.description,
  });
}

/**
 * Fixture de Perfil Padrão Equilibrado para Workloads Locais.
 */
export const STANDARD_LOCAL_PROFILE = createResourceProfileRevision({
  profileKey: 'profile_standard_local' as ResourceProfileKey,
  profileRevisionId: 'prof_rev_std_01' as ResourceProfileRevisionId,
  minimumFreeSystemRamBytes: 2 * 1024 * 1024 * 1024, // 2 GiB de margem no SO
  minimumFreeVramBytes: 1 * 1024 * 1024 * 1024,      // 1 GiB de margem na GPU
  maximumCpuUtilizationPercent: 90,                  // 90% máx
  maximumGpuUtilizationPercent: 95,                  // 95% máx
  maximumTelemetryAgeMs: 5000,                       // Telemetria com máx 5s de idade
  allowModelPreload: true,
  allowModelUnload: true,
  description: 'Standard local workload profile with balanced resource headroom',
});

/**
 * Fixture de Perfil Estrito (Sem Preload / Baixa tolerância a pressão).
 */
export const STRICT_CONSERVATIVE_PROFILE = createResourceProfileRevision({
  profileKey: 'profile_strict_conservative' as ResourceProfileKey,
  profileRevisionId: 'prof_rev_strict_01' as ResourceProfileRevisionId,
  minimumFreeSystemRamBytes: 4 * 1024 * 1024 * 1024, // 4 GiB livre
  minimumFreeVramBytes: 2 * 1024 * 1024 * 1024,      // 2 GiB livre
  maximumCpuUtilizationPercent: 70,
  maximumGpuUtilizationPercent: 75,
  maximumTelemetryAgeMs: 3000,
  allowModelPreload: false,                          // Proíbe preload sob demanda
  allowModelUnload: false,                           // Proíbe descarregamento
  description: 'Strict conservative profile prohibiting on-demand model lifecycle changes',
});
