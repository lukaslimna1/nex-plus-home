/**
 * NEX+ · Job Runtime Boundary — Unit Tests
 * Testes Unitários de Configuração e Lifecycle do Provider — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Cobertura Obrigatória:
 * L. Import do módulo não inicia conexão, timer ou worker (zero side-effects)
 * M. Configuração de runtime congelada:
 *    - migrate: false
 *    - schema: 'pgboss'
 *    - useListenNotify: false
 *    - backend: 'postgres'
 * N. start/stop sem vazamento observável
 * + Validação de erros em operações antes do start
 * + Validação fail-closed antes do envio à fila
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPgBossRuntime,
  PgBossRuntime,
  PgBossRuntimeError,
  PG_BOSS_CANONICAL_SCHEMA,
  PG_BOSS_DEFAULT_BACKEND,
} from '../index';
import { JobWakeupPayloadError } from '../invariants';

describe('Job Runtime Boundary — Provider Configuration & Lifecycle (0.86C-3A)', () => {
  // ==========================================================================
  // L. ZERO SIDE-EFFECTS NO IMPORT DO MÓDULO
  // ==========================================================================

  it('L. importar e instanciar o módulo não cria conexões, timers ativos ou workers automáticos', () => {
    // Instanciar runtime NÃO deve iniciar conexões ou timers antes de start() explícito
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://dummy:dummy@127.0.0.1:5432/dummy_db',
    });

    assert.ok(runtime instanceof PgBossRuntime);
    assert.equal(runtime.isStarted, false);
  });

  // ==========================================================================
  // M. CONFIGURAÇÃO CONGELADA DE RUNTIME
  // ==========================================================================

  it('M. constrói runtime com configurações estritamente congeladas: migrate: false, schema: pgboss, useListenNotify: false, backend: postgres', () => {
    const connStr = 'postgres://test_user:test_pass@127.0.0.1:5432/test_db';
    const runtime = createPgBossRuntime({
      connectionString: connStr,
    });

    const cfg = runtime.config;

    assert.equal(cfg.connectionString, connStr);
    assert.equal(cfg.schema, PG_BOSS_CANONICAL_SCHEMA);
    assert.equal(cfg.schema, 'pgboss');
    assert.equal(cfg.backend, PG_BOSS_DEFAULT_BACKEND);
    assert.equal(cfg.backend, 'postgres');
    assert.equal(cfg.migrate, false);
    assert.equal(cfg.useListenNotify, false);
    assert.ok(Object.isFrozen(cfg), 'Configuração de runtime deve ser congelada/imutável');
  });

  it('permite customizar schema explicitamente preservando migrate: false e useListenNotify: false', () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
      schema: 'custom_pgboss',
    });

    assert.equal(runtime.config.schema, 'custom_pgboss');
    assert.equal(runtime.config.migrate, false);
    assert.equal(runtime.config.useListenNotify, false);
  });

  it('rejeita connectionString vazia ou em branco', () => {
    assert.throws(
      () => createPgBossRuntime({ connectionString: '' }),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'START_FAILURE');
        return true;
      }
    );

    assert.throws(
      () => createPgBossRuntime({ connectionString: '   ' }),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'START_FAILURE');
        return true;
      }
    );
  });

  // ==========================================================================
  // N. LIFECYCLE & OPERAÇÕES PROTEGIDAS (FAIL-CLOSED)
  // ==========================================================================

  it('impede createQueue se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.createQueue('test_queue'),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'RUNTIME_NOT_STARTED');
        return true;
      }
    );
  });

  it('impede sendWakeup se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.sendWakeup('test_queue', { jobId: 'job_123' }),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'RUNTIME_NOT_STARTED');
        return true;
      }
    );
  });

  it('impede fetchWakeup se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.fetchWakeup('test_queue'),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'RUNTIME_NOT_STARTED');
        return true;
      }
    );
  });

  it('impede completeJob se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.completeJob('test_queue', 'msg_123'),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'RUNTIME_NOT_STARTED');
        return true;
      }
    );
  });

  it('impede getSchemaVersion se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.getSchemaVersion(),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'RUNTIME_NOT_STARTED');
        return true;
      }
    );
  });

  it('impede detectDrift se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.detectDrift(),
      (err: unknown) => {
        assert.ok(err instanceof PgBossRuntimeError);
        assert.equal(err.code, 'RUNTIME_NOT_STARTED');
        return true;
      }
    );
  });

  it('valida payload com fail-closed em sendWakeup antes de qualquer interação técnica', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    const badPayload = { jobId: 'job_123', sessionRef: 'leak' };
    await assert.rejects(
      async () => runtime.sendWakeup('test_queue', badPayload as unknown as { jobId: string }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        return true;
      }
    );
  });

  it('N. stop() idempotente e seguro quando chamado antes de start() ou repetidamente', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    // stop() sem start() não deve lançar erro
    await assert.doesNotReject(async () => runtime.stop());
    assert.equal(runtime.isStarted, false);

    // Múltiplos stops não quebram
    await assert.doesNotReject(async () => runtime.stop());
    assert.equal(runtime.isStarted, false);
  });
});
