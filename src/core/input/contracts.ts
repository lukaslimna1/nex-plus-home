/**
 * NEX+ · InputRecord Multimodal & Ingress Content
 * Contratos Canônicos TypeScript — Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Princípios Fundamentais:
 * 1. InputRecord é o FATO ORIGINAL da entrada, imutável e multipart ordenado.
 * 2. InputRecordId != SourceEventIdentity.
 * 3. SHA-256 é integridade/deduplicação física, NUNCA identidade de domínio.
 * 4. IngressContentId != SHA-256 != storageKey != provider file ID.
 * 5. Referência identifica, NUNCA autoriza (INV-INPUT-NO-AUTHORITY).
 * 6. Contexto é sinal, NUNCA autoridade.
 * 7. Eixos de autoridade (actor, userId, sessionRef, contextSubjectRef, channel, correlationId)
 *    derivam exclusivamente do OperationalContext confiável do B2.
 * 8. InputRecord NÃO copia location, focus, observedInteraction nem objetos inteiros de domínio.
 * 9. Ingress transitório != Resource != Evidence durável.
 * 10. Provider IDs e storageKey são detalhes internos e nunca entram no contrato canônico público.
 */

import type {
  Actor,
  SourceRefId,
  EvidenceArtifactRefId,
} from '../observations/contracts';
import type { SessionRef } from '../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  OperationalChannel,
  OperationalContext,
} from '../context/contracts';
import type {
  CorrelationId,
  ResourceRef,
  EventId,
} from '../modules/contracts';

// ============================================================================
// 1. IDENTIFICADORES BRANDED (Semantic Aliases)
// ============================================================================

export type InputRecordId = string & { readonly __brand?: 'InputRecordId' };
export type IngressContentId = string & { readonly __brand?: 'IngressContentId' };

// ============================================================================
// 2. SOURCE EVENT IDENTITY
// ============================================================================

/**
 * Identidade estável de uma ocorrência originada em fonte externa.
 * Somente existe quando a origem realmente fornece identidade estável.
 */
export interface SourceEventIdentity {
  readonly source: string;
  readonly id: string;
}

// ============================================================================
// 3. INGRESS CONTENT REF
// ============================================================================

/**
 * Referência semântica pública mínima a um conteúdo binário/documental
 * materializado no Ingress Content Store. Não expõe storageKey nem hash.
 */
export interface IngressContentRef {
  readonly contentId: IngressContentId;
}

// ============================================================================
// 4. INPUT PART (Discriminated Union Estrita)
// ============================================================================

export interface TextInputPart {
  readonly kind: 'text';
  readonly text: string;
}

export interface ContentRefInputPart {
  readonly kind: 'content_ref';
  readonly content: IngressContentRef;
}

export interface EventRefInputPart {
  readonly kind: 'event_ref';
  readonly eventId: EventId;
}

export interface ResourceRefInputPart {
  readonly kind: 'resource_ref';
  readonly resource: ResourceRef;
}

export interface EvidenceRefInputPart {
  readonly kind: 'evidence_ref';
  readonly evidenceArtifactId: EvidenceArtifactRefId;
}

export type InputPart =
  | TextInputPart
  | ContentRefInputPart
  | EventRefInputPart
  | ResourceRefInputPart
  | EvidenceRefInputPart;

export type InputPartKind = InputPart['kind'];

// ============================================================================
// 5. INPUT RECORD (Envelope Canônico Imutável)
// ============================================================================

export interface InputRecord {
  readonly inputId: InputRecordId;

  readonly actor: Actor;
  readonly userId?: string;
  readonly sessionRef?: SessionRef;
  readonly contextSubjectRef?: ContextSubjectRef;

  readonly sourceRefId?: SourceRefId;
  readonly sourceEventIdentity?: SourceEventIdentity;

  readonly occurredAt?: string;
  readonly receivedAt: string;

  readonly channel?: OperationalChannel;
  readonly correlationId?: CorrelationId;

  readonly parts: readonly InputPart[];
}

// ============================================================================
// 6. INGRESS CONTENT RECORD (Metadata Interna Append-Only)
// ============================================================================

export interface IngressContentRecord {
  readonly contentId: IngressContentId;

  readonly actor: Actor;
  readonly userId?: string;
  readonly sessionRef?: SessionRef;
  readonly contextSubjectRef?: ContextSubjectRef;

  readonly sourceRefId?: SourceRefId;

  readonly declaredMimeType?: string;
  readonly verifiedMimeType: string;

  readonly sha256: string;
  readonly byteSize: number;

  readonly storageBackend: string;
  readonly storageKey: string;

  readonly receivedAt: string;
  readonly expiresAt?: string;
}

// ============================================================================
// 7. PARÂMETROS E RESULTADOS DOS SERVIÇOS
// ============================================================================

export interface RecordInputDraft {
  readonly inputId?: InputRecordId;
  readonly parts: readonly InputPart[];
  readonly sourceRefId?: SourceRefId;
  readonly sourceEventIdentity?: SourceEventIdentity;
  readonly occurredAt?: string;
}

export interface RecordInputResult {
  readonly record: InputRecord;
  readonly deduplicated: boolean;
}

export interface IngestContentParams {
  readonly contentId?: IngressContentId;
  readonly data: Buffer | NodeJS.ReadableStream;
  readonly declaredMimeType?: string;
  readonly sourceRefId?: SourceRefId;
  readonly expiresAt?: string;
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
}

// ============================================================================
// 8. TRUST BOUNDARY: AUTHORIZER & INSPECTOR
// ============================================================================

export type IngressAccessOperation = 'create' | 'read' | 'attach_to_input';

export interface IngressAccessAuthorizer {
  authorize(params: {
    readonly operation: IngressAccessOperation;
    readonly context: OperationalContext;
    readonly content?: IngressContentRecord;
    readonly contentId?: IngressContentId;
  }): Promise<boolean>;
}

export interface IngressContentInspectionResult {
  readonly accepted: boolean;
  readonly verifiedMimeType?: string;
  readonly rejectionReason?: string;
}

export interface IngressContentInspector {
  inspect(params: {
    readonly declaredMimeType?: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly sampleBuffer?: Buffer;
  }): Promise<IngressContentInspectionResult>;
}
