/**
 * NEX+ · Hierarquia de Erros do Boundary de Input & Ingress Content
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 */

export class InputInvariantViolationError extends Error {
  readonly violationType: string;

  constructor(violationType: string, message: string) {
    super(`[NEX+ Input Invariant Violation] ${violationType}: ${message}`);
    this.name = 'InputInvariantViolationError';
    this.violationType = violationType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IngressAuthorizationError extends Error {
  readonly operation: string;
  readonly contentId?: string;

  constructor(operation: string, contentId?: string, message?: string) {
    super(
      message ??
        `Unauthorized ingress operation '${operation}'${contentId ? ` for content '${contentId}'` : ''}.`
    );
    this.name = 'IngressAuthorizationError';
    this.operation = operation;
    this.contentId = contentId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IngressContentInspectionError extends Error {
  readonly declaredMimeType?: string;
  readonly reason: string;

  constructor(reason: string, declaredMimeType?: string) {
    super(
      `Ingress content inspection rejected: ${reason}${declaredMimeType ? ` (declared: ${declaredMimeType})` : ''}.`
    );
    this.name = 'IngressContentInspectionError';
    this.reason = reason;
    this.declaredMimeType = declaredMimeType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IngressContentExpiredError extends Error {
  readonly contentId: string;
  readonly expiresAt: string;

  constructor(contentId: string, expiresAt: string) {
    super(`Ingress content '${contentId}' expired at '${expiresAt}' and cannot be accessed or attached.`);
    this.name = 'IngressContentExpiredError';
    this.contentId = contentId;
    this.expiresAt = expiresAt;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IngressContentNotFoundError extends Error {
  readonly contentId: string;

  constructor(contentId: string) {
    super(`Ingress content '${contentId}' not found.`);
    this.name = 'IngressContentNotFoundError';
    this.contentId = contentId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InputRecordNotFoundError extends Error {
  readonly inputId: string;

  constructor(inputId: string) {
    super(`Input record '${inputId}' not found.`);
    this.name = 'InputRecordNotFoundError';
    this.inputId = inputId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IngressIntegrityError extends Error {
  readonly contentId: string;
  readonly storageKey: string;
  readonly reason: string;

  constructor(contentId: string, storageKey: string, reason: string) {
    super(`Ingress content integrity failure for '${contentId}' (storageKey: '${storageKey}'): ${reason}`);
    this.name = 'IngressIntegrityError';
    this.contentId = contentId;
    this.storageKey = storageKey;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
