/**
 * NEX+ · Auth Layer
 * Gerenciador de Sessão por Atividade e Inatividade (Sliding Session & Inactivity Grace Period)
 *
 * Características:
 * - 10 minutos de inatividade tolerada antes do modal de aviso.
 * - 10 segundos de countdown com aviso visual para o usuário decidir continuar ou sair.
 * - Sliding session: renovação em background a cada 2 minutos de atividade contínua.
 * - Sincronização multi-aba via BroadcastChannel ('nex_auth_activity').
 * - Desacoplado de frameworks e 100% testável com simulação de tempo.
 */

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos (600.000 ms)
export const DEFAULT_WARNING_COUNTDOWN_SECONDS = 10; // 10 segundos
export const MIN_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos (120.000 ms)
export const TRAILING_DEBOUNCE_MS = 10 * 1000; // 10 segundos após término de rajada de atividade
export const MIN_TRAILING_INTERVAL_MS = 30 * 1000; // 30 segundos de intervalo mínimo entre refreshes trailing
export const BROADCAST_CHANNEL_NAME = 'nex_auth_activity';

export type SessionActivityState = 'ACTIVE' | 'WARNING' | 'EXPIRED';

export interface SessionBroadcastMessage {
  type: 'ACTIVITY' | 'REFRESH' | 'LOGOUT';
  timestamp: number;
  reason?: string;
}

export interface SessionActivityControllerConfig {
  inactivityTimeoutMs?: number;
  warningCountdownSeconds?: number;
  minRefreshIntervalMs?: number;
  trailingDebounceMs?: number;
  minTrailingIntervalMs?: number;
  onStateChange?: (state: SessionActivityState, countdownSeconds: number) => void;
  onRefresh?: () => Promise<{ success: boolean; error?: string }>;
  onLogout?: () => Promise<{ success: boolean; error?: string }>;
  broadcastChannelFactory?: (name: string) => BroadcastChannelLike | null;
  getCurrentTime?: () => number;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: any) => void) | null;
  close(): void;
}

export class SessionActivityController {
  private state: SessionActivityState = 'ACTIVE';
  private countdown: number = DEFAULT_WARNING_COUNTDOWN_SECONDS;
  private lastActivityTime: number;
  private lastRefreshTime: number;
  private readonly inactivityTimeoutMs: number;
  private readonly warningCountdownSeconds: number;
  private readonly minRefreshIntervalMs: number;
  private readonly trailingDebounceMs: number;
  private readonly minTrailingIntervalMs: number;
  private readonly onStateChange?: (state: SessionActivityState, countdownSeconds: number) => void;
  private readonly onRefresh?: () => Promise<{ success: boolean; error?: string }>;
  private readonly onLogout?: () => Promise<{ success: boolean; error?: string }>;
  private readonly getCurrentTime: () => number;

  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private trailingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannelLike | null = null;
  private isDestroyed = false;

  constructor(config: SessionActivityControllerConfig = {}) {
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.warningCountdownSeconds = config.warningCountdownSeconds ?? DEFAULT_WARNING_COUNTDOWN_SECONDS;
    this.minRefreshIntervalMs = config.minRefreshIntervalMs ?? MIN_REFRESH_INTERVAL_MS;
    this.trailingDebounceMs = config.trailingDebounceMs ?? TRAILING_DEBOUNCE_MS;
    this.minTrailingIntervalMs = config.minTrailingIntervalMs ?? MIN_TRAILING_INTERVAL_MS;
    this.onStateChange = config.onStateChange;
    this.onRefresh = config.onRefresh;
    this.onLogout = config.onLogout;
    this.getCurrentTime = config.getCurrentTime ?? (() => Date.now());

    const now = this.getCurrentTime();
    this.lastActivityTime = now;
    this.lastRefreshTime = now;
    this.countdown = this.warningCountdownSeconds;

    // Inicializar BroadcastChannel se disponível
    if (config.broadcastChannelFactory) {
      this.channel = config.broadcastChannelFactory(BROADCAST_CHANNEL_NAME);
    } else if (typeof globalThis.BroadcastChannel === 'function') {
      try {
        this.channel = new globalThis.BroadcastChannel(BROADCAST_CHANNEL_NAME);
      } catch {
        this.channel = null;
      }
    }

    if (this.channel) {
      this.channel.onmessage = (event: { data: unknown }) => {
        this.handleBroadcastMessage(event.data as SessionBroadcastMessage);
      };
    }

    this.startInactivityTimer();
  }

  public getState(): SessionActivityState {
    return this.state;
  }

  public getCountdown(): number {
    return this.countdown;
  }

  /**
   * Registra atividade do usuário local (clique, digitação, touch, scroll).
   * Em estado ACTIVE: reseta o timer de inatividade e renova a sessão se atingido o intervalo mínimo.
   * Agenda também um trailing debounced refresh para assegurar que a última atividade sincronize com o backend.
   * Em estado WARNING: fecha o modal de aviso e restaura o estado ACTIVE renovando a sessão imediatamente.
   */
  public registerActivity(): void {
    if (this.isDestroyed || this.state === 'EXPIRED') return;

    const now = this.getCurrentTime();
    this.lastActivityTime = now;

    // Se estava em WARNING, voltar imediatamente para ACTIVE
    if (this.state === 'WARNING') {
      this.clearCountdownInterval();
      this.state = 'ACTIVE';
      this.countdown = this.warningCountdownSeconds;
      this.notifyStateChange();
      this.triggerSessionRefresh();
      this.broadcast({ type: 'ACTIVITY', timestamp: now });
      this.startInactivityTimer();
      return;
    }

    // Se estava em ACTIVE, renovar timer de inatividade
    this.startInactivityTimer();
    this.broadcast({ type: 'ACTIVITY', timestamp: now });

    // 1. Throttle imediato se passou o intervalo mínimo de atividade contínua
    if (now - this.lastRefreshTime >= this.minRefreshIntervalMs) {
      this.clearTrailingRefreshTimer();
      this.triggerSessionRefresh();
      return;
    }

    // 2. Trailing debounce: agenda refresh para quando a rajada de atividade atual cessar
    this.scheduleTrailingRefresh();
  }

  private scheduleTrailingRefresh(): void {
    this.clearTrailingRefreshTimer();

    this.trailingRefreshTimer = setTimeout(() => {
      if (this.isDestroyed || this.state !== 'ACTIVE') return;

      const now = this.getCurrentTime();
      if (now - this.lastRefreshTime >= this.minTrailingIntervalMs) {
        this.triggerSessionRefresh();
      }
    }, this.trailingDebounceMs);
  }

  private clearTrailingRefreshTimer(): void {
    if (this.trailingRefreshTimer) {
      clearTimeout(this.trailingRefreshTimer);
      this.trailingRefreshTimer = null;
    }
  }

  /**
   * O usuário clica explicitamente em "Continuar sessão" no modal.
   */
  public async stayLoggedIn(): Promise<void> {
    if (this.isDestroyed || this.state === 'EXPIRED') return;

    this.clearCountdownInterval();
    this.clearTrailingRefreshTimer();
    this.state = 'ACTIVE';
    this.countdown = this.warningCountdownSeconds;
    this.lastActivityTime = this.getCurrentTime();
    this.notifyStateChange();
    this.broadcast({ type: 'ACTIVITY', timestamp: this.lastActivityTime });
    this.startInactivityTimer();

    await this.triggerSessionRefresh();
  }

  /**
   * O usuário clica em "Sair agora" ou o countdown encerra.
   */
  public async logOut(reason: string = 'manual'): Promise<void> {
    if (this.isDestroyed || this.state === 'EXPIRED') return;

    this.clearTimers();
    this.state = 'EXPIRED';
    this.notifyStateChange();
    this.broadcast({ type: 'LOGOUT', timestamp: this.getCurrentTime(), reason });

    if (this.onLogout) {
      try {
        await this.onLogout();
      } catch {}
    }
  }

  /**
   * Destrói os listeners, timers e o canal.
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.clearTimers();
    if (this.channel) {
      try {
        this.channel.close();
      } catch {}
      this.channel = null;
    }
  }

  private startInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      this.triggerInactivityWarning();
    }, this.inactivityTimeoutMs);
  }

  private triggerInactivityWarning(): void {
    if (this.isDestroyed || this.state !== 'ACTIVE') return;

    this.state = 'WARNING';
    this.countdown = this.warningCountdownSeconds;
    this.notifyStateChange();

    this.countdownInterval = setInterval(() => {
      this.countdown -= 1;
      this.notifyStateChange();

      if (this.countdown <= 0) {
        this.clearCountdownInterval();
        this.logOut('inactivity_timeout');
      }
    }, 1000);
  }

  private async triggerSessionRefresh(): Promise<void> {
    const now = this.getCurrentTime();
    this.lastRefreshTime = now;
    if (this.onRefresh) {
      try {
        const result = await this.onRefresh();
        if (result && result.success) {
          this.broadcast({ type: 'REFRESH', timestamp: now });
        } else {
          // Se a sessão já foi revogada remotamente
          this.logOut('session_revoked');
        }
      } catch {
        // Falha de rede transitória: não desloga imediatamente se ainda houver tempo
      }
    }
  }

  private handleBroadcastMessage(message: SessionBroadcastMessage): void {
    if (!message || this.isDestroyed) return;

    if (message.type === 'ACTIVITY') {
      if (this.state === 'WARNING') {
        this.clearCountdownInterval();
        this.state = 'ACTIVE';
        this.countdown = this.warningCountdownSeconds;
        this.notifyStateChange();
      }
      this.lastActivityTime = message.timestamp;
      this.startInactivityTimer();
    } else if (message.type === 'REFRESH') {
      this.lastRefreshTime = message.timestamp;
    } else if (message.type === 'LOGOUT') {
      this.clearTimers();
      this.state = 'EXPIRED';
      this.notifyStateChange();
    }
  }

  private broadcast(message: SessionBroadcastMessage): void {
    if (this.channel) {
      try {
        this.channel.postMessage(message);
      } catch {}
    }
  }

  private clearCountdownInterval(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private clearTimers(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.clearCountdownInterval();
    this.clearTrailingRefreshTimer();
  }

  private notifyStateChange(): void {
    if (this.onStateChange && !this.isDestroyed) {
      this.onStateChange(this.state, this.countdown);
    }
  }
}
