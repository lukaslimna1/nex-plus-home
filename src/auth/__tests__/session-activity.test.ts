/**
 * NEX+ · Auth Layer
 * Testes Unitários do Controlador de Atividade, Inatividade e Sliding Session
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionActivityController,
  type SessionBroadcastMessage,
  type BroadcastChannelLike,
} from '../session-activity';

class MockBroadcastChannel implements BroadcastChannelLike {
  public messages: unknown[] = [];
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public closed = false;

  constructor(public name: string) {}

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  close(): void {
    this.closed = true;
  }

  simulateIncomingMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }
}

describe('NEX+ Auth · Session Activity Controller (Sliding Session & Inactivity)', () => {
  it('1. Inicializa em estado ACTIVE e com countdown padrão', () => {
    const controller = new SessionActivityController({
      inactivityTimeoutMs: 1000,
      warningCountdownSeconds: 10,
    });

    assert.equal(controller.getState(), 'ACTIVE');
    assert.equal(controller.getCountdown(), 10);
    controller.destroy();
  });

  it('2. Entra em estado WARNING quando atinge o tempo de inatividade', async () => {
    let stateRecorded = '';
    let countdownRecorded = 0;

    const controller = new SessionActivityController({
      inactivityTimeoutMs: 50,
      warningCountdownSeconds: 5,
      onStateChange: (state, countdown) => {
        stateRecorded = state;
        countdownRecorded = countdown;
      },
    });

    assert.equal(controller.getState(), 'ACTIVE');

    // Aguardar o timeout de inatividade disparar
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(stateRecorded, 'WARNING');
    assert.equal(countdownRecorded, 5);
    controller.destroy();
  });

  it('3. stayLoggedIn() restaura estado ACTIVE e dispara onRefresh', async () => {
    let refreshCalled = false;
    let stateRecorded = '';

    const controller = new SessionActivityController({
      inactivityTimeoutMs: 50,
      warningCountdownSeconds: 5,
      onStateChange: (state) => {
        stateRecorded = state;
      },
      onRefresh: async () => {
        refreshCalled = true;
        return { success: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(controller.getState(), 'WARNING');

    await controller.stayLoggedIn();
    assert.equal(controller.getState(), 'ACTIVE');
    assert.equal(refreshCalled, true);
    controller.destroy();
  });

  it('4. logOut() transita para EXPIRED e invoca onLogout', async () => {
    let logoutCalled = false;
    const mockChannel = new MockBroadcastChannel('test');

    const controller = new SessionActivityController({
      inactivityTimeoutMs: 5000,
      broadcastChannelFactory: () => mockChannel,
      onLogout: async () => {
        logoutCalled = true;
        return { success: true };
      },
    });

    await controller.logOut('user_action');
    assert.equal(controller.getState(), 'EXPIRED');
    assert.equal(logoutCalled, true);
    assert.equal(mockChannel.messages.length, 1);
    assert.equal((mockChannel.messages[0] as SessionBroadcastMessage).type, 'LOGOUT');
    controller.destroy();
  });

  it('5. Sincronização multi-aba: mensagem ACTIVITY de outra aba fecha modal de aviso', async () => {
    const mockChannel = new MockBroadcastChannel('test');

    const controller = new SessionActivityController({
      inactivityTimeoutMs: 50,
      warningCountdownSeconds: 5,
      broadcastChannelFactory: () => mockChannel,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(controller.getState(), 'WARNING');

    // Simular atividade ocorrida em outra aba
    mockChannel.simulateIncomingMessage({
      type: 'ACTIVITY',
      timestamp: Date.now(),
    });

    assert.equal(controller.getState(), 'ACTIVE');
    controller.destroy();
  });

  it('6. Sincronização multi-aba: mensagem LOGOUT de outra aba expira a sessão local', () => {
    const mockChannel = new MockBroadcastChannel('test');

    const controller = new SessionActivityController({
      inactivityTimeoutMs: 5000,
      broadcastChannelFactory: () => mockChannel,
    });

    assert.equal(controller.getState(), 'ACTIVE');

    mockChannel.simulateIncomingMessage({
      type: 'LOGOUT',
      timestamp: Date.now(),
    });

    assert.equal(controller.getState(), 'EXPIRED');
    controller.destroy();
  });

  it('7. Sliding Session: atividade contínua após minRefreshIntervalMs dispara onRefresh', () => {
    let refreshCount = 0;
    let simulatedTime = 1000000;

    const controller = new SessionActivityController({
      inactivityTimeoutMs: 600000,
      minRefreshIntervalMs: 120000, // 2 minutos
      getCurrentTime: () => simulatedTime,
      onRefresh: async () => {
        refreshCount += 1;
        return { success: true };
      },
    });

    // Atividade logo em seguida (delta de 30s < 120s) -> não deve disparar refresh ainda
    simulatedTime += 30000;
    controller.registerActivity();
    assert.equal(refreshCount, 0);

    // Atividade após 130s (> 120s) -> deve disparar refresh deslizante!
    simulatedTime += 100000;
    controller.registerActivity();
    assert.equal(refreshCount, 1);

    controller.destroy();
  });
});
