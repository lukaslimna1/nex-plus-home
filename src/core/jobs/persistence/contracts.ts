/**
 * NEX+ · Job Lifecycle Core
 * Porta Assíncrona de Persistência — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2B)
 *
 * Plano de Autoridade (L0).
 * Interface assíncrona para persistência durável no PostgreSQL, preservando
 * a semântica canônica do Job Lifecycle (Job != Attempt) e garantindo
 * reidratação exata pós-queda/restart.
 */

import type {
  JobId,
  JobState,
  JobEvent,
  JobEventType,
  CreateJobParams,
} from '../contracts';

export type JobRecordKind = 'created' | 'transition';

export interface JobStoredRecord {
  readonly jobId: JobId;
  readonly revision: number;
  readonly recordKind: JobRecordKind;
  readonly eventType?: JobEventType;
  readonly occurredAt: string; // ISO 8601 UTC
  readonly payload: Readonly<Record<string, unknown>>;
  readonly appendSequence: string;
}

export interface PgQueryConfig {
  text: string;
  values?: unknown[];
  queryMode?: 'extended';
}

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgExecutor {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  query<T = any>(config: PgQueryConfig): Promise<PgQueryResult<T>>;
}

export interface PgTransactionalClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  query<T = any>(config: PgQueryConfig): Promise<PgQueryResult<T>>;
  release(): void;
}

export interface PgTransactionalExecutor extends PgExecutor {
  connect(): Promise<PgTransactionalClient>;
}

export interface DurableJobStore {
  /**
   * Cria um Job de forma durável na revision 1 em estado 'queued'.
   * Grava atomicamente o registro de criação em nex_job_events e a projeção operacional em nex_job_heads.
   * Lança DuplicateJobIdError se o jobId já existir.
   */
  createJob(params: CreateJobParams): Promise<JobState>;

  /**
   * Obtém a projeção operacional atual do Job a partir de nex_job_heads com validação defensiva estrita.
   * Retorna undefined se o Job não existir.
   */
  getJob(jobId: JobId): Promise<JobState | undefined>;

  /**
   * Aplica um JobEvent sob concorrência otimista (exigindo expectedRevision).
   * Bloqueia o head com SELECT FOR UPDATE, executa reduceJob puro do Core,
   * insere a nova revisão em nex_job_events e atualiza o head atomicamente.
   */
  applyJobEvent(event: JobEvent, expectedRevision: number): Promise<JobState>;

  /**
   * Lista o histórico ordenado por revision ascendente de todas as revisões persistidas do Job.
   */
  listJobEvents(jobId: JobId): Promise<readonly JobStoredRecord[]>;

  /**
   * Executa replay completo e explícito desde a revision 1 reconstruindo cada transição
   * e validando equivalência estrita contra o head persistido.
   * Retorna undefined se o Job não existir.
   * Falha fechado com CorruptedJobStorageError ou JobRehydrationDivergenceError em caso de anomalia.
   */
  rehydrateJob(jobId: JobId): Promise<JobState | undefined>;
}
