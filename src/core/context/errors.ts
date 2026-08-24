/**
 * NEX+ · Erros Tipados do Contexto Operacional & Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Todas as mensagens de erro são seguras para auditoria:
 * Não contêm JWT, cookies, _sid, tokens ou segredos de infraestrutura.
 */

import type { SessionRef } from '../../auth/session-ref.types';

export class OperationalContextInvariantError extends Error {
  readonly code = 'OPERATIONAL_CONTEXT_INVARIANT_VIOLATION';
  readonly violationType: string;

  constructor(violationType: string, message: string) {
    super(`[OperationalContext] Invariant violation (${violationType}): ${message}`);
    this.name = 'OperationalContextInvariantError';
    this.violationType = violationType;
  }
}

export class SessionOperationalStateInvariantError extends Error {
  readonly code = 'SESSION_OPERATIONAL_STATE_INVARIANT_VIOLATION';
  readonly violationType: string;

  constructor(violationType: string, message: string) {
    super(`[SessionOperationalState] Invariant violation (${violationType}): ${message}`);
    this.name = 'SessionOperationalStateInvariantError';
    this.violationType = violationType;
  }
}

export class SessionOperationalStateOwnershipMismatchError extends Error {
  readonly code = 'SESSION_OPERATIONAL_STATE_OWNERSHIP_MISMATCH';
  readonly sessionRef: SessionRef;
  readonly expectedUserId: string;
  readonly actualUserId: string;

  constructor(params: {
    sessionRef: SessionRef;
    expectedUserId: string;
    actualUserId: string;
  }) {
    super(
      `[SessionOperationalState] Ownership mismatch for sessionRef '${params.sessionRef}': expected caller/owner '${params.expectedUserId}', but found state bound to user '${params.actualUserId}'.`
    );
    this.name = 'SessionOperationalStateOwnershipMismatchError';
    this.sessionRef = params.sessionRef;
    this.expectedUserId = params.expectedUserId;
    this.actualUserId = params.actualUserId;
  }
}

export class SessionOperationalStateRevisionConflictError extends Error {
  readonly code = 'SESSION_OPERATIONAL_STATE_REVISION_CONFLICT';
  readonly sessionRef: SessionRef;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(params: {
    sessionRef: SessionRef;
    expectedRevision: number;
    actualRevision: number;
  }) {
    super(
      `[SessionOperationalState] Revision conflict for sessionRef '${params.sessionRef}': expected revision ${params.expectedRevision}, but current revision is ${params.actualRevision}.`
    );
    this.name = 'SessionOperationalStateRevisionConflictError';
    this.sessionRef = params.sessionRef;
    this.expectedRevision = params.expectedRevision;
    this.actualRevision = params.actualRevision;
  }
}

export class SessionOperationalStateNotFoundError extends Error {
  readonly code = 'SESSION_OPERATIONAL_STATE_NOT_FOUND';
  readonly sessionRef: SessionRef;

  constructor(sessionRef: SessionRef) {
    super(`[SessionOperationalState] No operational state found for sessionRef '${sessionRef}'.`);
    this.name = 'SessionOperationalStateNotFoundError';
    this.sessionRef = sessionRef;
  }
}
