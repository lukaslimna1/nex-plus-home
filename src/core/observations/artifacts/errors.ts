/**
 * NEX+ · Evidence Artifact Store Errors
 * Escopo 0.85 (Bloco 0.85C)
 */

export class ArtifactNotFoundError extends Error {
  readonly artifactId: string;

  constructor(artifactId: string) {
    super(`Evidence artifact '${artifactId}' was not found.`);
    this.name = 'ArtifactNotFoundError';
    this.artifactId = artifactId;
  }
}

export class ArtifactIntegrityError extends Error {
  readonly storageKey: string;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;

  constructor(params: { storageKey: string; expectedSha256?: string; actualSha256?: string; message?: string }) {
    const msg = params.message ?? `Artifact integrity violation on '${params.storageKey}': expected '${params.expectedSha256}', found '${params.actualSha256}'.`;
    super(msg);
    this.name = 'ArtifactIntegrityError';
    this.storageKey = params.storageKey;
    this.expectedSha256 = params.expectedSha256;
    this.actualSha256 = params.actualSha256;
  }
}

export class ArtifactIdentityConflictError extends Error {
  readonly artifactId: string;
  readonly reason: string;

  constructor(artifactId: string, reason: string) {
    super(`Artifact identity conflict for '${artifactId}': ${reason}`);
    this.name = 'ArtifactIdentityConflictError';
    this.artifactId = artifactId;
    this.reason = reason;
  }
}

export class ArtifactTooLargeError extends Error {
  readonly byteSize: number;
  readonly maxArtifactBytes: number;

  constructor(byteSize: number, maxArtifactBytes: number) {
    super(`Artifact size (${byteSize} bytes) exceeds maximum permitted limit of ${maxArtifactBytes} bytes.`);
    this.name = 'ArtifactTooLargeError';
    this.byteSize = byteSize;
    this.maxArtifactBytes = maxArtifactBytes;
  }
}

export class SecretMaterialRejectedError extends Error {
  constructor(reason?: string) {
    super(`Evidence artifact rejected: contains secret material. Secret or credential material is strictly forbidden in durable evidence. ${reason ?? ''}`.trim());
    this.name = 'SecretMaterialRejectedError';
  }
}

export class ArtifactAccessDeniedError extends Error {
  readonly operation: string;
  readonly reasonCode: string;

  constructor(operation: string, reasonCode: string, details?: string) {
    super(`Artifact access denied for operation '${operation}' (reason: ${reasonCode}). ${details ?? ''}`.trim());
    this.name = 'ArtifactAccessDeniedError';
    this.operation = operation;
    this.reasonCode = reasonCode;
  }
}

export class ArtifactStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ArtifactStorageError';
  }
}

export class ArtifactInvariantViolationError extends Error {
  readonly violationType: string;

  constructor(violationType: string, message: string) {
    super(`[${violationType}] ${message}`);
    this.name = 'ArtifactInvariantViolationError';
    this.violationType = violationType;
  }
}
