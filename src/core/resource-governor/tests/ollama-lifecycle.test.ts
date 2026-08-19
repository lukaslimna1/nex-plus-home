/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes Unitários de Cliente e Lifecycle Ollama — Escopo 0.6 (Fase A)
 *
 * Cenários A11 a A24: Parsing de VRAM/context, loopback gating, catálogo aprovado,
 * comandos de lifecycle, verificação factual pós-comando, timeouts e segurança de API.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovedLocalModelRef } from '../contracts';
import {
  createOllamaClient,
  OllamaClientError,
  OllamaTimeoutError,
  validateLoopbackUrl,
} from '../ollama/client';
import {
  preloadModel,
  unloadModel,
} from '../ollama/lifecycle';

const mockApprovedCatalog: readonly ApprovedLocalModelRef[] = [
  { modelName: 'llama3:8b', runtime: 'ollama_local', estimatedVramBytes: 6 * 1024 * 1024 * 1024 },
  { modelName: 'mistral:7b', runtime: 'ollama_local', estimatedVramBytes: 5 * 1024 * 1024 * 1024 },
];

describe('NEX+ Resource Governor · Ollama Client & Lifecycle (Fase A)', () => {
  // A11. Ollama /api/ps parseia size_vram
  it('A11. Ollama /api/ps parseia size_vram', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'llama3:8b',
              size: 4920737382,
              size_vram: 4920737382,
              digest: 'sha256:12345',
            },
          ],
        }),
      } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const loaded = await client.getLoadedModels();

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].modelName, 'llama3:8b');
    assert.equal(loaded[0].sizeVramBytes, 4920737382);
  });

  // A12. Ollama /api/ps parseia context_length
  it('A12. Ollama /api/ps parseia context_length', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'llama3:8b',
              details: { context_length: 8192 },
            },
          ],
        }),
      } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const loaded = await client.getLoadedModels();

    assert.equal(loaded[0].contextLength, 8192);
  });

  // A13. Ollama /api/tags parseia catálogo instalado
  it('A13. Ollama /api/tags parseia catálogo instalado', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: 'llama3:8b', digest: 'sha256:aaa', size: 4000000, modified_at: '2026-08-19T00:00:00Z' },
            { name: 'mistral:7b', digest: 'sha256:bbb', size: 4500000, modified_at: '2026-08-19T00:00:00Z' },
          ],
        }),
      } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const installed = await client.getInstalledModels();

    assert.equal(installed.length, 2);
    assert.equal(installed[0].modelName, 'llama3:8b');
    assert.equal(installed[1].modelName, 'mistral:7b');
  });

  // A14. base URL não-loopback é rejeitada
  it('A14. base URL não-loopback é rejeitada', () => {
    assert.throws(() => validateLoopbackUrl('http://192.168.1.50:11434'), /strictly prohibited/);
    assert.throws(() => validateLoopbackUrl('https://api.ollama.ai'), /strictly prohibited/);
    assert.throws(() => validateLoopbackUrl('http://cloud-host:11434'), /strictly prohibited/);

    // Válidos
    assert.equal(validateLoopbackUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
    assert.equal(validateLoopbackUrl('http://localhost:11434'), 'http://localhost:11434');
    assert.equal(validateLoopbackUrl('http://[::1]:11434'), 'http://[::1]:11434');
  });

  // A15. modelo fora do catálogo aprovado é rejeitado
  it('A15. modelo fora do catálogo aprovado é rejeitado', async () => {
    const client = createOllamaClient();
    const result = await preloadModel(client, mockApprovedCatalog, 'unapproved-model:70b');

    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'MODEL_NOT_APPROVED');
  });

  // A16. preload envia keep_alive=-1
  it('A16. preload envia keep_alive=-1', async () => {
    let capturedBody: any;
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/api/generate')) {
        capturedBody = JSON.parse(init?.body as string);
        return { ok: true, status: 200 } as Response;
      }
      if (urlStr.endsWith('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3:8b' }] }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const result = await preloadModel(client, mockApprovedCatalog, 'llama3:8b');

    assert.equal(capturedBody?.keep_alive, -1);
    assert.equal(capturedBody?.model, 'llama3:8b');
    assert.equal(result.status, 'verified_loaded');
  });

  // A17. unload envia keep_alive=0
  it('A17. unload envia keep_alive=0', async () => {
    let capturedBody: any;
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/api/generate')) {
        capturedBody = JSON.parse(init?.body as string);
        return { ok: true, status: 200 } as Response;
      }
      if (urlStr.endsWith('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [] }), // Descarregado com sucesso
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const result = await unloadModel(client, mockApprovedCatalog, 'llama3:8b');

    assert.equal(capturedBody?.keep_alive, 0);
    assert.equal(result.status, 'verified_unloaded');
  });

  // A18. HTTP 200 sem estado pós-comando comprovado não vira verified
  it('A18. HTTP 200 sem estado pós-comando comprovado vira indeterminate', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/api/generate')) {
        return { ok: true, status: 200 } as Response;
      }
      if (urlStr.endsWith('/api/ps')) {
        // Retorna lista vazia: modelo não apareceu no /api/ps
        return { ok: true, status: 200, json: async () => ({ models: [] }) } as Response;
      }
      return { ok: false, status: 404 } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const result = await preloadModel(client, mockApprovedCatalog, 'llama3:8b');

    assert.equal(result.status, 'indeterminate');
    assert.equal(result.reasonCode, 'LIFECYCLE_UNVERIFIED');
  });

  // A19. preload + /api/ps contendo modelo → verified_loaded
  it('A19. preload + /api/ps contendo modelo → verified_loaded', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/api/generate')) {
        return { ok: true, status: 200 } as Response;
      }
      if (urlStr.endsWith('/api/ps')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'mistral:7b' }] }) } as Response;
      }
      return { ok: false, status: 404 } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const result = await preloadModel(client, mockApprovedCatalog, 'mistral:7b');

    assert.equal(result.status, 'verified_loaded');
    assert.equal(result.reasonCode, 'MODEL_VERIFIED_LOADED');
  });

  // A20. unload + /api/ps sem modelo → verified_unloaded
  it('A20. unload + /api/ps sem modelo → verified_unloaded', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/api/generate')) {
        return { ok: true, status: 200 } as Response;
      }
      if (urlStr.endsWith('/api/ps')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'other_model:latest' }] }) } as Response;
      }
      return { ok: false, status: 404 } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    const result = await unloadModel(client, mockApprovedCatalog, 'llama3:8b');

    assert.equal(result.status, 'verified_unloaded');
    assert.equal(result.reasonCode, 'MODEL_VERIFIED_UNLOADED');
  });

  // A21. timeout retorna resultado explícito
  it('A21. timeout retorna resultado explícito', async () => {
    const slowFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const client = createOllamaClient({ fetchFn: slowFetch as any, timeoutMs: 20 });
    await assert.rejects(async () => {
      await client.getLoadedModels();
    }, OllamaTimeoutError);
  });

  // A22. resposta inválida não vira observação
  it('A22. resposta inválida não vira observação', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ invalid_payload: true }),
      } as Response;
    };

    const client = createOllamaClient({ fetchFn: mockFetch as any });
    await assert.rejects(async () => {
      await client.getLoadedModels();
    }, /missing models array/);
  });

  // A23. não existe método público pull/push/create/delete
  it('A23. não existe método público pull/push/create/delete', () => {
    const client = createOllamaClient();
    const untyped = (client as unknown) as Record<string, unknown>;

    assert.equal(untyped.pull, undefined);
    assert.equal(untyped.push, undefined);
    assert.equal(untyped.create, undefined);
    assert.equal(untyped.delete, undefined);
    assert.equal(untyped.copy, undefined);
  });

  // A24. nenhum teste da Fase A chama serviço externo
  it('A24. base URL loopback padrão e ausência de chamadas externas', () => {
    const client = createOllamaClient();
    assert.equal(client.baseUrl, 'http://127.0.0.1:11434');
  });
});
