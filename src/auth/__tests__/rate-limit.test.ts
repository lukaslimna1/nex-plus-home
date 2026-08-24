/**
 * NEX+ · Auth Layer
 * Testes Unitários do Rate Limiter de Recuperação de Senha (Zero-Cost Anti-Flood)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter } from '../rate-limiter';

describe('NEX+ Auth · Sliding Window Rate Limiter (Forgot Password Anti-Flood)', () => {
  it('1. Permite até o limite máximo configurado para um mesmo e-mail na mesma janela', () => {
    const limiter = new SlidingWindowRateLimiter({
      maxRequestsPerEmail: 3,
      windowMs: 60000,
      globalMaxRequests: 10,
    });

    const now = 1000000;
    assert.equal(limiter.consume('user@starlevel.com.br', now), true);
    assert.equal(limiter.consume('user@starlevel.com.br', now + 1000), true);
    assert.equal(limiter.consume('user@starlevel.com.br', now + 2000), true);

    // 4ª tentativa dentro da mesma janela de 60s deve ser rejeitada
    assert.equal(limiter.consume('user@starlevel.com.br', now + 3000), false);
  });

  it('2. E-mails diferentes possuem cotas individuais independentes', () => {
    const limiter = new SlidingWindowRateLimiter({
      maxRequestsPerEmail: 2,
      windowMs: 60000,
      globalMaxRequests: 10,
    });

    const now = 1000000;
    assert.equal(limiter.consume('user1@starlevel.com.br', now), true);
    assert.equal(limiter.consume('user1@starlevel.com.br', now + 1000), true);
    assert.equal(limiter.consume('user1@starlevel.com.br', now + 2000), false); // user1 esgotou

    // user2 ainda tem cota livre
    assert.equal(limiter.consume('user2@starlevel.com.br', now + 2000), true);
    assert.equal(limiter.consume('user2@starlevel.com.br', now + 3000), true);
    assert.equal(limiter.consume('user2@starlevel.com.br', now + 4000), false); // user2 esgotou
  });

  it('3. Janela de tempo deslizante libera novas tentativas após windowMs', () => {
    const limiter = new SlidingWindowRateLimiter({
      maxRequestsPerEmail: 2,
      windowMs: 60000, // 60 segundos
      globalMaxRequests: 10,
    });

    const now = 1000000;
    assert.equal(limiter.consume('user@starlevel.com.br', now), true);
    assert.equal(limiter.consume('user@starlevel.com.br', now + 10000), true);
    assert.equal(limiter.consume('user@starlevel.com.br', now + 20000), false);

    // Avançar tempo além da janela de 60s para o primeiro registro
    const futureTime = now + 65000;
    assert.equal(limiter.consume('user@starlevel.com.br', futureTime), true);
  });

  it('4. Normalização de e-mail impede bypass com maiúsculas ou espaços', () => {
    const limiter = new SlidingWindowRateLimiter({
      maxRequestsPerEmail: 1,
      windowMs: 60000,
    });

    const now = 1000000;
    assert.equal(limiter.consume('User.Test@StarLevel.com.br ', now), true);
    assert.equal(limiter.consume('  user.test@starlevel.com.br', now + 1000), false);
  });

  it('5. Limite global impede flood automatizado com múltiplos e-mails forjados', () => {
    const limiter = new SlidingWindowRateLimiter({
      maxRequestsPerEmail: 5,
      windowMs: 60000,
      globalMaxRequests: 3,
    });

    const now = 1000000;
    assert.equal(limiter.consume('attacker1@domain.com', now), true);
    assert.equal(limiter.consume('attacker2@domain.com', now + 100), true);
    assert.equal(limiter.consume('attacker3@domain.com', now + 200), true);

    // GlobalMax (3) atingido
    assert.equal(limiter.consume('attacker4@domain.com', now + 300), false);
  });
});
