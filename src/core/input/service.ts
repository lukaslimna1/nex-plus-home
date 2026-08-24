/**
 * NEX+ · Input Record Service
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Responsabilidades:
 * 1. Constrói o InputRecord canônico imutável a partir do OperationalContext confiável e draft não-autoritativo.
 * 2. Deriva estritamente do OperationalContext: actor, userId, sessionRef, contextSubjectRef, channel, correlationId.
 * 3. Não copia location, focus, observedInteraction nem objetos inteiros de domínio.
 * 4. Valida partes: para content_ref, verifica existência, não-expiração e autorização attach_to_input.
 * 5. Gerencia reentrega de eventos externos via SourceEventIdentity com convergência idempotente.
 * 6. Persiste atomicamente InputRecord e suas InputPart[] relacionais no PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import type { OperationalContext } from '../context/contracts';
import { validateOperationalContext } from '../context/invariants';
import type {
  InputRecordId,
  InputRecord,
  RecordInputDraft,
  RecordInputResult,
  IngressAccessAuthorizer,
} from './contracts';
import {
  validateInputRecordId,
  validateInputRecord,
  validateRecordInputDraft,
  sanitizeActor,
} from './invariants';
import {
  IngressAuthorizationError,
  IngressContentExpiredError,
  IngressContentNotFoundError,
  InputRecordNotFoundError,
} from './errors';
import type {
  InputRecordStore,
  IngressContentStore,
} from './persistence/contracts';

export interface InputRecordServiceOptions {
  readonly inputStore: InputRecordStore;
  readonly contentStore: IngressContentStore;
  readonly authorizer: IngressAccessAuthorizer;
  readonly nowProvider?: () => string;
}

export class InputRecordService {
  private readonly inputStore: InputRecordStore;
  private readonly contentStore: IngressContentStore;
  private readonly authorizer: IngressAccessAuthorizer;
  private readonly nowProvider: () => string;

  constructor(options: InputRecordServiceOptions) {
    if (!options.inputStore || typeof options.inputStore.saveInputRecord !== 'function') {
      throw new Error('InputRecordService requires a valid InputRecordStore instance.');
    }
    if (!options.contentStore || typeof options.contentStore.getContent !== 'function') {
      throw new Error('InputRecordService requires a valid IngressContentStore instance.');
    }
    if (!options.authorizer || typeof options.authorizer.authorize !== 'function') {
      throw new Error('InputRecordService requires a valid IngressAccessAuthorizer instance (fail-closed).');
    }

    this.inputStore = options.inputStore;
    this.contentStore = options.contentStore;
    this.authorizer = options.authorizer;
    this.nowProvider = options.nowProvider ?? (() => new Date().toISOString());
  }

  /**
   * Registra uma nova ocorrência de entrada no NEX+:
   * 1. Valida draft e OperationalContext confiável.
   * 2. Verifica cada content_ref (existência, validade temporal e autorização attach_to_input).
   * 3. Se houver SourceEventIdentity, verifica se a ocorrência externa já foi registrada (deduplicada).
   * 4. Se for nova, persiste atomicamente e retorna o registro imutável.
   */
  async recordInput(
    draft: RecordInputDraft,
    context: OperationalContext
  ): Promise<RecordInputResult> {
    validateRecordInputDraft(draft);
    validateOperationalContext(context);

    // 1. Verificação e autorização prévia de cada content_ref
    for (const part of draft.parts) {
      if (part.kind === 'content_ref') {
        const contentId = part.content.contentId;
        const contentRecord = await this.contentStore.getContent(contentId);

        if (!contentRecord) {
          throw new IngressContentNotFoundError(contentId);
        }

        // Verifica expiração
        if (contentRecord.expiresAt) {
          const now = new Date(this.nowProvider()).getTime();
          const expires = new Date(contentRecord.expiresAt).getTime();
          if (now > expires) {
            throw new IngressContentExpiredError(contentId, contentRecord.expiresAt);
          }
        }

        // Autoriza anexação à entrada no contexto operacional atual
        const isAuthorized = await this.authorizer.authorize({
          operation: 'attach_to_input',
          context,
          content: contentRecord,
          contentId,
        });

        if (!isAuthorized) {
          throw new IngressAuthorizationError('attach_to_input', contentId);
        }
      }
    }

    // 2. Verificação de reentrega duplicada via SourceEventIdentity (se fornecida)
    if (draft.sourceEventIdentity) {
      const existing = await this.inputStore.findBySourceEventIdentity(draft.sourceEventIdentity);
      if (existing) {
        return {
          record: existing,
          deduplicated: true,
        };
      }
    }

    // 3. Montar InputRecord canônico imutável derivando autoridade estritamente do OperationalContext
    const inputId = (draft.inputId ?? `inp_${randomUUID()}`) as InputRecordId;
    validateInputRecordId(inputId);

    const receivedAt = this.nowProvider();

    const record: InputRecord = Object.freeze({
      inputId,
      actor: sanitizeActor(context.actor),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.sessionRef ? { sessionRef: context.sessionRef } : {}),
      ...(context.contextSubjectRef ? { contextSubjectRef: context.contextSubjectRef } : {}),
      ...(draft.sourceRefId ? { sourceRefId: draft.sourceRefId } : {}),
      ...(draft.sourceEventIdentity ? { sourceEventIdentity: draft.sourceEventIdentity } : {}),
      ...(draft.occurredAt ? { occurredAt: draft.occurredAt } : {}),
      receivedAt,
      ...(context.channel ? { channel: context.channel } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      parts: Object.freeze([...draft.parts]),
    });

    validateInputRecord(record);

    try {
      const savedRecord = await this.inputStore.saveInputRecord(record);
      return {
        record: savedRecord,
        deduplicated: false,
      };
    } catch (err: any) {
      // Concorrência: se falhou por chave única de source_event_identity, recupera o já salvo
      if (
        draft.sourceEventIdentity &&
        (err.code === '23505' || String(err.message).includes('duplicate key') || String(err.message).includes('source_event'))
      ) {
        const existing = await this.inputStore.findBySourceEventIdentity(draft.sourceEventIdentity);
        if (existing) {
          return {
            record: existing,
            deduplicated: true,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Obtém um InputRecord pelo seu ID canônico.
   */
  async getInputRecord(inputId: InputRecordId): Promise<InputRecord> {
    validateInputRecordId(inputId);

    const record = await this.inputStore.getInputRecord(inputId);
    if (!record) {
      throw new InputRecordNotFoundError(inputId);
    }

    return record;
  }
}
