/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Testes Unitários de Invariantes e Validação Defensiva (0.86C-3B)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertJobId,
  assertWorkerId,
  assertFencingToken,
  assertLeaseDurationMs,
  assertAcquireJobClaimParams,
  assertRenewJobClaimParams,
  assertReleaseJobClaimParams,
  FENCING_TOKEN_REGEX,
} from '../invariants';
import { JobClaimInvariantsError } from '../errors';

describe('Canonical Job Claims — Invariants & Defensive Bounds (0.86C-3B)', () => {
  describe('assertJobId', () => {
    it('aceita jobId válido não-vazio', () => {
      assert.doesNotThrow(() => assertJobId('job_123'));
      assert.doesNotThrow(() => assertJobId('01J8NEXPLUS001'));
    });

    it('rejeita jobId vazio, whitespace ou não-string', () => {
      const invalid = ['', '   ', '\t\n', null, undefined, 123, {}, []];
      for (const val of invalid) {
        assert.throws(
          () => assertJobId(val),
          (err: unknown) => {
            assert.ok(err instanceof JobClaimInvariantsError);
            assert.equal(err.code, 'INVALID_CLAIM_PARAM');
            return true;
          }
        );
      }
    });
  });

  describe('assertWorkerId', () => {
    it('aceita workerId opaco válido e preserva identidade', () => {
      assert.doesNotThrow(() => assertWorkerId('worker-node-1'));
      assert.doesNotThrow(() => assertWorkerId('pid_9921_host'));
      assert.doesNotThrow(() => assertWorkerId('01J8NEX_WORKER_ALPHA'));
    });

    it('rejeita workerId vazio, whitespace ou não-string', () => {
      const invalid = ['', '   ', '\t', null, undefined, 42, {}];
      for (const val of invalid) {
        assert.throws(
          () => assertWorkerId(val),
          (err: unknown) => {
            assert.ok(err instanceof JobClaimInvariantsError);
            assert.equal(err.code, 'INVALID_CLAIM_PARAM');
            return true;
          }
        );
      }
    });
  });

  describe('assertFencingToken & FENCING_TOKEN_REGEX', () => {
    it('aceita tokens decimais estritamente positivos', () => {
      assert.equal(FENCING_TOKEN_REGEX.test('1'), true);
      assert.equal(FENCING_TOKEN_REGEX.test('2'), true);
      assert.equal(FENCING_TOKEN_REGEX.test('193'), true);
      assert.equal(FENCING_TOKEN_REGEX.test('1000000000000000'), true);

      assert.doesNotThrow(() => assertFencingToken('1'));
      assert.doesNotThrow(() => assertFencingToken('42'));
      assert.doesNotThrow(() => assertFencingToken('999999'));
    });

    it('rejeita tokens inválidos: zero, negativos, decimais, octais, expoentes, whitespace, números JS', () => {
      const invalid = [
        '0',
        '-1',
        '-42',
        '01',
        '002',
        '1.5',
        '1e3',
        ' 1 ',
        '',
        'one',
        1 as unknown as string,
        BigInt(1) as unknown as string,
        null,
        undefined,
      ];

      for (const val of invalid) {
        assert.throws(
          () => assertFencingToken(val),
          (err: unknown) => {
            assert.ok(err instanceof JobClaimInvariantsError);
            assert.equal(err.code, 'INVALID_CLAIM_PARAM');
            return true;
          }
        );
      }
    });
  });

  describe('assertLeaseDurationMs', () => {
    it('aceita duração em milissegundos inteira e positiva', () => {
      assert.doesNotThrow(() => assertLeaseDurationMs(1));
      assert.doesNotThrow(() => assertLeaseDurationMs(5000));
      assert.doesNotThrow(() => assertLeaseDurationMs(60000));
    });

    it('rejeita valores zero, negativos, decimais, não-finitos ou strings', () => {
      const invalid = [
        0,
        -1,
        -5000,
        0.5,
        1500.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '5000',
        null,
        undefined,
        {},
      ];

      for (const val of invalid) {
        assert.throws(
          () => assertLeaseDurationMs(val),
          (err: unknown) => {
            assert.ok(err instanceof JobClaimInvariantsError);
            assert.equal(err.code, 'INVALID_CLAIM_PARAM');
            return true;
          }
        );
      }
    });
  });

  describe('assertAcquireJobClaimParams, assertRenewJobClaimParams, assertReleaseJobClaimParams', () => {
    it('valida AcquireJobClaimParams completo', () => {
      assert.doesNotThrow(() =>
        assertAcquireJobClaimParams({
          jobId: 'job_1',
          workerId: 'worker_a',
          leaseDurationMs: 10000,
        })
      );

      assert.throws(() => assertAcquireJobClaimParams(null));
      assert.throws(() => assertAcquireJobClaimParams({ jobId: '', workerId: 'w', leaseDurationMs: 1000 }));
      assert.throws(() => assertAcquireJobClaimParams({ jobId: 'j', workerId: '', leaseDurationMs: 1000 }));
      assert.throws(() => assertAcquireJobClaimParams({ jobId: 'j', workerId: 'w', leaseDurationMs: 0 }));
    });

    it('valida RenewJobClaimParams completo', () => {
      assert.doesNotThrow(() =>
        assertRenewJobClaimParams({
          jobId: 'job_1',
          workerId: 'worker_a',
          fencingToken: '1',
          leaseDurationMs: 10000,
        })
      );

      assert.throws(() => assertRenewJobClaimParams(null));
      assert.throws(() => assertRenewJobClaimParams({ jobId: 'j', workerId: 'w', fencingToken: '0', leaseDurationMs: 1000 }));
      assert.throws(() => assertRenewJobClaimParams({ jobId: 'j', workerId: 'w', fencingToken: '1', leaseDurationMs: -1 }));
    });

    it('valida ReleaseJobClaimParams completo', () => {
      assert.doesNotThrow(() =>
        assertReleaseJobClaimParams({
          jobId: 'job_1',
          workerId: 'worker_a',
          fencingToken: '2',
        })
      );

      assert.throws(() => assertReleaseJobClaimParams(null));
      assert.throws(() => assertReleaseJobClaimParams({ jobId: '', workerId: 'w', fencingToken: '2' }));
      assert.throws(() => assertReleaseJobClaimParams({ jobId: 'j', workerId: '', fencingToken: '2' }));
      assert.throws(() => assertReleaseJobClaimParams({ jobId: 'j', workerId: 'w', fencingToken: 'bad' }));
    });
  });
});
