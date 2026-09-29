/**
 * NEX+ · Single-Delivery Worker Bridge
 * Ponte entre Notificação Técnica (pg-boss) e Execução Canônica (JobStore + Claims) — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3C)
 *
 * Princípios Fundamentais:
 * 1. Single-delivery unitário: processNext() processa no máximo UMA mensagem sem timers ou loops contínuos.
 * 2. Ordem estrita e invariável: fetch → rehydrate → claim → callback → release → complete.
 * 3. Fila subordinada: se Job não existe, liquida attempt técnico e marca 'orphaned' sem chamar callback.
 * 4. Fencing token: se claim held, liquida delivery técnica e marca 'held' sem chamar callback.
 * 5. Callback orchestration-only: curto, idempotente, sem side effects materiais nem criação de Attempt NEX.
 * 6. Preservação estruturada de erros primários e falhas secundárias de cleanup (sem engolir exceções).
 */

import type { JobState } from '../contracts';
import type { DurableJobStore } from '../persistence/contracts';
import type { JobClaimStore, JobClaimSnapshot } from '../claims/contracts';
import { assertWorkerId, assertLeaseDurationMs } from '../claims/invariants';
import {
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  type IPgBossRuntime,
  type PgBossDeliveryAttemptRef,
} from './contracts';

export type WorkerBridgeOutcome =
  | 'idle'
  | 'processed'
  | 'held'
  | 'orphaned'
  | 'technical_stale';

export interface WorkerBridgeProcessResult {
  readonly outcome: WorkerBridgeOutcome;
  readonly jobId?: string;
  readonly deliveryId?: string;
  readonly retryCount?: number;
  readonly fencingToken?: string;
}

export interface WorkerBridgeCallbackContext {
  readonly job: Readonly<JobState>;
  readonly claim: Readonly<JobClaimSnapshot>;
}

export type JobWakeupCallback = (context: WorkerBridgeCallbackContext) => Promise<void>;

export interface WorkerBridgeOptions {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly queueName?: string;
}

/**
 * Erro estruturado indicando que a tentativa técnica do wake-up no pg-boss
 * ficou stale (affected=0 / settled=false) e a liquidação de falha não foi aplicada (F-3C-02).
 * Não expõe secrets nem payloads arbitrários.
 */
export class WorkerBridgeTechnicalStaleError extends Error {
  readonly deliveryId: string;
  readonly retryCount: number;
  readonly queueName: string;

  constructor(options: { deliveryId: string; retryCount: number; queueName: string }) {
    super(
      `[WorkerBridge] Technical attempt is stale on queue '${options.queueName}' (deliveryId: '${options.deliveryId}', retryCount: ${options.retryCount}). Failure settlement was not applied.`,
    );
    this.name = 'WorkerBridgeTechnicalStaleError';
    this.deliveryId = options.deliveryId;
    this.retryCount = options.retryCount;
    this.queueName = options.queueName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Representação explícita de falha capturada, imune a valores falsey (F-3C-03).
 */
export interface BridgeCapturedFailure {
  readonly hasError: boolean;
  readonly error?: unknown;
}

export interface WorkerBridgeErrorOptions {
  readonly primaryError: unknown;
  readonly hasReleaseError?: boolean;
  readonly releaseError?: unknown;
  readonly hasTechnicalSettlementError?: boolean;
  readonly technicalSettlementError?: unknown;
}

/**
 * Erro composto do WorkerBridge para preservar falha primária juntamente com
 * falhas secundárias de release e settlement técnico (P-M2 pattern / F-3C-02 / F-3C-03).
 */
export class WorkerBridgeError extends Error {
  readonly primaryError: unknown;
  readonly hasReleaseError: boolean;
  readonly releaseError?: unknown;
  readonly hasTechnicalSettlementError: boolean;
  readonly technicalSettlementError?: unknown;

  constructor(message: string, options: WorkerBridgeErrorOptions) {
    const causes: unknown[] = [options.primaryError];
    const hasRelease =
      options.hasReleaseError ??
      ('releaseError' in options && options.releaseError !== undefined);
    const hasTech =
      options.hasTechnicalSettlementError ??
      ('technicalSettlementError' in options && options.technicalSettlementError !== undefined);

    if (hasRelease) causes.push(options.releaseError);
    if (hasTech) causes.push(options.technicalSettlementError);

    const cause =
      typeof AggregateError !== 'undefined' && causes.length > 1
        ? new AggregateError(causes, message)
        : options.primaryError;

    super(message, { cause });
    this.name = 'WorkerBridgeError';
    this.primaryError = options.primaryError;
    this.hasReleaseError = hasRelease;
    this.releaseError = options.releaseError;
    this.hasTechnicalSettlementError = hasTech;
    this.technicalSettlementError = options.technicalSettlementError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function formatErrorDetail(val: unknown): string {
  if (val instanceof Error) return val.message;
  return String(val);
}

export function composeBridgeCallbackError(
  callbackError: unknown,
  releaseArg?: BridgeCapturedFailure | unknown,
  failArg?: BridgeCapturedFailure | unknown,
): Error {
  const releaseFailure: BridgeCapturedFailure =
    releaseArg && typeof releaseArg === 'object' && 'hasError' in releaseArg
      ? (releaseArg as BridgeCapturedFailure)
      : releaseArg !== undefined
        ? { hasError: true, error: releaseArg }
        : { hasError: false };

  const failFailure: BridgeCapturedFailure =
    failArg && typeof failArg === 'object' && 'hasError' in failArg
      ? (failArg as BridgeCapturedFailure)
      : failArg !== undefined
        ? { hasError: true, error: failArg }
        : { hasError: false };

  if (!releaseFailure.hasError && !failFailure.hasError) {
    if (callbackError instanceof Error) return callbackError;
    return new Error(String(callbackError));
  }

  const primaryMsg = formatErrorDetail(callbackError);
  const releaseMsg = releaseFailure.hasError
    ? ` (release error: ${formatErrorDetail(releaseFailure.error)})`
    : '';
  const failMsg = failFailure.hasError
    ? ` (failWakeup error: ${formatErrorDetail(failFailure.error)})`
    : '';

  return new WorkerBridgeError(
    `[WorkerBridge] Callback failure: ${primaryMsg}${releaseMsg}${failMsg}`,
    {
      primaryError: callbackError,
      hasReleaseError: releaseFailure.hasError,
      releaseError: releaseFailure.error,
      hasTechnicalSettlementError: failFailure.hasError,
      technicalSettlementError: failFailure.error,
    },
  );
}

export function composeBridgeReleaseError(
  releaseError: unknown,
  failArg?: BridgeCapturedFailure | unknown,
): Error {
  const failFailure: BridgeCapturedFailure =
    failArg && typeof failArg === 'object' && 'hasError' in failArg
      ? (failArg as BridgeCapturedFailure)
      : failArg !== undefined
        ? { hasError: true, error: failArg }
        : { hasError: false };

  if (!failFailure.hasError) {
    if (releaseError instanceof Error) return releaseError;
    return new Error(String(releaseError));
  }

  const releaseMsg = formatErrorDetail(releaseError);
  const failMsg = ` (failWakeup error: ${formatErrorDetail(failFailure.error)})`;

  return new WorkerBridgeError(
    `[WorkerBridge] Canonical release failed: ${releaseMsg}${failMsg}`,
    {
      primaryError: releaseError,
      hasReleaseError: false,
      hasTechnicalSettlementError: true,
      technicalSettlementError: failFailure.error,
    },
  );
}

export class JobWorkerBridge {
  private readonly queueName: string;

  constructor(
    private readonly runtime: IPgBossRuntime,
    private readonly jobStore: DurableJobStore,
    private readonly claimStore: JobClaimStore,
    private readonly options: WorkerBridgeOptions,
  ) {
    assertWorkerId(options.workerId);
    assertLeaseDurationMs(options.leaseDurationMs);
    this.queueName = options.queueName ?? PG_BOSS_DEFAULT_WAKEUP_QUEUE;
  }

  /**
   * Processa no máximo UMA delivery de wake-up da fila.
   * Não executa loop, timer ou scheduler.
   */
  async processNext(callback: JobWakeupCallback): Promise<WorkerBridgeProcessResult> {
    // 1. Fetch de no máximo uma mensagem
    const messages = await this.runtime.fetchWakeup(this.queueName, 1);
    if (!messages || messages.length === 0) {
      return Object.freeze({ outcome: 'idle' });
    }

    const message = messages[0];
    const { jobId } = message.data;
    const target: PgBossDeliveryAttemptRef = {
      id: message.id,
      retryCount: message.retryCount,
    };

    // 2. Reidratação do Job canônico a partir do DurableJobStore
    const job = await this.jobStore.rehydrateJob(jobId);

    // 3. Caso o Job não exista (wake-up órfão)
    if (!job) {
      const settlement = await this.runtime.completeWakeup(this.queueName, target);
      if (!settlement.settled) {
        return Object.freeze({
          outcome: 'technical_stale',
          jobId,
          deliveryId: message.id,
          retryCount: message.retryCount,
        });
      }
      return Object.freeze({
        outcome: 'orphaned',
        jobId,
        deliveryId: message.id,
        retryCount: message.retryCount,
      });
    }

    // 4. Aquisição de claim operacional canônico NEX
    const claimResult = await this.claimStore.acquireClaim({
      jobId,
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
    });

    // 5. Caso o claim esteja mantido por outro worker ativo (held)
    if (!claimResult.acquired) {
      const settlement = await this.runtime.completeWakeup(this.queueName, target);
      if (!settlement.settled) {
        return Object.freeze({
          outcome: 'technical_stale',
          jobId,
          deliveryId: message.id,
          retryCount: message.retryCount,
        });
      }
      return Object.freeze({
        outcome: 'held',
        jobId,
        deliveryId: message.id,
        retryCount: message.retryCount,
      });
    }

    // 6. Claim adquirido com sucesso: executar callback do consumidor
    const claim = claimResult.claim;

    try {
      await callback({
        job: Object.freeze(job),
        claim: Object.freeze(claim),
      });
    } catch (callbackErr) {
      // Falha do callback:
      // A. Tentar liberar o claim canônico com a referência exata
      let releaseFailure: BridgeCapturedFailure = { hasError: false };
      try {
        await this.claimStore.releaseClaim({
          jobId,
          workerId: this.options.workerId,
          fencingToken: claim.fencingToken,
        });
      } catch (err) {
        releaseFailure = { hasError: true, error: err };
      }

      // B. Executar failWakeup fenced da tentativa técnica atual
      let settlementFailure: BridgeCapturedFailure = { hasError: false };
      try {
        const settlement = await this.runtime.failWakeup(this.queueName, target);
        if (!settlement.settled) {
          settlementFailure = {
            hasError: true,
            error: new WorkerBridgeTechnicalStaleError({
              deliveryId: message.id,
              retryCount: message.retryCount,
              queueName: this.queueName,
            }),
          };
        }
      } catch (err) {
        settlementFailure = { hasError: true, error: err };
      }

      // C. Propagar erro preservando falhas secundárias
      throw composeBridgeCallbackError(callbackErr, releaseFailure, settlementFailure);
    }

    // 7. Sucesso do callback: liberar o claim canônico
    try {
      await this.claimStore.releaseClaim({
        jobId,
        workerId: this.options.workerId,
        fencingToken: claim.fencingToken,
      });
    } catch (releaseErr) {
      // Se release falhar (expirou / fence stale), o worker não tem mais autoridade
      // Executa failWakeup técnico fenced se possível e propaga o erro
      let settlementFailure: BridgeCapturedFailure = { hasError: false };
      try {
        const settlement = await this.runtime.failWakeup(this.queueName, target);
        if (!settlement.settled) {
          settlementFailure = {
            hasError: true,
            error: new WorkerBridgeTechnicalStaleError({
              deliveryId: message.id,
              retryCount: message.retryCount,
              queueName: this.queueName,
            }),
          };
        }
      } catch (err) {
        settlementFailure = { hasError: true, error: err };
      }
      throw composeBridgeReleaseError(releaseErr, settlementFailure);
    }

    // 8. Se release passou: completar a delivery técnica fenced no pg-boss
    const settlement = await this.runtime.completeWakeup(this.queueName, target);
    if (!settlement.settled) {
      return Object.freeze({
        outcome: 'technical_stale',
        jobId,
        deliveryId: message.id,
        retryCount: message.retryCount,
        fencingToken: claim.fencingToken,
      });
    }

    return Object.freeze({
      outcome: 'processed',
      jobId,
      deliveryId: message.id,
      retryCount: message.retryCount,
      fencingToken: claim.fencingToken,
    });
  }
}
