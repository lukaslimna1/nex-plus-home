/**
 * NEX+ · Input Record Service
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3 · Rodada B3-R1)
 *
 * Responsabilidades:
 * 1. Constrói o InputRecord canônico imutável a partir do OperationalContext confiável e draft não-autoritativo.
 * 2. Deriva estritamente do OperationalContext: actor, userId, sessionRef, contextSubjectRef, channel, correlationId.
 * 3. Não copia location, focus, observedInteraction nem objetos inteiros de domínio.
 * 4. Imutabilidade profunda: canonicaliza e congela profundamente cada InputPart e SourceEventIdentity.
 * 5. Replay seguro: reconhece duplicate delivery de SourceEventIdentity ANTES de validar content_ref/expiração.
 * 6. Boundary de autorização de leitura: exige InputRecordAccessAuthorizer fail-closed (SourceEventIdentity não autoriza leitura).
 * 7. Persiste atomicamente InputRecord e suas InputPart[] relacionais no PostgreSQL.
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
  InputRecordAccessAuthorizer,
} from './contracts';
import {
  validateInputRecordId,
  validateInputRecord,
  validateRecordInputDraft,
  sanitizeActor,
  sanitizeContextSubjectRef,
  sanitizeInputPart,
  sanitizeSourceEventIdentity,
} from './invariants';
import {
  IngressAuthorizationError,
  InputRecordAuthorizationError,
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
  readonly inputAuthorizer: InputRecordAccessAuthorizer;
  readonly nowProvider?: () => string;
}

export class InputRecordService {
  private readonly inputStore: InputRecordStore;
  private readonly contentStore: IngressContentStore;
  private readonly authorizer: IngressAccessAuthorizer;
  private readonly inputAuthorizer: InputRecordAccessAuthorizer;
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
    if (!options.inputAuthorizer || typeof options.inputAuthorizer.authorize !== 'function') {
      throw new Error('InputRecordService requires a valid InputRecordAccessAuthorizer instance (fail-closed).');
    }

    this.inputStore = options.inputStore;
    this.contentStore = options.contentStore;
    this.authorizer = options.authorizer;
    this.inputAuthorizer = options.inputAuthorizer;
    this.nowProvider = options.nowProvider ?? (() => new Date().toISOString());
  }

  /**
   * Registra uma nova ocorrência de entrada no NEX+:
   * 1. Valida draft e OperationalContext confiável.
   * 2. Se houver SourceEventIdentity, verifica se a ocorrência externa já existe ANTES
   *    de resolver anexos, verificar expiração ou executar attach_to_input.
   * 3. Se for reentrega de ocorrência existente, executa autorização de leitura 'read'
   *    do InputRecord contra o OperationalContext atual antes de retornar.
   * 4. Se for nova ocorrência, valida parts e autorizações de attachment.
   * 5. Canonicaliza defensivamente e congela profundamente todos os objetos e partes.
   * 6. Persiste atomicamente e retorna o registro imutável.
   */
  async recordInput(
    draft: RecordInputDraft,
    context: OperationalContext
  ): Promise<RecordInputResult> {
    validateRecordInputDraft(draft);
    validateOperationalContext(context);

    // 1. Verificação de reentrega duplicada via SourceEventIdentity (se fornecida)
    // Executada ANTES de resolver content_ref, checar expiração ou autorizar attachment
    if (draft.sourceEventIdentity) {
      const canonicalSourceEvent = sanitizeSourceEventIdentity(draft.sourceEventIdentity);
      const existing = await this.inputStore.findBySourceEventIdentity(canonicalSourceEvent);

      if (existing) {
        // SourceEventIdentity NÃO concede autoridade de leitura: exige autorização explícita do InputRecord
        const isAuthorized = await this.inputAuthorizer.authorize({
          operation: 'read',
          context,
          record: existing,
        });

        if (!isAuthorized) {
          throw new InputRecordAuthorizationError(
            'read',
            undefined,
            'Unauthorized to access existing duplicate input record.'
          );
        }

        return {
          record: existing,
          deduplicated: true,
        };
      }
    }

    // 2. Canonicalização defensiva profunda de cada parte (preserva texto original sem trim)
    const canonicalParts = draft.parts.map(sanitizeInputPart);

    // 3. Verificação e autorização de cada content_ref para nova ocorrência
    for (const part of canonicalParts) {
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

    // 4. Montar InputRecord canônico profundamente imutável
    const inputId = (draft.inputId ?? `inp_${randomUUID()}`) as InputRecordId;
    validateInputRecordId(inputId);

    const receivedAt = this.nowProvider();

    const canonicalSourceEventIdentity = draft.sourceEventIdentity
      ? sanitizeSourceEventIdentity(draft.sourceEventIdentity)
      : undefined;

    const record: InputRecord = Object.freeze({
      inputId,
      actor: sanitizeActor(context.actor),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.sessionRef ? { sessionRef: context.sessionRef } : {}),
      ...(context.contextSubjectRef
        ? { contextSubjectRef: sanitizeContextSubjectRef(context.contextSubjectRef) }
        : {}),
      ...(draft.sourceRefId ? { sourceRefId: draft.sourceRefId } : {}),
      ...(canonicalSourceEventIdentity ? { sourceEventIdentity: canonicalSourceEventIdentity } : {}),
      ...(draft.occurredAt ? { occurredAt: draft.occurredAt } : {}),
      receivedAt,
      ...(context.channel ? { channel: context.channel } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      parts: Object.freeze(canonicalParts),
    });

    validateInputRecord(record);

    try {
      const savedRecord = await this.inputStore.saveInputRecord(record);
      return {
        record: savedRecord,
        deduplicated: false,
      };
    } catch (err: any) {
      // Concorrência: se falhou por chave única de source_event_identity, recupera o já salvo e autoriza leitura
      if (
        draft.sourceEventIdentity &&
        (err.code === '23505' || String(err.message).includes('duplicate key') || String(err.message).includes('source_event'))
      ) {
        const canonicalSourceEvent = sanitizeSourceEventIdentity(draft.sourceEventIdentity);
        const existing = await this.inputStore.findBySourceEventIdentity(canonicalSourceEvent);
        if (existing) {
          const isAuthorized = await this.inputAuthorizer.authorize({
            operation: 'read',
            context,
            record: existing,
          });

          if (!isAuthorized) {
            throw new InputRecordAuthorizationError(
              'read',
              undefined,
              'Unauthorized to access existing duplicate input record.'
            );
          }

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
   * Obtém um InputRecord pelo seu ID canônico após verificar autorização de leitura.
   */
  async getInputRecord(
    inputId: InputRecordId,
    context: OperationalContext
  ): Promise<InputRecord> {
    validateInputRecordId(inputId);
    validateOperationalContext(context);

    const record = await this.inputStore.getInputRecord(inputId);
    if (!record) {
      throw new InputRecordNotFoundError(inputId);
    }

    const isAuthorized = await this.inputAuthorizer.authorize({
      operation: 'read',
      context,
      record,
    });

    if (!isAuthorized) {
      throw new InputRecordAuthorizationError('read', inputId);
    }

    return record;
  }
}
