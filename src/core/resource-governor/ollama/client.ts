/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Cliente HTTP Local Ollama — Escopo 0.6 (Fase A)
 *
 * Comunicação direta e determinística via APIs HTTP locais oficiais (/api/ps, /api/tags, /api/generate).
 * Restrito estritamente a loopback (127.0.0.1, localhost, ::1).
 * Não expõe métodos de download/pull, push, create ou delete de modelos.
 */

import type {
  OllamaInstalledModelObservation,
  OllamaLoadedModelObservation,
} from '../contracts';

export class OllamaClientError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(`[OllamaClient] ${message}`);
    this.name = 'OllamaClientError';
    this.code = code;
  }
}

export class OllamaUnavailableError extends OllamaClientError {
  constructor(detail?: string) {
    super(detail || 'Ollama local runtime is unreachable or unavailable', 'OLLAMA_UNAVAILABLE');
    this.name = 'OllamaUnavailableError';
  }
}

export class OllamaTimeoutError extends OllamaClientError {
  constructor(timeoutMs: number) {
    super(`Request to Ollama timed out after ${timeoutMs}ms`, 'OLLAMA_TIMEOUT');
    this.name = 'OllamaTimeoutError';
  }
}

export class InvalidOllamaResponseError extends OllamaClientError {
  constructor(detail: string) {
    super(`Received invalid response shape from Ollama: ${detail}`, 'INVALID_OLLAMA_RESPONSE');
    this.name = 'InvalidOllamaResponseError';
  }
}

export interface OllamaClientConfig {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Valida se a URL base informada pertence estritamente à interface loopback.
 * Rejeita qualquer IP ou host externo/remoto.
 */
export function validateLoopbackUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0:0:0:0:0:0:0:1';

    if (!isLoopback) {
      throw new OllamaClientError(
        `Remote or non-loopback base URL '${urlStr}' is strictly prohibited for local Resource Governor.`,
        'REMOTE_URL_PROHIBITED',
      );
    }

    return parsed.origin;
  } catch (err: any) {
    if (err instanceof OllamaClientError) throw err;
    throw new OllamaClientError(`Invalid base URL format '${urlStr}': ${err.message}`, 'INVALID_BASE_URL');
  }
}

export interface OllamaClient {
  readonly baseUrl: string;
  getLoadedModels(options?: { timeoutMs?: number }): Promise<OllamaLoadedModelObservation[]>;
  getInstalledModels(options?: { timeoutMs?: number }): Promise<OllamaInstalledModelObservation[]>;
  setLifecycle(
    modelName: string,
    keepAlive: number,
    options?: { timeoutMs?: number },
  ): Promise<{ status: number; ok: boolean }>;
}

export function createOllamaClient(config: OllamaClientConfig = {}): OllamaClient {
  const rawBaseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const baseUrl = validateLoopbackUrl(rawBaseUrl);
  const defaultTimeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchFn = config.fetchFn || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    throw new OllamaClientError('Native fetch is not available in current runtime.', 'FETCH_UNAVAILABLE');
  }

  async function requestJson<T>(
    endpoint: string,
    options: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const timeout = options.timeoutMs || defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetchFn(`${baseUrl}${endpoint}`, {
        ...options,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new OllamaClientError(
          `HTTP ${res.status} ${res.statusText} from ${endpoint}`,
          `HTTP_${res.status}`,
        );
      }

      const data = await res.json();
      return data as T;
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new OllamaTimeoutError(timeout);
      }
      if (err instanceof OllamaClientError) {
        throw err;
      }
      throw new OllamaUnavailableError(err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl,

    async getLoadedModels(options = {}): Promise<OllamaLoadedModelObservation[]> {
      const raw = await requestJson<{ models?: unknown }>('/api/ps', options);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) {
        throw new InvalidOllamaResponseError('/api/ps response missing models array');
      }

      const observations: OllamaLoadedModelObservation[] = [];
      const now = new Date().toISOString();

      for (const item of raw.models) {
        if (!item || typeof item !== 'object') continue;
        const m = item as Record<string, unknown>;
        const modelName = (m.name || m.model) as string;
        if (!modelName || typeof modelName !== 'string') continue;

        const digest = typeof m.digest === 'string' ? m.digest : undefined;
        const sizeBytes = typeof m.size === 'number' ? m.size : undefined;
        const sizeVramBytes = typeof m.size_vram === 'number' ? m.size_vram : undefined;

        let contextLength: number | undefined;
        if (typeof m.context_length === 'number') {
          contextLength = m.context_length;
        } else if (m.details && typeof m.details === 'object' && typeof (m.details as any).context_length === 'number') {
          contextLength = (m.details as any).context_length;
        }

        const expiresAt = typeof m.expires_at === 'string' ? m.expires_at : undefined;

        observations.push({
          modelName,
          digest,
          sizeBytes,
          sizeVramBytes,
          contextLength,
          expiresAt,
          observedAt: now,
        });
      }

      return observations;
    },

    async getInstalledModels(options = {}): Promise<OllamaInstalledModelObservation[]> {
      const raw = await requestJson<{ models?: unknown }>('/api/tags', options);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) {
        throw new InvalidOllamaResponseError('/api/tags response missing models array');
      }

      const installed: OllamaInstalledModelObservation[] = [];
      for (const item of raw.models) {
        if (!item || typeof item !== 'object') continue;
        const m = item as Record<string, unknown>;
        const modelName = (m.name || m.model) as string;
        if (!modelName || typeof modelName !== 'string') continue;

        installed.push({
          modelName,
          digest: typeof m.digest === 'string' ? m.digest : undefined,
          sizeBytes: typeof m.size === 'number' ? m.size : undefined,
          modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : undefined,
        });
      }

      return installed;
    },

    async setLifecycle(
      modelName: string,
      keepAlive: number,
      options = {},
    ): Promise<{ status: number; ok: boolean }> {
      if (!modelName || typeof modelName !== 'string') {
        throw new OllamaClientError('modelName must be a valid string', 'INVALID_MODEL_NAME');
      }

      const timeout = options.timeoutMs || defaultTimeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetchFn(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            keep_alive: keepAlive,
            stream: false,
          }),
          signal: controller.signal,
        });

        // Consome a resposta não-streaming completa antes de prosseguir
        if (res.ok) {
          try {
            await res.json();
          } catch {
            // tolera formato de término vazio caso status seja OK
          }
        }

        return { status: res.status, ok: res.ok };
      } catch (err: any) {
        if (err.name === 'AbortError' || controller.signal.aborted) {
          throw new OllamaTimeoutError(timeout);
        }
        if (err instanceof OllamaClientError) {
          throw err;
        }
        throw new OllamaUnavailableError(err.message);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
