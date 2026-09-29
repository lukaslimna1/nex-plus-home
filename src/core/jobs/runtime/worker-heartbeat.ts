/**
 * NEX+ · Worker Heartbeat Controller
 * Keepalive Operacional Dual (Claim NEX + pg-boss Technical Touch) — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3D)
 *
 * Princípios Fundamentais:
 * 1. O keepalive opera estritamente durante o ciclo de vida do callback de processamento.
 * 2. Ordem estrita e invariável em cada tick: renewClaim (NEX) ANTES de touchWakeup (pg-boss).
 * 3. Se perder autoridade (canonical stale, technical stale ou touch failure): aborta cooperativamente
 *    o signal via AbortController e interrompe ticks subsequentes.
 * 4. Execução estritamente serial: nunca sobrepõe heartbeats (inFlightCount no máximo 1).
 * 5. Parada limpa e garantida (stop): impede novos agendamentos e aguarda tick in-flight antes de retornar.
 * 6. Zero timers residuais: nenhum setTimeout permanece ativo após stop().
 */

import type { JobClaimStore } from '../claims/contracts';
import { JobClaimStaleError } from '../claims/errors';
import type { IPgBossRuntime } from './contracts';

export type WorkerBridgeAuthorityLostReason =
  | 'canonical_claim_stale'
  | 'technical_attempt_stale'
  | 'technical_heartbeat_failure';

export interface WorkerBridgeAuthorityLostErrorOptions {
  readonly reason: WorkerBridgeAuthorityLostReason;
  readonly message: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly deliveryId: string;
  readonly retryCount: number;
  readonly fencingToken?: string;
  readonly cause?: unknown;
}

/**
 * Erro estruturado emitido quando um worker perde autoridade operacional durante a execução.
 * Distingue explicitamente se a perda foi por claim canônico stale, attempt técnica stale
 * ou falha operacional de heartbeat técnico.
 */
export class WorkerBridgeAuthorityLostError extends Error {
  readonly reason: WorkerBridgeAuthorityLostReason;
  readonly jobId: string;
  readonly workerId: string;
  readonly deliveryId: string;
  readonly retryCount: number;
  readonly fencingToken?: string;

  constructor(options: WorkerBridgeAuthorityLostErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'WorkerBridgeAuthorityLostError';
    this.reason = options.reason;
    this.jobId = options.jobId;
    this.workerId = options.workerId;
    this.deliveryId = options.deliveryId;
    this.retryCount = options.retryCount;
    this.fencingToken = options.fencingToken;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface WorkerHeartbeatOptions {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string;
  readonly deliveryId: string;
  readonly retryCount: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly queueName: string;
  readonly claimStore: JobClaimStore;
  readonly runtime: IPgBossRuntime;
  readonly abortController?: AbortController;
}

export class WorkerHeartbeatController {
  private readonly _abortController: AbortController;
  private _started = false;
  private _stopped = false;
  private _inFlightPromise: Promise<void> | null = null;
  private _timerHandle: NodeJS.Timeout | null = null;
  private _authorityLostError: WorkerBridgeAuthorityLostError | null = null;
  private _authorityLost = false;
  private _ticksCompleted = 0;

  constructor(private readonly options: WorkerHeartbeatOptions) {
    this._abortController = options.abortController ?? new AbortController();
  }

  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  get isStarted(): boolean {
    return this._started;
  }

  get isStopped(): boolean {
    return this._stopped;
  }

  get isAuthorityLost(): boolean {
    return this._authorityLost;
  }

  get authorityLostError(): WorkerBridgeAuthorityLostError | null {
    return this._authorityLostError;
  }

  get inFlightCount(): number {
    return this._inFlightPromise !== null ? 1 : 0;
  }

  get ticksCompleted(): number {
    return this._ticksCompleted;
  }

  /**
   * Inicia o keepalive agendando o primeiro tick após heartbeatIntervalMs.
   * É estritamente idempotente (F-3D-HB-START-01): chamadas subsequentes enquanto
   * já iniciado são no-ops, evitando timers duplicados ou sobreposição de heartbeats.
   */
  start(): void {
    if (this._started || this._stopped || this._authorityLost) {
      return;
    }
    this._started = true;
    this._timerHandle = setTimeout(() => {
      void this._runTick();
    }, this.options.heartbeatIntervalMs);
  }

  /**
   * Encerramento limpo e seguro do keepalive (0.86C-3D):
   * 1. Impede novos ticks de serem agendados;
   * 2. Cancela qualquer timer pendente imediatamente (zero timers residuais);
   * 3. Aguarda tick que já esteja in-flight para evitar concorrência com release/complete;
   * 4. Retorna autoridade perdida se tiver ocorrido durante a execução.
   */
  async stop(): Promise<WorkerBridgeAuthorityLostError | null> {
    this._stopped = true;
    this._started = false;
    if (this._timerHandle !== null) {
      clearTimeout(this._timerHandle);
      this._timerHandle = null;
    }
    if (this._inFlightPromise !== null) {
      await this._inFlightPromise;
    }
    return this._authorityLostError;
  }

  /**
   * Execução serial de um tick de keepalive.
   * Ordem estrita: renewClaim (NEX) ANTES de touchWakeup (pg-boss).
   */
  private async _runTick(): Promise<void> {
    if (this._stopped || this._authorityLost) {
      return;
    }

    this._timerHandle = null;

    this._inFlightPromise = (async () => {
      // 1. RENOVAÇÃO DO CLAIM CANÔNICO NEX (AUTORIDADE PRIMÁRIA)
      try {
        await this.options.claimStore.renewClaim({
          jobId: this.options.jobId,
          workerId: this.options.workerId,
          fencingToken: this.options.fencingToken,
          leaseDurationMs: this.options.leaseDurationMs,
        });
      } catch (err) {
        this._handleAuthorityLoss(
          'canonical_claim_stale',
          `[WorkerHeartbeat] Canonical claim renewal failed for Job '${this.options.jobId}' (worker '${this.options.workerId}', fence '${this.options.fencingToken}'): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
        return;
      }

      // Se o controlador foi parado enquanto renewClaim estava executando
      if (this._stopped) {
        return;
      }

      // 2. TOUCH TÉCNICO FENCED NO PG-BOSS (AUTORIDADE TÉCNICA SECUNDÁRIA)
      try {
        const settlement = await this.options.runtime.touchWakeup(this.options.queueName, {
          id: this.options.deliveryId,
          retryCount: this.options.retryCount,
        });

        if (!settlement.settled || settlement.affected === 0) {
          this._handleAuthorityLoss(
            'technical_attempt_stale',
            `[WorkerHeartbeat] Technical attempt is stale on queue '${this.options.queueName}' (deliveryId: '${this.options.deliveryId}', retryCount: ${this.options.retryCount}): touch returned affected=0.`,
          );
          return;
        }
      } catch (err) {
        this._handleAuthorityLoss(
          'technical_heartbeat_failure',
          `[WorkerHeartbeat] Technical touch failed on queue '${this.options.queueName}' (deliveryId: '${this.options.deliveryId}', retryCount: ${this.options.retryCount}): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
        return;
      }

      this._ticksCompleted++;

      // 3. AGENDAMENTO RECURSIVO DO PRÓXIMO TICK (SERIAL, NUNCA SOBREPOSTO)
      if (!this._stopped && !this._authorityLost) {
        this._timerHandle = setTimeout(() => {
          void this._runTick();
        }, this.options.heartbeatIntervalMs);
      }
    })();

    try {
      await this._inFlightPromise;
    } finally {
      this._inFlightPromise = null;
    }
  }

  private _handleAuthorityLoss(
    reason: WorkerBridgeAuthorityLostReason,
    message: string,
    cause?: unknown,
  ): void {
    if (this._authorityLost) {
      return;
    }
    this._authorityLost = true;
    this._authorityLostError = new WorkerBridgeAuthorityLostError({
      reason,
      message,
      jobId: this.options.jobId,
      workerId: this.options.workerId,
      deliveryId: this.options.deliveryId,
      retryCount: this.options.retryCount,
      fencingToken: this.options.fencingToken,
      cause,
    });

    if (!this._abortController.signal.aborted) {
      this._abortController.abort(this._authorityLostError);
    }
  }
}
