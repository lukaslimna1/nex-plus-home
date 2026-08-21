import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultArtifactAccessAuthorizer } from '../authorizer';
import type { ArtifactAccessContext } from '../contracts';

describe('Escopo 0.85C · DefaultArtifactAccessAuthorizer (Fronteira ACL Fail-Closed)', () => {
  const authorizer = new DefaultArtifactAccessAuthorizer();

  it('AA: Acesso sem ator ou bypass explícito é negado (Fail-Closed)', async () => {
    const context: ArtifactAccessContext = {
      operation: 'read',
    };

    const decision = await authorizer.authorize(context);
    assert.equal(decision.granted, false);
    assert.equal(decision.reasonCode, 'ACCESS_DENIED_NO_VALID_AUTHORIZATION');
  });

  it('AB: Acesso com ator humano ou sistema autorizado é concedido', async () => {
    const contextHuman: ArtifactAccessContext = {
      operation: 'read',
      actor: { kind: 'human', humanId: 'user_lucas', role: 'admin' },
    };

    const decisionHuman = await authorizer.authorize(contextHuman);
    assert.equal(decisionHuman.granted, true);
    assert.equal(decisionHuman.reasonCode, 'SYSTEM_ACTOR_AUTHORIZED');

    const contextSystem: ArtifactAccessContext = {
      operation: 'backup',
      actor: { kind: 'system', component: 'backup_service' },
    };

    const decisionSystem = await authorizer.authorize(contextSystem);
    assert.equal(decisionSystem.granted, true);
  });

  it('AC: Autorização de bypass de teste funciona de forma controlada', async () => {
    const context: ArtifactAccessContext = {
      operation: 'integrity_inspect',
      bypassForTesting: true,
    };

    const decision = await authorizer.authorize(context);
    assert.equal(decision.granted, true);
    assert.equal(decision.reasonCode, 'TEST_BYPASS_GRANTED');
  });
});
