/**
 * NEX+ · Job Lifecycle Core
 * Adaptador PostgreSQL para Durable Job Store — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2B)
 *
 * Plano de Autoridade (L0).
 * Persistência durável e reidratável do JobState canônico sobre PostgreSQL.
 * Transacional, fail-closed, concorrência otimista via SELECT FOR UPDATE,
 * e autoridade semântica exclusiva delegada ao createJob e reduceJob do Core.
 */

import type {
  JobId,
  JobState,
  JobEvent,
  CreateJobParams,
} from '../contracts';
import { createJob, reduceJob } from '../lifecycle';
import type {
  DurableJobStore,
  JobStoredRecord,
  PgTransactionalClient,
  PgTransactionalExecutor,
} from './contracts';
import {
  DuplicateJobIdError,
  JobNotFoundError,
  JobRevisionConflictError,
  CorruptedJobStorageError,
} from './errors';
import {
  serializeCreateJobParams,
  serializeCreationParamsFromJobState,
  serializeJobEvent,
  serializeJobState,
  extractEventOccurredAt,
  mapRowToJobState,
  mapRowToStoredRecord,
  mapStoredRecordToCreateJobParams,
  mapStoredRecordToJobEvent,
  assertJobStatesEquivalent,
} from './serialization';

/**
 * Façade de banco de dados estritamente delimitada ao escopo transacional (0.86C-3C / F-3C-01).
 * Não expõe handles de conexão, release, end nem operações de controle transacional.
 */
export interface PostgresTransactionDb {
  executeSql(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Escopo transacional seguro exposto pelo PostgresJobStore (0.86C-3C).
 * Permite coordenar escrita no JobStore e enfileiramento na MESMA transação PostgreSQL.
 * O PostgresJobStore é o ÚNICO owner de BEGIN, COMMIT, ROLLBACK e release da conexão.
 */
export interface PostgresJobStoreWriteTransactionScope {
  createJob(params: CreateJobParams): Promise<JobState>;
  applyJobEvent(event: JobEvent, expectedRevision: number): Promise<JobState>;
  readonly transactionDb: PostgresTransactionDb;
}

/**
 * Validação fail-closed que proíbe comandos de controle transacional na transactionDb façade (F-3C-01).
 * Garante que o consumidor do seam não execute COMMIT, ROLLBACK, BEGIN, SAVEPOINT, etc.,
 * preservando a autoridade transacional exclusiva do PostgresJobStore.
 */
export function assertNoTransactionControlSql(sql: string): void {
  if (typeof sql !== 'string') {
    throw new Error('[PostgresJobStore] SQL command must be a string.');
  }

  // Remove espaços em branco e comentários SQL no início (-- e /* ... */)
  let cleaned = sql.trim();
  while (cleaned.startsWith('--') || cleaned.startsWith('/*')) {
    if (cleaned.startsWith('--')) {
      const newlineIdx = cleaned.indexOf('\n');
      if (newlineIdx === -1) {
        cleaned = '';
        break;
      }
      cleaned = cleaned.slice(newlineIdx + 1).trim();
    } else if (cleaned.startsWith('/*')) {
      const closeIdx = cleaned.indexOf('*/');
      if (closeIdx === -1) {
        throw new Error('[PostgresJobStore] Malformed SQL: unclosed comment block.');
      }
      cleaned = cleaned.slice(closeIdx + 2).trim();
    }
  }

  if (cleaned.length === 0) {
    return;
  }

  const match = cleaned.match(/^([A-Za-z_]+)(?:\s+([A-Za-z_]+))?/);
  if (!match) {
    return;
  }

  const firstToken = match[1].toUpperCase();
  const secondToken = match[2] ? match[2].toUpperCase() : '';

  const forbiddenFirstTokens = new Set([
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'END',
    'ABORT',
    'SAVEPOINT',
  ]);

  if (forbiddenFirstTokens.has(firstToken)) {
    throw new Error(
      `[PostgresJobStore] Transaction control statement '${firstToken}' is prohibited in transactionDb façade. Transaction boundary is owned exclusively by JobStore.`,
    );
  }

  if (firstToken === 'START') {
    throw new Error(
      `[PostgresJobStore] Transaction control statement 'START${secondToken ? ' ' + secondToken : ''}' is prohibited in transactionDb façade. Transaction boundary is owned exclusively by JobStore.`,
    );
  }

  if (firstToken === 'RELEASE') {
    throw new Error(
      `[PostgresJobStore] Transaction control statement 'RELEASE${secondToken ? ' ' + secondToken : ''}' is prohibited in transactionDb façade. Transaction boundary is owned exclusively by JobStore.`,
    );
  }

  if (firstToken === 'SET' && secondToken === 'TRANSACTION') {
    throw new Error(
      `[PostgresJobStore] Transaction control statement 'SET TRANSACTION' is prohibited in transactionDb façade. Transaction boundary is owned exclusively by JobStore.`,
    );
  }
}

export class PostgresJobStore implements DurableJobStore {
  constructor(private readonly executor: PgTransactionalExecutor) {}

  /**
   * Executa operação encapsulada em transação PostgreSQL.
   * Utiliza rigorosamente o mesmo client durante BEGIN, COMMIT e ROLLBACK.
   */
  private async withTransaction<T>(
    operation: (client: PgTransactionalClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.executor.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignora falha secundária no rollback para preservar o erro raiz
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Executa operação de leitura encapsulada em transação REPEATABLE READ READ ONLY.
   * Garante snapshot point-in-time consistente entre head e histórico de eventos
   * sem bloquear leituras concorrentes nem utilizar FOR UPDATE.
   */
  private async withReadSnapshot<T>(
    operation: (client: PgTransactionalClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.executor.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignora falha secundária no rollback para preservar o erro raiz
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Seam transacional seguro do PostgresJobStore (0.86C-3C).
   * Permite que coordenadores atômicos participem da MESMA transação PostgreSQL
   * sem duplicar a autoridade de escrita e sem transferir o transaction ownership.
   */
  async withWriteTransaction<T>(
    operation: (scope: PostgresJobStoreWriteTransactionScope) => Promise<T>,
  ): Promise<T> {
    return await this.withTransaction(async (client) => {
      const transactionDb: PostgresTransactionDb = {
        async executeSql(text: string, values?: unknown[]) {
          assertNoTransactionControlSql(text);
          const result = await client.query(text, values);
          return {
            rows: result.rows,
            rowCount: result.rowCount,
          };
        },
      };

      const scope: PostgresJobStoreWriteTransactionScope = {
        createJob: (params) => this.executeCreateJob(client, params),
        applyJobEvent: (event, expectedRevision) =>
          this.executeApplyJobEvent(client, event, expectedRevision),
        transactionDb,
      };
      return await operation(scope);
    });
  }

  // ==========================================================================
  // 1. CRIAÇÃO DURÁVEL (REVISION 1)
  // ==========================================================================

  private async executeCreateJob(
    tx: PgTransactionalClient,
    params: CreateJobParams,
  ): Promise<JobState> {
    // 1. Valida e inicializa via reducer puro do Core (JobState sanitizado, revision 1, queued)
    const initialJob = createJob(params);

    // 2. Serializa por allowlist explícita derivada exclusivamente do JobState canônico
    const creationRecordPayload = serializeCreationParamsFromJobState(initialJob);
    const serializedHead = serializeJobState(initialJob);

    // Pre-check de unicidade do Job
    const existingHead = await tx.query(
      `SELECT "job_id" FROM "nex_job_heads" WHERE "job_id" = $1`,
      [initialJob.jobId],
    );
    if (existingHead.rows.length > 0) {
      throw new DuplicateJobIdError(initialJob.jobId);
    }

    try {
      // Grava a projeção operacional em nex_job_heads primeiro (satisfaz FK de nex_job_events)
      await tx.query(
        `INSERT INTO "nex_job_heads" (
          "job_id",
          "status",
          "revision",
          "created_at",
          "updated_at",
          "started_at",
          "finished_at",
          "state_payload"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          initialJob.jobId,
          initialJob.status,
          initialJob.revision,
          initialJob.createdAt,
          initialJob.updatedAt,
          initialJob.startedAt ?? null,
          initialJob.finishedAt ?? null,
          JSON.stringify(serializedHead),
        ],
      );

      // Grava o registro físico de criação em nex_job_events (record_kind = 'created', revision = 1)
      await tx.query(
        `INSERT INTO "nex_job_events" (
          "job_id",
          "revision",
          "record_kind",
          "event_type",
          "occurred_at",
          "payload"
        ) VALUES ($1, $2, 'created', NULL, $3, $4)`,
        [
          initialJob.jobId,
          initialJob.revision,
          initialJob.createdAt,
          JSON.stringify(creationRecordPayload),
        ],
      );
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new DuplicateJobIdError(initialJob.jobId);
      }
      throw err;
    }

    return initialJob;
  }

  async createJob(params: CreateJobParams): Promise<JobState> {
    return await this.withTransaction((client) => this.executeCreateJob(client, params));
  }

  // ==========================================================================
  // 2. LEITURA OPERACIONAL DEFENSIVA
  // ==========================================================================

  async getJob(jobId: JobId): Promise<JobState | undefined> {
    const res = await this.executor.query(
      `SELECT
        "job_id",
        "status",
        "revision",
        "created_at",
        "updated_at",
        "started_at",
        "finished_at",
        "state_payload"
      FROM "nex_job_heads"
      WHERE "job_id" = $1`,
      [jobId],
    );

    if (res.rows.length === 0) {
      return undefined;
    }

    return mapRowToJobState(res.rows[0]);
  }

  // ==========================================================================
  // 3. TRANSIÇÃO CONCORRENTE (REVISION 2+)
  // ==========================================================================

  private async executeApplyJobEvent(
    tx: PgTransactionalClient,
    event: JobEvent,
    expectedRevision: number,
  ): Promise<JobState> {
    // 1. Bloqueia o head do Job exclusivamente (SELECT ... FOR UPDATE)
    const headRes = await tx.query(
      `SELECT
        "job_id",
        "status",
        "revision",
        "created_at",
        "updated_at",
        "started_at",
        "finished_at",
        "state_payload"
      FROM "nex_job_heads"
      WHERE "job_id" = $1
      FOR UPDATE`,
      [event.jobId],
    );

    if (headRes.rows.length === 0) {
      throw new JobNotFoundError(event.jobId);
    }

    // 2. Desserializa defensivamente o estado atual
    const currentState = mapRowToJobState(headRes.rows[0]);

    // 3. Verifica optimistic concurrency (expectedRevision estrito)
    if (currentState.revision !== expectedRevision) {
      throw new JobRevisionConflictError(
        event.jobId,
        expectedRevision,
        currentState.revision,
      );
    }

    // 4. Delega a transição para a autoridade semântica pura do Core
    // Se for transição inválida, reduceJob lança JobLifecycleError (rollback total)
    const nextState = reduceJob(currentState, event);

    // 5. Serializa o evento com allowlist estrita
    const serializedEvent = serializeJobEvent(event);
    const serializedNextHead = serializeJobState(nextState);
    const occurredAt = extractEventOccurredAt(event);

    // 6. Insere exatamente uma nova linha histórica append-only
    await tx.query(
      `INSERT INTO "nex_job_events" (
        "job_id",
        "revision",
        "record_kind",
        "event_type",
        "occurred_at",
        "payload"
      ) VALUES ($1, $2, 'transition', $3, $4, $5)`,
      [
        event.jobId,
        nextState.revision,
        event.type,
        occurredAt,
        JSON.stringify(serializedEvent),
      ],
    );

    // 7. Atualiza o head mutável com a nova revisão e projeção
    await tx.query(
      `UPDATE "nex_job_heads"
      SET
        "status" = $1,
        "revision" = $2,
        "updated_at" = $3,
        "started_at" = $4,
        "finished_at" = $5,
        "state_payload" = $6
      WHERE "job_id" = $7`,
      [
        nextState.status,
        nextState.revision,
        nextState.updatedAt,
        nextState.startedAt ?? null,
        nextState.finishedAt ?? null,
        JSON.stringify(serializedNextHead),
        event.jobId,
      ],
    );

    return nextState;
  }

  async applyJobEvent(event: JobEvent, expectedRevision: number): Promise<JobState> {
    return await this.withTransaction((client) =>
      this.executeApplyJobEvent(client, event, expectedRevision),
    );
  }

  // ==========================================================================
  // 4. LEITURA DE HISTÓRICO PÚBLICO
  // ==========================================================================

  async listJobEvents(jobId: JobId): Promise<readonly JobStoredRecord[]> {
    const res = await this.executor.query(
      `SELECT
        "job_id",
        "revision",
        "record_kind",
        "event_type",
        "occurred_at",
        "payload",
        "append_sequence"
      FROM "nex_job_events"
      WHERE "job_id" = $1
      ORDER BY "revision" ASC`,
      [jobId],
    );

    const records = res.rows.map((row) => mapRowToStoredRecord(row));
    return Object.freeze(records);
  }

  // ==========================================================================
  // 5. REPLAY / REIDRATAÇÃO AUDITÁVEL
  // ==========================================================================

  async rehydrateJob(jobId: JobId): Promise<JobState | undefined> {
    return await this.withReadSnapshot(async (client) => {
      // 1. Carrega o head persistido
      const headRes = await client.query(
        `SELECT
          "job_id",
          "status",
          "revision",
          "created_at",
          "updated_at",
          "started_at",
          "finished_at",
          "state_payload"
        FROM "nex_job_heads"
        WHERE "job_id" = $1`,
        [jobId],
      );

      // 2. Carrega todos os registros históricos em ordem ascendente de revisão no mesmo snapshot
      const eventsRes = await client.query(
        `SELECT
          "job_id",
          "revision",
          "record_kind",
          "event_type",
          "occurred_at",
          "payload",
          "append_sequence"
        FROM "nex_job_events"
        WHERE "job_id" = $1
        ORDER BY "revision" ASC`,
        [jobId],
      );

      // 3. Valida integridade básica da existência mútua (head vs histórico)
      if (headRes.rows.length === 0 && eventsRes.rows.length === 0) {
        return undefined;
      }

      if (headRes.rows.length === 0 && eventsRes.rows.length > 0) {
        throw new CorruptedJobStorageError(
          'nex_job_heads',
          `Job events exist for Job '${jobId}', but the operational head is missing.`,
          jobId,
        );
      }

      if (headRes.rows.length > 0 && eventsRes.rows.length === 0) {
        throw new CorruptedJobStorageError(
          'nex_job_events',
          `Operational head exists for Job '${jobId}', but no event records were found.`,
          jobId,
        );
      }

      const headState = mapRowToJobState(headRes.rows[0]);
      const storedRecords = eventsRes.rows.map((row) => mapRowToStoredRecord(row));

      // 4. Valida primeiro registro (criação revision 1)
      const firstRecord = storedRecords[0];
      if (firstRecord.revision !== 1) {
        throw new CorruptedJobStorageError(
          'nex_job_events',
          `First record for Job '${jobId}' must be revision 1, but found revision ${firstRecord.revision}.`,
          jobId,
        );
      }
      if (firstRecord.recordKind !== 'created') {
        throw new CorruptedJobStorageError(
          'nex_job_events',
          `First record for Job '${jobId}' must have record_kind 'created', but found '${firstRecord.recordKind}'.`,
          jobId,
        );
      }

      // 5. Replay inicial: reconstruir CreateJobParams e executar createJob puro
      const createParams = mapStoredRecordToCreateJobParams(firstRecord);
      let replayedState = createJob(createParams);

      if (replayedState.revision !== 1) {
        throw new CorruptedJobStorageError(
          'nex_job_events',
          `Replayed initial state for Job '${jobId}' produced revision ${replayedState.revision}, expected 1.`,
          jobId,
        );
      }

      // 6. Replay subsequente: iterar sequencialmente por cada transição
      for (let i = 1; i < storedRecords.length; i++) {
        const record = storedRecords[i];
        const expectedRev = replayedState.revision + 1;

        if (record.revision !== expectedRev) {
          throw new CorruptedJobStorageError(
            'nex_job_events',
            `Revision gap or disorder detected for Job '${jobId}': expected revision ${expectedRev}, but found revision ${record.revision}.`,
            jobId,
          );
        }

        if (record.recordKind !== 'transition') {
          throw new CorruptedJobStorageError(
            'nex_job_events',
            `Record at revision ${record.revision} for Job '${jobId}' must have record_kind 'transition', but found '${record.recordKind}'.`,
            jobId,
          );
        }

        const domainEvent = mapStoredRecordToJobEvent(record);
        replayedState = reduceJob(replayedState, domainEvent);
      }

      // 7. Validação estrita de equivalência entre replay e head operacional
      assertJobStatesEquivalent(replayedState, headState);

      return replayedState;
    });
  }
}

export function createPostgresJobStore(executor: PgTransactionalExecutor): DurableJobStore {
  return new PostgresJobStore(executor);
}
