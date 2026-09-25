/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Erros Determinísticos de Persistência — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 */

export {
  DuplicateIdError,
  InvalidAttemptTransitionError,
  InvalidAttemptReferenceError,
  InvalidSignalReferenceError,
  InvalidEvidenceReferenceError,
  InvalidAssessmentReferenceError,
  InvalidAssessmentLineageError,
  CrossAttemptReferenceError,
  InvalidReceiptStructureError,
} from '../ledger';

/**
 * Erro lançado quando uma linha retornada pelo banco de dados viola o trust boundary
 * (ex: campos obrigatórios ausentes, JSONB corrompido, tipo inválido ou timestamps malformados).
 */
export class CorruptedLedgerRowError extends Error {
  readonly table: string;
  readonly entityId?: string;
  readonly detail: string;

  constructor(table: string, detail: string, entityId?: string) {
    super(`[L0 Execution Ledger Persistence] Corrupted row in table '${table}'${entityId ? ` for ID '${entityId}'` : ''}: ${detail}`);
    this.name = 'CorruptedLedgerRowError';
    this.table = table;
    this.entityId = entityId;
    this.detail = detail;
  }
}
