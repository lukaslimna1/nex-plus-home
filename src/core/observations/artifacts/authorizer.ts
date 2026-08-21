/**
 * NEX+ · Artifact Access Authorizer & ACL Boundary
 * Escopo 0.85 (Bloco 0.85C)
 *
 * Boundary fail-closed para operações de leitura, escrita, backup, restore
 * e inspeção de integridade de artefatos duráveis.
 */

import type {
  ArtifactAccessAuthorizer,
  ArtifactAccessContext,
  ArtifactAccessDecision,
} from './contracts';

export class DefaultArtifactAccessAuthorizer implements ArtifactAccessAuthorizer {
  async authorize(context: ArtifactAccessContext): Promise<ArtifactAccessDecision> {
    // Modo explícito de teste / sistema interno autorizado
    if (context.bypassForTesting) {
      return {
        granted: true,
        reasonCode: 'TEST_BYPASS_GRANTED',
        explanation: 'Explicit test or internal root bypass authorization granted.',
      };
    }

    // Se o ator for um humano ou componente de sistema com contexto válido
    if (context.actor) {
      if (context.actor.kind === 'system' || context.actor.kind === 'max' || context.actor.kind === 'human') {
        return {
          granted: true,
          reasonCode: 'SYSTEM_ACTOR_AUTHORIZED',
          explanation: `Actor of kind '${context.actor.kind}' is authorized for operation '${context.operation}'.`,
        };
      }
    }

    // Fail-closed por padrão
    return {
      granted: false,
      reasonCode: 'ACCESS_DENIED_NO_VALID_AUTHORIZATION',
      explanation: `No valid actor or explicit permission provided for operation '${context.operation}'.`,
    };
  }
}
