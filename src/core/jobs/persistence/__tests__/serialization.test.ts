/**
 * NEX+ · Job Lifecycle Core
 * Testes Unitários de Serialização e Trust Boundary — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2B)
 *
 * Validação rigorosa dos mecanismos defensivos:
 * - Allowlist estrita descartando campos desconhecidos e credenciais/segredos
 * - Imunidade a prototype pollution (__proto__, constructor)
 * - Mapeamento defensivo fail-closed em dados corrompidos
 * - Asserção estrita de equivalência para replay / rehydration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  JobId,
  CreateJobParams,
  JobStartedEvent,
  JobPausedEvent,
  JobResumedEvent,
  JobCancelledEvent,
  JobSucceededEvent,
  JobFailedEvent,
  JobProgressUpdatedEvent,
  JobState,
} from '../../contracts';
import { createJob } from '../../lifecycle';
import {
  assertNonEmptyString,
  assertString,
  readCanonicalPayloadUtcInstant,
  normalizePgTimestampInstant,
  areSameUtcInstant,
  assertMatchingUtcInstant,
  serializeCreateJobParams,
  serializeCreationParamsFromJobState,
  serializeJobEvent,
  serializeJobState,
  extractEventOccurredAt,
  mapPayloadToActor,
  mapRowToJobState,
  mapRowToStoredRecord,
  mapStoredRecordToCreateJobParams,
  mapStoredRecordToJobEvent,
  assertJobStatesEquivalent,
} from '../serialization';
import {
  CorruptedJobStorageError,
  JobRehydrationDivergenceError,
} from '../errors';

describe('0.86C-2B · Serialização, Allowlist e Trust Boundary', () => {
  const JOB_ID = 'job_test_001' as JobId;
  const T0 = '2026-09-27T10:00:00.000Z';
  const T1 = '2026-09-27T10:01:00.000Z';
  const T2 = '2026-09-27T10:02:00.000Z';
  const T3 = '2026-09-27T10:03:00.000Z';

  // ==========================================================================
  // 1. ALLOWLIST DE ESCRITA & REMOÇÃO DE EXTRAS / SEGREDOS
  // ==========================================================================
  describe('Allowlist de Escrita (Descarte de Extras e Segredos)', () => {
    it('C25 & C27: Descarta campos extras, tokens, cookies e authorization em serializeCreateJobParams', () => {
      const maliciousInput = {
        jobId: JOB_ID,
        createdAt: T0,
        userId: 'usr_abc',
        sessionRef: 'b'.repeat(64) as any,
        actor: { kind: 'human', humanId: 'usr_abc' },
        contextSubjectRef: { subjectType: 'lead', subjectId: 'lead_123' },
        correlationId: 'corr_xyz',
        materialContextPinId: 'mcp_001',
        // Injetados maliciosamente / acidentalmente no runtime:
        token: 'secret_bearer_token',
        cookie: 'sid=sensitive_cookie',
        password: 'raw_password_123',
        authorization: 'Bearer super_secret',
        extraField: { nested: 'should_be_omitted' },
      } as unknown as CreateJobParams;

      const serialized = serializeCreateJobParams(maliciousInput);

      // Campos canônicos permitidos devem estar presentes
      assert.equal(serialized.jobId, JOB_ID);
      assert.equal(serialized.createdAt, T0);
      assert.equal(serialized.userId, 'usr_abc');
      assert.equal(serialized.sessionRef, 'b'.repeat(64));
      assert.equal(serialized.correlationId, 'corr_xyz');
      assert.equal(serialized.materialContextPinId, 'mcp_001');

      // Campos fora do contrato DEVEM ser purgados
      assert.equal((serialized as any).token, undefined);
      assert.equal((serialized as any).cookie, undefined);
      assert.equal((serialized as any).password, undefined);
      assert.equal((serialized as any).authorization, undefined);
      assert.equal((serialized as any).extraField, undefined);
    });

    it('C25 & C27: Descarta campos extras em serializeJobEvent', () => {
      const maliciousEvent: JobStartedEvent & { secretKey?: string; headers?: Record<string, string> } = {
        type: 'JobStarted',
        jobId: JOB_ID,
        startedAt: T1,
        attemptId: 'att_001' as any,
        secretKey: 'top_secret',
        headers: { Authorization: 'Bearer xyz' },
      };

      const serialized = serializeJobEvent(maliciousEvent);

      assert.equal(serialized.type, 'JobStarted');
      assert.equal(serialized.jobId, JOB_ID);
      assert.equal(serialized.startedAt, T1);
      assert.equal(serialized.attemptId, 'att_001');

      // Verificação de ausência de extras
      assert.equal((serialized as any).secretKey, undefined);
      assert.equal((serialized as any).headers, undefined);
    });

    it('C26: Prototype pollution e __proto__ são sanitizados e não ganham autoridade', () => {
      const pollutedJson = JSON.parse(
        '{"jobId":"job_polluted","createdAt":"2026-09-27T10:00:00.000Z","actor":{"kind":"system","component":"test"},"__proto__":{"isAdmin":true}}',
      );

      const serialized = serializeCreateJobParams(pollutedJson);
      assert.equal((serialized as any).isAdmin, undefined);
      assert.equal(({} as any).isAdmin, undefined);
    });
  });

  // ==========================================================================
  // 2. DESERIALIZAÇÃO DE LEITURA (DB UNTRUSTED)
  // ==========================================================================
  describe('Desserialização de Leitura (DB Untrusted / Fail-Closed)', () => {
    it('Mapeia row válida para JobState completo', () => {
      const initialJob = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        userId: 'usr_test',
        sessionRef: 'a'.repeat(64) as any,
        actor: { kind: 'human', humanId: 'usr_test' },
      });

      const serializedHead = serializeJobState(initialJob);

      const row = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: null,
        finished_at: null,
        state_payload: serializedHead,
      };

      const mappedState = mapRowToJobState(row);
      assert.equal(mappedState.jobId, JOB_ID);
      assert.equal(mappedState.status, 'queued');
      assert.equal(mappedState.revision, 1);
      assert.equal(mappedState.userId, 'usr_test');
    });

    it('C18: Falha fechado com CorruptedJobStorageError se state_payload estiver corrompido', () => {
      const corruptRow = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: null,
        finished_at: null,
        state_payload: 'not_an_object',
      };

      assert.throws(
        () => mapRowToJobState(corruptRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.table === 'nex_job_heads',
      );
    });

    it('C18: Falha fechado se revision no head divergir da revision do state_payload', () => {
      const initialJob = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        actor: { kind: 'system', component: 'orchestrator' },
      });

      const serializedHead = serializeJobState(initialJob);

      const divergedRow = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 5, // divergente da payload (revision 1)
        created_at: T0,
        updated_at: T0,
        started_at: null,
        finished_at: null,
        state_payload: serializedHead,
      };

      assert.throws(
        () => mapRowToJobState(divergedRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Mismatch between column revision'),
      );
    });

    it('C19: Falha fechado se stored record possuir record_kind desconhecido', () => {
      const corruptRecordRow = {
        job_id: JOB_ID,
        revision: 1,
        record_kind: 'unknown_kind',
        event_type: null,
        occurred_at: T0,
        payload: {},
        append_sequence: '1',
      };

      assert.throws(
        () => mapRowToStoredRecord(corruptRecordRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.table === 'nex_job_events',
      );
    });

    it('C17: Falha fechado se record payload tiver jobId divergente da coluna job_id', () => {
      const divergedRecordRow = {
        job_id: JOB_ID,
        revision: 1,
        record_kind: 'created',
        event_type: null,
        occurred_at: T0,
        payload: {
          jobId: 'divergent_job_id',
          createdAt: T0,
          actor: { kind: 'system', component: 'orchestrator' },
        },
        append_sequence: '1',
      };

      const record = mapRowToStoredRecord(divergedRecordRow);
      assert.throws(
        () => mapStoredRecordToCreateJobParams(record),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Mismatch between record.jobId'),
      );
    });
  });

  // ==========================================================================
  // 3. EQUIVALÊNCIA PARA REPLAY / REHYDRATION
  // ==========================================================================
  describe('assertJobStatesEquivalent', () => {
    it('Aceita dois JobStates idênticos', () => {
      const stateA = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        userId: 'usr_1',
        actor: { kind: 'system', component: 'orchestrator' },
      });
      const stateB = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        userId: 'usr_1',
        actor: { kind: 'system', component: 'orchestrator' },
      });

      assert.doesNotThrow(() => assertJobStatesEquivalent(stateA, stateB));
    });

    it('C20: Rejeita divergência de status entre replay e head com JobRehydrationDivergenceError', () => {
      const stateA = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        actor: { kind: 'system', component: 'orchestrator' },
      });
      const stateB = {
        ...stateA,
        status: 'running',
      } as unknown as JobState;

      assert.throws(
        () => assertJobStatesEquivalent(stateA, stateB),
        (err: any) => err instanceof JobRehydrationDivergenceError && err.detail.includes('status mismatch'),
      );
    });

    it('C20: Rejeita divergência de attemptLineage entre replay e head', () => {
      const stateA = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        actor: { kind: 'system', component: 'orchestrator' },
      });
      const stateB = {
        ...stateA,
        attemptLineage: ['att_001'],
      } as unknown as JobState;

      assert.throws(
        () => assertJobStatesEquivalent(stateA, stateB),
        (err: any) => err instanceof JobRehydrationDivergenceError && err.detail.includes('attemptLineage mismatch'),
      );
    });
  });

  // ==========================================================================
  // 4. FIDELIDADE SEMÂNTICA DE STRINGS (H-01) & REVISION 1 DO CANÔNICO
  // ==========================================================================
  describe('H-01 · Fidelidade Semântica & Preservação Exata de Strings', () => {
    it('assertNonEmptyString valida string não-vazia mas preserva whitespace original sem trim', () => {
      const spacedString = '   user_with_spaces   ';
      const result = assertNonEmptyString(spacedString, 'test_table', 'userId', JOB_ID);
      assert.equal(result, spacedString); // Deve preservar os espaços exatamente!
    });

    it('assertString aceita string vazia sem transformar nem rejeitar', () => {
      const emptyString = '';
      const result = assertString(emptyString, 'test_table', 'unit', JOB_ID);
      assert.equal(result, '');
    });

    it('serializeCreateJobParams e serializeCreationParamsFromJobState preservam whitespace original', () => {
      const params: CreateJobParams = {
        jobId: JOB_ID,
        createdAt: T0,
        userId: '   usr_spaced   ',
        correlationId: '   corr_spaced   ',
        actor: { kind: 'human', humanId: '   human_spaced   ' },
      };

      const fromParams = serializeCreateJobParams(params);
      assert.equal(fromParams.userId, '   usr_spaced   ');
      assert.equal(fromParams.correlationId, '   corr_spaced   ');

      const initialJob = createJob(params);
      const fromCanonicalJob = serializeCreationParamsFromJobState(initialJob);

      assert.equal(fromCanonicalJob.jobId, JOB_ID);
      assert.equal(fromCanonicalJob.createdAt, T0);
      assert.equal(fromCanonicalJob.userId, '   usr_spaced   ');
      assert.equal(fromCanonicalJob.correlationId, '   corr_spaced   ');
      assert.equal((fromCanonicalJob as any).revision, undefined);
      assert.equal((fromCanonicalJob as any).status, undefined);
    });

    it('mapRowToJobState aceita string vazia em campos opcionais (terminalReason)', () => {
      const serializedHead = {
        jobId: JOB_ID,
        status: 'cancelled',
        revision: 2,
        actor: { kind: 'system', component: 'orchestrator' },
        createdAt: T0,
        updatedAt: T1,
        finishedAt: T1,
        attemptLineage: [],
        terminalReason: '', // string vazia permitida pelo Core
      };

      const row = {
        job_id: JOB_ID,
        status: 'cancelled',
        revision: 2,
        created_at: T0,
        updated_at: T1,
        started_at: null,
        finished_at: T1,
        state_payload: serializedHead,
      };

      const mapped = mapRowToJobState(row);
      assert.equal(mapped.terminalReason, '');
    });

    it('mapStoredRecordToJobEvent aceita string vazia em terminalReason para eventos terminais', () => {
      const row = {
        job_id: JOB_ID,
        revision: 2,
        record_kind: 'transition',
        event_type: 'JobSucceeded',
        occurred_at: T1,
        payload: {
          type: 'JobSucceeded',
          jobId: JOB_ID,
          finishedAt: T1,
          terminalReason: '', // string vazia
        },
        append_sequence: '2',
      };

      const record = mapRowToStoredRecord(row);
      const event = mapStoredRecordToJobEvent(record);
      assert.equal(event.type, 'JobSucceeded');
      assert.equal((event as JobSucceededEvent).terminalReason, '');
    });
  });

  // ==========================================================================
  // 5. TIMESTAMPS DETERMINÍSTICOS & VALIDAÇÕES DEFENSIVAS (M-01, M-04, M-05, M-06, M-07)
  // ==========================================================================
  describe('M-01, M-04, M-05, M-06, M-07 · Validações Defensivas Rigorosas', () => {
    it('M-01: extractEventOccurredAt para JobProgressUpdated retorna progress.updatedAt determinístico', () => {
      const progressEvent: JobProgressUpdatedEvent = {
        type: 'JobProgressUpdated',
        jobId: JOB_ID,
        progress: {
          completed: 10,
          updatedAt: T1,
        },
      };

      const occurredAt = extractEventOccurredAt(progressEvent);
      assert.equal(occurredAt, T1);
    });

    it('M-04: mapRowToJobState falha se timestamp escalar da coluna divergir do payload', () => {
      const initialJob = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        actor: { kind: 'system', component: 'orchestrator' },
      });

      const serializedHead = serializeJobState(initialJob);

      // Coluna updated_at diverge do payload updatedAt
      const divergedRow = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T1, // Divergente de T0 no payload
        started_at: null,
        finished_at: null,
        state_payload: serializedHead,
      };

      assert.throws(
        () => mapRowToJobState(divergedRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Mismatch between column updated_at'),
      );
    });

    it('M-05: mapRowToJobState falha se JobState contiver invariantes de status impossíveis', () => {
      const basePayload = {
        jobId: JOB_ID,
        revision: 1,
        actor: { kind: 'system', component: 'orchestrator' },
        createdAt: T0,
        updatedAt: T0,
        attemptLineage: [],
      };

      // queued com startedAt presente na revision 1 (impossível no Core)
      const invalidQueuedRow = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: T0,
        finished_at: null,
        state_payload: {
          ...basePayload,
          status: 'queued',
          startedAt: T0,
        },
      };

      assert.throws(
        () => mapRowToJobState(invalidQueuedRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('cannot have startedAt'),
      );
    });

  describe('R-02 / Seção 14 · Provas Adversariais de JobState e assertCanonicalJobState', () => {
    const basePayload = {
      jobId: JOB_ID,
      actor: { kind: 'system', component: 'orchestrator' },
      createdAt: T0,
      updatedAt: T0,
    };

    it('5. queued revision 1 com dados históricos impossíveis é rejeitado', () => {
      // Revision 1 com startedAt
      const rowStarted = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: T0,
        finished_at: null,
        state_payload: { ...basePayload, revision: 1, status: 'queued', attemptLineage: [], startedAt: T0 },
      };
      assert.throws(
        () => mapRowToJobState(rowStarted),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('cannot have startedAt'),
      );

      // Revision 1 com attemptLineage não vazia
      const rowLineage = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: null,
        finished_at: null,
        state_payload: { ...basePayload, revision: 1, status: 'queued', attemptLineage: ['att_1'] },
      };
      assert.throws(
        () => mapRowToJobState(rowLineage),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('empty attemptLineage'),
      );

      // Revision 1 com progress
      const rowProgress = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: null,
        finished_at: null,
        state_payload: {
          ...basePayload,
          revision: 1,
          status: 'queued',
          attemptLineage: [],
          progress: { completed: 10, updatedAt: T0 },
        },
      };
      assert.throws(
        () => mapRowToJobState(rowProgress),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('cannot have progress'),
      );
    });

    it('6. queued revision >1 com startedAt/lineage/progress válidos é aceito', () => {
      const validQueuedRow = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 4,
        created_at: T0,
        updated_at: T2,
        started_at: T1,
        finished_at: null,
        state_payload: {
          ...basePayload,
          revision: 4,
          status: 'queued',
          updatedAt: T2,
          startedAt: T1,
          attemptLineage: ['att_1'],
          progress: { completed: 50, total: 100, updatedAt: T2 },
        },
      };

      const mapped = mapRowToJobState(validQueuedRow);
      assert.equal(mapped.status, 'queued');
      assert.equal(mapped.revision, 4);
      assert.equal(mapped.startedAt, T1);
      assert.deepEqual(mapped.attemptLineage, ['att_1']);
      assert.equal(mapped.progress?.completed, 50);
      assert.equal(mapped.finishedAt, undefined);
    });

    it('7. duplicate attemptLineage no head é rejeitado', () => {
      const duplicateLineageRow = {
        job_id: JOB_ID,
        status: 'running',
        revision: 3,
        created_at: T0,
        updated_at: T2,
        started_at: T1,
        finished_at: null,
        state_payload: {
          ...basePayload,
          revision: 3,
          status: 'running',
          updatedAt: T2,
          startedAt: T1,
          attemptLineage: ['att_1', 'att_1'],
        },
      };

      assert.throws(
        () => mapRowToJobState(duplicateLineageRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Duplicate AttemptId'),
      );
    });

    it('8. Infinity/valor não finito de progress vindo do DB é rejeitado', () => {
      const infiniteProgressRow = {
        job_id: JOB_ID,
        status: 'running',
        revision: 2,
        created_at: T0,
        updated_at: T1,
        started_at: T1,
        finished_at: null,
        state_payload: {
          ...basePayload,
          revision: 2,
          status: 'running',
          updatedAt: T1,
          startedAt: T1,
          attemptLineage: ['att_1'],
          progress: { completed: Infinity, updatedAt: T1 },
        },
      };

      assert.throws(
        () => mapRowToJobState(infiniteProgressRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Progress completed must be a non-negative finite number'),
      );
    });

    it('9. estado terminal com controlIntent é rejeitado', () => {
      const terminalWithControlRow = {
        job_id: JOB_ID,
        status: 'succeeded',
        revision: 3,
        created_at: T0,
        updated_at: T2,
        started_at: T1,
        finished_at: T2,
        state_payload: {
          ...basePayload,
          revision: 3,
          status: 'succeeded',
          updatedAt: T2,
          startedAt: T1,
          finishedAt: T2,
          attemptLineage: ['att_1'],
          controlIntent: 'cancel',
        },
      };

      assert.throws(
        () => mapRowToJobState(terminalWithControlRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('cannot have controlIntent'),
      );
    });

    it('10. paused com controlIntent=\'pause\' é rejeitado', () => {
      const pausedWithPauseIntentRow = {
        job_id: JOB_ID,
        status: 'paused',
        revision: 3,
        created_at: T0,
        updated_at: T2,
        started_at: T1,
        finished_at: null,
        state_payload: {
          ...basePayload,
          revision: 3,
          status: 'paused',
          updatedAt: T2,
          startedAt: T1,
          attemptLineage: ['att_1'],
          controlIntent: 'pause',
        },
      };

      assert.throws(
        () => mapRowToJobState(pausedWithPauseIntentRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes("cannot retain controlIntent='pause'"),
      );
    });

    it('11. failed/cancelled sem terminalReason é rejeitado', () => {
      const failedWithoutReasonRow = {
        job_id: JOB_ID,
        status: 'failed',
        revision: 2,
        created_at: T0,
        updated_at: T1,
        started_at: T1,
        finished_at: T1,
        state_payload: {
          ...basePayload,
          revision: 2,
          status: 'failed',
          updatedAt: T1,
          startedAt: T1,
          finishedAt: T1,
          attemptLineage: ['att_1'],
          // sem terminalReason
        },
      };

      assert.throws(
        () => mapRowToJobState(failedWithoutReasonRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('must have terminalReason'),
      );
    });

    it('12. terminal updatedAt != finishedAt é rejeitado', () => {
      const divergedTerminalRow = {
        job_id: JOB_ID,
        status: 'succeeded',
        revision: 3,
        created_at: T0,
        updated_at: T1, // T1 !== T2!
        started_at: T1,
        finished_at: T2,
        state_payload: {
          ...basePayload,
          revision: 3,
          status: 'succeeded',
          updatedAt: T1,
          startedAt: T1,
          finishedAt: T2,
          attemptLineage: ['att_1'],
        },
      };

      assert.throws(
        () => mapRowToJobState(divergedTerminalRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('must have updatedAt strictly equal to finishedAt'),
      );
    });
  });

    it('M-06: mapRowToStoredRecord falha se occurred_at divergir do timestamp do evento no payload', () => {
      const divergedEventRow = {
        job_id: JOB_ID,
        revision: 2,
        record_kind: 'transition',
        event_type: 'JobStarted',
        occurred_at: T1, // T1
        payload: {
          type: 'JobStarted',
          jobId: JOB_ID,
          startedAt: T0, // T0 !== T1!
        },
        append_sequence: '2',
      };

      assert.throws(
        () => mapRowToStoredRecord(divergedEventRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Mismatch between row occurred_at'),
      );
    });

    it('M-07: mapRowToStoredRecord rejeita append_sequence inválido ou não-positivo', () => {
      const invalidSeqRows = ['0', '-1', 'abc', '1.5', ''];

      for (const invalidSeq of invalidSeqRows) {
        const row = {
          job_id: JOB_ID,
          revision: 1,
          record_kind: 'created',
          event_type: null,
          occurred_at: T0,
          payload: {
            jobId: JOB_ID,
            createdAt: T0,
            actor: { kind: 'system', component: 'orchestrator' },
          },
          append_sequence: invalidSeq,
        };

        assert.throws(
          () => mapRowToStoredRecord(row),
          (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('append_sequence'),
          `Deveria falhar para append_sequence='${invalidSeq}'`,
        );
      }

      // Válido: '1', '100'
      const validRow = {
        job_id: JOB_ID,
        revision: 1,
        record_kind: 'created',
        event_type: null,
        occurred_at: T0,
        payload: {
          jobId: JOB_ID,
          createdAt: T0,
          actor: { kind: 'system', component: 'orchestrator' },
        },
        append_sequence: '42',
      };

      const record = mapRowToStoredRecord(validRow);
      assert.equal(record.appendSequence, '42');
    });
  });

  // ==========================================================================
  // R-04 · SEMÂNTICA DE MaxActor.sessionRef vs JobState.sessionRef TOP-LEVEL
  // ==========================================================================
  describe('R-04 · MaxActor.sessionRef Opaco vs JobState.sessionRef Auth Hex-64', () => {
    it('mapPayloadToActor aceita e preserva exatamente sessionRef opaco de MaxActor', () => {
      const payload = {
        kind: 'max',
        maxVersion: 'max-v1',
        sessionRef: 'max-session-opaque',
      };

      const actor = mapPayloadToActor(payload, 'nex_job_heads', JOB_ID);
      assert.equal(actor.kind, 'max');
      if (actor.kind === 'max') {
        assert.equal(actor.maxVersion, 'max-v1');
        assert.equal(actor.sessionRef, 'max-session-opaque');
      }
    });

    it('mapPayloadToActor preserva whitespace significativo em MaxActor.sessionRef', () => {
      const opaqueWithWhitespace = '  max-session-opaque  ';
      const payload = {
        kind: 'max',
        maxVersion: 'max-v1',
        sessionRef: opaqueWithWhitespace,
      };

      const actor = mapPayloadToActor(payload, 'nex_job_heads', JOB_ID);
      assert.equal(actor.kind, 'max');
      if (actor.kind === 'max') {
        assert.equal(actor.sessionRef, opaqueWithWhitespace);
      }
    });

    it('mapPayloadToActor rejeita MaxActor.sessionRef com whitespace-only', () => {
      const payload = {
        kind: 'max',
        maxVersion: 'max-v1',
        sessionRef: '   ',
      };

      assert.throws(
        () => mapPayloadToActor(payload, 'nex_job_heads', JOB_ID),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes("Field 'actor.sessionRef' must be a non-empty string"),
      );
    });

    it('Não-regressão: CreateJobParams.sessionRef top-level continua rejeitando string opaca e exigindo SessionRef hex-64', () => {
      // 1. O Core rejeita "max-session-opaque" como sessionRef top-level
      assert.throws(
        () =>
          createJob({
            jobId: JOB_ID,
            createdAt: T0,
            actor: { kind: 'system', component: 'orchestrator' },
            sessionRef: 'max-session-opaque' as any,
          }),
        (err: any) => err?.code === 'JOB_INVALID_PAYLOAD' && err.message.includes("Field 'sessionRef' must be a valid SessionRef"),
      );

      // 2. O Core rejeita whitespace-only
      assert.throws(
        () =>
          createJob({
            jobId: JOB_ID,
            createdAt: T0,
            actor: { kind: 'system', component: 'orchestrator' },
            sessionRef: '   ' as any,
          }),
        (err: any) => err?.code === 'JOB_INVALID_PAYLOAD',
      );

      // 3. Hex-64 válido passa normalmente
      const validHex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as any;
      const job = createJob({
        jobId: JOB_ID,
        createdAt: T0,
        actor: { kind: 'system', component: 'orchestrator' },
        sessionRef: validHex64,
      });
      assert.equal(job.sessionRef, validHex64);
    });

    it('Não-regressão: mapRowToJobState rejeita row com sessionRef top-level que não seja hex-64', () => {
      const invalidRow = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: T0,
        updated_at: T0,
        started_at: null,
        finished_at: null,
        state_payload: {
          jobId: JOB_ID,
          status: 'queued',
          revision: 1,
          createdAt: T0,
          updatedAt: T0,
          actor: { kind: 'system', component: 'orchestrator' },
          attemptLineage: [],
          sessionRef: 'max-session-opaque', // Inválido para top-level
        },
      };

      assert.throws(
        () => mapRowToJobState(invalidRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Invalid sessionRef in Job payload'),
      );
    });
  });

  // ==========================================================================
  // T-01 · FIDELIDADE TEXTUAL DE TIMESTAMPS UTC & CROSS-CHECK TEMPORAL
  // ==========================================================================
  describe('T-01 · Fidelidade Textual de Timestamps UTC & Cross-Check Temporal', () => {
    const T_NO_FRAC = '2026-09-25T12:00:00Z';
    const T_1_DIGIT = '2026-09-25T12:00:00.1Z';
    const T_2_DIGIT = '2026-09-25T12:00:00.12Z';
    const T_3_DIGIT = '2026-09-25T12:00:00.123Z';

    it('readCanonicalPayloadUtcInstant aceita e preserva strings canônicas sem alteração de zeros', () => {
      assert.equal(readCanonicalPayloadUtcInstant(T_NO_FRAC, 'test_table', 't'), T_NO_FRAC);
      assert.equal(readCanonicalPayloadUtcInstant(T_1_DIGIT, 'test_table', 't'), T_1_DIGIT);
      assert.equal(readCanonicalPayloadUtcInstant(T_2_DIGIT, 'test_table', 't'), T_2_DIGIT);
      assert.equal(readCanonicalPayloadUtcInstant(T_3_DIGIT, 'test_table', 't'), T_3_DIGIT);

      // Rejeita timestamp inválido ou com mais de 3 casas decimais
      assert.throws(
        () => readCanonicalPayloadUtcInstant('2026-09-25T12:00:00.1234Z', 'test_table', 't'),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('non-canonical or invalid UTC timestamp string'),
      );
      assert.throws(
        () => readCanonicalPayloadUtcInstant('2026-09-25 12:00:00', 'test_table', 't'),
        (err: any) => err instanceof CorruptedJobStorageError,
      );
    });

    it('normalizePgTimestampInstant e areSameUtcInstant comparam instantes temporais sem exigir igualdade textual', () => {
      const date100 = new Date('2026-09-25T12:00:00.100Z');
      assert.ok(areSameUtcInstant(date100, T_1_DIGIT));
      assert.ok(areSameUtcInstant(T_1_DIGIT, date100));

      const date101 = new Date('2026-09-25T12:00:00.101Z');
      assert.strictEqual(areSameUtcInstant(date101, T_1_DIGIT), false);

      // assertMatchingUtcInstant
      assert.doesNotThrow(() => assertMatchingUtcInstant(date100, T_1_DIGIT, 'test_table', 'col'));
      assert.throws(
        () => assertMatchingUtcInstant(date101, T_1_DIGIT, 'test_table', 'col'),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes("Mismatch between column col"),
      );
    });

    it('mapRowToJobState aceita coluna SQL .100Z com payload .1Z e preserva string textual .1Z no JobState', () => {
      const sqlDate = new Date('2026-09-25T12:00:00.100Z');
      const canonicalInput = T_1_DIGIT; // '2026-09-25T12:00:00.1Z'

      const row = {
        job_id: JOB_ID,
        status: 'running',
        revision: 2,
        created_at: sqlDate,
        updated_at: sqlDate,
        started_at: sqlDate,
        finished_at: null,
        state_payload: {
          jobId: JOB_ID,
          status: 'running',
          revision: 2,
          actor: { kind: 'system', component: 'orchestrator' },
          createdAt: canonicalInput,
          updatedAt: canonicalInput,
          startedAt: canonicalInput,
          attemptLineage: ['att_1'],
        },
      };

      const mapped = mapRowToJobState(row);
      assert.equal(mapped.createdAt, canonicalInput);
      assert.equal(mapped.updatedAt, canonicalInput);
      assert.equal(mapped.startedAt, canonicalInput);
    });

    it('mapRowToJobState falha fechado se instante da coluna SQL divergir temporalmente do payload', () => {
      const divergedDate = new Date('2026-09-25T12:00:00.101Z'); // 1ms a mais que .100Z
      const row = {
        job_id: JOB_ID,
        status: 'queued',
        revision: 1,
        created_at: divergedDate,
        updated_at: divergedDate,
        started_at: null,
        finished_at: null,
        state_payload: {
          jobId: JOB_ID,
          status: 'queued',
          revision: 1,
          actor: { kind: 'system', component: 'orchestrator' },
          createdAt: T_1_DIGIT,
          updatedAt: T_1_DIGIT,
          attemptLineage: [],
        },
      };

      assert.throws(
        () => mapRowToJobState(row),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Mismatch between column created_at'),
      );
    });

    it('mapRowToStoredRecord aceita coluna occurred_at .100Z e devolve string exata .1Z do payload no record.occurredAt', () => {
      const sqlDate = new Date('2026-09-25T12:00:00.100Z');
      const row = {
        job_id: JOB_ID,
        revision: 1,
        record_kind: 'created',
        event_type: null,
        occurred_at: sqlDate,
        payload: {
          jobId: JOB_ID,
          createdAt: T_1_DIGIT,
          actor: { kind: 'system', component: 'orchestrator' },
        },
        append_sequence: '1',
      };

      const record = mapRowToStoredRecord(row);
      assert.equal(record.occurredAt, T_1_DIGIT);
      assert.equal(record.payload.createdAt, T_1_DIGIT);

      // Divergência real de 1ms
      const divergedRow = {
        ...row,
        occurred_at: new Date('2026-09-25T12:00:00.101Z'),
      };
      assert.throws(
        () => mapRowToStoredRecord(divergedRow),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Mismatch between row occurred_at'),
      );
    });

    it('Seção 17: mapStoredRecordToCreateJobParams sem payload.createdAt falha fechado (sem fallback para occurredAt)', () => {
      const recordWithoutCreatedAt = {
        jobId: JOB_ID,
        revision: 1,
        recordKind: 'created' as const,
        occurredAt: T0,
        payload: {
          jobId: JOB_ID,
          actor: { kind: 'system', component: 'orchestrator' },
          // createdAt ausente
        },
        appendSequence: '1',
      };

      assert.throws(
        () => mapStoredRecordToCreateJobParams(recordWithoutCreatedAt as any),
        (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes('Creation payload missing createdAt'),
      );
    });

    it('Seção 17: mapStoredRecordToJobEvent sem timestamp factual no payload falha fechado (sem fallback para occurredAt)', () => {
      const eventTypes = [
        { type: 'JobStarted', missing: 'startedAt', payload: {} },
        { type: 'JobAttemptCorrelated', missing: 'correlatedAt', payload: { attemptId: 'att_1' } },
        { type: 'JobWaiting', missing: 'transitionedAt', payload: { cause: { kind: 'human', reasonCode: 'HUMAN', requestedAt: T0 } } },
        { type: 'JobYieldedWaiting', missing: 'resumedAt', payload: {} },
        { type: 'JobControlRequested', missing: 'requestedAt', payload: { intent: 'pause' } },
        { type: 'JobPaused', missing: 'pausedAt', payload: {} },
        { type: 'JobResumed', missing: 'resumedAt', payload: {} },
        { type: 'JobSucceeded', missing: 'finishedAt', payload: {} },
        { type: 'JobFailed', missing: 'finishedAt', payload: { reasonCode: 'ERR' } },
        { type: 'JobCancelled', missing: 'finishedAt', payload: {} },
      ];

      for (const item of eventTypes) {
        const record = {
          jobId: JOB_ID,
          revision: 2,
          recordKind: 'transition' as const,
          eventType: item.type as any,
          occurredAt: T0,
          payload: item.payload,
          appendSequence: '2',
        };

        assert.throws(
          () => mapStoredRecordToJobEvent(record as any),
          (err: any) => err instanceof CorruptedJobStorageError && err.detail.includes(`missing ${item.missing}`),
          `Deveria falhar para ${item.type} sem ${item.missing}`,
        );
      }
    });

    it('Payloads aninhados preservam strings canônicas de timestamp sem normalização', () => {
      // HumanWaitingCause
      const humanCause = {
        kind: 'human',
        reasonCode: 'HUMAN_APPROVAL',
        requestedAt: T_1_DIGIT,
        deadline: T_2_DIGIT,
      };
      const rowHuman = {
        job_id: JOB_ID,
        status: 'waiting',
        revision: 2,
        created_at: new Date('2026-09-25T12:00:00.100Z'),
        updated_at: new Date('2026-09-25T12:00:00.100Z'),
        started_at: new Date('2026-09-25T12:00:00.100Z'),
        finished_at: null,
        state_payload: {
          jobId: JOB_ID,
          status: 'waiting',
          revision: 2,
          actor: { kind: 'system', component: 'orchestrator' },
          createdAt: T_1_DIGIT,
          updatedAt: T_1_DIGIT,
          startedAt: T_1_DIGIT,
          attemptLineage: ['att_1'],
          waitingCause: humanCause,
        },
      };
      const mappedHuman = mapRowToJobState(rowHuman);
      assert.equal(mappedHuman.waitingCause?.requestedAt, T_1_DIGIT);
      if (mappedHuman.waitingCause?.kind === 'human') {
        assert.equal(mappedHuman.waitingCause.deadline, T_2_DIGIT);
      }

      // JobProgress
      const progressPayload = {
        completed: 40,
        total: 100,
        updatedAt: T_1_DIGIT,
      };
      const rowProgress = {
        ...rowHuman,
        status: 'running',
        state_payload: {
          ...rowHuman.state_payload,
          status: 'running',
          waitingCause: undefined,
          progress: progressPayload,
        },
      };
      const mappedProgress = mapRowToJobState(rowProgress);
      assert.equal(mappedProgress.progress?.updatedAt, T_1_DIGIT);
    });
  });
});
