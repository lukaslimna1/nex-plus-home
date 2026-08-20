/**
 * NEX+ · Auth Layer
 * Server Actions de Login e Logout — Escopo 0.8A Hardening
 *
 * Utiliza as Server Functions oficiais do `@payloadcms/next/auth` para manipulação segura de cookies e sessões.
 * Garante mensagens de erro genéricas e seguras para a interface sem vazar detalhes da conta ou tokens.
 */

'use server';

import { login, logout } from '@payloadcms/next/auth';
import configPromise from '@/payload.config';
import {
  normalizeEmail,
  handleLogoutResult,
  type LogoutActionResult,
} from './identity';

export interface LoginActionResult {
  readonly success: boolean;
  readonly error?: string;
}

export type { LogoutActionResult };

/**
 * Server Action para autenticação de usuários da aplicação na coleção `users`.
 */
export async function loginAction(
  credentials: { email?: string; password?: string } | FormData,
): Promise<LoginActionResult> {
  let email = '';
  let password = '';

  if (credentials instanceof FormData) {
    email = String(credentials.get('email') || '');
    password = String(credentials.get('password') || '');
  } else if (credentials && typeof credentials === 'object') {
    email = String(credentials.email || '');
    password = String(credentials.password || '');
  }

  const cleanEmail = normalizeEmail(email);

  if (!cleanEmail || !password) {
    return {
      success: false,
      error: 'E-mail ou senha inválidos.',
    };
  }

  try {
    const result = await login({
      collection: 'users',
      config: configPromise,
      email: cleanEmail,
      password,
    });

    if (result && result.user) {
      return { success: true };
    }

    return {
      success: false,
      error: 'E-mail ou senha inválidos.',
    };
  } catch {
    // Retorno genérico seguro: não diferencia usuário inexistente de senha incorreta
    return {
      success: false,
      error: 'E-mail ou senha inválidos.',
    };
  }
}

/**
 * Server Action para encerramento da sessão atual do usuário da aplicação.
 */
export async function logoutAction(): Promise<LogoutActionResult> {
  try {
    const result = await logout({
      config: configPromise,
    });
    return handleLogoutResult(result);
  } catch {
    return {
      success: false,
      error: 'Não foi possível encerrar a sessão.',
    };
  }
}
