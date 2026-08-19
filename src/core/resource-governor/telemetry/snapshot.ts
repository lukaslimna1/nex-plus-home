/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Agregador de Resource Snapshot — Escopo 0.6 (Fase A)
 *
 * Orquestra a coleta factual de System, NVIDIA GPU e Ollama.
 * Normaliza e correlaciona a telemetria em um ResourceSnapshot imutável.
 * NÃO executa regras de admissão ou decisões do Governor.
 */

import type {
  GpuTelemetry,
  OllamaTelemetry,
  ResourceSnapshot,
  ResourceSnapshotId,
  SystemTelemetry,
} from '../contracts';

import { captureSystemTelemetry, type SystemTelemetryOptions } from './system';
import { captureNvidiaTelemetry, type NvidiaTelemetryOptions } from './nvidia';
import { captureOllamaTelemetry } from '../ollama/lifecycle';
import type { OllamaClient } from '../ollama/client';

export interface SnapshotAdapters {
  readonly systemTelemetryFn?: (options?: SystemTelemetryOptions) => Promise<SystemTelemetry>;
  readonly nvidiaTelemetryFn?: (options?: NvidiaTelemetryOptions) => Promise<GpuTelemetry>;
  readonly ollamaTelemetryFn?: (options?: { includeInstalled?: boolean; observedAt?: string }) => Promise<OllamaTelemetry>;
  readonly ollamaClient?: OllamaClient;
}

export interface CaptureSnapshotOptions {
  readonly snapshotId?: ResourceSnapshotId;
  readonly collectedAt?: string;
  readonly includeInstalledModels?: boolean;
  readonly systemOptions?: SystemTelemetryOptions;
  readonly nvidiaOptions?: NvidiaTelemetryOptions;
}

/**
 * Coleta e agrega telemetria de todas as fontes disponíveis em um ResourceSnapshot estruturado.
 */
export async function captureResourceSnapshot(
  adapters: SnapshotAdapters = {},
  options: CaptureSnapshotOptions = {},
): Promise<ResourceSnapshot> {
  const collectedAt = options.collectedAt || new Date().toISOString();
  const snapshotId =
    options.snapshotId ||
    (`snap_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` as ResourceSnapshotId);

  const getSystem = adapters.systemTelemetryFn || captureSystemTelemetry;
  const getNvidia = adapters.nvidiaTelemetryFn || captureNvidiaTelemetry;

  const [system, gpu] = await Promise.all([
    getSystem({ ...options.systemOptions, observedAt: collectedAt }),
    getNvidia({ ...options.nvidiaOptions, observedAt: collectedAt }),
  ]);

  let ollama: OllamaTelemetry;
  if (adapters.ollamaTelemetryFn) {
    ollama = await adapters.ollamaTelemetryFn({
      includeInstalled: options.includeInstalledModels,
      observedAt: collectedAt,
    });
  } else if (adapters.ollamaClient) {
    ollama = await captureOllamaTelemetry(adapters.ollamaClient, {
      includeInstalled: options.includeInstalledModels,
      observedAt: collectedAt,
    });
  } else {
    ollama = {
      status: 'unavailable',
      loadedModels: [],
      observedAt: collectedAt,
      errorDetail: 'No Ollama client or telemetry adapter configured',
    };
  }

  return {
    snapshotId,
    collectedAt,
    system,
    gpu,
    ollama,
  };
}
