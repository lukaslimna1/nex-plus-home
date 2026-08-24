/**
 * NEX+ · Testes Unitários e Adversariais do InputRecordService
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3 · Rodada B3-R1)
 *
 * Provas:
 * 1. InputRecord multipart canônico com preservação de ordem.
 * 2. Imutabilidade profunda: mutação posterior no draft, nas parts ou no SourceEventIdentity não afeta o InputRecord nem o store.
 * 3. Eixos de autoridade derivados estritamente do OperationalContext.
 * 4. Não-cópia de location, focus, observedInteraction.
 * 5. IngressAccessAuthorizer 'attach_to_input' obrigatório para content_ref.
 * 6. InputRecordAccessAuthorizer 'read' obrigatório no getInputRecord (conhecer ID não concede leitura).
 * 7. SourceEventIdentity não concede autoridade de leitura (se A registrar e B tentar replay com a mesma identidade, B é negado pelo authorizer e nada é exposto).
 * 8. Replay legítimo com SourceEventIdentity converge para o InputRecord existente mesmo se o IngressContent original tiver expirado.
 * 9. Dois inputs de texto idênticos sem SourceEventIdentity geram dois InputRecords distintos (sem deduplicação por conteúdo).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HumanActor } from '../../observations/contracts';
import type { SessionRef } from '../../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  OperationalContext,
} from '../../context/contracts';
import type {
  ModuleKey,
  ResourceType,
  ResourceId,
} from '../../modules/contracts';
import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  InputPart,
  InputRecord,
  IngressContentRecord,
  RecordInputDraft,
  IngressAccessAuthorizer,
  InputRecordAccessAuthorizer,
} from '../contracts';
import {
  IngressAuthorizationError,
  InputRecordAuthorizationError,
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
  readonly bySourceEvent = new Map<string, InputRecord>();

  async saveInputRecord(record: InputRecord): Promise<InputRecord> {
    if (record.sourceEventIdentity) {
      const key = `${record.sourceEventIdentity.source}:::${record.sourceEventIdentity.id}`;
      if (this.bySourceEvent.has(key)) {
        const err: any = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      this.bySourceEvent.set(key, record);
    }
    this.records.set(record.inputId, record);
    return record;
  }

  async getInputRecord(inputId: InputRecordId): Promise<InputRecord | null> {
    return this.records.get(inputId) ?? null;
  }

  async findBySourceEventIdentity(identity: SourceEventIdentity): Promise<InputRecord | null> {
    const key = `${identity.source}:::${identity.id}`;
    return this.bySourceEvent.get(key) ?? null;
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

describe('0.86B-3 · InputRecordService (Multimodal Envelopes & Authority · B3-R1)', () => {
  const sessionRefLucas = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const sessionRefJoao = '2222222222222222222222222222222222222222222222222222222222222222' as SessionRef;

  const lucasContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_lucas' },
    userId: 'usr_lucas',
    sessionRef: sessionRefLucas,
    contextSubjectRef: { subjectType: 'brand' as ContextSubjectType, subjectId: 'alterstate' as ContextSubjectId },
    channel: 'web_dashboard' as any,
    correlationId: 'corr_req_123' as any,
    location: {
      module: { moduleKey: 'radar' as ModuleKey },
      trail: [],
    },
    focus: {
      action: 'view' as any,
    },
    observedInteraction: {
      origin: 'client_observed',
      observedAt: '2026-08-24T21:00:00.000Z',
    },
  };

  const joaoContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_joao' },
    userId: 'usr_joao',
    sessionRef: sessionRefJoao,
  };

  const permissiveIngressAuthorizer: IngressAccessAuthorizer = {
    async authorize() {
      return true;
    },
  };

  const userScopedInputAuthorizer: InputRecordAccessAuthorizer = {
    async authorize({ operation, context, record }) {
      if (operation === 'read') {
        return record.userId === context.userId;
      }
      return false;
    },
  };

  it('1. cria InputRecord multipart derivando autoridade do context e omitindo location/focus', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    const draft: RecordInputDraft = {
      parts: [
        { kind: 'text', text: 'Analise o seguinte fornecedor:' },
        {
          kind: 'resource_ref',
          resource: {
            ownerModule: { moduleKey: 'fornecedores' as ModuleKey },
            resourceType: 'supplier_card' as ResourceType,
            resourceId: 'sup_77' as ResourceId,
          },
        },
      ],
    };

    const { record, deduplicated } = await service.recordInput(draft, lucasContext);

    assert.equal(deduplicated, false);
    assert.ok(record.inputId.startsWith('inp_'));
    assert.equal(record.actor.kind, 'human');
    assert.equal((record.actor as HumanActor).humanId, 'usr_lucas');
    assert.equal(record.userId, 'usr_lucas');
    assert.equal(record.sessionRef, sessionRefLucas);
    assert.equal(record.contextSubjectRef?.subjectId, 'alterstate');
    assert.equal(record.channel, 'web_dashboard');
    assert.equal(record.correlationId, 'corr_req_123');

    // Garante que location, focus e observedInteraction NÃO foram copiados
    assert.equal((record as any).location, undefined);
    assert.equal((record as any).focus, undefined);
    assert.equal((record as any).observedInteraction, undefined);

    // Garante preservação exata da ordem das partes
    assert.equal(record.parts.length, 2);
    assert.equal(record.parts[0].kind, 'text');
    assert.equal((record.parts[0] as any).text, 'Analise o seguinte fornecedor:');
    assert.equal(record.parts[1].kind, 'resource_ref');
  });

  it('1A. copia defensivamente e congela contextSubjectRef do OperationalContext', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();
    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    const mutableContext: OperationalContext = {
      ...lucasContext,
      contextSubjectRef: {
        subjectType: 'brand' as ContextSubjectType,
        subjectId: 'alterstate' as ContextSubjectId,
      },
    };

    const { record } = await service.recordInput(
      { parts: [{ kind: 'text', text: 'Entrada com sujeito contextual' }] },
      mutableContext
    );

    (mutableContext.contextSubjectRef as any).subjectId = 'mutated_after_record';

    assert.equal(record.contextSubjectRef?.subjectId, 'alterstate');
    assert.ok(Object.isFrozen(record.contextSubjectRef));
    assert.notEqual(record.contextSubjectRef, mutableContext.contextSubjectRef);
  });

  it('2. imutabilidade profunda: mutação posterior no draft, parts ou sourceEventIdentity não altera o InputRecord nem o store', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const contentRecord: IngressContentRecord = {
      contentId: 'ing_doc_1' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      verifiedMimeType: 'image/png',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteSize: 100,
      storageBackend: 'local_fs',
      storageKey: 'sha256/e3/b0/doc',
      receivedAt: '2026-08-24T21:00:00.000Z',
    };
    await contentStore.saveContent(contentRecord);

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    const textPartObj: any = { kind: 'text', text: 'Texto original' };
    const contentPartObj: any = { kind: 'content_ref', content: { contentId: 'ing_doc_1' as IngressContentId } };
    const resourcePartObj: any = {
      kind: 'resource_ref',
      resource: {
        ownerModule: { moduleKey: 'radar' as ModuleKey },
        resourceType: 'item' as ResourceType,
        resourceId: 'item_1' as ResourceId,
      },
    };
    const partsArray = [textPartObj, contentPartObj, resourcePartObj];
    const sourceEventObj: any = { source: 'slack', id: 'msg_original' };

    const draft: RecordInputDraft = {
      parts: partsArray,
      sourceEventIdentity: sourceEventObj,
    };

    const { record } = await service.recordInput(draft, lucasContext);

    // Tentativa de mutação nos objetos originais do caller após recordInput
    partsArray.push({ kind: 'text', text: 'Parte injetada pós record' });
    textPartObj.text = 'Texto MODIFICADO pelo caller';
    contentPartObj.content.contentId = 'ing_doc_MODIFICADO';
    resourcePartObj.resource.resourceId = 'item_MODIFICADO';
    resourcePartObj.resource.ownerModule.moduleKey = 'modulo_MODIFICADO';
    sourceEventObj.id = 'msg_MODIFICADO';

    // 1. Prova que o InputRecord retornado NÃO mudou
    assert.equal(record.parts.length, 3);
    assert.equal((record.parts[0] as any).text, 'Texto original');
    assert.equal((record.parts[1] as any).content.contentId, 'ing_doc_1');
    assert.equal((record.parts[2] as any).resource.resourceId, 'item_1');
    assert.equal((record.parts[2] as any).resource.ownerModule.moduleKey, 'radar');
    assert.equal(record.sourceEventIdentity?.id, 'msg_original');

    // 2. Prova que o objeto retornado está profundamente congelado
    assert.ok(Object.isFrozen(record.parts));
    assert.ok(Object.isFrozen(record.parts[0]));
    assert.ok(Object.isFrozen(record.parts[1]));
    assert.ok(Object.isFrozen((record.parts[1] as any).content));
    assert.ok(Object.isFrozen(record.parts[2]));
    assert.ok(Object.isFrozen((record.parts[2] as any).resource));
    assert.ok(Object.isFrozen((record.parts[2] as any).resource.ownerModule));
    assert.ok(Object.isFrozen(record.sourceEventIdentity));

    // 3. Prova que o registro mantido no store NÃO mudou
    const stored = await inputStore.getInputRecord(record.inputId);
    assert.ok(stored);
    assert.equal(stored.parts.length, 3);
    assert.equal((stored.parts[0] as any).text, 'Texto original');
    assert.equal((stored.parts[1] as any).content.contentId, 'ing_doc_1');
    assert.equal((stored.parts[2] as any).resource.resourceId, 'item_1');
    assert.equal((stored.parts[2] as any).resource.ownerModule.moduleKey, 'radar');
    assert.equal(stored.sourceEventIdentity?.id, 'msg_original');
  });

  it('3. rejeita anexação de content_ref se IngressAccessAuthorizer negar attach_to_input', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const contentRecord: IngressContentRecord = {
      contentId: 'ing_photo_1' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_joao' }, // Pertence ao João
      userId: 'usr_joao',
      verifiedMimeType: 'image/png',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteSize: 200,
      storageBackend: 'local_fs',
      storageKey: 'sha256/e3/b0/photo',
      receivedAt: '2026-08-24T21:00:00.000Z',
    };
    await contentStore.saveContent(contentRecord);

    const scopedIngressAuthorizer: IngressAccessAuthorizer = {
      async authorize({ operation, context, content }) {
        if (operation === 'attach_to_input') {
          return content?.userId === context.userId;
        }
        return false;
      },
    };

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: scopedIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    // Lucas tenta referenciar conteúdo de João em seu input
    const draft: RecordInputDraft = {
      parts: [
        { kind: 'text', text: 'Veja o anexo:' },
        { kind: 'content_ref', content: { contentId: 'ing_photo_1' as IngressContentId } },
      ],
    };

    await assert.rejects(
      () => service.recordInput(draft, lucasContext),
      (err: any) => {
        assert.ok(err instanceof IngressAuthorizationError);
        assert.equal(err.operation, 'attach_to_input');
        assert.equal(err.contentId, 'ing_photo_1');
        return true;
      }
    );
  });

  it('4. getInputRecord exige autorização de leitura: conhecer ID não autoriza acesso', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    const { record } = await service.recordInput(
      { parts: [{ kind: 'text', text: 'Mensagem privada do Lucas' }] },
      lucasContext
    );

    // Lucas consegue ler seu próprio InputRecord
    const lucasRead = await service.getInputRecord(record.inputId, lucasContext);
    assert.equal(lucasRead.inputId, record.inputId);

    // João conhece o inputId, mas tem leitura negada
    await assert.rejects(
      () => service.getInputRecord(record.inputId, joaoContext),
      (err: any) => {
        assert.ok(err instanceof InputRecordAuthorizationError);
        assert.equal(err.operation, 'read');
        assert.equal(err.inputId, record.inputId);
        return true;
      }
    );
  });

  it('5. SourceEventIdentity não concede autoridade: João tenta replay de ocorrência de Lucas e é bloqueado', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    const sourceIdentity: SourceEventIdentity = { source: 'webhook_stripe', id: 'evt_stripe_999' };

    // 1. Lucas registra ocorrência externa legítima
    const { record: lucasRecord, deduplicated: d1 } = await service.recordInput(
      {
        parts: [{ kind: 'text', text: 'Pagamento recebido de Lucas' }],
        sourceEventIdentity: sourceIdentity,
      },
      lucasContext
    );
    assert.equal(d1, false);

    // 2. João tenta submeter a mesma SourceEventIdentity
    // Como a ocorrência já existe para Lucas e o authorizer nega leitura para João,
    // o serviço deve falhar fechado com InputRecordAuthorizationError e NÃO devolver o registro de Lucas
    await assert.rejects(
      () =>
        service.recordInput(
          {
            parts: [{ kind: 'text', text: 'Tentativa maliciosa de João' }],
            sourceEventIdentity: sourceIdentity,
          },
          joaoContext
        ),
      (err: any) => {
        assert.ok(err instanceof InputRecordAuthorizationError);
        assert.equal(err.operation, 'read');
        assert.equal(err.inputId, undefined);
        assert.equal(err.message.includes(lucasRecord.inputId), false);
        return true;
      }
    );
  });

  it('6. Replay legítimo converge para InputRecord existente mesmo após expiração do IngressContent original', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    let currentTime = '2026-08-24T21:00:00.000Z';

    const contentRecord: IngressContentRecord = {
      contentId: 'ing_temp_doc' as IngressContentId,
      actor: { kind: 'human', humanId: 'usr_lucas' },
      userId: 'usr_lucas',
      verifiedMimeType: 'application/pdf',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteSize: 500,
      storageBackend: 'local_fs',
      storageKey: 'sha256/e3/b0/temp',
      receivedAt: '2026-08-24T21:00:00.000Z',
      expiresAt: '2026-08-24T21:30:00.000Z', // Expira às 21h30
    };
    await contentStore.saveContent(contentRecord);

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
      nowProvider: () => currentTime,
    });

    const sourceIdentity: SourceEventIdentity = { source: 'api_gateway', id: 'req_001' };

    // 1. Registro original às 21h00 (conteúdo ativo)
    const { record: original, deduplicated: d1 } = await service.recordInput(
      {
        parts: [
          { kind: 'text', text: 'Documento anexado' },
          { kind: 'content_ref', content: { contentId: 'ing_temp_doc' as IngressContentId } },
        ],
        sourceEventIdentity: sourceIdentity,
      },
      lucasContext
    );
    assert.equal(d1, false);

    // 2. Às 22h00 o conteúdo original está expirado
    currentTime = '2026-08-24T22:00:00.000Z';

    // 3. Reentrega legítima (replay com mesma SourceEventIdentity por Lucas)
    // Deve convergir sem falhar por expiração do anexo
    const { record: replayed, deduplicated: d2 } = await service.recordInput(
      {
        parts: [
          { kind: 'text', text: 'Documento anexado (replay)' },
          { kind: 'content_ref', content: { contentId: 'ing_temp_doc' as IngressContentId } },
        ],
        sourceEventIdentity: sourceIdentity,
      },
      lucasContext
    );

    assert.equal(d2, true);
    assert.equal(replayed.inputId, original.inputId);
    assert.equal(replayed.receivedAt, original.receivedAt);
  });

  it('7. dois inputs de texto idênticos sem SourceEventIdentity geram dois InputRecords distintos', async () => {
    const inputStore = new InMemoryInputRecordStore();
    const contentStore = new InMemoryIngressContentStore();

    const service = new InputRecordService({
      inputStore,
      contentStore,
      authorizer: permissiveIngressAuthorizer,
      inputAuthorizer: userScopedInputAuthorizer,
    });

    const draft: RecordInputDraft = {
      parts: [{ kind: 'text', text: 'Comando idêntico executado duas vezes' }],
    };

    const res1 = await service.recordInput(draft, lucasContext);
    const res2 = await service.recordInput(draft, lucasContext);

    assert.equal(res1.deduplicated, false);
    assert.equal(res2.deduplicated, false);
    assert.notEqual(res1.record.inputId, res2.record.inputId);
    assert.equal(inputStore.records.size, 2);
  });
});
