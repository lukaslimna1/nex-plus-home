/**
 * NEX+ · Atomic Enqueue Coordinator
 * Coordenação Transacional Atômica entre DurableJobStore e pg-boss — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3C)
 *
 * Princípios Fundamentais:
 * 1. Zero outbox: JobStore write e wake-up enqueue compartilham a MESMA transação PostgreSQL.
 * 2. Se qualquer etapa falhar (inclusive ausência de fila ou messageId nulo), rollback integral é executado.
 * 3. O payload canônico transportado é estritamente { jobId }.
 * 4. O coordinator NÃO cria filas ou schemas silenciosamente.
 */

import type { JobState, JobEvent, CreateJobParams } from '../contracts';
import type { PostgresJobStore } from '../persistence/postgres';
import type { PgTransactionalClient } from '../persistence/contracts';
import {
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  type IPgBossRuntime,
  type PgBossTransactionDb,
} from './contracts';
import { PgBossRuntimeError } from './pg-boss';

/**
 * Resultado do enqueue atômico de Job + wake-up.
 */
export interface AtomicJobWakeupResult {
  readonly job: JobState;
  readonly messageId: string;
}

export interface AtomicEnqueueOptions {
  readonly queueName?: string;
}

/**
 * Adapta com fidelidade um PgTransactionalClient da persistência PostgreSQL
 * para a interface PgBossTransactionDb exigida pelo runtime pg-boss.
 */
export function adaptTransactionalClientToPgBossDb(
  client: PgTransactionalClient,
): PgBossTransactionDb {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const result = await client.query(text, values);
      return {
        rows: result.rows,
        rowCount: result.rowCount,
      };
    },
  };
}

/**
 * Cria um Job durável na revision 1 e emite wake-up atômico na MESMA transação PostgreSQL.
 * Se o envio para a fila falhar ou retornar messageId nulo, o Job sofre rollback automático.
 */
export async function createJobAndWakeup(
  store: PostgresJobStore,
  runtime: IPgBossRuntime,
  params: CreateJobParams,
  options?: AtomicEnqueueOptions,
): Promise<AtomicJobWakeupResult> {
  const queueName = options?.queueName ?? PG_BOSS_DEFAULT_WAKEUP_QUEUE;

  return await store.withWriteTransaction(async (scope) => {
    // 1. Criação do Job na revision 1
    const job = await scope.createJob(params);

    // 2. Adaptação do client transacional para o pg-boss
    const txDb = adaptTransactionalClientToPgBossDb(scope.client);

    // 3. Emissão de wake-up usando o mesmo client transacional
    const sendResult = await runtime.sendWakeupInTransaction(
      queueName,
      { jobId: job.jobId },
      txDb,
    );

    // 4. Validação estrita de messageId material (fail-closed se nulo)
    if (!sendResult.messageId) {
      throw new PgBossRuntimeError({
        code: 'SEND_FAILURE',
        message: `[AtomicEnqueue] Failed to enqueue wake-up for Job '${job.jobId}': provider returned null messageId on queue '${queueName}'. Rolling back.`,
      });
    }

    return Object.freeze({
      job,
      messageId: sendResult.messageId,
    });
  });
}

/**
 * Aplica um JobEvent sob concorrência otimista e emite wake-up atômico na MESMA transação PostgreSQL.
 * Se o envio para a fila falhar ou retornar messageId nulo, a transição de estado e o evento sofrem rollback.
 */
export async function applyJobEventAndWakeup(
  store: PostgresJobStore,
  runtime: IPgBossRuntime,
  event: JobEvent,
  expectedRevision: number,
  options?: AtomicEnqueueOptions,
): Promise<AtomicJobWakeupResult> {
  const queueName = options?.queueName ?? PG_BOSS_DEFAULT_WAKEUP_QUEUE;

  return await store.withWriteTransaction(async (scope) => {
    // 1. Aplicação da transição de estado e inserção do novo evento histórico
    const job = await scope.applyJobEvent(event, expectedRevision);

    // 2. Adaptação do client transacional para o pg-boss
    const txDb = adaptTransactionalClientToPgBossDb(scope.client);

    // 3. Emissão de wake-up usando o mesmo client transacional
    const sendResult = await runtime.sendWakeupInTransaction(
      queueName,
      { jobId: job.jobId },
      txDb,
    );

    // 4. Validação estrita de messageId material (fail-closed se nulo)
    if (!sendResult.messageId) {
      throw new PgBossRuntimeError({
        code: 'SEND_FAILURE',
        message: `[AtomicEnqueue] Failed to enqueue wake-up for Job '${job.jobId}' revision ${job.revision}: provider returned null messageId on queue '${queueName}'. Rolling back.`,
      });
    }

    return Object.freeze({
      job,
      messageId: sendResult.messageId,
    });
  });
}
