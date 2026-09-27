/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Testes Focados de Serialização e Trust Boundary (assertPlainObject Hardening) — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlainObject, formatPgTimestampToUtcInstant } from '../serialization';
import { deepCloneAndFreeze } from '../../ledger';
import { CorruptedLedgerRowError } from '../errors';

describe('0.86C-2A · Serialization Trust Boundary: assertPlainObject Hardening', () => {
  const TABLE = 'test_table';
  const FIELD = 'test_field';
  const ENTITY_ID = 'test_entity_01';

  describe('Casos Válidos (Plain Objects)', () => {
    it('Aceita objeto literal JSON padrão com Object.prototype', () => {
      const input = { key: 'value', count: 10, flag: true };
      const result = assertPlainObject(input, TABLE, FIELD, ENTITY_ID);

      assert.deepEqual(result, { key: 'value', count: 10, flag: true });
      assert.ok(Object.isFrozen(result));
    });

    it('Aceita objeto literal aninhado e congela recursivamente', () => {
      const input = {
        metadata: {
          nested: {
            deepKey: 'deepValue',
          },
        },
      };
      const result = assertPlainObject(input, TABLE, FIELD, ENTITY_ID);

      assert.deepEqual(result, input);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen((result as any).metadata));
      assert.ok(Object.isFrozen((result as any).metadata.nested));
    });

    it('Aceita Object.create(null) preservando compatibilidade', () => {
      const nullProtoObj = Object.create(null);
      nullProtoObj.customProp = 'safe_fact';

      const result = assertPlainObject(nullProtoObj, TABLE, FIELD, ENTITY_ID);
      assert.equal(result.customProp, 'safe_fact');
      assert.ok(Object.isFrozen(result));
    });

    it('Aceita objeto vazio {}', () => {
      const result = assertPlainObject({}, TABLE, FIELD, ENTITY_ID);
      assert.deepEqual(result, {});
      assert.ok(Object.isFrozen(result));
    });
  });

  describe('Casos Inválidos Rejeitados com CorruptedLedgerRowError', () => {
    it('Rejeita Date com CorruptedLedgerRowError', () => {
      const dateVal = new Date();
      assert.throws(
        () => assertPlainObject(dateVal, TABLE, FIELD, ENTITY_ID),
        (err: any) => {
          assert.ok(err instanceof CorruptedLedgerRowError);
          assert.equal(err.table, TABLE);
          assert.equal(err.entityId, ENTITY_ID);
          assert.match(err.message, /must be a non-null plain JSON object/i);
          return true;
        },
      );
    });

    it('Rejeita Map com CorruptedLedgerRowError', () => {
      const mapVal = new Map([['k', 'v']]);
      assert.throws(
        () => assertPlainObject(mapVal, TABLE, FIELD, ENTITY_ID),
        (err: any) => {
          assert.ok(err instanceof CorruptedLedgerRowError);
          assert.equal(err.table, TABLE);
          assert.equal(err.entityId, ENTITY_ID);
          assert.match(err.message, /must be a non-null plain JSON object/i);
          return true;
        },
      );
    });

    it('Rejeita Set com CorruptedLedgerRowError', () => {
      const setVal = new Set(['item']);
      assert.throws(
        () => assertPlainObject(setVal, TABLE, FIELD, ENTITY_ID),
        (err: any) => {
          assert.ok(err instanceof CorruptedLedgerRowError);
          assert.equal(err.table, TABLE);
          assert.equal(err.entityId, ENTITY_ID);
          assert.match(err.message, /must be a non-null plain JSON object/i);
          return true;
        },
      );
    });

    it('Rejeita instância de classe customizada com CorruptedLedgerRowError', () => {
      class DomainModel {
        id = 'dm_01';
      }
      const instance = new DomainModel();

      assert.throws(
        () => assertPlainObject(instance, TABLE, FIELD, ENTITY_ID),
        (err: any) => {
          assert.ok(err instanceof CorruptedLedgerRowError);
          assert.equal(err.table, TABLE);
          assert.equal(err.entityId, ENTITY_ID);
          assert.match(err.message, /must be a non-null plain JSON object/i);
          return true;
        },
      );
    });

    it('Rejeita null e undefined', () => {
      assert.throws(
        () => assertPlainObject(null, TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
      assert.throws(
        () => assertPlainObject(undefined, TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita array []', () => {
      assert.throws(
        () => assertPlainObject([1, 2, 3], TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });

    it('Rejeita valores primitivos', () => {
      assert.throws(
        () => assertPlainObject('string_value', TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
      assert.throws(
        () => assertPlainObject(42, TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
      assert.throws(
        () => assertPlainObject(true, TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
      assert.throws(
        () => assertPlainObject(Symbol('sym'), TABLE, FIELD, ENTITY_ID),
        (err: any) => err instanceof CorruptedLedgerRowError,
      );
    });
  });

  describe('F-01 · formatPgTimestampToUtcInstant: Validação Estrita de ISO UTC Canônico', () => {
    it('Aceita strings ISO UTC canônicas com e sem frações de segundo e normaliza para ISO UTC', () => {
      assert.equal(
        formatPgTimestampToUtcInstant('2026-09-25T12:00:00Z', TABLE, FIELD, ENTITY_ID),
        '2026-09-25T12:00:00.000Z',
      );
      assert.equal(
        formatPgTimestampToUtcInstant('2026-09-25T12:00:00.1Z', TABLE, FIELD, ENTITY_ID),
        '2026-09-25T12:00:00.100Z',
      );
      assert.equal(
        formatPgTimestampToUtcInstant('2026-09-25T12:00:00.12Z', TABLE, FIELD, ENTITY_ID),
        '2026-09-25T12:00:00.120Z',
      );
      assert.equal(
        formatPgTimestampToUtcInstant('2026-09-25T12:00:00.123Z', TABLE, FIELD, ENTITY_ID),
        '2026-09-25T12:00:00.123Z',
      );
    });

    it('Aceita Date válido retornado pelo driver do PostgreSQL e retorna ISO UTC string', () => {
      const driverDate = new Date('2026-09-25T12:00:00.000Z');
      const result = formatPgTimestampToUtcInstant(driverDate, TABLE, FIELD, ENTITY_ID);
      assert.equal(result, '2026-09-25T12:00:00.000Z');
    });

    it('Rejeita strings fora do padrão canônico ou com overflow de calendário com CorruptedLedgerRowError', () => {
      const rejectedStrings = [
        'September 25, 2026 12:00:00',
        '2026-09-25 12:00:00',
        '2026-09-25T12:00:00',
        '2026-09-25T12:00:00-03:00',
        '2026-09-25T12:00:00+03:00',
        '2026-02-30T12:00:00Z',
        'banana',
        '',
        '   ',
      ];

      for (const str of rejectedStrings) {
        assert.throws(
          () => formatPgTimestampToUtcInstant(str, TABLE, FIELD, ENTITY_ID),
          (err: any) => {
            assert.ok(err instanceof CorruptedLedgerRowError);
            assert.equal(err.table, TABLE);
            assert.equal(err.entityId, ENTITY_ID);
            return true;
          },
          `Deveria ter rejeitado: '${str}'`,
        );
      }
    });

    it('Rejeita Date inválido (NaN) com CorruptedLedgerRowError', () => {
      const invalidDate = new Date(NaN);
      assert.throws(
        () => formatPgTimestampToUtcInstant(invalidDate, TABLE, FIELD, ENTITY_ID),
        (err: any) => {
          assert.ok(err instanceof CorruptedLedgerRowError);
          assert.equal(err.table, TABLE);
          assert.equal(err.entityId, ENTITY_ID);
          assert.match(err.message, /invalid Date object/i);
          return true;
        },
      );
    });

    it('Rejeita tipos não-temporais (números, booleans, objetos)', () => {
      assert.throws(() => formatPgTimestampToUtcInstant(123456789, TABLE, FIELD, ENTITY_ID), (err: any) => err instanceof CorruptedLedgerRowError);
      assert.throws(() => formatPgTimestampToUtcInstant(null, TABLE, FIELD, ENTITY_ID), (err: any) => err instanceof CorruptedLedgerRowError);
      assert.throws(() => formatPgTimestampToUtcInstant(undefined, TABLE, FIELD, ENTITY_ID), (err: any) => err instanceof CorruptedLedgerRowError);
      assert.throws(() => formatPgTimestampToUtcInstant({}, TABLE, FIELD, ENTITY_ID), (err: any) => err instanceof CorruptedLedgerRowError);
    });
  });

  describe('F-02 · deepCloneAndFreeze e assertPlainObject: Proteção Contra Poluição de __proto__', () => {
    it('deepCloneAndFreeze não altera protótipo ao clonar JSON com chave __proto__', () => {
      const jsonStr = '{"__proto__":{"polluted":true},"ok":1}';
      const input = JSON.parse(jsonStr);

      const result = deepCloneAndFreeze(input);

      // 1. Prototype continua sendo Object.prototype (não null, não poluído)
      assert.equal(Object.getPrototypeOf(result), Object.prototype);

      // 2. Não herda a propriedade polluted no prototype
      assert.equal((result as any).polluted, undefined);

      // 3. __proto__ permanece propriedade própria (own property)
      assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), true);

      // 4. Valor original de __proto__ permanece acessível como dado
      const protoPropVal = Object.getOwnPropertyDescriptor(result, '__proto__')?.value;
      assert.deepEqual(protoPropVal, { polluted: true });
      assert.ok(Object.isFrozen(protoPropVal));

      // 5. Objeto permanece frozen
      assert.ok(Object.isFrozen(result));
      assert.equal((result as any).ok, 1);
    });

    it('deepCloneAndFreeze protege recursivamente contra __proto__ aninhado', () => {
      const jsonStr = '{"nested":{"__proto__":{"polluted":true},"flag":"safe"}}';
      const input = JSON.parse(jsonStr);

      const result = deepCloneAndFreeze(input);

      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal((result as any).polluted, undefined);

      const nested = (result as any).nested;
      assert.equal(Object.getPrototypeOf(nested), Object.prototype);
      assert.equal(nested.polluted, undefined);
      assert.equal(Object.prototype.hasOwnProperty.call(nested, '__proto__'), true);
      assert.deepEqual(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value, { polluted: true });
      assert.equal(nested.flag, 'safe');
      assert.ok(Object.isFrozen(nested));
      assert.ok(Object.isFrozen(result));
    });

    it('assertPlainObject protege boundary completo contra poluição de __proto__', () => {
      const jsonStr = '{"__proto__":{"polluted":true},"fact":"verified"}';
      const input = JSON.parse(jsonStr);

      const result = assertPlainObject(input, TABLE, FIELD, ENTITY_ID);

      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal((result as any).polluted, undefined);
      assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), true);
      assert.deepEqual(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, { polluted: true });
      assert.equal((result as any).fact, 'verified');
      assert.ok(Object.isFrozen(result));
    });

    it('deepCloneAndFreeze mantém comportamento e integridade em Arrays', () => {
      const arr = [1, { a: 'test' }, [2, 3]];
      const result = deepCloneAndFreeze(arr);

      assert.ok(Array.isArray(result));
      assert.ok(Object.isFrozen(result));
      assert.deepEqual(result, [1, { a: 'test' }, [2, 3]]);
      assert.ok(Object.isFrozen(result[1]));
      assert.ok(Object.isFrozen(result[2]));
    });
  });
});
