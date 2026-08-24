/**
 * NEX+ · Contratos de Persistência de Input & Ingress Content
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 */

import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  InputRecord,
  IngressContentRecord,
} from '../contracts';

export interface IngressContentStore {
  saveContent(record: IngressContentRecord): Promise<IngressContentRecord>;
  getContent(contentId: IngressContentId): Promise<IngressContentRecord | null>;
  hasContent(contentId: IngressContentId): Promise<boolean>;
}

export interface InputRecordStore {
  saveInputRecord(record: InputRecord): Promise<InputRecord>;
  getInputRecord(inputId: InputRecordId): Promise<InputRecord | null>;
  findBySourceEventIdentity(identity: SourceEventIdentity): Promise<InputRecord | null>;
}
