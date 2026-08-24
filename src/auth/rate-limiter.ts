/**
 * NEX+ · Auth Layer
 * Rate Limiter em Memória com Janela Deslizante (Zero-Cost Anti-Flood)
 *
 * Protege contra consumo artificial da cota de e-mail (MailApp) e ataques de flooding
 * sem bloquear contas legítimas e sem expor detalhes ou contagens para a resposta externa.
 */

export interface RateLimiterConfig {
  maxRequestsPerEmail?: number;
  windowMs?: number;
  globalMaxRequests?: number;
}

export const DEFAULT_FORGOT_PASSWORD_MAX_PER_EMAIL = 3;
export const DEFAULT_FORGOT_PASSWORD_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
export const DEFAULT_FORGOT_PASSWORD_GLOBAL_MAX = 50; // 50 em 15 minutos

export class SlidingWindowRateLimiter {
  private readonly maxPerEmail: number;
  private readonly windowMs: number;
  private readonly globalMax: number;

  private readonly emailTimestamps: Map<string, number[]> = new Map();
  private globalTimestamps: number[] = [];

  constructor(config: RateLimiterConfig = {}) {
    this.maxPerEmail = config.maxRequestsPerEmail ?? DEFAULT_FORGOT_PASSWORD_MAX_PER_EMAIL;
    this.windowMs = config.windowMs ?? DEFAULT_FORGOT_PASSWORD_WINDOW_MS;
    this.globalMax = config.globalMaxRequests ?? DEFAULT_FORGOT_PASSWORD_GLOBAL_MAX;
  }

  /**
   * Avalia e consome uma tentativa de recuperação de senha.
   * Retorna `true` se permitida, ou `false` se o limite foi atingido.
   */
  public consume(email: string, now: number = Date.now()): boolean {
    const normalizedKey = email.trim().toLowerCase();
    const threshold = now - this.windowMs;

    // 1. Limpar timestamps globais expirados
    this.globalTimestamps = this.globalTimestamps.filter((t) => t > threshold);

    // 2. Verificar limite global contra flood massivo
    if (this.globalTimestamps.length >= this.globalMax) {
      return false;
    }

    // 3. Limpar timestamps do e-mail específico
    const timestamps = (this.emailTimestamps.get(normalizedKey) || []).filter((t) => t > threshold);

    // 4. Verificar limite por e-mail
    if (timestamps.length >= this.maxPerEmail) {
      return false;
    }

    // 5. Registrar tentativa permitida
    timestamps.push(now);
    this.emailTimestamps.set(normalizedKey, timestamps);
    this.globalTimestamps.push(now);

    return true;
  }

  /**
   * Limpa o estado em memória (útil para testes unitários).
   */
  public reset(): void {
    this.emailTimestamps.clear();
    this.globalTimestamps = [];
  }
}

/**
 * Instância singleton do rate limiter de recuperação de senha no servidor.
 */
export const forgotPasswordRateLimiter = new SlidingWindowRateLimiter();
