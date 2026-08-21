/**
 * NEX+ · Erros Tipados de Persistência de Observações & Projeções
 * Escopo 0.85 (Bloco 0.85B)
 */

export class ObservationPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationPersistenceError';
  }
}

export class IdempotencyConflictError extends ObservationPersistenceError {
  readonly scope: string;
  readonly key: string;
  readonly existingObservationId: string;
  readonly attemptedObservationId: string;

  constructor(params: {
    scope: string;
    key: string;
    existingObservationId: string;
    attemptedObservationId: string;
  }) {
    super(
      `Idempotency conflict for scope '${params.scope}' and key '${params.key}': already bound to observation '${params.existingObservationId}', cannot bind to '${params.attemptedObservationId}'.`
    );
    this.name = 'IdempotencyConflictError';
    this.scope = params.scope;
    this.key = params.key;
    this.existingObservationId = params.existingObservationId;
    this.attemptedObservationId = params.attemptedObservationId;
  }
}

export class StaleCanonicalBaseConflictError extends ObservationPersistenceError {
  readonly domain: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly expectedBaseRevisionId?: string;
  readonly currentHeadRevisionId?: string;

  constructor(params: {
    domain: string;
    entityType: string;
    entityId: string;
    expectedBaseRevisionId?: string;
    currentHeadRevisionId?: string;
  }) {
    super(
      `Stale canonical base conflict for subject '${params.domain}:${params.entityType}:${params.entityId}': expected base '${params.expectedBaseRevisionId ?? 'none'}', but current head is '${params.currentHeadRevisionId ?? 'none'}'.`
    );
    this.name = 'StaleCanonicalBaseConflictError';
    this.domain = params.domain;
    this.entityType = params.entityType;
    this.entityId = params.entityId;
    this.expectedBaseRevisionId = params.expectedBaseRevisionId;
    this.currentHeadRevisionId = params.currentHeadRevisionId;
  }
}

export class RecordNotFoundError extends ObservationPersistenceError {
  readonly recordType: string;
  readonly id: string;

  constructor(recordType: string, id: string) {
    super(`${recordType} with id '${id}' was not found.`);
    this.name = 'RecordNotFoundError';
    this.recordType = recordType;
    this.id = id;
  }
}

export class PersistenceInvariantViolationError extends ObservationPersistenceError {
  readonly violationType: string;

  constructor(violationType: string, message: string) {
    super(`Persistence invariant violation [${violationType}]: ${message}`);
    this.name = 'PersistenceInvariantViolationError';
    this.violationType = violationType;
  }
}
