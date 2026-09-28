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
  parseSettlementAffected,
  composeRuntimeErrorWithCleanup,
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

  // ==========================================================================
  // F-3A-04-R1. HARD PRIVACY DA CONNECTION STRING (ECMAScript #connectionString)
  // ==========================================================================

  it('F-3A-04-R1: assegura hard privacy da connection string em runtime via private field nativo (#)', () => {
    const syntheticUser = 'nex_secret_user';
    const syntheticPass = 'NEX_SECRET_PASSWORD_123';
    const syntheticDb = 'nex_secret_database';
    const syntheticDsn = `postgres://${syntheticUser}:${syntheticPass}@127.0.0.1:5432/${syntheticDb}`;

    const runtime = createPgBossRuntime({
      connectionString: syntheticDsn,
    });

    // A. Object.keys(runtime)
    const keys = Object.keys(runtime);
    assert.equal(keys.includes('_connectionString'), false);
    assert.equal(keys.includes('connectionString'), false);
    assert.equal(keys.includes('#connectionString'), false);
    assert.equal(keys.some((k) => k.includes(syntheticUser) || k.includes(syntheticPass) || k.includes(syntheticDb)), false);

    // B. Object.getOwnPropertyNames(runtime)
    const propNames = Object.getOwnPropertyNames(runtime);
    assert.equal(propNames.includes('_connectionString'), false);
    assert.equal(propNames.includes('connectionString'), false);
    assert.equal(propNames.includes('#connectionString'), false);
    assert.equal(propNames.some((k) => k.includes(syntheticUser) || k.includes(syntheticPass) || k.includes(syntheticDb)), false);

    // C. Reflect.ownKeys(runtime)
    const reflectKeys = Reflect.ownKeys(runtime);
    assert.equal(reflectKeys.includes('_connectionString'), false);
    assert.equal(reflectKeys.includes('connectionString'), false);
    assert.equal(reflectKeys.includes('#connectionString'), false);
    assert.equal(
      reflectKeys.some(
        (k) =>
          typeof k === 'string' &&
          (k.includes(syntheticUser) || k.includes(syntheticPass) || k.includes(syntheticDb))
      ),
      false
    );

    // D. JSON.stringify(runtime)
    const serialized = JSON.stringify(runtime);
    assert.equal(serialized.includes(syntheticDsn), false);
    assert.equal(serialized.includes(syntheticUser), false);
    assert.equal(serialized.includes(syntheticPass), false);
    assert.equal(serialized.includes(syntheticDb), false);
    assert.equal(serialized.includes('_connectionString'), false);
    assert.equal(serialized.includes('connectionString'), false);

    // E. Spread {...runtime}
    const spread = { ...runtime };
    assert.equal('_connectionString' in spread, false);
    assert.equal('connectionString' in spread, false);
    const spreadSerialized = JSON.stringify(spread);
    assert.equal(spreadSerialized.includes(syntheticDsn), false);
    assert.equal(spreadSerialized.includes(syntheticPass), false);

    // F. Acesso por bracket runtime['_connectionString'] deve ser undefined
    assert.equal((runtime as unknown as Record<string, unknown>)['_connectionString'], undefined);

    // G. Acesso por bracket runtime['connectionString'] deve ser undefined
    assert.equal((runtime as unknown as Record<string, unknown>)['connectionString'], undefined);

    // H. runtime.config continua sem connectionString
    assert.equal('connectionString' in runtime.config, false);
    assert.equal((runtime.config as unknown as Record<string, unknown>).connectionString, undefined);
  });

  // ==========================================================================
  // P-M1. FAIL-CLOSED DO RETORNO DE SETTLEMENT (parseSettlementAffected)
  // ==========================================================================

  it('P-M1: aceita estritamente affected = 0 (settled: false) e affected = 1 (settled: true)', () => {
    assert.equal(parseSettlementAffected(0), 0);
    assert.equal(parseSettlementAffected(1), 1);
    assert.equal(parseSettlementAffected(0, 'test_queue'), 0);
    assert.equal(parseSettlementAffected(1, 'test_queue'), 1);
  });

  it('P-M1: rejeita valores malformados de affected fail-closed com SETTLEMENT_FAILURE', () => {
    const invalidCases: Array<{ label: string; value: unknown }> = [
      { label: 'missing/undefined', value: undefined },
      { label: 'null', value: null },
      { label: 'string "0"', value: '0' },
      { label: 'string "1"', value: '1' },
      { label: 'string arbitrária', value: 'affected' },
      { label: 'NaN', value: NaN },
      { label: 'negativo -1', value: -1 },
      { label: 'negativo -42', value: -42 },
      { label: 'decimal 0.5', value: 0.5 },
      { label: 'decimal 1.5', value: 1.5 },
      { label: 'maior que 1 (2)', value: 2 },
      { label: 'maior que 1 (10)', value: 10 },
      { label: 'Infinity', value: Infinity },
      { label: '-Infinity', value: -Infinity },
      { label: 'objeto vazio', value: {} },
      { label: 'array', value: [1] },
    ];

    for (const testCase of invalidCases) {
      assert.throws(
        () => parseSettlementAffected(testCase.value, 'queue_x'),
        (err: unknown) => {
          assert.ok(
            err instanceof PgBossRuntimeError,
            `Esperado PgBossRuntimeError para caso ${testCase.label}`
          );
          assert.equal(
            err.code,
            'SETTLEMENT_FAILURE',
            `Esperado SETTLEMENT_FAILURE para caso ${testCase.label}`
          );
          return true;
        },
        `Deveria falhar para ${testCase.label}`
      );
    }
  });

  // ==========================================================================
  // P-M2. PRESERVAÇÃO DE ERRO PRIMÁRIO E CLEANUP ERROR (composeRuntimeErrorWithCleanup)
  // ==========================================================================

  it('P-M2: preserva erro primário quando não há cleanupError', () => {
    // Caso 1: erro comum embrulhado com defaultCode
    const rawError = new Error('Database connection timeout');
    const result1 = composeRuntimeErrorWithCleanup(
      rawError,
      null,
      'PROVISIONING_FAILURE',
      '[PgBoss Provisioning] Controlled provisioning failed'
    );
    assert.ok(result1 instanceof PgBossRuntimeError);
    assert.equal(result1.code, 'PROVISIONING_FAILURE');
    assert.equal(result1.cause, rawError);
    assert.equal(result1.cleanupError, undefined);
    assert.ok(result1.message.includes('Database connection timeout'));

    // Caso 2: erro já era PgBossRuntimeError (ex: SCHEMA_DRIFT_DETECTED)
    const driftError = new PgBossRuntimeError({
      code: 'SCHEMA_DRIFT_DETECTED',
      message: 'Drift detected in schema pgboss',
      schemaVersion: 43,
    });
    const result2 = composeRuntimeErrorWithCleanup(
      driftError,
      null,
      'PROVISIONING_FAILURE',
      '[PgBoss Provisioning] Controlled provisioning failed'
    );
    assert.equal(result2, driftError);
    assert.equal(result2.code, 'SCHEMA_DRIFT_DETECTED');
    assert.equal(result2.schemaVersion, 43);
  });

  it('P-M2: preserva ambos os erros (primário + cleanup) quando cleanup falha', () => {
    // Caso 1: erro primário comum + falha secundária no cleanup
    const primary = new Error('Disk full during migration');
    const cleanup = new Error('Connection reset on stop');

    const result1 = composeRuntimeErrorWithCleanup(
      primary,
      cleanup,
      'PROVISIONING_FAILURE',
      '[PgBoss Provisioning] Controlled provisioning failed'
    );

    assert.ok(result1 instanceof PgBossRuntimeError);
    assert.equal(result1.code, 'PROVISIONING_FAILURE');
    assert.equal(result1.cleanupError, cleanup);
    assert.ok(result1.message.includes('Disk full during migration'));
    assert.ok(result1.message.includes('Connection reset on stop'));
    assert.ok(result1.cause instanceof AggregateError);
    const aggErrors1 = (result1.cause as AggregateError).errors;
    assert.equal(aggErrors1[0], primary);
    assert.equal(aggErrors1[1], cleanup);

    // Caso 2: erro primário é PgBossRuntimeError com código específico (ex: SCHEMA_DRIFT_DETECTED)
    const driftError = new PgBossRuntimeError({
      code: 'SCHEMA_DRIFT_DETECTED',
      message: 'Schema drift detected after provisioning in schema pgboss',
      schemaVersion: 43,
    });
    const stopError = new Error('Socket closed prematurely during stop');

    const result2 = composeRuntimeErrorWithCleanup(
      driftError,
      stopError,
      'PROVISIONING_FAILURE',
      '[PgBoss Provisioning] Controlled provisioning failed'
    );

    assert.ok(result2 instanceof PgBossRuntimeError);
    assert.equal(result2.code, 'SCHEMA_DRIFT_DETECTED');
    assert.equal(result2.schemaVersion, 43);
    assert.equal(result2.cleanupError, stopError);
    assert.ok(result2.message.includes('Schema drift detected'));
    assert.ok(result2.message.includes('Socket closed prematurely during stop'));
    assert.ok(result2.cause instanceof AggregateError);
    const aggErrors2 = (result2.cause as AggregateError).errors;
    assert.equal(aggErrors2[0], driftError);
    assert.equal(aggErrors2[1], stopError);
  });
});
