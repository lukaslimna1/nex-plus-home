/**
 * NEX+ · Job Runtime Boundary — Unit Tests
 * Testes Unitários de Payload de Wake-up — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Cobertura Obrigatória de Invariantes:
 * A. Payload válido { jobId }
 * B. jobId vazio
 * C. jobId whitespace-only
 * D. Payload null / undefined / primitivo
 * E. Payload array
 * F. Payload com chave desconhecida
 * G. Payload com sessionRef
 * H. Payload com token
 * I. Payload com state
 * J. Payload com actor
 * K. Payload com headers
 * + Imutabilidade profunda (Object.freeze)
 * + Preservação textual exata do jobId
 * + Rejeição de symbol properties
 * + Rejeição de prototypes customizados
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseJobWakeupPayload,
  assertJobWakeupPayload,
  JobWakeupPayloadError,
} from '../invariants';

describe('Job Runtime Boundary — Wake-up Payload Invariants (0.86C-3A)', () => {
  // ==========================================================================
  // CASOS POSITIVOS
  // ==========================================================================

  it('A. aceita payload canônico estrito { jobId } válido e preserva valor textual exato', () => {
    const raw = { jobId: 'job_01J8ABC123XYZ' };
    const payload = parseJobWakeupPayload(raw);

    assert.equal(payload.jobId, 'job_01J8ABC123XYZ');
    assert.deepEqual(Object.keys(payload), ['jobId']);
    assert.ok(Object.isFrozen(payload), 'Payload deve ser congelado/imutável');

    // Validação de asserção TypeScript
    assert.doesNotThrow(() => assertJobWakeupPayload(raw));
  });

  it('preserva caracteres especiais e formato textual exato do jobId', () => {
    const complexId = 'job-uuid:430c04c2-c812-4a2d-8a36-eb90ff0ab281/task#1';
    const payload = parseJobWakeupPayload({ jobId: complexId });
    assert.equal(payload.jobId, complexId);
  });

  // ==========================================================================
  // CASOS NEGATIVOS DE IDENTIFICADOR (jobId)
  // ==========================================================================

  it('B. rejeita payload com jobId vazio', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: '' }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'INVALID_JOB_ID');
        assert.match(err.message, /empty or whitespace-only/i);
        return true;
      }
    );
  });

  it('C. rejeita payload com jobId whitespace-only', () => {
    const whitespaceCases = ['   ', '\t', '\n', ' \t \r\n '];
    for (const ws of whitespaceCases) {
      assert.throws(
        () => parseJobWakeupPayload({ jobId: ws }),
        (err: unknown) => {
          assert.ok(err instanceof JobWakeupPayloadError);
          assert.equal(err.code, 'INVALID_JOB_ID');
          return true;
        }
      );
    }
  });

  it('rejeita payload onde jobId não é string (número, boolean, objeto, null)', () => {
    const nonStringJobIds = [123, true, false, null, undefined, {}, []];
    for (const badId of nonStringJobIds) {
      assert.throws(
        () => parseJobWakeupPayload({ jobId: badId }),
        (err: unknown) => {
          assert.ok(err instanceof JobWakeupPayloadError);
          return true;
        }
      );
    }
  });

  // ==========================================================================
  // CASOS NEGATIVOS DE TIPO DE PAYLOAD
  // ==========================================================================

  it('D. rejeita payload null, undefined e tipos primitivos', () => {
    const nonObjectCases = [null, undefined, 42, 'string', true, Symbol('test')];
    for (const badPayload of nonObjectCases) {
      assert.throws(
        () => parseJobWakeupPayload(badPayload),
        (err: unknown) => {
          assert.ok(err instanceof JobWakeupPayloadError);
          assert.equal(err.code, 'INVALID_WAKEUP_PAYLOAD_TYPE');
          return true;
        }
      );
    }
  });

  it('E. rejeita payload array (mesmo contendo jobId)', () => {
    assert.throws(
      () => parseJobWakeupPayload([{ jobId: 'job_123' }]),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'INVALID_WAKEUP_PAYLOAD_TYPE');
        assert.equal(err.receivedType, 'array');
        return true;
      }
    );
  });

  it('rejeita objetos com prototypes customizados (anti prototype-pollution)', () => {
    class CustomPayload {
      jobId = 'job_123';
    }
    assert.throws(
      () => parseJobWakeupPayload(new CustomPayload()),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'INVALID_WAKEUP_PAYLOAD_TYPE');
        return true;
      }
    );
  });

  // ==========================================================================
  // CASOS NEGATIVOS DE CAMPOS PROIBIDOS / DESCONHECIDOS
  // ==========================================================================

  it('F. rejeita payload com chave desconhecida genérica', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: 'job_123', extraProp: 'forbidden' }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        assert.deepEqual(err.forbiddenFields, ['extraProp']);
        return true;
      }
    );
  });

  it('G. rejeita especificamente tentativa de incluir sessionRef', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: 'job_123', sessionRef: 'sess_abc' }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        assert.ok(err.forbiddenFields?.includes('sessionRef'));
        return true;
      }
    );
  });

  it('H. rejeita especificamente tentativa de incluir token / jwt', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: 'job_123', token: 'bearer-secret-token' }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        assert.ok(err.forbiddenFields?.includes('token'));
        return true;
      }
    );
  });

  it('I. rejeita especificamente tentativa de incluir state / JobState', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: 'job_123', state: { status: 'running' } }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        assert.ok(err.forbiddenFields?.includes('state'));
        return true;
      }
    );
  });

  it('J. rejeita especificamente tentativa de incluir actor', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: 'job_123', actor: { type: 'system', id: 'sys' } }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        assert.ok(err.forbiddenFields?.includes('actor'));
        return true;
      }
    );
  });

  it('K. rejeita especificamente tentativa de incluir headers', () => {
    assert.throws(
      () => parseJobWakeupPayload({ jobId: 'job_123', headers: { authorization: 'secret' } }),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        assert.ok(err.forbiddenFields?.includes('headers'));
        return true;
      }
    );
  });

  it('rejeita tentativa de incluir propriedades Symbol', () => {
    const sym = Symbol('secret');
    const rawWithSymbol = { jobId: 'job_123', [sym]: 'hidden' };
    assert.throws(
      () => parseJobWakeupPayload(rawWithSymbol),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'FORBIDDEN_PAYLOAD_FIELD');
        return true;
      }
    );
  });

  it('rejeita payload vazio {}', () => {
    assert.throws(
      () => parseJobWakeupPayload({}),
      (err: unknown) => {
        assert.ok(err instanceof JobWakeupPayloadError);
        assert.equal(err.code, 'INVALID_WAKEUP_PAYLOAD_SHAPE');
        return true;
      }
    );
  });
});
