/**
 * NEX+ · Hierarquia de Erros do Boundary de Material Context Pin
 * Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 */

export class MaterialContextInvariantViolationError extends Error {
  readonly violationType: string;

  constructor(violationType: string, message: string) {
    super(`[NEX+ Material Context Invariant Violation] ${violationType}: ${message}`);
    this.name = 'MaterialContextInvariantViolationError';
    this.violationType = violationType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MaterialContextAuthorizationError extends Error {
  readonly operation: string;
  readonly pinId?: string;

  constructor(operation: string, pinId?: string, message?: string) {
    super(
      message ??
        `Unauthorized material context operation '${operation}'${pinId ? ` for pin '${pinId}'` : ''}.`
    );
    this.name = 'MaterialContextAuthorizationError';
    this.operation = operation;
    this.pinId = pinId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MaterialContextPinNotFoundError extends Error {
  readonly pinId: string;

  constructor(pinId: string) {
    super(`Material context pin '${pinId}' not found.`);
    this.name = 'MaterialContextPinNotFoundError';
    this.pinId = pinId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
