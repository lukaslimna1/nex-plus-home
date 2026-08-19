/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Operações de Lifecycle e Observabilidade Ollama — Escopo 0.6 (Fase A)
 *
 * Suporta Preload (keep_alive: -1), Unload (keep_alive: 0) e verificação factual pós-comando.
 * Transport success (HTTP 200) NÃO equivale a estado factual confirmado sem checagem em /api/ps.
 * Rejeita qualquer operação sobre modelos fora do catálogo aprovado fornecido por L0.
 */

import type {
  ApprovedLocalModelRef,
  LifecycleExecutionResult,
  OllamaTelemetry,
} from '../contracts';

import type { OllamaClient } from './client';

export interface LifecycleOptions {
  readonly timeoutMs?: number;
  readonly observedAt?: string;
}

/**
 * Normaliza o nome do modelo (remove tag padrão ':latest' se necessário para comparação).
 */
export function normalizeModelName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim().toLowerCase();
  return trimmed.endsWith(':latest') ? trimmed.slice(0, -7) : trimmed;
}

/**
 * Verifica se o modelo está estritamente aprovado no catálogo de L0.
 */
export function isModelApproved(
  catalog: readonly ApprovedLocalModelRef[],
  modelName: string,
): boolean {
  if (!Array.isArray(catalog) || !modelName) return false;
  const targetNorm = normalizeModelName(modelName);

  return catalog.some(
    (item) =>
      item.runtime === 'ollama_local' &&
      normalizeModelName(item.modelName) === targetNorm,
  );
}

/**
 * Executa preload factual de um modelo aprovado no Ollama com keep_alive: -1.
 * Confirma o carregamento fático via /api/ps.
 */
export async function preloadModel(
  client: OllamaClient,
  approvedCatalog: readonly ApprovedLocalModelRef[],
  modelName: string,
  options: LifecycleOptions = {},
): Promise<LifecycleExecutionResult> {
  const observedAt = options.observedAt || new Date().toISOString();

  // 1. Gate de Autoridade: Modelo deve estar no catálogo aprovado
  if (!isModelApproved(approvedCatalog, modelName)) {
    return {
      status: 'rejected',
      modelName,
      reasonCode: 'MODEL_NOT_APPROVED',
      observedAt,
      detail: `Model '${modelName}' is not in the L0 approved local model catalog.`,
    };
  }

  // 2. Envio do comando de Preload (keep_alive: -1)
  try {
    const res = await client.setLifecycle(modelName, -1, options);
    if (!res.ok) {
      return {
        status: 'transport_failed',
        modelName,
        reasonCode: `HTTP_${res.status}`,
        observedAt,
      };
    }
  } catch (err: any) {
    return {
      status: 'transport_failed',
      modelName,
      reasonCode: err.code || 'OLLAMA_TRANSPORT_FAILED',
      observedAt,
      detail: err.message,
    };
  }

  // 3. Verificação Factual Pós-Comando via /api/ps
  try {
    const loaded = await client.getLoadedModels(options);
    const targetNorm = normalizeModelName(modelName);
    const isLoaded = loaded.some((m) => normalizeModelName(m.modelName) === targetNorm);

    if (isLoaded) {
      return {
        status: 'verified_loaded',
        modelName,
        reasonCode: 'MODEL_VERIFIED_LOADED',
        observedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'indeterminate',
      modelName,
      reasonCode: 'LIFECYCLE_UNVERIFIED',
      observedAt: new Date().toISOString(),
      detail: 'HTTP request succeeded but model was not observed in /api/ps after preload command.',
    };
  } catch (err: any) {
    return {
      status: 'indeterminate',
      modelName,
      reasonCode: 'POST_COMMAND_VERIFICATION_FAILED',
      observedAt: new Date().toISOString(),
      detail: err.message,
    };
  }
}

/**
 * Executa unload factual de um modelo no Ollama com keep_alive: 0.
 * Confirma o descarregamento fático via /api/ps.
 */
export async function unloadModel(
  client: OllamaClient,
  approvedCatalog: readonly ApprovedLocalModelRef[],
  modelName: string,
  options: LifecycleOptions = {},
): Promise<LifecycleExecutionResult> {
  const observedAt = options.observedAt || new Date().toISOString();

  // 1. Gate de Autoridade: Modelo deve estar no catálogo aprovado
  if (!isModelApproved(approvedCatalog, modelName)) {
    return {
      status: 'rejected',
      modelName,
      reasonCode: 'MODEL_NOT_APPROVED',
      observedAt,
      detail: `Model '${modelName}' is not in the L0 approved local model catalog.`,
    };
  }

  // 2. Envio do comando de Unload (keep_alive: 0)
  try {
    const res = await client.setLifecycle(modelName, 0, options);
    if (!res.ok) {
      return {
        status: 'transport_failed',
        modelName,
        reasonCode: `HTTP_${res.status}`,
        observedAt,
      };
    }
  } catch (err: any) {
    return {
      status: 'transport_failed',
      modelName,
      reasonCode: err.code || 'OLLAMA_TRANSPORT_FAILED',
      observedAt,
      detail: err.message,
    };
  }

  // 3. Verificação Factual Pós-Comando via /api/ps
  try {
    const loaded = await client.getLoadedModels(options);
    const targetNorm = normalizeModelName(modelName);
    const isLoaded = loaded.some((m) => normalizeModelName(m.modelName) === targetNorm);

    if (!isLoaded) {
      return {
        status: 'verified_unloaded',
        modelName,
        reasonCode: 'MODEL_VERIFIED_UNLOADED',
        observedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'indeterminate',
      modelName,
      reasonCode: 'LIFECYCLE_UNVERIFIED',
      observedAt: new Date().toISOString(),
      detail: 'HTTP request succeeded but model is still observed in /api/ps after unload command.',
    };
  } catch (err: any) {
    return {
      status: 'indeterminate',
      modelName,
      reasonCode: 'POST_COMMAND_VERIFICATION_FAILED',
      observedAt: new Date().toISOString(),
      detail: err.message,
    };
  }
}

/**
 * Coleta factual de telemetria do Ollama (modelos carregados e instalados).
 */
export async function captureOllamaTelemetry(
  client: OllamaClient,
  options: { includeInstalled?: boolean; observedAt?: string } = {},
): Promise<OllamaTelemetry> {
  const observedAt = options.observedAt || new Date().toISOString();

  try {
    const loadedModels = await client.getLoadedModels();
    let installedModels = undefined;

    if (options.includeInstalled) {
      try {
        installedModels = await client.getInstalledModels();
      } catch {
        // Installed models é complementar; não invalida loaded models se falhar
      }
    }

    return {
      status: 'available',
      loadedModels,
      installedModels,
      observedAt,
    };
  } catch (err: any) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    return {
      status: 'unavailable',
      loadedModels: [],
      observedAt,
      errorDetail,
    };
  }
}
