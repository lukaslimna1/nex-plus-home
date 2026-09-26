/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Testes Focados de Serialização e Trust Boundary (assertPlainObject Hardening) — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlainObject } from '../serialization';
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
});
