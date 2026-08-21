/**
 * NEX+ · Artifact Access Authorizer & ACL Boundary
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Boundary fail-closed estrutural.
 * Toda operação governada sem autorização explícita configurada é rejeitada por padrão.
 */

import type {
  ArtifactAccessAuthorizer,
  ArtifactAccessContext,
  ArtifactAccessDecision,
  ArtifactAccessOperation,
} from './contracts';

export class DefaultArtifactAccessAuthorizer implements ArtifactAccessAuthorizer {
  async authorize(
    context: ArtifactAccessContext,
    expectedOperation?: ArtifactAccessOperation
  ): Promise<ArtifactAccessDecision> {
    if (!context) {
      return {
        granted: false,
        reasonCode: 'ACCESS_DENIED_MISSING_CONTEXT',
        explanation: 'ArtifactAccessContext is required for all governed operations.',
      };
    }

    if (expectedOperation && context.operation !== expectedOperation) {
      return {
        granted: false,
        reasonCode: 'ACCESS_DENIED_OPERATION_MISMATCH',
        explanation: `Context operation '${context.operation}' does not match expected operation '${expectedOperation}'.`,
      };
    }

    // Fail-Closed estrito de produção por padrão
    // A presença de um ator por si só NÃO concede autorização irrestrita
    return {
      granted: false,
      reasonCode: 'ACCESS_DENIED_FAIL_CLOSED',
      explanation: `Default authorizer denies all operations without explicit role policies configured. Operation '${context.operation}' denied.`,
    };
  }
}
