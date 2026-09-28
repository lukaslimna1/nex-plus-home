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
  type PgBossDeliveryAttemptRef,
  type PgBossProvisioningResult,
  type PgBossRuntimeConfig,
  type PgBossRuntimeOptions,
  type PgBossSendResult,
  type PgBossSettlementResult,
  type PgBossWakeupMessage,
} from './contracts';
import {
  assertJobWakeupPayload,
  parseJobWakeupPayload,
  assertDeliveryAttemptRetryCount,
  assertDeliveryAttemptRef,
} from './invariants';

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
  | 'SETTLEMENT_FAILURE'
  | 'PROVISIONING_FAILURE'
  | 'SCHEMA_DRIFT_DETECTED';

export interface PgBossRuntimeErrorOptions {
  readonly code: PgBossRuntimeErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly schemaVersion?: number | null;
  readonly cleanupError?: unknown;
}

export class PgBossRuntimeError extends Error {
  readonly code: PgBossRuntimeErrorCode;
  readonly schemaVersion?: number | null;
  readonly cleanupError?: unknown;

  constructor(options: PgBossRuntimeErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'PgBossRuntimeError';
    this.code = options.code;
    this.schemaVersion = options.schemaVersion;
    this.cleanupError = options.cleanupError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// 1.1 HELPERS DEFENSIVOS DE TRUST BOUNDARY & CLEANUP ERROR PRESERVATION
// ============================================================================

/**
 * Validação fail-closed do retorno de settlement (P-M1).
 * Para uma única attempt, affected DEVE ser number, finito, inteiro e estritamente 0 ou 1.
 */
export function parseSettlementAffected(rawAffected: unknown, queueName?: string): number {
  if (
    typeof rawAffected !== 'number' ||
    !Number.isFinite(rawAffected) ||
    !Number.isInteger(rawAffected) ||
    rawAffected < 0 ||
    rawAffected > 1
  ) {
    const queueContext = queueName ? ` on queue '${queueName}'` : '';
    throw new PgBossRuntimeError({
      code: 'SETTLEMENT_FAILURE',
      message: `[PgBossRuntime] Invalid settlement response${queueContext}: expected affected to be integer 0 or 1, received: ${String(rawAffected)}`,
    });
  }

  return rawAffected;
}

/**
 * Preserva erro primário e falha secundária de cleanup sem mascaramento (P-M2).
 * Utiliza AggregateError, cause e o campo cleanupError do PgBossRuntimeError.
 */
export function composeRuntimeErrorWithCleanup(
  primaryError: unknown,
  cleanupError: unknown,
  defaultCode: PgBossRuntimeErrorCode,
  contextPrefix: string
): PgBossRuntimeError {
  if (!cleanupError) {
    if (primaryError instanceof PgBossRuntimeError) {
      return primaryError;
    }
    const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    return new PgBossRuntimeError({
      code: defaultCode,
      message: `${contextPrefix}: ${primaryMsg}`,
      cause: primaryError,
    });
  }

  const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
  const cleanupMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  const message = `${contextPrefix}: ${primaryMsg} (cleanup error: ${cleanupMsg})`;

  let cause: unknown = primaryError;
  if (typeof AggregateError !== 'undefined') {
    cause = new AggregateError(
      [primaryError, cleanupError],
      `${contextPrefix} followed by cleanup failure`
    );
  }

  const code: PgBossRuntimeErrorCode =
    primaryError instanceof PgBossRuntimeError ? primaryError.code : defaultCode;
  const schemaVersion =
    primaryError instanceof PgBossRuntimeError ? primaryError.schemaVersion : undefined;

  return new PgBossRuntimeError({
    code,
    message,
    cause,
    schemaVersion,
    cleanupError,
  });
}

// ============================================================================
// 2. ADAPTER DE RUNTIME NORMAL (migrate: false)
// ============================================================================

export class PgBossRuntime implements IPgBossRuntime {
  readonly #connectionString: string;
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

    this.#connectionString = options.connectionString;

    // Configuração estritamente congelada conforme decisões arquiteturais do 0.86C-3A
    // connectionString mantida em campo privado nativo (#connectionString · F-3A-04-R1),
    // schema imutável 'pgboss' (F-3A-02)
    this._config = Object.freeze({
      schema: PG_BOSS_CANONICAL_SCHEMA,
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
   * F-3A-01: Mantém referência ao PgBoss criado e executa cleanup best-effort se start falhar.
   */
  async start(): Promise<void> {
    if (this._isStarted && this._boss !== null) {
      return;
    }

    const candidateBoss = new PgBoss({
      connectionString: this.#connectionString,
      schema: this._config.schema,
      backend: this._config.backend,
      migrate: false,
      useListenNotify: false,
    });

    try {
      this._boss = candidateBoss;
      await candidateBoss.start();
      this._isStarted = true;
    } catch (err) {
      this._isStarted = false;
      this._boss = null;
      let cleanupError: unknown = null;
      try {
        await candidateBoss.stop({ graceful: false });
      } catch (cErr) {
        cleanupError = cErr;
      }

      throw composeRuntimeErrorWithCleanup(
        err,
        cleanupError,
        'START_FAILURE',
        '[PgBossRuntime] Failed to start pg-boss runtime (migrate: false)'
      );
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
        // Validação defensiva fail-closed da metadata técnica de tentativa (pg-boss 12.35)
        assertDeliveryAttemptRetryCount(job.retryCount);

        // Validação defensiva fail-closed do payload canônico { jobId }
        const validatedPayload = parseJobWakeupPayload(job.data);

        return Object.freeze({
          id: job.id,
          name: job.name,
          data: validatedPayload,
          retryCount: job.retryCount,
        });
      });

      return Object.freeze(messages);
    } catch (err) {
      if (err instanceof PgBossRuntimeError) {
        throw err;
      }
      throw new PgBossRuntimeError({
        code: 'FETCH_FAILURE',
        message: `[PgBossRuntime] Failed to fetch wake-up from queue '${queueName}': ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  /**
   * Conclui processamento técnico da mensagem na fila com attempt fencing ({ id, retryCount }).
   * F-3A-03 / pg-boss 12.35: NUNCA liquida por plain id. Avalia CommandResponse.affected.
   */
  async completeWakeup(queueName: string, target: PgBossDeliveryAttemptRef): Promise<PgBossSettlementResult> {
    assertDeliveryAttemptRef(target);

    if (!this._boss || !this._isStarted) {
      throw new PgBossRuntimeError({
        code: 'RUNTIME_NOT_STARTED',
        message: '[PgBossRuntime] Cannot complete wake-up: pg-boss runtime is not started.',
      });
    }

    try {
      // Settlement fenced obrigatório por { id, retryCount } (pg-boss 12.35)
      // NUNCA liquidar por plain id no boundary produtivo
      const response = await this._boss.complete(queueName, {
        id: target.id,
        retryCount: target.retryCount,
      });

      // P-M1: fail-closed estrito na avaliação do affected retornado pelo provider
      const rawAffected = (response as { affected?: unknown } | null | undefined)?.affected;
      const affected = parseSettlementAffected(rawAffected, queueName);

      return Object.freeze({
        settled: affected === 1,
        affected,
      });
    } catch (err) {
      if (err instanceof PgBossRuntimeError) {
        throw err;
      }
      throw new PgBossRuntimeError({
        code: 'SETTLEMENT_FAILURE',
        message: `[PgBossRuntime] Failed to complete wake-up on queue '${queueName}': ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
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
   * Detecta drift de schema usando a API oficial do pg-boss 12.35.0.
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
 * Utiliza a API oficial do pg-boss 12.35.0, verifica o schemaVersion = 43 e ausência de drift.
 * F-3A-02: Schema estritamente congelado em 'pgboss' sem parametrização pública.
 */
export async function provisionPgBossSchema(
  connectionString: string
): Promise<PgBossProvisioningResult> {
  const schema = PG_BOSS_CANONICAL_SCHEMA;

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
    let cleanupError: unknown = null;
    try {
      await provisioningBoss.stop({ graceful: false });
    } catch (cErr) {
      cleanupError = cErr;
    }

    throw composeRuntimeErrorWithCleanup(
      err,
      cleanupError,
      'PROVISIONING_FAILURE',
      '[PgBoss Provisioning] Controlled provisioning failed'
    );
  }
}
