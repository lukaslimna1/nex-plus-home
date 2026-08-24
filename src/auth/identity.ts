/**
 * NEX+ · Auth Layer
 * Identidade de Usuário da Aplicação e Utilitários de DTO — Escopo 0.8A
 *
 * Separação formal entre Administrador Técnico (Admins) e Usuário da Aplicação (Users).
 * Fornece projeção defensiva (DTO) para o frontend sem expor hashes, salts ou dados de sessão.
 */

export interface AppUserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export interface LogoutActionResult {
  readonly success: boolean;
  readonly error?: string;
}

export type IdentityClass = 'app_user' | 'admin' | 'anonymous';

/**
 * Tradutor determinístico do resultado de logout para resposta segura ao frontend.
 */
export function handleLogoutResult(
  result?: { success?: boolean; message?: string } | null,
): LogoutActionResult {
  if (result && (result.success === true || typeof result.message === 'string')) {
    return { success: true };
  }
  return {
    success: false,
    error: 'Não foi possível encerrar a sessão.',
  };
}

/**
 * Normaliza o e-mail para formato canônico seguro (trim e minúsculas).
 */
export function normalizeEmail(email?: string | null): string {
  if (!email || typeof email !== 'string') {
    return '';
  }
  return email.trim().toLowerCase();
}

/**
 * Deriva iniciais textuais deterministicamente a partir do nome de exibição.
 */
export function getInitials(displayName?: string | null): string {
  if (!displayName || typeof displayName !== 'string') {
    return 'U';
  }

  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return 'U';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Classifica a identidade de um objeto de usuário retornado pelo Payload.
 */
export function classifyIdentity(user: unknown): IdentityClass {
  if (!user || typeof user !== 'object') {
    return 'anonymous';
  }

  const u = user as Record<string, unknown>;
  if (u.collection === 'users') {
    return 'app_user';
  }
  if (u.collection === 'admins') {
    return 'admin';
  }
  return 'anonymous';
}

/**
 * Converte um documento de usuário do Payload em um DTO seguro para o frontend.
 * Retorna null se não for um usuário válido da coleção `users`.
 */
export function toAppUserView(user: unknown): AppUserView | null {
  if (classifyIdentity(user) !== 'app_user') {
    return null;
  }

  const u = user as Record<string, unknown>;
  const id = typeof u.id === 'string' ? u.id : String(u.id || '');
  const email = typeof u.email === 'string' ? u.email : '';
  const displayName = typeof u.displayName === 'string' && u.displayName.trim().length > 0
    ? u.displayName.trim()
    : email.split('@')[0] || 'Usuário';

  if (!id || !email) {
    return null;
  }

  return Object.freeze({
    id,
    email,
    displayName,
  });
}
