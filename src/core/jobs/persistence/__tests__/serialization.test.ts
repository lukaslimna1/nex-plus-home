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
  serializeCreateJobParams,
  serializeJobEvent,
  serializeJobState,
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
});
