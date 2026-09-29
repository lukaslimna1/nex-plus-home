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
 * Erro composto do WorkerBridge para preservar falha primária juntamente com
 * falhas secundárias de release e settlement técnico (P-M2 pattern).
 */
export class WorkerBridgeError extends Error {
  readonly primaryError: unknown;
  readonly releaseError?: unknown;
  readonly technicalSettlementError?: unknown;

  constructor(
    message: string,
    options: {
      primaryError: unknown;
      releaseError?: unknown;
      technicalSettlementError?: unknown;
    },
  ) {
    const causes: unknown[] = [options.primaryError];
    if (options.releaseError) causes.push(options.releaseError);
    if (options.technicalSettlementError) causes.push(options.technicalSettlementError);

    const cause =
      typeof AggregateError !== 'undefined' && causes.length > 1
        ? new AggregateError(causes, message)
        : options.primaryError;

    super(message, { cause });
    this.name = 'WorkerBridgeError';
    this.primaryError = options.primaryError;
    this.releaseError = options.releaseError;
    this.technicalSettlementError = options.technicalSettlementError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function composeBridgeCallbackError(
  callbackError: unknown,
  releaseError?: unknown,
  failError?: unknown,
): Error {
  if (!releaseError && !failError) {
    if (callbackError instanceof Error) return callbackError;
    return new Error(String(callbackError));
  }

  const primaryMsg = callbackError instanceof Error ? callbackError.message : String(callbackError);
  const releaseMsg = releaseError
    ? ` (release error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)})`
    : '';
  const failMsg = failError
    ? ` (failWakeup error: ${failError instanceof Error ? failError.message : String(failError)})`
    : '';

  return new WorkerBridgeError(
    `[WorkerBridge] Callback failure: ${primaryMsg}${releaseMsg}${failMsg}`,
    {
      primaryError: callbackError,
      releaseError,
      technicalSettlementError: failError,
    },
  );
}

export function composeBridgeReleaseError(
  releaseError: unknown,
  failError?: unknown,
): Error {
  if (!failError) {
    if (releaseError instanceof Error) return releaseError;
    return new Error(String(releaseError));
  }

  const releaseMsg = releaseError instanceof Error ? releaseError.message : String(releaseError);
  const failMsg = ` (failWakeup error: ${failError instanceof Error ? failError.message : String(failError)})`;

  return new WorkerBridgeError(
    `[WorkerBridge] Canonical release failed: ${releaseMsg}${failMsg}`,
    {
      primaryError: releaseError,
      technicalSettlementError: failError,
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
      let releaseErr: unknown;
      try {
        await this.claimStore.releaseClaim({
          jobId,
          workerId: this.options.workerId,
          fencingToken: claim.fencingToken,
        });
      } catch (err) {
        releaseErr = err;
      }

      // B. Executar failWakeup fenced da tentativa técnica atual
      let failErr: unknown;
      try {
        await this.runtime.failWakeup(this.queueName, target);
      } catch (err) {
        failErr = err;
      }

      // C. Propagar erro preservando falhas secundárias
      throw composeBridgeCallbackError(callbackErr, releaseErr, failErr);
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
      let failErr: unknown;
      try {
        await this.runtime.failWakeup(this.queueName, target);
      } catch (err) {
        failErr = err;
      }
      throw composeBridgeReleaseError(releaseErr, failErr);
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
