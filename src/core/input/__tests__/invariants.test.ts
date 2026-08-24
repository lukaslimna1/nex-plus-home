/**
 * NEX+ · Testes Unitários e Adversariais de Invariantes de Input & Ingress Content
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3 · Rodada B3-R1)
 *
 * Cobertura de Invariantes:
 * A. Multipart ordenado com todas as variantes canônicas.
 * B. Parts vazias rejeitadas.
 * C. Variantes híbridas rejeitadas.
 * D. Chaves extras rejeitadas.
 * E. source_ref como InputPart rejeitado.
 * F. Allowlist estrita de Actor e validação de SessionRef/userId.
 * G. Rejeição de contextSubjectRef: null (deve ser ausente/undefined para pessoal).
 * H. Validação de formato e temporalidade canônica compartilhada (UTC ISO 8601 com 'Z').
 * I. Rejeição de whitespace externo em SourceEventIdentity (" source", "source ", " id", "id ").
 * J. Imutabilidade profunda com cópia defensiva estruturada por variante.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HumanActor } from '../../observations/contracts';
import type { SessionRef } from '../../../auth/session-ref.types';
import type { ContextSubjectRef, ContextSubjectType, ContextSubjectId } from '../../context/contracts';
import type { ModuleKey, ResourceType, ResourceId, EventId } from '../../modules/contracts';
import { isCanonicalUtcInstant } from '../../context/invariants';
import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  InputPart,
  InputRecord,
  IngressContentRecord,
} from '../contracts';
import {
  validateInputRecordId,
  validateIngressContentId,
  validateSourceEventIdentity,
  sanitizeSourceEventIdentity,
  validateIngressContentRef,
  validateResourceRef,
  validateInputPart,
  sanitizeInputPart,
  validateActor,
  validateInputRecord,
  validateIngressContentRecord,
} from '../invariants';

describe('0.86B-3 · Invariantes de Input & Ingress Content (Runtime Strictness · B3-R1)', () => {
  const VALID_SESSION_REF = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const VALID_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const humanLucas: HumanActor = {
    kind: 'human',
    humanId: 'usr_lucas_123',
    role: 'partner',
  };

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  // ==========================================================================
  // 1. IDENTIFICADORES
  // ==========================================================================

  it('valida InputRecordId e IngressContentId não vazios', () => {
    assert.doesNotThrow(() => validateInputRecordId('inp_123'));
    assert.doesNotThrow(() => validateIngressContentId('ing_456'));

    assert.throws(() => validateInputRecordId(''), (err: any) => err.violationType === 'INVALID_INPUT_RECORD_ID');
    assert.throws(() => validateInputRecordId('   '), (err: any) => err.violationType === 'INVALID_INPUT_RECORD_ID');
    assert.throws(() => validateIngressContentId(''), (err: any) => err.violationType === 'INVALID_INGRESS_CONTENT_ID');
  });

  // ==========================================================================
  // 2. SOURCE EVENT IDENTITY & CANONICALIDADE ESTRITA
  // ==========================================================================

  it('valida SourceEventIdentity com source e id sem chaves extras', () => {
    const valid: SourceEventIdentity = { source: 'webhook_stripe', id: 'evt_123' };
    assert.doesNotThrow(() => validateSourceEventIdentity(valid));

    assert.throws(
      () => validateSourceEventIdentity({ source: 'stripe', id: '123', extra: true }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
    assert.throws(
      () => validateSourceEventIdentity({ source: '', id: '123' }),
      (err: any) => err.violationType === 'INVALID_SOURCE_EVENT_IDENTITY'
    );
    assert.throws(
      () => validateSourceEventIdentity({ source: 'stripe', id: '' }),
      (err: any) => err.violationType === 'INVALID_SOURCE_EVENT_IDENTITY'
    );
  });

  it('rejeita deterministamente SourceEventIdentity com whitespace externo (" source", "source ", " id", "id ")', () => {
    assert.throws(
      () => validateSourceEventIdentity({ source: ' stripe', id: 'evt_1' }),
      (err: any) => err.violationType === 'INVALID_SOURCE_EVENT_IDENTITY'
    );
    assert.throws(
      () => validateSourceEventIdentity({ source: 'stripe ', id: 'evt_1' }),
      (err: any) => err.violationType === 'INVALID_SOURCE_EVENT_IDENTITY'
    );
    assert.throws(
      () => validateSourceEventIdentity({ source: 'stripe', id: ' evt_1' }),
      (err: any) => err.violationType === 'INVALID_SOURCE_EVENT_IDENTITY'
    );
    assert.throws(
      () => validateSourceEventIdentity({ source: 'stripe', id: 'evt_1 ' }),
      (err: any) => err.violationType === 'INVALID_SOURCE_EVENT_IDENTITY'
    );
  });

  it('sanitizeSourceEventIdentity reconstrói e congela profundamente o objeto', () => {
    const original = { source: 'slack', id: 'msg_100' };
    const sanitized = sanitizeSourceEventIdentity(original);

    assert.deepEqual(sanitized, { source: 'slack', id: 'msg_100' });
    assert.ok(Object.isFrozen(sanitized));
    assert.notEqual(sanitized, original);
  });

  // ==========================================================================
  // 3. INGRESS CONTENT REF
  // ==========================================================================

  it('valida IngressContentRef sem expor storageKey nem hash', () => {
    const valid = { contentId: 'ing_123' as IngressContentId };
    assert.doesNotThrow(() => validateIngressContentRef(valid));

    assert.throws(
      () => validateIngressContentRef({ contentId: 'ing_123', storageKey: 'secret/path' }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
    assert.throws(
      () => validateIngressContentRef({ contentId: 'ing_123', sha256: VALID_SHA256 }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  // ==========================================================================
  // 4. RESOURCE REF
  // ==========================================================================

  it('valida ResourceRef mantendo ownerModule.moduleKey, resourceType e resourceId', () => {
    const valid = {
      ownerModule: { moduleKey: 'fornecedores' as ModuleKey },
      resourceType: 'supplier_card' as ResourceType,
      resourceId: 'sup_456' as ResourceId,
    };
    assert.doesNotThrow(() => validateResourceRef(valid));

    assert.throws(
      () =>
        validateResourceRef({
          ownerModule: { moduleKey: 'fornecedores', extra: true },
          resourceType: 'supplier_card',
          resourceId: 'sup_456',
        }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  // ==========================================================================
  // 5. INPUT PART (DISCRIMINATED UNION & DEEP SANITIZE)
  // ==========================================================================

  it('A. aceita todas as 5 variantes canônicas de InputPart com shape estrito', () => {
    const textPart: InputPart = { kind: 'text', text: 'Instrução do usuário' };
    const contentPart: InputPart = { kind: 'content_ref', content: { contentId: 'ing_123' as IngressContentId } };
    const eventPart: InputPart = { kind: 'event_ref', eventId: 'evt_999' as EventId };
    const resourcePart: InputPart = {
      kind: 'resource_ref',
      resource: {
        ownerModule: { moduleKey: 'radar' as ModuleKey },
        resourceType: 'monitored_item' as ResourceType,
        resourceId: 'item_1' as ResourceId,
      },
    };
    const evidencePart: InputPart = { kind: 'evidence_ref', evidenceArtifactId: 'art_555' as any };

    assert.doesNotThrow(() => validateInputPart(textPart));
    assert.doesNotThrow(() => validateInputPart(contentPart));
    assert.doesNotThrow(() => validateInputPart(eventPart));
    assert.doesNotThrow(() => validateInputPart(resourcePart));
    assert.doesNotThrow(() => validateInputPart(evidencePart));
  });

  it('sanitizeInputPart reconstrói e congela profundamente cada variante preservando texto original', () => {
    const rawText: InputPart = { kind: 'text', text: '  Texto com espaços preservados  ' };
    const sanitizedText = sanitizeInputPart(rawText);
    assert.equal(sanitizedText.kind, 'text');
    assert.equal((sanitizedText as any).text, '  Texto com espaços preservados  '); // Não trimado
    assert.ok(Object.isFrozen(sanitizedText));

    const rawResource: InputPart = {
      kind: 'resource_ref',
      resource: {
        ownerModule: { moduleKey: 'radar' as ModuleKey },
        resourceType: 'item' as ResourceType,
        resourceId: '123' as ResourceId,
      },
    };
    const sanitizedResource = sanitizeInputPart(rawResource);
    assert.ok(Object.isFrozen(sanitizedResource));
    assert.ok(Object.isFrozen((sanitizedResource as any).resource));
    assert.ok(Object.isFrozen((sanitizedResource as any).resource.ownerModule));
    assert.notEqual(sanitizedResource, rawResource);
  });

  it('B. rejeita texto vazio ou whitespace na variante text', () => {
    assert.throws(
      () => validateInputPart({ kind: 'text', text: '' }),
      (err: any) => err.violationType === 'INVALID_TEXT_PART'
    );
    assert.throws(
      () => validateInputPart({ kind: 'text', text: '   \n\t  ' }),
      (err: any) => err.violationType === 'INVALID_TEXT_PART'
    );
  });

  it('C. rejeita variantes híbridas de InputPart', () => {
    assert.throws(
      () => validateInputPart({ kind: 'text', text: 'Olá', eventId: 'evt_1' }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    assert.throws(
      () =>
        validateInputPart({
          kind: 'content_ref',
          content: { contentId: 'ing_1' as IngressContentId },
          storageKey: 'internal/key',
        }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    assert.throws(
      () =>
        validateInputPart({
          kind: 'resource_ref',
          resource: {
            ownerModule: { moduleKey: 'fornecedores' as ModuleKey },
            resourceType: 'sup' as ResourceType,
            resourceId: '1' as ResourceId,
          },
          evidenceArtifactId: 'art_1',
        }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('D. rejeita chaves extras em qualquer variante de InputPart', () => {
    assert.throws(
      () => validateInputPart({ kind: 'text', text: 'Teste', providerFileId: 'file-123' }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('E. rejeita explicitamente source_ref como modalidade de InputPart', () => {
    assert.throws(
      () => validateInputPart({ kind: 'source_ref', sourceRefId: 'src_123' }),
      (err: any) => err.violationType === 'SOURCE_REF_AS_INPUT_PART_PROHIBITED'
    );
  });

  // ==========================================================================
  // 6. ACTOR & AUTHORITY
  // ==========================================================================

  it('F. valida Actor allowlist estrita e rejeita chaves arbitrárias como jwt ou token', () => {
    assert.doesNotThrow(() => validateActor(humanLucas));
    assert.doesNotThrow(() => validateActor({ kind: 'max', maxVersion: '1.0' }));
    assert.doesNotThrow(() => validateActor({ kind: 'system', component: 'scheduler' }));
    assert.doesNotThrow(() => validateActor({ kind: 'integration', provider: 'slack' }));

    assert.throws(
      () => validateActor({ kind: 'human', humanId: 'usr_1', jwt: 'secret_token' }),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  // ==========================================================================
  // 7. INPUT RECORD (ENVELOPE CANÔNICO & TEMPORALIDADE COMPARTILHADA)
  // ==========================================================================

  it('valida temporalidade canônica compartilhada (ISO 8601 UTC com Z)', () => {
    // Aceita formatos canônicos válidos no Core
    assert.equal(isCanonicalUtcInstant('2026-08-24T21:00:00Z'), true);
    assert.equal(isCanonicalUtcInstant('2026-08-24T21:00:00.1Z'), true);
    assert.equal(isCanonicalUtcInstant('2026-08-24T21:00:00.12Z'), true);
    assert.equal(isCanonicalUtcInstant('2026-08-24T21:00:00.123Z'), true);

    // Rejeita offsets, sem Z ou datas inválidas
    assert.equal(isCanonicalUtcInstant('2026-08-24T21:00:00-03:00'), false);
    assert.equal(isCanonicalUtcInstant('2026-08-24T21:00:00'), false);
    assert.equal(isCanonicalUtcInstant('data_invalida'), false);
  });

  it('valida InputRecord completo e multipart', () => {
    const record: InputRecord = {
      inputId: 'inp_123' as InputRecordId,
      actor: humanLucas,
      userId: 'usr_lucas_123',
      sessionRef: VALID_SESSION_REF,
      contextSubjectRef: brandAlterstate,
      sourceRefId: 'src_manual' as any,
      sourceEventIdentity: { source: 'api', id: '1' },
      occurredAt: '2026-08-24T21:00:00.000Z',
      receivedAt: '2026-08-24T21:00:05.000Z',
      channel: 'web_dashboard' as any,
      correlationId: 'corr_123' as any,
      parts: [
        { kind: 'text', text: 'Veja esta imagem' },
        { kind: 'content_ref', content: { contentId: 'ing_photo_1' as IngressContentId } },
        { kind: 'text', text: 'E compare com o recurso anterior' },
        {
          kind: 'resource_ref',
          resource: {
            ownerModule: { moduleKey: 'radar' as ModuleKey },
            resourceType: 'item' as ResourceType,
            resourceId: 'item_1' as ResourceId,
          },
        },
      ],
    };

    assert.doesNotThrow(() => validateInputRecord(record));
  });

  it('rejeita InputRecord com parts vazio', () => {
    const invalid = {
      inputId: 'inp_123' as InputRecordId,
      actor: humanLucas,
      userId: 'usr_lucas_123',
      receivedAt: '2026-08-24T21:00:00.000Z',
      parts: [],
    };
    assert.throws(
      () => validateInputRecord(invalid),
      (err: any) => err.violationType === 'EMPTY_PARTS_ARRAY'
    );
  });

  it('rejeita InputRecord contendo contextSubjectRef: null', () => {
    const invalid = {
      inputId: 'inp_123' as InputRecordId,
      actor: humanLucas,
      userId: 'usr_lucas_123',
      contextSubjectRef: null,
      receivedAt: '2026-08-24T21:00:00.000Z',
      parts: [{ kind: 'text', text: 'Olá' }],
    };
    assert.throws(
      () => validateInputRecord(invalid),
      (err: any) => err.violationType === 'INVALID_CONTEXT_SUBJECT_REF'
    );
  });

  it('rejeita InputRecord com sessionRef sem userId ou com actor/user mismatch', () => {
    const missingUser = {
      inputId: 'inp_123' as InputRecordId,
      actor: humanLucas,
      sessionRef: VALID_SESSION_REF,
      receivedAt: '2026-08-24T21:00:00.000Z',
      parts: [{ kind: 'text', text: 'Olá' }],
    };
    assert.throws(
      () => validateInputRecord(missingUser),
      (err: any) => err.violationType === 'SESSION_REF_WITHOUT_USER_ID'
    );

    const userMismatch = {
      inputId: 'inp_123' as InputRecordId,
      actor: humanLucas, // humanId: 'usr_lucas_123'
      userId: 'usr_joao_456',
      sessionRef: VALID_SESSION_REF,
      receivedAt: '2026-08-24T21:00:00.000Z',
      parts: [{ kind: 'text', text: 'Olá' }],
    };
    assert.throws(
      () => validateInputRecord(userMismatch),
      (err: any) => err.violationType === 'ACTOR_USER_MISMATCH'
    );
  });

  // ==========================================================================
  // 8. INGRESS CONTENT RECORD
  // ==========================================================================

  it('valida IngressContentRecord append-only com metadata de verificação', () => {
    const valid: IngressContentRecord = {
      contentId: 'ing_doc_1' as IngressContentId,
      actor: humanLucas,
      userId: 'usr_lucas_123',
      sessionRef: VALID_SESSION_REF,
      contextSubjectRef: brandAlterstate,
      declaredMimeType: 'application/pdf',
      verifiedMimeType: 'application/pdf',
      sha256: VALID_SHA256,
      byteSize: 1024,
      storageBackend: 'local_fs',
      storageKey: `sha256/e3/b0/${VALID_SHA256}`,
      receivedAt: '2026-08-24T21:00:00.000Z',
      expiresAt: '2026-08-26T21:00:00.000Z',
    };

    assert.doesNotThrow(() => validateIngressContentRecord(valid));
  });

  it('rejeita IngressContentRecord com expiresAt anterior a receivedAt', () => {
    const invalid: IngressContentRecord = {
      contentId: 'ing_doc_1' as IngressContentId,
      actor: humanLucas,
      verifiedMimeType: 'image/png',
      sha256: VALID_SHA256,
      byteSize: 500,
      storageBackend: 'local_fs',
      storageKey: `sha256/e3/b0/${VALID_SHA256}`,
      receivedAt: '2026-08-24T21:00:00.000Z',
      expiresAt: '2026-08-24T20:00:00.000Z',
    };

    assert.throws(
      () => validateIngressContentRecord(invalid),
      (err: any) => err.violationType === 'INVALID_EXPIRES_AT_ORDER'
    );
  });
});
