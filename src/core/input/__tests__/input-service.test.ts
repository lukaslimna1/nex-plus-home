/**
 * NEX+ · Testes Unitários e Adversariais do InputRecordService
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Provas:
 * 1. Derivação de autoridade estritamente a partir do OperationalContext do B2.
 * 2. InputRecord NÃO copia location, focus ou observedInteraction do OperationalContext.
 * 3. Preservação rigorosa da ordem e tipos de partes no multipart.
 * 4. content_ref exige conteúdo existente, não expirado e autorização attach_to_input.
 * 5. Reentrega com mesma SourceEventIdentity converge para o registro existente (deduplicated: true).
 * 6. Entradas idênticas sem SourceEventIdentity geram dois InputRecords legítimos distintos.
 * 7. Expiração posterior de IngressContent NÃO modifica o InputRecord histórico.
 * 8. event_ref, resource_ref e evidence_ref permanecem refs não-autoritativas.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HumanActor } from '../../observations/contracts';
import type { SessionRef } from '../../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  OperationalLocation,
  OperationalFocus,
  ObservedInteractionContext,
  OperationalContext,
} from '../../context/contracts';
import type { ModuleKey, ResourceType, ResourceId, EventId } from '../../modules/contracts';
import type {
  InputRecordId,
  IngressContentId,
  IngressContentRecord,
  InputRecord,
  InputPart,
  RecordInputDraft,
  IngressAccessAuthorizer,
} from '../contracts';
import {
  IngressAuthorizationError,
  IngressContentExpiredError,
  IngressContentNotFoundError,
  InputRecordNotFoundError,
} from '../errors';
import type {
  InputRecordStore,
  IngressContentStore,
} from '../persistence/contracts';
import { InputRecordService } from '../service';

class InMemoryInputRecordStore implements InputRecordStore {
  readonly records = new Map<string, InputRecord>();

  async saveInputRecord(record: InputRecord): Promise<InputRecord> {
    this.records.set(record.inputId, record);
    return record;
  }

  async getInputRecord(inputId: InputRecordId): Promise<InputRecord | null> {
    return this.records.get(inputId) ?? null;
  }

  async findBySourceEventIdentity(identity: { source: string; id: string }): Promise<InputRecord | null> {
    for (const record of this.records.values()) {
      if (
        record.sourceEventIdentity &&
        record.sourceEventIdentity.source === identity.source &&
        record.sourceEventIdentity.id === identity.id
      ) {
        return record;
      }
    }
    return null;
  }
}

class InMemoryIngressContentStore implements IngressContentStore {
  readonly records = new Map<string, IngressContentRecord>();

  async saveContent(record: IngressContentRecord): Promise<IngressContentRecord> {
    this.records.set(record.contentId, record);
    return record;
  }

  async getContent(contentId: IngressContentId): Promise<IngressContentRecord | null> {
    return this.records.get(contentId) ?? null;
  }

  async hasContent(contentId: IngressContentId): Promise<boolean> {
    return this.records.has(contentId);
  }
}

describe('0.86B-3 · InputRecordService (Multimodal Boundaries & Authority)', () => {
  const sessionRefLucas = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const sessionRefJoao = '2222222222222222222222222222222222222222222222222222222222222222' as SessionRef;

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  const locFornecedores: OperationalLocation = {
    module: { moduleKey: 'fornecedores' as ModuleKey },
    trail: [],
  };

  const focusCompare: OperationalFocus = {
    action: 'compare' as any,
  };

  const observedRadar: ObservedInteractionContext = {
    origin: 'client_observed',
    observedAt: '2026-08-24T21:00:00.000Z',
    location: { module: { moduleKey: 'radar' as ModuleKey }, trail: [] },
  };

  const fullLucasContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_lucas' },
    userId: 'usr_lucas',
    sessionRef: sessionRefLucas,
    contextSubjectRef: brandAlterstate,
    location: locFornecedores,
    focus: focusCompare,
    observedInteraction: observedRadar,
    channel: 'web_dashboard' as any,
    correlationId: 'corr_xyz' as any,
  };

  const joaoContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_joao' },
    userId: 'usr_joao',
    sessionRef: sessionRefJoao,
  };

  it('1. constrói InputRecord derivando autoridade do OperationalContext e NÃO copia location/focus/observedInteraction', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer,
    });

    const draft: RecordInputDraft = {
      parts: [
        { kind: 'text', text: 'Favor comparar este produto com o radar' },
        {
          kind: 'resource_ref',
          resource: {
            ownerModule: { moduleKey: 'fornecedores' as ModuleKey },
            resourceType: 'product' as ResourceType,
            resourceId: 'prod_123' as ResourceId,
          },
        },
      ],
      occurredAt: '2026-08-24T21:00:00.000Z',
    };

    const result = await service.recordInput(draft, fullLucasContext);

    assert.equal(result.deduplicated, false);
    assert.ok(result.record.inputId.startsWith('inp_'));
    assert.equal(result.record.actor.kind, 'human');
    assert.equal((result.record.actor as HumanActor).humanId, 'usr_lucas');
    assert.equal(result.record.userId, 'usr_lucas');
    assert.equal(result.record.sessionRef, sessionRefLucas);
    assert.equal(result.record.contextSubjectRef?.subjectId, 'alterstate');
    assert.equal(result.record.channel, 'web_dashboard');
    assert.equal(result.record.correlationId, 'corr_xyz');

    // Prova: location, focus e observedInteraction NÃO são copiados para o InputRecord
    assert.equal((result.record as any).location, undefined);
    assert.equal((result.record as any).focus, undefined);
    assert.equal((result.record as any).observedInteraction, undefined);

    // Prova: 2 partes preservadas na ordem
    assert.equal(result.record.parts.length, 2);
    assert.equal(result.record.parts[0].kind, 'text');
    assert.equal(result.record.parts[1].kind, 'resource_ref');
  });

  it('2. registra multipart ordenado com imagem, documento, texto, evento e evidência', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    // Salva 2 IngressContents legítimos no store
    const contentPhoto: IngressContentRecord = {
      contentId: 'ing_photo_1' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      userId: 'usr_lucas',
      verifiedMimeType: 'image/jpeg',
      sha256: 'a'.repeat(64),
      byteSize: 1024,
      storageBackend: 'local_fs',
      storageKey: 'sha256/aa/aa/' + 'a'.repeat(64),
      receivedAt: '2026-08-24T21:00:00.000Z',
    };
    const contentPdf: IngressContentRecord = {
      contentId: 'ing_doc_1' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      userId: 'usr_lucas',
      verifiedMimeType: 'application/pdf',
      sha256: 'b'.repeat(64),
      byteSize: 2048,
      storageBackend: 'local_fs',
      storageKey: 'sha256/bb/bb/' + 'b'.repeat(64),
      receivedAt: '2026-08-24T21:00:00.000Z',
    };
    await contentStore.saveContent(contentPhoto);
    await contentStore.saveContent(contentPdf);

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer,
    });

    const parts: InputPart[] = [
      { kind: 'text', text: 'Analise a foto da embalagem:' },
      { kind: 'content_ref', content: { contentId: 'ing_photo_1' as IngressContentId } },
      { kind: 'text', text: 'E o laudo técnico em PDF:' },
      { kind: 'content_ref', content: { contentId: 'ing_doc_1' as IngressContentId } },
      { kind: 'event_ref', eventId: 'evt_price_change' as EventId },
      { kind: 'evidence_ref', evidenceArtifactId: 'art_receipt_1' as any },
    ];

    const result = await service.recordInput({ parts }, fullLucasContext);

    assert.equal(result.record.parts.length, 6);
    assert.equal(result.record.parts[0].kind, 'text');
    assert.equal(result.record.parts[1].kind, 'content_ref');
    assert.equal(result.record.parts[2].kind, 'text');
    assert.equal(result.record.parts[3].kind, 'content_ref');
    assert.equal(result.record.parts[4].kind, 'event_ref');
    assert.equal(result.record.parts[5].kind, 'evidence_ref');
  });

  it('3. content_ref rejeita se conteúdo não existir, estiver expirado ou se authorizer negar attach_to_input', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    // Content pertencente a Lucas
    const privateLucasContent: IngressContentRecord = {
      contentId: 'ing_secret' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      userId: 'usr_lucas',
      verifiedMimeType: 'image/png',
      sha256: 'c'.repeat(64),
      byteSize: 500,
      storageBackend: 'local_fs',
      storageKey: 'sha256/cc/cc/' + 'c'.repeat(64),
      receivedAt: '2026-08-24T21:00:00.000Z',
    };
    await contentStore.saveContent(privateLucasContent);

    // Content expirado
    const expiredContent: IngressContentRecord = {
      contentId: 'ing_expired' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      userId: 'usr_lucas',
      verifiedMimeType: 'text/plain',
      sha256: 'd'.repeat(64),
      byteSize: 100,
      storageBackend: 'local_fs',
      storageKey: 'sha256/dd/dd/' + 'd'.repeat(64),
      receivedAt: '2026-08-24T20:00:00.000Z',
      expiresAt: '2026-08-24T20:30:00.000Z',
    };
    await contentStore.saveContent(expiredContent);

    // Authorizer estrito: somente dono do arquivo pode anexar a seu input
    const strictAuthorizer: IngressAccessAuthorizer = {
      async authorize({ operation, context, content }) {
        if (operation === 'attach_to_input') {
          return content?.userId === context.userId;
        }
        return true;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: strictAuthorizer,
      nowProvider: () => '2026-08-24T21:00:00.000Z',
    });

    // 1. Falha se contentId não existe
    await assert.rejects(
      () =>
        service.recordInput(
          {
            parts: [{ kind: 'content_ref', content: { contentId: 'ing_nonexistent' as IngressContentId } }],
          },
          fullLucasContext
        ),
      IngressContentNotFoundError
    );

    // 2. Falha se contentId expirou
    await assert.rejects(
      () =>
        service.recordInput(
          {
            parts: [{ kind: 'content_ref', content: { contentId: 'ing_expired' as IngressContentId } }],
          },
          fullLucasContext
        ),
      IngressContentExpiredError
    );

    // 3. João tenta anexar o arquivo privado de Lucas -> authorizer nega
    await assert.rejects(
      () =>
        service.recordInput(
          {
            parts: [{ kind: 'content_ref', content: { contentId: 'ing_secret' as IngressContentId } }],
          },
          joaoContext
        ),
      (err: any) => {
        assert.ok(err instanceof IngressAuthorizationError);
        assert.equal(err.operation, 'attach_to_input');
        assert.equal(err.contentId, 'ing_secret');
        return true;
      }
    );
  });

  it('4. reentrega da mesma SourceEventIdentity converge para o primeiro InputRecord (deduplicated: true)', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer,
    });

    const draft: RecordInputDraft = {
      sourceEventIdentity: { source: 'webhook_github', id: 'delivery_abc_123' },
      parts: [{ kind: 'text', text: 'Commit push event payload' }],
    };

    // Primeira entrega
    const res1 = await service.recordInput(draft, fullLucasContext);
    assert.equal(res1.deduplicated, false);
    const originalInputId = res1.record.inputId;

    // Segunda entrega (reentrega do mesmo evento pelo webhook)
    const res2 = await service.recordInput(draft, fullLucasContext);
    assert.equal(res2.deduplicated, true);
    assert.equal(res2.record.inputId, originalInputId);
    assert.equal(res2.record.receivedAt, res1.record.receivedAt);

    // Garante que só há 1 registro no store
    assert.equal(inputStore.records.size, 1);
  });

  it('5. entradas com texto idêntico sem SourceEventIdentity geram dois InputRecords legítimos distintos', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer,
    });

    const draft: RecordInputDraft = {
      parts: [{ kind: 'text', text: 'Mensagem repetida do usuário' }],
    };

    const res1 = await service.recordInput(draft, fullLucasContext);
    const res2 = await service.recordInput(draft, fullLucasContext);

    assert.equal(res1.deduplicated, false);
    assert.equal(res2.deduplicated, false);
    assert.notEqual(res1.record.inputId, res2.record.inputId);
    assert.equal(inputStore.records.size, 2);
  });

  it('6. expiração posterior do IngressContent NÃO modifica o InputRecord histórico', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    let currentTime = '2026-08-24T21:00:00.000Z';

    const tempContent: IngressContentRecord = {
      contentId: 'ing_temp_doc' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      userId: 'usr_lucas',
      verifiedMimeType: 'application/pdf',
      sha256: 'e'.repeat(64),
      byteSize: 1000,
      storageBackend: 'local_fs',
      storageKey: 'sha256/ee/ee/' + 'e'.repeat(64),
      receivedAt: '2026-08-24T21:00:00.000Z',
      expiresAt: '2026-08-24T22:00:00.000Z', // Expira às 22h
    };
    await contentStore.saveContent(tempContent);

    const authorizer: IngressAccessAuthorizer = {
      async authorize() {
        return true;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer,
      nowProvider: () => currentTime,
    });

    // Às 21h: InputRecord criado com sucesso referenciando o arquivo
    const { record } = await service.recordInput(
      {
        parts: [{ kind: 'content_ref', content: { contentId: 'ing_temp_doc' as IngressContentId } }],
      },
      fullLucasContext
    );

    // Às 23h (após expiração do conteúdo):
    currentTime = '2026-08-24T23:00:00.000Z';

    // O InputRecord histórico continua intacto e recuperável
    const fetched = await service.getInputRecord(record.inputId);
    assert.equal(fetched.inputId, record.inputId);
    assert.equal(fetched.parts[0].kind, 'content_ref');
    assert.equal((fetched.parts[0] as any).content.contentId, 'ing_temp_doc');
  });

  it('7. getInputRecord lança InputRecordNotFoundError se registro não existir', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: { async authorize() { return true; } },
    });

    await assert.rejects(
      () => service.getInputRecord('inp_nonexistent' as InputRecordId),
      InputRecordNotFoundError
    );
  });
});
