/**
 * NEX+ · Single-Delivery Worker Bridge
 * Ponte entre Notificação Técnica (pg-boss) e Execução Canônica (JobStore + Claims) — Escopo 0.86 (Bloco 0.86C · Checkpoints 0.86C-3C & 0.86C-3D)
 *
 * Princípios Fundamentais:
 * 1. Single-delivery unitário: processNext() processa no máximo UMA mensagem sem timers ou loops contínuos.
 * 2. Ordem estrita e invariável: fetch → rehydrate → claim → heartbeat start → callback → heartbeat stop → release → complete.
 * 3. Fila subordinada: se Job não existe, liquida attempt técnico e marca 'orphaned' sem chamar callback nem keepalive.
 * 4. Fencing token: se claim held, liquida delivery técnica e marca 'held' sem chamar callback nem keepalive.
 * 5. Callback orchestration-only: curto, idempotente, sem side effects materiais nem criação de Attempt NEX.
 * 6. Dual Keepalive: renova claim canônico (NEX) antes de touch técnico (pg-boss) enquanto o callback está em voo.
 * 7. Authority Loss: se perder claim canônico ou attempt técnico, aborta cooperativamente o signal e impede success settlement.
 * 8. Preservação estruturada de erros primários e falhas secundárias de cleanup (sem engolir exceções).
 */

import type { JobState } from '../contracts';
import type { DurableJobStore } from '../persistence/contracts';
import type { JobClaimStore, JobClaimSnapshot } from '../claims/contracts';
import { assertWorkerId, assertLeaseDurationMs } from '../claims/invariants';
import {
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  PG_BOSS_WAKEUP_HEARTBEAT_SECONDS,
  type IPgBossRuntime,
  type PgBossDeliveryAttemptRef,
} from './contracts';
import {
  WorkerHeartbeatController,
  WorkerBridgeAuthorityLostError,
  type WorkerBridgeAuthorityLostReason,
} from './worker-heartbeat';

export {
  WorkerHeartbeatController,
  WorkerBridgeAuthorityLostError,
  type WorkerBridgeAuthorityLostReason,
};

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
  readonly signal: AbortSignal;
}

export type JobWakeupCallback = (context: WorkerBridgeCallbackContext) => Promise<void>;

export interface WorkerBridgeOptions {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly queueName?: string;
}

/**
 * Erro de invariante do Worker Bridge (0.86C-3D).
 */
export class WorkerBridgeInvariantsError extends Error {
  constructor(message: string) {
    super(`[WorkerBridge] Invariant violation: ${message}`);
    this.name = 'WorkerBridgeInvariantsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validação defensiva fail-closed do intervalo de heartbeat (0.86C-3D):
 * 1. Deve ser inteiro, finito e > 0;
 * 2. heartbeatIntervalMs <= floor(leaseDurationMs / 2) (margem operacional para renovar antes da expiração da lease);
 * 3. heartbeatIntervalMs <= 30000 ms (metade do PG_BOSS_WAKEUP_HEARTBEAT_SECONDS = 60s).
 */
export function assertHeartbeatIntervalMs(
  heartbeatIntervalMs: unknown,
  leaseDurationMs: number,
): asserts heartbeatIntervalMs is number {
  if (
    typeof heartbeatIntervalMs !== 'number' ||
    !Number.isFinite(heartbeatIntervalMs) ||
    !Number.isInteger(heartbeatIntervalMs) ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0
  ) {
    throw new WorkerBridgeInvariantsError(
      `heartbeatIntervalMs must be a positive finite integer > 0, received: ${String(heartbeatIntervalMs)}`,
    );
  }

  const maxAllowedByLease = Math.floor(leaseDurationMs / 2);
  if (heartbeatIntervalMs > maxAllowedByLease) {
    throw new WorkerBridgeInvariantsError(
      `heartbeatIntervalMs (${heartbeatIntervalMs}) must be <= floor(leaseDurationMs / 2) (${maxAllowedByLease}).`,
    );
  }

  const maxAllowedByPgBoss = Math.floor((PG_BOSS_WAKEUP_HEARTBEAT_SECONDS * 1000) / 2); // 30000 ms
  if (heartbeatIntervalMs > maxAllowedByPgBoss) {
    throw new WorkerBridgeInvariantsError(
      `heartbeatIntervalMs (${heartbeatIntervalMs}) must be <= ${maxAllowedByPgBoss} ms (half of PG_BOSS_WAKEUP_HEARTBEAT_SECONDS).`,
    );
  }
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
  readonly hasCallbackError?: boolean;
  readonly callbackError?: unknown;
}

/**
 * Erro composto do WorkerBridge para preservar falha primária juntamente com
 * falhas secundárias de release, settlement técnico ou callback (P-M2 pattern / F-3C-02 / F-3C-03 / 0.86C-3D).
 */
export class WorkerBridgeError extends Error {
  readonly primaryError: unknown;
  readonly hasReleaseError: boolean;
  readonly releaseError?: unknown;
  readonly hasTechnicalSettlementError: boolean;
  readonly technicalSettlementError?: unknown;
  readonly hasCallbackError: boolean;
  readonly callbackError?: unknown;

  constructor(message: string, options: WorkerBridgeErrorOptions) {
    const causes: unknown[] = [options.primaryError];
    const hasCallback =
      options.hasCallbackError ??
      ('callbackError' in options && options.callbackError !== undefined);
    const hasRelease =
      options.hasReleaseError ??
      ('releaseError' in options && options.releaseError !== undefined);
    const hasTech =
      options.hasTechnicalSettlementError ??
      ('technicalSettlementError' in options && options.technicalSettlementError !== undefined);

    if (hasCallback) causes.push(options.callbackError);
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
    this.hasCallbackError = hasCallback;
    this.callbackError = options.callbackError;
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

export function composeBridgeAuthorityLossError(
  authorityError: WorkerBridgeAuthorityLostError,
  options?: {
    hasCallbackError?: boolean;
    callbackError?: unknown;
    hasReleaseError?: boolean;
    releaseError?: unknown;
    hasTechnicalSettlementError?: boolean;
    technicalSettlementError?: unknown;
  },
): Error {
  const hasCallback = options?.hasCallbackError ?? false;
  const hasRelease = options?.hasReleaseError ?? false;
  const hasTech = options?.hasTechnicalSettlementError ?? false;

  const cbMsg = hasCallback ? ` (callback error: ${formatErrorDetail(options?.callbackError)})` : '';
  const relMsg = hasRelease ? ` (release error: ${formatErrorDetail(options?.releaseError)})` : '';
  const techMsg = hasTech ? ` (failWakeup error: ${formatErrorDetail(options?.technicalSettlementError)})` : '';

  return new WorkerBridgeError(
    `[WorkerBridge] Authority lost: ${formatErrorDetail(authorityError)}${cbMsg}${relMsg}${techMsg}`,
    {
      primaryError: authorityError,
      hasCallbackError: hasCallback,
      callbackError: options?.callbackError,
      hasReleaseError: hasRelease,
      releaseError: options?.releaseError,
      hasTechnicalSettlementError: hasTech,
      technicalSettlementError: options?.technicalSettlementError,
    },
  );
}

export class JobWorkerBridge {
  private readonly queueName: string;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly runtime: IPgBossRuntime,
    private readonly jobStore: DurableJobStore,
    private readonly claimStore: JobClaimStore,
    private readonly options: WorkerBridgeOptions,
  ) {
    assertWorkerId(options.workerId);
    assertLeaseDurationMs(options.leaseDurationMs);
    assertHeartbeatIntervalMs(options.heartbeatIntervalMs, options.leaseDurationMs);
    this.queueName = options.queueName ?? PG_BOSS_DEFAULT_WAKEUP_QUEUE;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
  }

  /**
   * Processa no máximo UMA delivery de wake-up da fila (0.86C-3C & 0.86C-3D).
   * Não executa loop, daemon ou scheduler contínuo.
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

    // 3. Caso o Job não exista (wake-up órfão) — nunca inicia keepalive
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

    // 5. Caso o claim esteja mantido por outro worker ativo (held) — nunca inicia keepalive
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

    // 6. Claim adquirido com sucesso: preparar AbortController e keepalive
    const claim = claimResult.claim;
    const abortController = new AbortController();

    const heartbeat = new WorkerHeartbeatController({
      jobId,
      workerId: this.options.workerId,
      fencingToken: claim.fencingToken,
      deliveryId: message.id,
      retryCount: message.retryCount,
      leaseDurationMs: this.options.leaseDurationMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      queueName: this.queueName,
      claimStore: this.claimStore,
      runtime: this.runtime,
      abortController,
    });

    // Inicia keepalive após aquisição de claim (0.86C-3D)
    heartbeat.start();

    let callbackError: unknown = undefined;
    let hasCallbackError = false;

    try {
      await callback({
        job: Object.freeze(job),
        claim: Object.freeze(claim),
        signal: abortController.signal,
      });
    } catch (cbErr) {
      hasCallbackError = true;
      callbackError = cbErr;
    }

    // 7. Parada obrigatória do keepalive ANTES de qualquer release ou settlement (0.86C-3D):
    // Impede novos ticks e aguarda qualquer tick que já esteja in-flight
    const authorityError = await heartbeat.stop();

    // 8. CENÁRIO A: PERDA DE AUTORIDADE DURANTE A EXECUÇÃO (0.86C-3D)
    if (authorityError) {
      if (authorityError.reason === 'canonical_claim_stale') {
        // Claim canônico perdido (stale):
        // NÃO tentar release (o claim já não é nosso / expirou / foi re-adquirido)
        // NÃO complete como sucesso
        // Tentar failWakeup fenced se aplicável
        let technicalSettlementError: unknown = undefined;
        let hasTechnicalSettlementError = false;
        try {
          const settlement = await this.runtime.failWakeup(this.queueName, target);
          if (!settlement.settled) {
            hasTechnicalSettlementError = true;
            technicalSettlementError = new WorkerBridgeTechnicalStaleError({
              deliveryId: message.id,
              retryCount: message.retryCount,
              queueName: this.queueName,
            });
          }
        } catch (fErr) {
          hasTechnicalSettlementError = true;
          technicalSettlementError = fErr;
        }

        throw composeBridgeAuthorityLossError(authorityError, {
          hasCallbackError,
          callbackError,
          hasReleaseError: false,
          hasTechnicalSettlementError,
          technicalSettlementError,
        });
      }

      if (authorityError.reason === 'technical_attempt_stale') {
        // Attempt técnica do pg-boss ficou stale (affected=0 no touch):
        // Liberar claim canônico com fence exata se ainda válido
        // NÃO complete
        // NÃO fail attempt nova (tentativa técnica já está stale/avançou)
        let releaseError: unknown = undefined;
        let hasReleaseError = false;
        try {
          await this.claimStore.releaseClaim({
            jobId,
            workerId: this.options.workerId,
            fencingToken: claim.fencingToken,
          });
        } catch (rErr) {
          hasReleaseError = true;
          releaseError = rErr;
        }

        throw composeBridgeAuthorityLossError(authorityError, {
          hasCallbackError,
          callbackError,
          hasReleaseError,
          releaseError,
          hasTechnicalSettlementError: false,
        });
      }

      // technical_heartbeat_failure (erro operacional no touch):
      // Preservar erro, liberar claim canônico se ainda válido, tentar failWakeup fenced
      let releaseError: unknown = undefined;
      let hasReleaseError = false;
      try {
        await this.claimStore.releaseClaim({
          jobId,
          workerId: this.options.workerId,
          fencingToken: claim.fencingToken,
        });
      } catch (rErr) {
        hasReleaseError = true;
        releaseError = rErr;
      }

      let technicalSettlementError: unknown = undefined;
      let hasTechnicalSettlementError = false;
      try {
        const settlement = await this.runtime.failWakeup(this.queueName, target);
        if (!settlement.settled) {
          hasTechnicalSettlementError = true;
          technicalSettlementError = new WorkerBridgeTechnicalStaleError({
            deliveryId: message.id,
            retryCount: message.retryCount,
            queueName: this.queueName,
          });
        }
      } catch (fErr) {
        hasTechnicalSettlementError = true;
        technicalSettlementError = fErr;
      }

      throw composeBridgeAuthorityLossError(authorityError, {
        hasCallbackError,
        callbackError,
        hasReleaseError,
        releaseError,
        hasTechnicalSettlementError,
        technicalSettlementError,
      });
    }

    // 9. CENÁRIO B: AUTORIDADE MANTIDA, MAS CALLBACK LANÇOU ERRO
    if (hasCallbackError) {
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

      throw composeBridgeCallbackError(callbackError, releaseFailure, settlementFailure);
    }

    // 10. CENÁRIO C: AUTORIDADE MANTIDA E CALLBACK COM SUCESSO
    // Release do claim canônico
    try {
      await this.claimStore.releaseClaim({
        jobId,
        workerId: this.options.workerId,
        fencingToken: claim.fencingToken,
      });
    } catch (releaseErr) {
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

    // Liquidação com completeWakeup fenced no provider
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
