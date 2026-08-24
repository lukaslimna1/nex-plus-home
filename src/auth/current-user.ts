/**
 * NEX+ · Auth Layer
 * Descoberta Server-Side do Usuário Autenticado da Aplicação — Escopo 0.8A
 *
 * Utiliza exclusivamente os headers da requisição e a autoridade oficial do Payload.
 * Aceita unicamente identidades pertencentes à coleção `users`.
 */

import 'server-only';

import { headers as getNextHeaders, cookies as getNextCookies } from 'next/headers';
import { getPayload } from 'payload';
import { jwtVerify } from 'jose';
import { sql } from '@payloadcms/db-postgres';
import configPromise from '@/payload.config';
import { toAppUserView, type AppUserView } from './identity';

/**
 * Retorna os dados do usuário autenticado na aplicação atual, ou `null` se anônimo / admin.
 */
export async function getCurrentAppUser(): Promise<AppUserView | null> {
  try {
    const payload = await getPayload({ config: configPromise });
    const cookieStore = await getNextCookies();
    const token = cookieStore.get('payload-token')?.value;

    if (!token) {
      return null;
    }

    const secretKey = new TextEncoder().encode(payload.secret);
    const { payload: decoded } = await jwtVerify(token, secretKey);

    if (!decoded.id || decoded.collection !== 'users') {
      return null;
    }

    const uid = String(decoded.id).replace(/[^a-f0-9-]/gi, '');
    const sid = decoded.sid ? String(decoded.sid).replace(/[^a-f0-9-]/gi, '') : null;

    if (!uid) {
      return null;
    }

    // Se a sessão usar sessions, validar se o sid ainda existe e não expirou em users_sessions
    if (sid) {
      const drizzle = (payload.db as unknown as { drizzle?: { execute: (q: unknown) => Promise<unknown> } }).drizzle;
      if (drizzle) {
        const rawRes = await drizzle.execute(
          sql.raw(`SELECT "id", "expires_at" FROM "users_sessions" WHERE "id" = '${sid}' AND "expires_at" > now() LIMIT 1`)
        );
        const rows = Array.isArray(rawRes) ? rawRes : (rawRes as { rows?: unknown[] })?.rows || [];
        if (rows.length === 0) {
          return null; // Sessão revogada ou expirada no banco
        }
      }
    }

    const userDoc = await payload.findByID({
      collection: 'users',
      id: uid,
      depth: 0,
    });

    if (!userDoc) {
      return null;
    }

    return toAppUserView({ ...userDoc, collection: 'users' });
  } catch (error) {
    // Falhas de cabeçalho ou contexto fora de requisição tratam como anônimo seguro
    return null;
  }
}
