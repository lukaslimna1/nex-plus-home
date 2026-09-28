/**
 * NEX+ · pg-boss Runtime Provider Adapter
 * Implementação do Provedor de Wake-up — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Princípios Fundamentais:
 * 1. Zero side-effects no import de módulo (sem conexão, sem timer, sem auto-start).
 * 2. Runtime normal roda estritamente com migrate: false e useListenNotify: false.
 * 3. Provisionamento é operação isolada e explícita, nunca acoplada ao boot normal.
 * 4. Validação defensiva fail-closed em qualquer payload de wake-up emitido.
 * 5. Lifecycle explícito e seguro: start() e stop() gracioso sem conexões/timers residuais.
 */

import { PgBoss } from 'pg-boss';
import {
  PG_BOSS_CANONICAL_SCHEMA,
  PG_BOSS_EXPECTED_SCHEMA_VERSION,
  PG_BOSS_DEFAULT_BACKEND,
  type IPgBossRuntime,
  type JobWakeupPayload,
  type PgBossProvisioningResult,
  type PgBossRuntimeConfig,
  type PgBossRuntimeOptions,
  type PgBossSendResult,
  type PgBossWakeupMessage,
} from './contracts';
import { assertJobWakeupPayload, parseJobWakeupPayload } from './invariants';

// ============================================================================
// 1. ERRO ESTRUTURADO DO RUNTIME PG-BOSS
// ============================================================================

export type PgBossRuntimeErrorCode =
  | 'RUNTIME_NOT_STARTED'
  | 'RUNTIME_ALREADY_STARTED'
  | 'START_FAILURE'
  | 'STOP_FAILURE'
  | 'SEND_FAILURE'
  | 'FETCH_FAILURE'
  | 'PROVISIONING_FAILURE'
  | 'SCHEMA_DRIFT_DETECTED';

export interface PgBossRuntimeErrorOptions {
  readonly code: PgBossRuntimeErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly schemaVersion?: number | null;
}

export class PgBossRuntimeError extends Error {
  readonly code: PgBossRuntimeErrorCode;
  readonly schemaVersion?: number | null;

  constructor(options: PgBossRuntimeErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'PgBossRuntimeError';
    this.code = options.code;
    this.schemaVersion = options.schemaVersion;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// 2. ADAPTER DE RUNTIME NORMAL (migrate: false)
// ============================================================================

export class PgBossRuntime implements IPgBossRuntime {
  private _boss: PgBoss | null = null;
  private _isStarted = false;
  private readonly _config: Readonly<PgBossRuntimeConfig>;

  constructor(options: PgBossRuntimeOptions) {
    if (!options.connectionString || options.connectionString.trim().length === 0) {
      throw new PgBossRuntimeError({
        code: 'START_FAILURE',
        message: '[PgBossRuntime] connectionString is required and cannot be empty.',
      });
    }

    // Configuração estritamente congelada conforme decisões arquiteturais do 0.86C-3A
    this._config = Object.freeze({
      connectionString: options.connectionString,
      schema: options.schema ?? PG_BOSS_CANONICAL_SCHEMA,
      backend: PG_BOSS_DEFAULT_BACKEND,
      migrate: false as const,
      useListenNotify: false as const,
    });
  }

  get isStarted(): boolean {
    return this._isStarted;
  }

  get config(): Readonly<PgBossRuntimeConfig> {
    return this._config;
  }

  /**
   * Inicialização explícita do runtime normal.
   * Lança PgBossRuntimeError se o schema não existir ou divergir de migrate: false.
   */
  async start(): Promise<void> {
    if (this._isStarted && this._boss !== null) {
      return;
    }

    try {
      this._boss = new PgBoss({
        connectionString: this._config.connectionString,
        schema: this._config.schema,
        backend: this._config.backend,
        migrate: false,
        useListenNotify: false,
      });

      await this._boss.start();
      this._isStarted = true;
    } catch (err) {
      this._isStarted = false;
      this._boss = null;
      throw new PgBossRuntimeError({
        code: 'START_FAILURE',
        message: `[PgBossRuntime] Failed to start pg-boss runtime (migrate: false): ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  /**
   * Encerramento explícito e gracioso do runtime.
   */
  async stop(options?: { graceful?: boolean; timeout?: number }): Promise<void> {
    if (!this._boss) {
      this._isStarted = false;
      return;
    }

    try {
      await this._boss.stop({
        graceful: options?.graceful ?? true,
        timeout: options?.timeout,
      });
    } catch (err) {
      throw new PgBossRuntimeError({
        code: 'STOP_FAILURE',
        message: `[PgBossRuntime] Error stopping pg-boss runtime: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    } finally {
      this._isStarted = false;
      this._boss = null;
    }
  }

  /**
   * Cria explicitamente uma queue técnica no pg-boss.
   * Utilizado para provisionar queues de aplicação ou smoke test no provider.
   */
  async createQueue(queueName: string): Promise<void> {
    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot create queue: pg-boss runtime is not started.',
      });
    }

    try {
      await this._boss.createQueue(queueName);
    } catch (err) {
      throw new PgBossRuntimeError({
        code: 'SEND_FAILURE',
        message: `[PgBossRuntime] Failed to create queue '${queueName}': ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  /**
   * Envia payload canônico de wake-up para a fila.
   * Valida rigorosamente com assertJobWakeupPayload (fail-closed).
   */
  async sendWakeup(queueName: string, payload: JobWakeupPayload): Promise<PgBossSendResult> {
    // Validação estrita defensiva fail-closed antes de qualquer operação
    assertJobWakeupPayload(payload);

    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot send wake-up: pg-boss runtime is not started.',
      });
    }

    try {
      const messageId = await this._boss.send(queueName, payload);
      return { messageId };
    } catch (err) {
      throw new PgBossRuntimeError({
        code: 'SEND_FAILURE',
        message: `[PgBossRuntime] Failed to send wake-up to queue '${queueName}': ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  /**
   * Recupera mensagens da fila (usado pelo harness de validação técnica).
   */
  async fetchWakeup(queueName: string, batchSize = 1): Promise<readonly PgBossWakeupMessage[]> {
    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot fetch wake-up: pg-boss runtime is not started.',
      });
    }

    try {
      const jobs = await this._boss.fetch<unknown>(queueName, { batchSize });
      if (!jobs || jobs.length === 0) {
        return Object.freeze([]);
      }

      const messages: PgBossWakeupMessage[] = jobs.map((job) => {
        // Valida payload recuperado
        const validatedPayload = parseJobWakeupPayload(job.data);
        return Object.freeze({
          id: job.id,
          name: job.name,
          data: validatedPayload,
        });
      });

      return Object.freeze(messages);
    } catch (err) {
      throw new PgBossRuntimeError({
        code: 'FETCH_FAILURE',
        message: `[PgBossRuntime] Failed to fetch wake-up from queue '${queueName}': ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  /**
   * Conclui processamento técnico da mensagem na fila.
   */
  async completeJob(queueName: string, messageId: string): Promise<void> {
    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot complete job: pg-boss runtime is not started.',
      });
    }

    await this._boss.complete(queueName, messageId);
  }

  /**
   * Retorna a versão do schema no banco.
   */
  async getSchemaVersion(): Promise<number | null> {
    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot check schema version: pg-boss runtime is not started.',
      });
    }

    return await this._boss.schemaVersion();
  }

  /**
   * Detecta drift de schema usando a API oficial do pg-boss 12.34.0.
   */
  async detectDrift(): Promise<{ ok: boolean }> {
    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot detect schema drift: pg-boss runtime is not started.',
      });
    }

    const report = await this._boss.detectSchemaDrift();
    return { ok: report.ok };
  }
}

// ============================================================================
// 3. FACTORY DO RUNTIME NORMAL
// ============================================================================

export function createPgBossRuntime(options: PgBossRuntimeOptions): IPgBossRuntime {
  return new PgBossRuntime(options);
}

// ============================================================================
// 4. PROVISIONAMENTO CONTROLADO & ISOLADO (migrate: true)
// ============================================================================

/**
 * Executa o provisionamento explícito e controlado do schema do pg-boss.
 * Este método é estritamente separado do boot da aplicação e nunca é invocado silenciosamente.
 * Utiliza a API oficial do pg-boss 12.34.0, verifica o schemaVersion = 42 e ausência de drift.
 */
export async function provisionPgBossSchema(
  connectionString: string,
  options?: { schema?: string }
): Promise<PgBossProvisioningResult> {
  const schema = options?.schema ?? PG_BOSS_CANONICAL_SCHEMA;

  const provisioningBoss = new PgBoss({
    connectionString,
    schema,
    backend: PG_BOSS_DEFAULT_BACKEND,
    migrate: true,
    useListenNotify: false,
  });

  try {
    await provisioningBoss.start();

    const version = await provisioningBoss.schemaVersion();
    const driftReport = await provisioningBoss.detectSchemaDrift();

    await provisioningBoss.stop({ graceful: true });

    if (version !== PG_BOSS_EXPECTED_SCHEMA_VERSION) {
      throw new PgBossRuntimeError({
        code: 'PROVISIONING_FAILURE',
        message: `[PgBoss Provisioning] Expected schema version ${PG_BOSS_EXPECTED_SCHEMA_VERSION}, received: ${version}`,
        schemaVersion: version,
      });
    }

    if (!driftReport.ok) {
      throw new PgBossRuntimeError({
        code: 'SCHEMA_DRIFT_DETECTED',
        message: `[PgBoss Provisioning] Schema drift detected after provisioning in schema '${schema}'.`,
        schemaVersion: version,
      });
    }

    return Object.freeze({
      success: true,
      schema,
      schemaVersion: version,
      driftOk: driftReport.ok,
    });
  } catch (err) {
    try {
      await provisioningBoss.stop({ graceful: true });
    } catch {
      // Ignora falha de stop secundária na presença de erro primário
    }

    if (err instanceof PgBossRuntimeError) {
      throw err;
    }

    throw new PgBossRuntimeError({
      code: 'PROVISIONING_FAILURE',
      message: `[PgBoss Provisioning] Controlled provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
}
