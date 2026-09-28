/**
 * NEX+ · Job Runtime Boundary & Provider Contracts
 * Contratos Canônicos — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Princípios Fundamentais:
 * 1. pg-boss NÃO é autoridade canônica de Job (autoridade continua no NEX Job Lifecycle + DurableJobStore).
 * 2. A fila de wake-up atua estritamente como infraestrutura de delivery/notificação de trabalho.
 * 3. O payload canônico de wake-up transporta EXCLUSIVAMENTE { jobId }.
 * 4. NENHUM estado de execução, credencial, token, ator, sessão ou contexto é transmitido pela fila.
 * 5. Configuração congelada: schema 'pgboss', backend 'postgres', migrate: false, useListenNotify: false.
 */

import type { JobId } from '../contracts';

// ============================================================================
// 1. CONSTANTES CONGELADAS DO PROVIDER
// ============================================================================

export const PG_BOSS_CANONICAL_SCHEMA = 'pgboss' as const;
export const PG_BOSS_EXPECTED_SCHEMA_VERSION = 42 as const;
export const PG_BOSS_DEFAULT_WAKEUP_QUEUE = 'nex_job_wakeup' as const;
export const PG_BOSS_DEFAULT_BACKEND = 'postgres' as const;

// ============================================================================
// 2. PAYLOAD CANÔNICO DE WAKE-UP
// ============================================================================

/**
 * Contrato canônico estrito para wake-up de Job.
 * Transporta única e exclusivamente o identificador do Job.
 * Qualquer propriedade adicional é estritamente proibida e rejeitada em tempo de validação.
 */
export interface JobWakeupPayload {
  readonly jobId: string;
}

// ============================================================================
// 3. CONFIGURAÇÕES DO RUNTIME DO PROVIDER
// ============================================================================

export interface PgBossRuntimeOptions {
  readonly connectionString: string;
  readonly schema?: string;
}

export interface PgBossRuntimeConfig {
  readonly connectionString: string;
  readonly schema: string;
  readonly backend: 'postgres';
  readonly migrate: false;
  readonly useListenNotify: false;
}

// ============================================================================
// 4. MENSAGEM RECUPERADA & RESULTADOS TÉCNICOS
// ============================================================================

export interface PgBossWakeupMessage {
  readonly id: string;
  readonly name: string;
  readonly data: JobWakeupPayload;
}

export interface PgBossSendResult {
  readonly messageId: string | null;
}

export interface PgBossProvisioningResult {
  readonly success: boolean;
  readonly schema: string;
  readonly schemaVersion: number | null;
  readonly driftOk: boolean;
}

// ============================================================================
// 5. INTERFACE DO RUNTIME BOUNDARY (ISOLAMENTO DO CORE)
// ============================================================================

export interface IPgBossRuntime {
  readonly isStarted: boolean;
  readonly config: Readonly<PgBossRuntimeConfig>;
  start(): Promise<void>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  createQueue(queueName: string): Promise<void>;
  sendWakeup(queueName: string, payload: JobWakeupPayload): Promise<PgBossSendResult>;
  fetchWakeup(queueName: string, batchSize?: number): Promise<readonly PgBossWakeupMessage[]>;
  completeJob(queueName: string, messageId: string): Promise<void>;
  getSchemaVersion(): Promise<number | null>;
  detectDrift(): Promise<{ ok: boolean }>;
}
