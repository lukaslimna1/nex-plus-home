/**
 * NEX+ · Auth Layer
 * Descoberta Server-Side do Usuário Autenticado da Aplicação — Escopo 0.8A
 *
 * Utiliza exclusivamente os headers da requisição e a autoridade oficial do Payload.
 * Aceita unicamente identidades pertencentes à coleção `users`.
 */

import 'server-only';

import { headers as getNextHeaders } from 'next/headers';
import { getPayload } from 'payload';
import configPromise from '@/payload.config';
import { toAppUserView, type AppUserView } from './identity';

/**
 * Retorna os dados do usuário autenticado na aplicação atual, ou `null` se anônimo / admin.
 */
export async function getCurrentAppUser(): Promise<AppUserView | null> {
  try {
    const headers = await getNextHeaders();
    const payload = await getPayload({ config: configPromise });
    const authResult = await payload.auth({ headers });

    if (!authResult || !authResult.user) {
      return null;
    }

    return toAppUserView(authResult.user);
  } catch (error) {
    // Falhas de cabeçalho ou contexto fora de requisição tratam como anônimo seguro
    return null;
  }
}
