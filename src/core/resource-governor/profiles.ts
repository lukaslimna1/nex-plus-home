/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Definições e Fábrica de Resource Profiles — Escopo 0.6
 *
 * Perfis imutáveis de governança de recursos locais.
 * Valida estritamente limites numéricos finitos de RAM, VRAM, CPU e GPU.
 * Não congela perfis com números arbitrários na API pública de produção.
 */

import type {
  ResourceProfileKey,
  ResourceProfileRevision,
  ResourceProfileRevisionId,
} from './contracts';

export class ResourceProfileValidationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(`[ResourceProfile] ${message}`);
    this.name = 'ResourceProfileValidationError';
    this.code = code;
  }
}

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
    throw new ResourceProfileValidationError(
      'profileKey and profileRevisionId are mandatory.',
      'INVALID_PROFILE_PARAMS',
    );
  }

  if (!Number.isFinite(params.minimumFreeSystemRamBytes) || params.minimumFreeSystemRamBytes < 0) {
    throw new ResourceProfileValidationError(
      'minimumFreeSystemRamBytes must be a finite number >= 0.',
      'INVALID_NUMERIC_THRESHOLD',
    );
  }

  if (!Number.isFinite(params.minimumFreeVramBytes) || params.minimumFreeVramBytes < 0) {
    throw new ResourceProfileValidationError(
      'minimumFreeVramBytes must be a finite number >= 0.',
      'INVALID_NUMERIC_THRESHOLD',
    );
  }

  if (!Number.isFinite(params.maximumTelemetryAgeMs) || params.maximumTelemetryAgeMs <= 0) {
    throw new ResourceProfileValidationError(
      'maximumTelemetryAgeMs must be a finite number > 0.',
      'INVALID_NUMERIC_THRESHOLD',
    );
  }

  if (params.maximumCpuUtilizationPercent !== undefined) {
    if (
      !Number.isFinite(params.maximumCpuUtilizationPercent) ||
      params.maximumCpuUtilizationPercent < 0 ||
      params.maximumCpuUtilizationPercent > 100
    ) {
      throw new ResourceProfileValidationError(
        'maximumCpuUtilizationPercent must be a finite number between 0 and 100 inclusive.',
        'INVALID_NUMERIC_THRESHOLD',
      );
    }
  }

  if (params.maximumGpuUtilizationPercent !== undefined) {
    if (
      !Number.isFinite(params.maximumGpuUtilizationPercent) ||
      params.maximumGpuUtilizationPercent < 0 ||
      params.maximumGpuUtilizationPercent > 100
    ) {
      throw new ResourceProfileValidationError(
        'maximumGpuUtilizationPercent must be a finite number between 0 and 100 inclusive.',
        'INVALID_NUMERIC_THRESHOLD',
      );
    }
  }

  return Object.freeze({
    profileKey: params.profileKey,
    profileRevisionId: params.profileRevisionId,
    minimumFreeSystemRamBytes: params.minimumFreeSystemRamBytes,
    minimumFreeVramBytes: params.minimumFreeVramBytes,
    maximumCpuUtilizationPercent: params.maximumCpuUtilizationPercent,
    maximumGpuUtilizationPercent: params.maximumGpuUtilizationPercent,
    maximumTelemetryAgeMs: params.maximumTelemetryAgeMs,
    allowModelPreload: Boolean(params.allowModelPreload),
    allowModelUnload: Boolean(params.allowModelUnload),
    description: params.description,
  });
}
