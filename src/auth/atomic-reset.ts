/**
 * NEX+ · Auth Layer
 * Atomic Password Reset Operation — Contrato A
 *
 * Executa a redefinição de senha com invalidação global de sessões sob uma única
 * transação relacional externa no Payload, assegurando que nenhuma mutação parcial
 * permaneça caso ocorra qualquer falha no fluxo ou violação da pós-condição.
 */

import { getPayload, type PayloadRequest } from 'payload';
import configPromise from '@/payload.config';

export interface AtomicPasswordResetResult {
  readonly success: boolean;
  readonly error?: string;
  readonly userId?: string;
}

/**
 * Executa a redefinição de senha em transação única atômica via APIs públicas do Payload:
 * 1. Inicia transação externa via payload.db.beginTransaction()
 * 2. Executa payload.resetPassword({ ..., req: transactionalReq })
 * 3. Executa payload.update({ ..., req: transactionalReq }) sem usuário autenticado (revogação global documentada)
 * 4. Valida a pós-condição obrigatória sob a mesma transação: users.sessions deve estar vazio
 * 5. Comita a transação via payload.db.commitTransaction() exclusivamente após validação bem-sucedida
 * 6. Em qualquer erro: rollback integral e idempotente via payload.db.rollbackTransaction()
 */
export async function executeAtomicPasswordReset(params: {
  readonly token: string;
  readonly password: string;
}): Promise<AtomicPasswordResetResult> {
  const { token, password } = params;

  let transactionID: string | number | null = null;
  let committed = false;

  try {
    const payload = await getPayload({ config: configPromise });

    // 1. Iniciar transação única no banco de dados via API pública do Payload
    transactionID = await payload.db.beginTransaction();
    if (!transactionID) {
      return {
        success: false,
        error: 'Falha ao iniciar transação no banco de dados.',
      };
    }

    const transactionalReq: Partial<PayloadRequest> = {
      transactionID,
    };

    // 2. Executar resetPassword dentro da transação
    const resetResult = await payload.resetPassword({
      collection: 'users',
      data: {
        token,
        password,
      },
      overrideAccess: true,
      req: transactionalReq,
    });

    const rawUserId = resetResult?.user?.id;
    if (!rawUserId || typeof rawUserId === 'object') {
      throw new Error('Identificador de usuário inválido na recuperação de senha.');
    }
    const userId = String(rawUserId);

    // 3. Contrato A (Recuperação de Senha):
    // No Payload 3.90.2, resetPassword invalida sessões anteriores, porém emite token e sessão automática.
    // O NEX+ exige que nenhuma sessão automática permaneça utilizável e que o usuário realize novo login manual.
    // Conforme documentado no Payload 3.90.2, um update de password via Local API sem usuário autenticado revoga todas as sessões.
    // Como resetPassword pode popular req.user, definimos explicitamente user = null para assegurar contexto não autenticado:
    transactionalReq.user = null;

    // Executado sob a MESMA transação:
    await payload.update({
      collection: 'users',
      id: userId,
      data: {
        password,
      },
      overrideAccess: true,
      req: transactionalReq,
    });

    // 4. Verificação defensiva da pós-condição ANTES do commit (sob a mesma transação):
    const verifiedUser = await payload.findByID({
      collection: 'users',
      id: userId,
      depth: 0,
      overrideAccess: true,
      req: transactionalReq,
    });

    const remainingSessions = (verifiedUser.sessions || []) as Array<{ id?: string }>;
    if (remainingSessions.length !== 0) {
      throw new Error(
        `[SECURITY_FAIL_CLOSED] Pós-condição de recuperação violada: esperadas 0 sessões ativas, encontradas ${remainingSessions.length}.`,
      );
    }

    // 5. Commit explícito da transação via API pública após validação integral da pós-condição
    await payload.db.commitTransaction(transactionID);
    committed = true;

    return {
      success: true,
      userId,
    };
  } catch {
    // 6. Rollback seguro e idempotente em qualquer falha
    if (transactionID && !committed) {
      try {
        const payload = await getPayload({ config: configPromise });
        await payload.db.rollbackTransaction(transactionID);
      } catch {
        // Idempotência segura caso o Payload já tenha encerrado a transação internamente
      }
    }

    return {
      success: false,
      error: 'O link de recuperação é inválido ou já expirou. Solicite um novo link.',
    };
  }
}
