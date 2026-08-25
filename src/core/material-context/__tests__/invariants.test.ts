import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeJsonMaterialValue,
  sanitizeResourceRef,
  sanitizeContextAnchorRef,
  sanitizeContextAspectRef,
  sanitizeMaterialContextItem,
  validateMaterialContextPinId,
  validatePinMaterialContextDraft,
  validateMaterialContextPin,
} from '../invariants';
import { MaterialContextInvariantViolationError } from '../errors';
import type {
  MaterialInputRef,
  MaterialObservationRef,
  MaterialCanonicalProjectionRef,
  MaterialEvidenceRef,
  MaterialPrecedentRef,
  MaterialResourceRef,
  MaterialAspectSnapshot,
  MaterialContextPin,
} from '../contracts';
import type { ResourceRef } from '../../modules/contracts';
import type { ContextAspectRef } from '../../context/contracts';

describe('0.86B-4 · Material Context Pin Invariants & Sanitizers', () => {
  describe('1. JSON Material Value Validation & Sanitization', () => {
    it('aceita valores JSON primitivos válidos (string, número finito, boolean, null)', () => {
      assert.equal(sanitizeJsonMaterialValue('teste'), 'teste');
      assert.equal(sanitizeJsonMaterialValue(123.45), 123.45);
      assert.equal(sanitizeJsonMaterialValue(0), 0);
      assert.equal(sanitizeJsonMaterialValue(true), true);
      assert.equal(sanitizeJsonMaterialValue(false), false);
      assert.equal(sanitizeJsonMaterialValue(null), null);
    });

    it('aceita e congela profundamente arrays e objetos aninhados', () => {
      const obj = {
        title: 'Livro',
        price: 79.9,
        available: true,
        tags: ['promo', 'livros'],
        metadata: {
          edition: 2,
          notes: null,
        },
      };

      const sanitized = sanitizeJsonMaterialValue(obj) as any;
      assert.deepEqual(sanitized, obj);
      assert.ok(Object.isFrozen(sanitized));
      assert.ok(Object.isFrozen(sanitized.tags));
      assert.ok(Object.isFrozen(sanitized.metadata));

      // Imutabilidade defensiva
      assert.throws(() => {
        sanitized.price = 99.9;
      });
      assert.throws(() => {
        sanitized.tags.push('novo');
      });
    });

    it('rejeita undefined', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue(undefined),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_UNDEFINED');
          return true;
        }
      );
    });

    it('rejeita NaN, Infinity e -Infinity', () => {
      for (const val of [NaN, Infinity, -Infinity]) {
        assert.throws(
          () => sanitizeJsonMaterialValue(val),
          (err: any) => {
            assert.ok(err instanceof MaterialContextInvariantViolationError);
            assert.equal(err.violationType, 'INVALID_JSON_NUMBER');
            return true;
          }
        );
      }
    });

    it('rejeita BigInt', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue(BigInt(100)),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_BIGINT');
          return true;
        }
      );
    });

    it('rejeita function e symbol', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue(() => {}),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_TYPE');
          return true;
        }
      );
      assert.throws(
        () => sanitizeJsonMaterialValue(Symbol('test')),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_TYPE');
          return true;
        }
      );
    });

    it('rejeita Date instances', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue(new Date()),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_DATE_INSTANCE');
          return true;
        }
      );
    });

    it('rejeita Buffer instances', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue(Buffer.from('bytes')),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_BUFFER_INSTANCE');
          return true;
        }
      );
    });

    it('rejeita Map e Set', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue(new Map()),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_COLLECTION');
          return true;
        }
      );
      assert.throws(
        () => sanitizeJsonMaterialValue(new Set()),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_JSON_COLLECTION');
          return true;
        }
      );
    });

    it('rejeita referências circulares diretas (self)', () => {
      const circular: any = { a: 1 };
      circular.self = circular;
      assert.throws(
        () => sanitizeJsonMaterialValue(circular),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'CIRCULAR_REFERENCE_DETECTED');
          return true;
        }
      );
    });

    it('rejeita referências circulares indiretas (a -> b -> a)', () => {
      const a: any = { name: 'a' };
      const b: any = { name: 'b' };
      a.child = b;
      b.parent = a;
      assert.throws(
        () => sanitizeJsonMaterialValue(a),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'CIRCULAR_REFERENCE_DETECTED');
          return true;
        }
      );
    });

    it('aceita referências compartilhadas acíclicas (shared alias) com cópias independentes', () => {
      const x = { n: 1 };
      const value = {
        first: x,
        second: x,
      };

      const sanitized: any = sanitizeJsonMaterialValue(value);
      assert.deepEqual(sanitized, { first: { n: 1 }, second: { n: 1 } });
      assert.equal(sanitized.first.n, 1);
      assert.equal(sanitized.second.n, 1);

      // Mutação posterior no objeto original não altera o snapshot
      x.n = 999;
      assert.equal(sanitized.first.n, 1);
      assert.equal(sanitized.second.n, 1);
      assert.ok(Object.isFrozen(sanitized));
      assert.ok(Object.isFrozen(sanitized.first));
      assert.ok(Object.isFrozen(sanitized.second));
    });

    it('aceita referências compartilhadas acíclicas dentro de arrays', () => {
      const shared = { amount: 50 };
      const arr = [shared, shared];

      const sanitized: any = sanitizeJsonMaterialValue(arr);
      assert.deepEqual(sanitized, [{ amount: 50 }, { amount: 50 }]);
      shared.amount = 999;
      assert.equal(sanitized[0].amount, 50);
      assert.equal(sanitized[1].amount, 50);
      assert.ok(Object.isFrozen(sanitized));
      assert.ok(Object.isFrozen(sanitized[0]));
      assert.ok(Object.isFrozen(sanitized[1]));
    });

    it('teste adversarial __proto__: preserva dado sem poluir Object.prototype nem alterar protótipo', () => {
      const rawJson = '{"__proto__": {"polluted": true}, "normal": 42}';
      const parsed = JSON.parse(rawJson);

      const sanitized: any = sanitizeJsonMaterialValue(parsed);

      // 1. Não altera Object.prototype
      assert.equal((Object.prototype as any).polluted, undefined);

      // 2. O objeto canônico não ganha inherited polluted
      assert.equal(sanitized.polluted, undefined);

      // 3. __proto__ permanece como dado próprio ou acessível
      assert.ok(Object.prototype.hasOwnProperty.call(sanitized, '__proto__'));
      assert.deepEqual(sanitized.__proto__, { polluted: true });

      // 4. JSON.stringify do resultado preserva o campo
      assert.equal(JSON.stringify(sanitized), '{"__proto__":{"polluted":true},"normal":42}');

      // 5. Nested values ficam profundamente congelados
      assert.ok(Object.isFrozen(sanitized));
      assert.ok(Object.isFrozen(sanitized.__proto__));

      // 6. Mutação posterior no objeto original não altera o snapshot
      parsed.__proto__.polluted = false;
      assert.equal(sanitized.__proto__.polluted, true);
    });

    it('preserva chaves constructor e prototype como dados normais em JSON', () => {
      const raw = {
        constructor: 'CustomConstructor',
        prototype: { method: 'run' },
      };

      const sanitized: any = sanitizeJsonMaterialValue(raw);
      assert.equal(sanitized.constructor, 'CustomConstructor');
      assert.deepEqual(sanitized.prototype, { method: 'run' });
      assert.ok(Object.isFrozen(sanitized));
      assert.ok(Object.isFrozen(sanitized.prototype));
      assert.equal(JSON.stringify(sanitized), '{"constructor":"CustomConstructor","prototype":{"method":"run"}}');
    });

    it('rejeita classes arbitrárias', () => {
      class CustomItem {
        id = 1;
      }
      assert.throws(
        () => sanitizeJsonMaterialValue(new CustomItem()),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_CLASS_INSTANCE');
          return true;
        }
      );
    });

    it('rejeita propriedades undefined dentro de objetos', () => {
      assert.throws(
        () => sanitizeJsonMaterialValue({ foo: undefined }),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_OBJECT_UNDEFINED_PROPERTY');
          return true;
        }
      );
    });
  });

  describe('2. Sanitização de Todas as 7 Variantes Canônicas de MaterialContextItem', () => {
    const validResource: ResourceRef = {
      ownerModule: { moduleKey: 'catalog' as any },
      resourceType: 'product' as any,
      resourceId: 'prod_123' as any,
    };

    const validAspect: ContextAspectRef = {
      target: {
        kind: 'resource',
        resource: validResource,
      },
      aspectKey: 'price' as any,
    };

    it('1. input_ref válido', () => {
      const item: MaterialInputRef = {
        kind: 'input_ref',
        inputId: 'inp_abc' as any,
      };
      const res = sanitizeMaterialContextItem(item);
      assert.deepEqual(res, item);
      assert.ok(Object.isFrozen(res));
    });

    it('2. observation_ref válido', () => {
      const item: MaterialObservationRef = {
        kind: 'observation_ref',
        observationId: 'obs_123' as any,
      };
      const res = sanitizeMaterialContextItem(item);
      assert.deepEqual(res, item);
      assert.ok(Object.isFrozen(res));
    });

    it('3. canonical_projection_ref válido', () => {
      const item: MaterialCanonicalProjectionRef = {
        kind: 'canonical_projection_ref',
        projectionRevisionId: 'rev_proj_456' as any,
      };
      const res = sanitizeMaterialContextItem(item);
      assert.deepEqual(res, item);
      assert.ok(Object.isFrozen(res));
    });

    it('4. evidence_ref válido', () => {
      const item: MaterialEvidenceRef = {
        kind: 'evidence_ref',
        evidenceArtifactId: 'art_789' as any,
      };
      const res = sanitizeMaterialContextItem(item);
      assert.deepEqual(res, item);
      assert.ok(Object.isFrozen(res));
    });

    it('5. precedent_ref válido', () => {
      const item: MaterialPrecedentRef = {
        kind: 'precedent_ref',
        precedentId: 'prec_321' as any,
      };
      const res = sanitizeMaterialContextItem(item);
      assert.deepEqual(res, item);
      assert.ok(Object.isFrozen(res));
    });

    it('6. resource_ref válido', () => {
      const item: MaterialResourceRef = {
        kind: 'resource_ref',
        resource: validResource,
      };
      const res = sanitizeMaterialContextItem(item);
      assert.deepEqual(res, item);
      assert.ok(Object.isFrozen(res));
      assert.ok(Object.isFrozen((res as MaterialResourceRef).resource));
      assert.ok(Object.isFrozen((res as MaterialResourceRef).resource.ownerModule));
    });

    it('7. aspect_snapshot válido (com JSON null e com objeto)', () => {
      const itemWithNull: MaterialAspectSnapshot = {
        kind: 'aspect_snapshot',
        aspect: validAspect,
        value: null,
      };
      const resNull = sanitizeMaterialContextItem(itemWithNull);
      assert.deepEqual(resNull, itemWithNull);
      assert.equal((resNull as MaterialAspectSnapshot).value, null);

      const itemWithObj: MaterialAspectSnapshot = {
        kind: 'aspect_snapshot',
        aspect: validAspect,
        value: { amount: 79.9, currency: 'BRL' },
      };
      const resObj = sanitizeMaterialContextItem(itemWithObj);
      assert.deepEqual(resObj, itemWithObj);
      assert.ok(Object.isFrozen((resObj as MaterialAspectSnapshot).value));
    });
  });

  describe('3. Rejeição de Variantes Proibidas, Chaves Extras e Híbridos', () => {
    it('rejeita kinds não-canônicos e transitórios (content_ref, ingress_ref, event_ref, source_ref)', () => {
      const forbiddenKinds = [
        'content_ref',
        'ingress_ref',
        'event_ref',
        'source_ref',
        'review_ref',
        'reconciliation_ref',
        'arbitrary_ref',
      ];

      for (const kind of forbiddenKinds) {
        assert.throws(
          () => sanitizeMaterialContextItem({ kind, someId: '123' }),
          (err: any) => {
            assert.ok(err instanceof MaterialContextInvariantViolationError);
            assert.equal(err.violationType, 'UNSUPPORTED_ITEM_KIND');
            return true;
          }
        );
      }
    });

    it('rejeita chaves extras em input_ref', () => {
      assert.throws(
        () =>
          sanitizeMaterialContextItem({
            kind: 'input_ref',
            inputId: 'inp_123',
            extraField: 'unauthorized',
          }),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INPUT_REF_EXTRA_KEYS');
          return true;
        }
      );
    });

    it('rejeita variantes híbridas', () => {
      assert.throws(
        () =>
          sanitizeMaterialContextItem({
            kind: 'input_ref',
            inputId: 'inp_123',
            observationId: 'obs_123',
          }),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INPUT_REF_EXTRA_KEYS');
          return true;
        }
      );
    });

    it('rejeita aspect_snapshot sem propriedade value', () => {
      assert.throws(
        () =>
          sanitizeMaterialContextItem({
            kind: 'aspect_snapshot',
            aspect: {
              target: {
                kind: 'resource',
                resource: {
                  ownerModule: { moduleKey: 'mod' },
                  resourceType: 'type',
                  resourceId: 'id',
                },
              },
              aspectKey: 'key',
            },
          }),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'ASPECT_SNAPSHOT_MISSING_VALUE');
          return true;
        }
      );
    });
  });

  describe('4. Validação de PinMaterialContextDraft e MaterialContextPin', () => {
    it('rejeita draft com items vazio', () => {
      assert.throws(
        () => validatePinMaterialContextDraft({ items: [] }),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'EMPTY_ITEMS');
          return true;
        }
      );
    });

    it('rejeita draft com campos não autorizados (actor, pinnedAt, etc.)', () => {
      assert.throws(
        () =>
          validatePinMaterialContextDraft({
            items: [{ kind: 'input_ref', inputId: 'inp_123' }],
            actor: { kind: 'human', humanId: 'h1' },
          }),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'DRAFT_UNAUTHORIZED_KEY');
          return true;
        }
      );
    });

    it('valida MaterialContextPin canônico completo', () => {
      const validPin: MaterialContextPin = {
        pinId: 'pin_test_1' as any,
        actor: { kind: 'human', humanId: 'lucas' },
        userId: 'usr_lucas',
        sessionRef: 'sess_123' as any,
        contextSubjectRef: {
          subjectType: 'brand' as any,
          subjectId: 'brd_tea' as any,
        },
        flowRef: {
          flowType: 'checkout' as any,
          flowId: 'flw_999' as any,
        },
        correlationId: 'corr_xyz' as any,
        channel: 'web' as any,
        pinnedAt: '2026-08-25T02:00:00.000Z',
        items: [
          {
            kind: 'input_ref',
            inputId: 'inp_123' as any,
          },
        ],
      };

      assert.doesNotThrow(() => validateMaterialContextPin(validPin));
    });

    it('rejeita sessionRef sem userId', () => {
      const pinWithoutUser: any = {
        pinId: 'pin_test_1',
        actor: { kind: 'human', humanId: 'lucas' },
        sessionRef: 'sess_123',
        pinnedAt: '2026-08-25T02:00:00.000Z',
        items: [{ kind: 'input_ref', inputId: 'inp_123' }],
      };

      assert.throws(
        () => validateMaterialContextPin(pinWithoutUser),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'SESSION_WITHOUT_USER');
          return true;
        }
      );
    });

    it('rejeita pinnedAt inválido (sem UTC Z ou formato corrompido)', () => {
      const pinBadDate: any = {
        pinId: 'pin_test_1',
        actor: { kind: 'human', humanId: 'lucas' },
        pinnedAt: '2026-08-25 02:00:00',
        items: [{ kind: 'input_ref', inputId: 'inp_123' }],
      };

      assert.throws(
        () => validateMaterialContextPin(pinBadDate),
        (err: any) => {
          assert.ok(err instanceof MaterialContextInvariantViolationError);
          assert.equal(err.violationType, 'INVALID_PINNED_AT');
          return true;
        }
      );
    });
  });
});
