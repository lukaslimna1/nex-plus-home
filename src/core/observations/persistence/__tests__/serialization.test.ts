import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeToPgJsonb,
  parsePgJsonb,
  formatPgTimestampToUtcInstant,
} from '../serialization';
import { PersistenceInvariantViolationError } from '../errors';

describe('Escopo 0.85B · Serialização & Tratamento de Tipos de Persistência', () => {
  describe('serializeToPgJsonb', () => {
    it('Serializa objetos e arrays válidos preservando a estrutura', () => {
      const obj = { price: 49.9, tags: ['promo', 'summer'], nested: { a: 1 } };
      const serialized = serializeToPgJsonb(obj);
      assert.equal(typeof serialized, 'string');
      assert.deepEqual(JSON.parse(serialized), obj);
    });

    it('Preserva o valor explícito null sem transformar em undefined', () => {
      const serialized = serializeToPgJsonb(null, 'test_null');
      assert.equal(serialized, 'null');
    });

    it('Rejeita explicitamente valor undefined lançando PersistenceInvariantViolationError', () => {
      assert.throws(
        () => {
          serializeToPgJsonb(undefined, 'test_undefined');
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_SERIALIZATION');
          return true;
        }
      );
    });

    it('Rejeita estruturas circulares lançando PersistenceInvariantViolationError', () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      assert.throws(
        () => {
          serializeToPgJsonb(circular, 'test_circular');
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          return true;
        }
      );
    });
  });

  describe('parsePgJsonb', () => {
    it('Retorna null quando o valor de entrada é null', () => {
      assert.equal(parsePgJsonb(null), null);
    });

    it('Faz parse de string JSON quando necessário', () => {
      const parsed = parsePgJsonb<{ count: number }>('{"count": 42}');
      assert.deepEqual(parsed, { count: 42 });
    });

    it('Retorna o próprio objeto se já estiver parseado pelo driver pg', () => {
      const obj = { count: 42 };
      assert.equal(parsePgJsonb(obj), obj);
    });
  });

  describe('formatPgTimestampToUtcInstant', () => {
    it('Formata Date para string ISO 8601 UTC terminada em Z', () => {
      const d = new Date('2026-08-21T15:30:00.000Z');
      const instant = formatPgTimestampToUtcInstant(d);
      assert.equal(instant, '2026-08-21T15:30:00.000Z');
      assert.ok(instant.endsWith('Z'));
    });

    it('Aceita string ISO UTC já terminada em Z', () => {
      const instant = formatPgTimestampToUtcInstant('2026-08-21T15:30:00Z');
      assert.equal(instant, '2026-08-21T15:30:00Z');
    });

    it('Rejeita strings arbitrárias ou datas inválidas', () => {
      assert.throws(
        () => {
          formatPgTimestampToUtcInstant('invalid-date-string');
        },
        (err: unknown) => {
          assert.ok(err instanceof PersistenceInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_TIMESTAMP_DESERIALIZATION');
          return true;
        }
      );
    });
  });
});
