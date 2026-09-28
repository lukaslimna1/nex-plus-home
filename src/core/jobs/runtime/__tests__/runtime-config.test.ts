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
  type PgBossRuntimeOptions,
} from '../index';
import {
  JobWakeupPayloadError,
  DeliveryAttemptError,
  assertDeliveryAttemptRetryCount,
  assertDeliveryAttemptRef,
} from '../invariants';

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

    // F-3A-04: connectionString não deve ser exposta no config público
    assert.equal('connectionString' in cfg, false);
    assert.equal((cfg as Record<string, unknown>).connectionString, undefined);

    assert.equal(cfg.schema, PG_BOSS_CANONICAL_SCHEMA);
    assert.equal(cfg.schema, 'pgboss');
    assert.equal(cfg.backend, PG_BOSS_DEFAULT_BACKEND);
    assert.equal(cfg.backend, 'postgres');
    assert.equal(cfg.migrate, false);
    assert.equal(cfg.useListenNotify, false);
    assert.ok(Object.isFrozen(cfg), 'Configuração de runtime deve ser congelada/imutável');
  });

  it('F-3A-02: schema é estritamente invariável mesmo se consumidor tentar passar schema via cast', () => {
    const optionsWithExtra = {
      connectionString: 'postgres://test:test@localhost:5432/test',
      schema: 'custom_pgboss',
    } as unknown as PgBossRuntimeOptions;
    const runtime = createPgBossRuntime(optionsWithExtra);

    assert.equal(runtime.config.schema, 'pgboss');
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

  it('impede completeWakeup se runtime não foi iniciado', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    await assert.rejects(
      async () => runtime.completeWakeup('test_queue', { id: 'msg_123', retryCount: 0 }),
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

  // ==========================================================================
  // VALIDAÇÕES DEFENSIVAS DE DELIVERY / RETRY COUNT (PG-BOSS 12.35)
  // ==========================================================================

  it('valida retryCount na referência de delivery: aceita inteiros >= 0', () => {
    assert.doesNotThrow(() => assertDeliveryAttemptRetryCount(0));
    assert.doesNotThrow(() => assertDeliveryAttemptRetryCount(1));
    assert.doesNotThrow(() => assertDeliveryAttemptRetryCount(42));
  });

  it('rejeita retryCount inválido: negativo, decimal, NaN, string, null, undefined', () => {
    const invalidCases = [-1, -42, 1.5, 0.1, NaN, Infinity, -Infinity, '0', '1', null, undefined, {}, []];
    for (const badValue of invalidCases) {
      assert.throws(
        () => assertDeliveryAttemptRetryCount(badValue),
        (err: unknown) => {
          assert.ok(err instanceof DeliveryAttemptError);
          assert.equal(err.code, 'INVALID_RETRY_COUNT');
          return true;
        }
      );
    }
  });

  it('completeWakeup valida target fail-closed antes de qualquer operação', async () => {
    const runtime = createPgBossRuntime({
      connectionString: 'postgres://test:test@localhost:5432/test',
    });

    // target inválido não passa
    await assert.rejects(
      async () => runtime.completeWakeup('test_queue', { id: '', retryCount: 0 } as any),
      (err: unknown) => {
        assert.ok(err instanceof DeliveryAttemptError);
        assert.equal(err.code, 'INVALID_DELIVERY_ATTEMPT_REF');
        return true;
      }
    );

    // retryCount inválido no target não passa
    await assert.rejects(
      async () => runtime.completeWakeup('test_queue', { id: 'msg_123', retryCount: -1 } as any),
      (err: unknown) => {
        assert.ok(err instanceof DeliveryAttemptError);
        assert.equal(err.code, 'INVALID_RETRY_COUNT');
        return true;
      }
    );
  });
});
