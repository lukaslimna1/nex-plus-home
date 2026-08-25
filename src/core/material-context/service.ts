/**
 * NEX+ · Material Context Pin Service
 * Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 *
 * Responsabilidades:
 * 1. Materialização seletiva, durável, imutável e auditável do contexto material (MaterialContextPin).
 * 2. Deriva estritamente do OperationalContext: actor, userId, sessionRef, contextSubjectRef, flowRef, correlationId, channel.
 * 3. NÃO copia location, focus, observedInteraction automaticamente.
 * 4. Imutabilidade profunda: canonicaliza, reconstrói e congela profundamente todos os nós e itens.
 * 5. Boundary de autorização obrigatório (MaterialContextAccessAuthorizer fail-closed para create e read).
 * 6. Persistência atômica do header e items relacionais em transação PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import type { OperationalContext } from '../context/contracts';
import { validateOperationalContext } from '../context/invariants';
import type {
  MaterialContextPinId,
  MaterialContextPin,
  PinMaterialContextDraft,
  MaterialContextAccessAuthorizer,
} from './contracts';
import {
  validateMaterialContextPinId,
  validateMaterialContextPin,
  validatePinMaterialContextDraft,
  sanitizeActor,
  sanitizeContextSubjectRef,
  sanitizeFlowRef,
  sanitizeMaterialContextItem,
} from './invariants';
import {
  MaterialContextAuthorizationError,
  MaterialContextPinNotFoundError,
} from './errors';
import type { MaterialContextStore } from './persistence/contracts';

export interface MaterialContextPinServiceOptions {
  readonly store: MaterialContextStore;
  readonly authorizer: MaterialContextAccessAuthorizer;
  readonly nowProvider?: () => string;
}

export class MaterialContextPinService {
  private readonly store: MaterialContextStore;
  private readonly authorizer: MaterialContextAccessAuthorizer;
  private readonly nowProvider: () => string;

  constructor(options: MaterialContextPinServiceOptions) {
    if (!options.store || typeof options.store.savePin !== 'function') {
      throw new Error('MaterialContextPinService requires a valid MaterialContextStore instance.');
    }
    if (!options.authorizer || typeof options.authorizer.authorize !== 'function') {
      throw new Error('MaterialContextPinService requires a valid MaterialContextAccessAuthorizer instance (fail-closed).');
    }
    this.store = options.store;
    this.authorizer = options.authorizer;
    this.nowProvider = options.nowProvider ?? (() => new Date().toISOString());
  }

  /**
   * Congela o contexto material de uma operação/decisão:
   * 1. Valida OperationalContext confiável.
   * 2. Autoriza 'create' via MaterialContextAccessAuthorizer.
   * 3. Valida draft de criação (exige items > 0 e impede sobrescrita de eixos de autoridade).
   * 4. Reconstrói defensivamente e congela profundamente cada item.
   * 5. Deriva eixos de procedência estritamente do OperationalContext (actor, user, session, subject, flow, correlation, channel).
   * 6. Persiste atomicamente no store e retorna o pin profundamente imutável.
   */
  async pin(
    draft: PinMaterialContextDraft,
    context: OperationalContext
  ): Promise<MaterialContextPin> {
    validateOperationalContext(context);

    const isAuthorized = await this.authorizer.authorize({
      operation: 'create',
      context,
    });
    if (!isAuthorized) {
      throw new MaterialContextAuthorizationError(
        'create',
        undefined,
        'Unauthorized to create material context pin in current operational context.'
      );
    }

    validatePinMaterialContextDraft(draft);

    const pinId = (draft.pinId ?? `pin_${randomUUID()}`) as MaterialContextPinId;
    validateMaterialContextPinId(pinId);

    const canonicalItems = draft.items.map(sanitizeMaterialContextItem);
    const pinnedAt = this.nowProvider();

    const pin: MaterialContextPin = Object.freeze({
      pinId,
      actor: sanitizeActor(context.actor),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.sessionRef ? { sessionRef: context.sessionRef } : {}),
      ...(context.contextSubjectRef
        ? { contextSubjectRef: sanitizeContextSubjectRef(context.contextSubjectRef) }
        : {}),
      ...(context.flowRef ? { flowRef: sanitizeFlowRef(context.flowRef) } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context.channel ? { channel: context.channel } : {}),
      pinnedAt,
      items: Object.freeze(canonicalItems),
    });

    validateMaterialContextPin(pin);

    return this.store.savePin(pin);
  }

  /**
   * Recupera um MaterialContextPin pelo seu identificador:
   * 1. Valida pinId e OperationalContext.
   * 2. Recupera do store (lança MaterialContextPinNotFoundError se inexistente).
   * 3. Autoriza 'read' via MaterialContextAccessAuthorizer.
   * 4. Retorna o pin imutável com items na ordem original.
   */
  async getPin(
    pinId: MaterialContextPinId,
    context: OperationalContext
  ): Promise<MaterialContextPin> {
    validateMaterialContextPinId(pinId);
    validateOperationalContext(context);

    const pin = await this.store.getPin(pinId);
    if (!pin) {
      throw new MaterialContextPinNotFoundError(pinId);
    }

    const isAuthorized = await this.authorizer.authorize({
      operation: 'read',
      context,
      pin,
      pinId,
    });
    if (!isAuthorized) {
      throw new MaterialContextAuthorizationError('read', pinId);
    }

    return pin;
  }
}
