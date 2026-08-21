import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultArtifactAccessAuthorizer } from '../authorizer';
import type {
  ArtifactAccessAuthorizer,
  ArtifactAccessContext,
  ArtifactAccessDecision,
  ArtifactAccessOperation,
} from '../contracts';

/**
 * Helper de autorização irrestrita exclusivo para uso em suítes de teste.
 * NÃO exportado pelo barrel de produção.
 */
export class AllowAllTestArtifactAuthorizer implements ArtifactAccessAuthorizer {
  async authorize(
    context: ArtifactAccessContext,
    expectedOperation?: ArtifactAccessOperation
  ): Promise<ArtifactAccessDecision> {
    if (!context) {
      return { granted: false, reasonCode: 'TEST_NO_CONTEXT' };
    }
    if (expectedOperation && context.operation !== expectedOperation) {
      return { granted: false, reasonCode: 'TEST_OPERATION_MISMATCH' };
    }
    return {
      granted: true,
      reasonCode: 'TEST_EXPLICIT_ALLOW_ALL',
    };
  }
}

describe('Escopo 0.85C · DefaultArtifactAccessAuthorizer (Fronteira ACL Fail-Closed)', () => {
  const authorizer = new DefaultArtifactAccessAuthorizer();

  it('ACL-1: Acesso sem contexto é rejeitado (Fail-Closed)', async () => {
    const decision = await authorizer.authorize(null as any);
    assert.equal(decision.granted, false);
    assert.equal(decision.reasonCode, 'ACCESS_DENIED_MISSING_CONTEXT');
  });

  it('ACL-2: Ator human sem regra explícita recebe DENY (human não ganha restore/read por existir)', async () => {
    const contextHuman: ArtifactAccessContext = {
      operation: 'restore',
      actor: { kind: 'human', humanId: 'user_lucas', role: 'admin' },
    };

    const decision = await authorizer.authorize(contextHuman, 'restore');
    assert.equal(decision.granted, false);
    assert.equal(decision.reasonCode, 'ACCESS_DENIED_FAIL_CLOSED');
  });

  it('ACL-3: Ator MAX/System sem regra explícita recebe DENY', async () => {
    const contextMax: ArtifactAccessContext = {
      operation: 'backup',
      actor: { kind: 'max', maxVersion: '1.0' },
    };

    const decision = await authorizer.authorize(contextMax, 'backup');
    assert.equal(decision.granted, false);
    assert.equal(decision.reasonCode, 'ACCESS_DENIED_FAIL_CLOSED');
  });

  it('ACL-4: Operation confusion / mismatch é rejeitado', async () => {
    const contextRead: ArtifactAccessContext = {
      operation: 'read',
      actor: { kind: 'system', component: 'test' },
    };

    // Caller tenta usar contexto de 'read' para executar 'restore'
    const decision = await authorizer.authorize(contextRead, 'restore');
    assert.equal(decision.granted, false);
    assert.equal(decision.reasonCode, 'ACCESS_DENIED_OPERATION_MISMATCH');
  });

  it('ACL-5: AllowAllTestArtifactAuthorizer permite operações em ambiente de teste controlado', async () => {
    const testAuth = new AllowAllTestArtifactAuthorizer();
    const context: ArtifactAccessContext = {
      operation: 'read',
    };

    const decision = await testAuth.authorize(context, 'read');
    assert.equal(decision.granted, true);
    assert.equal(decision.reasonCode, 'TEST_EXPLICIT_ALLOW_ALL');
  });
});
