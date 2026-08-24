/**
 * NEX+ · Auth Layer
 * Server Actions de Login e Logout — Escopo 0.8A Hardening
 *
 * Utiliza as Server Functions oficiais do `@payloadcms/next/auth` para manipulação segura de cookies e sessões.
 * Garante mensagens de erro genéricas e seguras para a interface sem vazar detalhes da conta ou tokens.
 */

'use server';

import { getPayload } from 'payload';
import { login, logout, refresh } from '@payloadcms/next/auth';
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

export interface ForgotPasswordActionResult {
  readonly success: boolean;
  readonly message: string;
  readonly error?: string;
}

export interface ResetPasswordActionResult {
  readonly success: boolean;
  readonly message?: string;
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
 * Server Action para solicitação de redefinição de senha (Forgot Password).
 * Proteção total contra enumeração de contas (resposta neutra constante).
 */
export async function forgotPasswordAction(
  data: { email?: string } | FormData,
): Promise<ForgotPasswordActionResult> {
  let email = '';

  if (data instanceof FormData) {
    email = String(data.get('email') || '');
  } else if (data && typeof data === 'object') {
    email = String(data.email || '');
  }

  const cleanEmail = normalizeEmail(email);

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return {
      success: false,
      message: '',
      error: 'Por favor, informe um endereço de e-mail válido.',
    };
  }

  const neutralSuccessMessage =
    'Se existir uma conta associada a este e-mail, você receberá as instruções para redefinir sua senha.';

  try {
    const payload = await getPayload({ config: configPromise });
    await payload.forgotPassword({
      collection: 'users',
      data: {
        email: cleanEmail,
      },
    });

    return {
      success: true,
      message: neutralSuccessMessage,
    };
  } catch {
    // Retorno neutro mesmo em caso de erro interno para evitar enumeração
    return {
      success: true,
      message: neutralSuccessMessage,
    };
  }
}

/**
 * Server Action para conclusão da redefinição de senha (Reset Password com token).
 */
export async function resetPasswordAction(
  data:
    | { token?: string; password?: string; confirmPassword?: string }
    | FormData,
): Promise<ResetPasswordActionResult> {
  let token = '';
  let password = '';
  let confirmPassword = '';

  if (data instanceof FormData) {
    token = String(data.get('token') || '');
    password = String(data.get('password') || '');
    confirmPassword = String(data.get('confirmPassword') || '');
  } else if (data && typeof data === 'object') {
    token = String(data.token || '');
    password = String(data.password || '');
    confirmPassword = String(data.confirmPassword || '');
  }

  token = token.trim();

  if (!token) {
    return {
      success: false,
      error: 'Token de recuperação ausente ou inválido. Solicite um novo link de recuperação.',
    };
  }

  if (!password || password.length < 8) {
    return {
      success: false,
      error: 'A nova senha deve possuir pelo menos 8 caracteres.',
    };
  }

  if (password !== confirmPassword) {
    return {
      success: false,
      error: 'As senhas informadas não coincidem.',
    };
  }

  try {
    const payload = await getPayload({ config: configPromise });
    await payload.resetPassword({
      collection: 'users',
      data: {
        token,
        password,
      },
      overrideAccess: true,
    });

    return {
      success: true,
      message: 'Sua senha foi redefinida com sucesso. Você já pode entrar com sua nova senha.',
    };
  } catch {
    return {
      success: false,
      error: 'O link de recuperação é inválido ou já expirou. Solicite um novo link.',
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

export interface RefreshSessionActionResult {
  readonly success: boolean;
  readonly error?: string;
}

/**
 * Server Action para renovação transparente da sessão (Sliding Session).
 * Atualiza o cookie HTTP-only payload-token e o timestamp da sessão no banco de dados.
 */
export async function refreshSessionAction(): Promise<RefreshSessionActionResult> {
  try {
    const result = await refresh({
      config: configPromise,
    });
    if (result && result.success) {
      return { success: true };
    }
    return {
      success: false,
      error: 'Não foi possível renovar a sessão.',
    };
  } catch {
    return {
      success: false,
      error: 'Sessão expirada ou não autenticada.',
    };
  }
}
