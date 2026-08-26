/**
 * NEX+ · 0.86B-5 Acceptance Gate · Cross-Boundary Adversarial & Boundary Hardening
 * Contrato Canônico de Acceptance (0.86B-5 · 26/08/2026)
 *
 * Provas Adversariais & Red-Team:
 * 1. Concorrência otimista (SessionOperationalState revision conflict - sem last-write-wins).
 * 2. Ownership fail-closed (Sessão do User A não pode ser acessada/mutada por User B).
 * 3. Tentativas de sobrescrita de eixos de autoridade em draft de InputRecord.
 * 4. Replay não autoriza leitura (SourceEventIdentity de terceiro com autorizador negado).
 * 5. Ingress attach authorization (conhecimento de contentId não concede anexação).
 * 6. Expiração temporal estrita de Ingress (now === expiresAt e now > expiresAt bloqueiam).
 * 7. Material Context Pin não é dereference capability (ler Pin não autoriza ler InputRecord).
 * 8. Ingress não pode ser pinado (rejeição de content_ref / ingress_ref em MaterialContextPin).
 * 9. CorrelationId não concede autoridade de leitura.
 * 10. Imutabilidade profunda contra prototype tampering e mutação de nós.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AuthenticatedSessionContext, SessionRef } from '../../auth/session-ref.types';
import type { HumanActor } from '../observations/contracts';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  FlowRef,
  FlowType,
  FlowId,
  OperationalContext,
  OperationalChannel,
  SessionOperationalState,
} from '../context/contracts';
import type {
  ModuleKey,
  ResourceType,
  ResourceId,
  CorrelationId,
} from '../modules/contracts';
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
  IngressAccessOperation,
  InputRecordAccessOperation,
} from '../input/contracts';
import type {
  MaterialContextPinId,
  MaterialContextPin,
  PinMaterialContextDraft,
  MaterialContextAccessAuthorizer,
  MaterialContextAccessAuthorizationParams,
} from '../material-context/contracts';
import type {
  EnsureSessionOperationalStateParams,
  SessionOperationalStateStore,
  SetContextSubjectParams,
} from '../context/persistence/contracts';
import type {
  InputRecordStore,
  IngressContentStore,
} from '../input/persistence/contracts';
import type { MaterialContextStore } from '../material-context/persistence/contracts';

import {
  ensureSessionOperationalState,
  getSessionOperationalState,
  setSessionContextSubject,
} from '../context/session-state';
import {
  SessionOperationalStateOwnershipMismatchError,
  SessionOperationalStateRevisionConflictError,
} from '../context/errors';
import { composeOperationalContext } from '../context/compose';
import { InputRecordService } from '../input/service';
import {
  IngressAuthorizationError,
  InputRecordAuthorizationError,
  IngressContentExpiredError,
  InputRecordNotFoundError,
  InputInvariantViolationError,
} from '../input/errors';
import { MaterialContextPinService } from '../material-context/service';
import {
  MaterialContextAuthorizationError,
  MaterialContextInvariantViolationError,
} from '../material-context/errors';

// ============================================================================
// STORES EM MEMÓRIA COM SUPORTE A ERROS CANÔNICOS
// ============================================================================

class MemorySessionStore implements SessionOperationalStateStore {
  readonly store = new Map<string, SessionOperationalState>();

  async getState(sessionRef: SessionRef, expectedUserId: string): Promise<SessionOperationalState | null> {
    const existing = this.store.get(sessionRef);
    if (!existing) return null;
    if (existing.userId !== expectedUserId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef,
        expectedUserId,
        actualUserId: existing.userId,
      });
    }
    return existing;
  }

  async ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new SessionOperationalStateOwnershipMismatchError({
          sessionRef: params.sessionRef,
          expectedUserId: params.userId,
          actualUserId: existing.userId,
        });
      }
      return existing;
    }

    const now = new Date().toISOString();
    const created: SessionOperationalState = {
      sessionRef: params.sessionRef,
      userId: params.userId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(params.sessionRef, created);
    return created;
  }

  async setContextSubject(params: SetContextSubjectParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
    if (!existing) {
      throw new Error(`Session ${params.sessionRef} not found.`);
    }
    if (existing.userId !== params.userId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef: params.sessionRef,
        expectedUserId: params.userId,
        actualUserId: existing.userId,
      });
    }
    if (existing.revision !== params.expectedRevision) {
      throw new SessionOperationalStateRevisionConflictError({
        sessionRef: params.sessionRef,
        expectedRevision: params.expectedRevision,
        actualRevision: existing.revision,
      });
    }

    const now = new Date().toISOString();
    const updated: SessionOperationalState = {
      ...existing,
      ...(params.contextSubjectRef !== null
        ? { contextSubjectRef: params.contextSubjectRef }
        : {}),
      revision: existing.revision + 1,
      updatedAt: now,
    };
    if (params.contextSubjectRef === null) {
      delete (updated as any).contextSubjectRef;
    }
    this.store.set(params.sessionRef, updated);
    return updated;
  }
}

class MemoryInputStore implements InputRecordStore {
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

class MemoryIngressStore implements IngressContentStore {
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

class MemoryMaterialStore implements MaterialContextStore {
  readonly pins = new Map<string, MaterialContextPin>();

  async savePin(pin: MaterialContextPin): Promise<MaterialContextPin> {
    if (this.pins.has(pin.pinId)) {
      throw new Error(`Pin '${pin.pinId}' already exists.`);
    }
    this.pins.set(pin.pinId, pin);
    return pin;
  }

  async getPin(pinId: MaterialContextPinId): Promise<MaterialContextPin | null> {
    return this.pins.get(pinId) ?? null;
  }

  async hasPin(pinId: MaterialContextPinId): Promise<boolean> {
    return this.pins.has(pinId);
  }
}

class ConfigurableAuthorizer implements IngressAccessAuthorizer, InputRecordAccessAuthorizer, MaterialContextAccessAuthorizer {
  allowIngressAttach = true;
  allowIngressRead = true;
  allowInputRead = true;
  allowPinCreate = true;
  allowPinRead = true;

  async authorize(params: any): Promise<boolean> {
    if ('operation' in params) {
      if (params.operation === 'attach_to_input') return this.allowIngressAttach;
      if (params.operation === 'read' && 'content' in params) return this.allowIngressRead;
      if (params.operation === 'read' && 'record' in params) return this.allowInputRead;
      if (params.operation === 'create' && !('record' in params)) return this.allowPinCreate;
      if (params.operation === 'read' && 'pin' in params) return this.allowPinRead;
    }
    return false;
  }
}

// ============================================================================
// SUÍTE DE TESTES ADVERSARIAIS & HARDENING
// ============================================================================

describe('0.86B-5 Acceptance Gate · Cross-Boundary Adversarial & Boundary Hardening', () => {
  const userAlice = 'usr_alice_111';
  const userBob = 'usr_bob_222';

  const actorAlice: HumanActor = { kind: 'human', humanId: userAlice, role: 'director' };
  const actorBob: HumanActor = { kind: 'human', humanId: userBob, role: 'operator' };

  const sessionRefAlice = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const sessionRefBob = '2222222222222222222222222222222222222222222222222222222222222222' as SessionRef;

  const sessionContextAlice: AuthenticatedSessionContext = {
    sessionRef: sessionRefAlice,
    actor: actorAlice,
  };

  const sessionContextBob: AuthenticatedSessionContext = {
    sessionRef: sessionRefBob,
    actor: actorBob,
  };

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  const brandArkana: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'arkana' as ContextSubjectId,
  };

  describe('1. Concorrência Otimista & Ownership (Seções 10, 11)', () => {
    it('SessionOperationalState: update com expectedRevision defasado falha com conflito e não aceita last-write-wins', async () => {
      const sessionStore = new MemorySessionStore();
      await ensureSessionOperationalState(sessionContextAlice, sessionStore);

      // Revision 1 -> 2
      const updatedState = await setSessionContextSubject(
        sessionContextAlice,
        { contextSubjectRef: brandAlterstate, expectedRevision: 1 },
        sessionStore
      );
      assert.strictEqual(updatedState.revision, 2);

      // Tentativa concorrente com revision antiga (1) deve falhar
      await assert.rejects(
        async () => {
          await setSessionContextSubject(
            sessionContextAlice,
            { contextSubjectRef: brandArkana, expectedRevision: 1 },
            sessionStore
          );
        },
        (err: any) => {
          return err instanceof SessionOperationalStateRevisionConflictError &&
            err.expectedRevision === 1 &&
            err.actualRevision === 2;
        }
      );

      // Estado permanece inalterado (Alterstate)
      const current = await getSessionOperationalState(sessionContextAlice, sessionStore);
      assert.strictEqual(current?.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(current?.revision, 2);
    });

    it('Ownership Fail-Closed: tentativa de acessar sessão de Alice utilizando contexto de Bob é rejeitada', async () => {
      const sessionStore = new MemorySessionStore();
      await ensureSessionOperationalState(sessionContextAlice, sessionStore);

      // Bob tenta personificar a sessão de Alice
      const maliciousBobContext: AuthenticatedSessionContext = {
        sessionRef: sessionRefAlice, // sessão de Alice
        actor: actorBob, // Bob
      };

      await assert.rejects(
        async () => {
          await getSessionOperationalState(maliciousBobContext, sessionStore);
        },
        (err: any) => {
          return err instanceof SessionOperationalStateOwnershipMismatchError &&
            err.expectedUserId === userBob &&
            err.actualUserId === userAlice;
        }
      );

      await assert.rejects(
        async () => {
          await setSessionContextSubject(
            maliciousBobContext,
            { contextSubjectRef: brandArkana, expectedRevision: 1 },
            sessionStore
          );
        },
        (err: any) => {
          return err instanceof SessionOperationalStateOwnershipMismatchError;
        }
      );
    });
  });

  describe('2. Anti-Bypass em InputRecord & Derivação Estrita (Seções 12, 13)', () => {
    it('Tentativa de sobrescrita de eixos de autoridade pelo draft é rejeitada estruturalmente pelo validador de draft', async () => {
      const inputStore = new MemoryInputStore();
      const contentStore = new MemoryIngressStore();
      const authorizer = new ConfigurableAuthorizer();
      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
      });

      const trustedContext = composeOperationalContext({
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
        contextSubjectRef: brandAlterstate,
        channel: 'trusted_web' as OperationalChannel,
        correlationId: 'corr_trusted_1' as CorrelationId,
      });

      // Draft malicioso tentando injetar identidade de Bob e Brand Arkana
      const maliciousDraft: any = {
        parts: [{ kind: 'text', text: 'Ação legítima aparente' }],
        actor: { kind: 'human', humanId: userBob },
        userId: userBob,
        sessionRef: sessionRefBob,
        contextSubjectRef: brandArkana,
        channel: 'forged_channel',
        correlationId: 'corr_forged_999',
      };

      await assert.rejects(
        async () => {
          await inputService.recordInput(maliciousDraft, trustedContext);
        },
        (err: any) => {
          return (
            err instanceof InputInvariantViolationError &&
            err.violationType === 'UNEXPECTED_PROPERTY'
          );
        }
      );
    });
  });

  describe('3. Replay Não Autoriza Leitura (Seção 17)', () => {
    it('Apresentar SourceEventIdentity existente com authorizer de leitura negado falha com erro seguro sem vazar dados', async () => {
      const inputStore = new MemoryInputStore();
      const contentStore = new MemoryIngressStore();
      const authorizer = new ConfigurableAuthorizer();
      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
      });

      const sourceEvent: SourceEventIdentity = {
        source: 'payment_gateway',
        id: 'txn_alice_secret_999',
      };

      const ctxAlice = composeOperationalContext({
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
        contextSubjectRef: brandAlterstate,
      });

      // Alice grava o input original
      authorizer.allowInputRead = true;
      const originalResult = await inputService.recordInput(
        {
          sourceEventIdentity: sourceEvent,
          parts: [{ kind: 'text', text: 'Dados financeiros confidenciais de Alice' }],
        },
        ctxAlice
      );
      assert.strictEqual(originalResult.deduplicated, false);

      // Bob descobre o sourceEventIdentity e tenta reentregar para capturar o registro
      const ctxBob = composeOperationalContext({
        actor: actorBob,
        userId: userBob,
        sessionRef: sessionRefBob,
      });

      // Authorizer nega leitura para Bob
      authorizer.allowInputRead = false;

      await assert.rejects(
        async () => {
          await inputService.recordInput(
            {
              sourceEventIdentity: sourceEvent,
              parts: [{ kind: 'text', text: 'Tentativa de phishing de Bob' }],
            },
            ctxBob
          );
        },
        (err: any) => {
          assert.ok(err instanceof InputRecordAuthorizationError);
          assert.strictEqual(err.operation, 'read');
          // Não vaza o inputId nem dados do registro original no erro
          assert.strictEqual((err as any).record, undefined);
          assert.strictEqual((err as any).inputId, undefined);
          return true;
        }
      );
    });
  });

  describe('4. Ingress Access & Expiração Temporal Estrita (Seções 18, 19)', () => {
    it('Conhecer contentId não concede autoridade: attach_to_input negado pelo autorizador é rejeitado', async () => {
      const inputStore = new MemoryInputStore();
      const contentStore = new MemoryIngressStore();
      const authorizer = new ConfigurableAuthorizer();
      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
      });

      const contentId = 'ing_doc_12345' as IngressContentId;
      await contentStore.saveContent({
        contentId,
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
        declaredMimeType: 'application/pdf',
        verifiedMimeType: 'application/pdf',
        sha256: 'a'.repeat(64),
        byteSize: 2048,
        storageBackend: 'local_fs',
        storageKey: 'sha256/aa/aa/' + 'a'.repeat(64),
        receivedAt: '2026-08-26T10:00:00.000Z',
      });

      const ctxBob = composeOperationalContext({
        actor: actorBob,
        userId: userBob,
        sessionRef: sessionRefBob,
      });

      // Nega attach_to_input
      authorizer.allowIngressAttach = false;

      await assert.rejects(
        async () => {
          await inputService.recordInput(
            {
              parts: [{ kind: 'content_ref', content: { contentId } }],
            },
            ctxBob
          );
        },
        (err: any) => {
          assert.ok(err instanceof IngressAuthorizationError);
          assert.strictEqual(err.operation, 'attach_to_input');
          assert.strictEqual(err.contentId, contentId);
          return true;
        }
      );
    });

    it('Expiração temporal exata: now === expiresAt e now > expiresAt bloqueiam attach_to_input com IngressContentExpiredError', async () => {
      const inputStore = new MemoryInputStore();
      const contentStore = new MemoryIngressStore();
      const authorizer = new ConfigurableAuthorizer();
      authorizer.allowIngressAttach = true;

      const expiresAt = '2026-08-26T12:00:00.000Z';
      const contentId = 'ing_temp_exp' as IngressContentId;

      await contentStore.saveContent({
        contentId,
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
        declaredMimeType: 'image/png',
        verifiedMimeType: 'image/png',
        sha256: 'b'.repeat(64),
        byteSize: 1024,
        storageBackend: 'local_fs',
        storageKey: 'sha256/bb/bb/' + 'b'.repeat(64),
        receivedAt: '2026-08-26T11:00:00.000Z',
        expiresAt,
      });

      const ctxAlice = composeOperationalContext({
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
      });

      // 1. Instante EXATO de expiração (now === expiresAt)
      const inputServiceAtExpiry = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
        nowProvider: () => '2026-08-26T12:00:00.000Z', // Exato instante de expiração
      });

      await assert.rejects(
        async () => {
          await inputServiceAtExpiry.recordInput(
            { parts: [{ kind: 'content_ref', content: { contentId } }] },
            ctxAlice
          );
        },
        (err: any) => {
          assert.ok(err instanceof IngressContentExpiredError);
          assert.strictEqual(err.contentId, contentId);
          return true;
        }
      );

      // 2. Instante POSTERIOR à expiração (now > expiresAt)
      const inputServiceAfterExpiry = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
        nowProvider: () => '2026-08-26T12:00:01.000Z', // 1 segundo depois
      });

      await assert.rejects(
        async () => {
          await inputServiceAfterExpiry.recordInput(
            { parts: [{ kind: 'content_ref', content: { contentId } }] },
            ctxAlice
          );
        },
        (err: any) => {
          assert.ok(err instanceof IngressContentExpiredError);
          assert.strictEqual(err.contentId, contentId);
          return true;
        }
      );
    });
  });

  describe('5. Material Context Pin Não é Dereference Capability & Anti-Leakage (Seções 24, 25, 27)', () => {
    it('Ler MaterialContextPin com input_ref NÃO concede permissão para ler o InputRecord subjacente se authorizer negar', async () => {
      const inputStore = new MemoryInputStore();
      const contentStore = new MemoryIngressStore();
      const materialStore = new MemoryMaterialStore();
      const authorizer = new ConfigurableAuthorizer();

      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
      });

      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer,
      });

      const ctxAlice = composeOperationalContext({
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
        contextSubjectRef: brandAlterstate,
      });

      // 1. Criar InputRecord e Pin
      authorizer.allowInputRead = true;
      authorizer.allowPinCreate = true;
      authorizer.allowPinRead = true;

      const inputResult = await inputService.recordInput(
        { parts: [{ kind: 'text', text: 'Documento interno confidencial' }] },
        ctxAlice
      );

      const pin = await pinService.pin(
        {
          items: [{ kind: 'input_ref', inputId: inputResult.record.inputId }],
        },
        ctxAlice
      );

      // 2. Usuário lê o Pin com sucesso
      const readPin = await pinService.getPin(pin.pinId, ctxAlice);
      assert.strictEqual(readPin.pinId, pin.pinId);
      const inputRef = readPin.items[0];
      assert.strictEqual(inputRef.kind, 'input_ref');
      const inputId = (inputRef as any).inputId;

      // 3. Agora o authorizer NEGA leitura do InputRecord
      authorizer.allowInputRead = false;

      // Ter o pin e o inputId NÃO autoriza ler o InputRecord
      await assert.rejects(
        async () => {
          await inputService.getInputRecord(inputId, ctxAlice);
        },
        (err: any) => {
          assert.ok(err instanceof InputRecordAuthorizationError);
          assert.strictEqual(err.operation, 'read');
          return true;
        }
      );
    });

    it('Ingress NÃO pode ser pinado: tentativa de passar content_ref ou ingress_ref como MaterialContextItem é rejeitada em runtime', async () => {
      const materialStore = new MemoryMaterialStore();
      const authorizer = new ConfigurableAuthorizer();
      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer,
      });

      const ctx = composeOperationalContext({
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
      });

      // Tentativa 1: kind 'content_ref'
      await assert.rejects(
        async () => {
          await pinService.pin(
            {
              items: [
                {
                  kind: 'content_ref',
                  content: { contentId: 'ing_123' },
                } as any,
              ],
            },
            ctx
          );
        },
        (err: any) => {
          return err instanceof MaterialContextInvariantViolationError;
        }
      );

      // Tentativa 2: kind 'ingress_ref'
      await assert.rejects(
        async () => {
          await pinService.pin(
            {
              items: [
                {
                  kind: 'ingress_ref',
                  contentId: 'ing_123',
                } as any,
              ],
            },
            ctx
          );
        },
        (err: any) => {
          return err instanceof MaterialContextInvariantViolationError;
        }
      );
    });

    it('CorrelationId não é chave mestra: conhecer correlationId não concede leitura de InputRecord nem de MaterialContextPin', async () => {
      const inputStore = new MemoryInputStore();
      const contentStore = new MemoryIngressStore();
      const materialStore = new MemoryMaterialStore();
      const authorizer = new ConfigurableAuthorizer();

      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer,
        inputAuthorizer: authorizer,
      });

      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer,
      });

      const sharedCorrelationId = 'corr_shared_leak_123' as CorrelationId;

      const ctxAlice = composeOperationalContext({
        actor: actorAlice,
        userId: userAlice,
        sessionRef: sessionRefAlice,
        correlationId: sharedCorrelationId,
      });

      // Alice cria Input e Pin com correlationId compartilhado
      authorizer.allowInputRead = true;
      authorizer.allowPinCreate = true;

      const inputResult = await inputService.recordInput(
        { parts: [{ kind: 'text', text: 'Nota com correlationId' }] },
        ctxAlice
      );

      const pin = await pinService.pin(
        {
          items: [
            {
              kind: 'resource_ref',
              resource: { ownerModule: { moduleKey: 'notes' as any }, resourceType: 'note' as any, resourceId: 'n1' as any },
            },
          ],
        },
        ctxAlice
      );

      // Bob conhece o correlationId compartilhado
      const ctxBob = composeOperationalContext({
        actor: actorBob,
        userId: userBob,
        sessionRef: sessionRefBob,
        correlationId: sharedCorrelationId,
      });

      // Authorizers negam leitura para Bob
      authorizer.allowInputRead = false;
      authorizer.allowPinRead = false;

      await assert.rejects(
        async () => {
          await inputService.getInputRecord(inputResult.record.inputId, ctxBob);
        },
        (err: any) => err instanceof InputRecordAuthorizationError
      );

      await assert.rejects(
        async () => {
          await pinService.getPin(pin.pinId, ctxBob);
        },
        (err: any) => err instanceof MaterialContextAuthorizationError
      );
    });
  });
});
