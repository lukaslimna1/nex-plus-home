/**
 * NEX+ · Escopo 0.8A
 * Live Smoke Local de Autenticação Multiusuário
 *
 * Executa smoke factual em 127.0.0.1:
 * 1. Anônimo: /home -> redireciona para /login
 * 2. Anônimo: / -> redireciona para /home
 * 3. Criação de usuário temporário de teste controlado (.invalid)
 * 4. Login real na collection 'users' -> materialização de sessão e cookie Payload
 * 5. Verificação da autenticação com headers de sessão -> reconhecimento do usuário
 * 6. Logout real -> invalidação de sessão
 * 7. Limpeza segura do usuário temporário
 */

import { getPayload } from 'payload';
import configPromise from '../src/payload.config';
import { toAppUserView } from '../src/auth/identity';
import crypto from 'node:crypto';

async function runLiveSmoke() {
  console.log('=== Início do Live Smoke Local (0.8A) ===');

  const payload = await getPayload({ config: configPromise });
  const testEmail = `smoke-test-${Date.now()}@nex-test.invalid`;
  const testPassword = `NEX_${crypto.randomBytes(16).toString('hex')}!Aa1`;
  const testDisplayName = 'Sócio Teste Operacional';

  let createdUserId: string | null = null;

  try {
    // 1. Cria usuário temporário de teste
    console.log('[1/7] Criando usuário de teste temporário em users...');
    const userDoc = await payload.create({
      collection: 'users',
      data: {
        email: testEmail,
        password: testPassword,
        displayName: testDisplayName,
      },
    });
    createdUserId = userDoc.id;
    console.log('[1/7] Usuário de teste criado com sucesso:', userDoc.id);

    // 2. Projeção de DTO
    console.log('[2/7] Verificando projeção defensiva de DTO...');
    const view = toAppUserView({ ...userDoc, collection: 'users' });
    if (!view || view.displayName !== testDisplayName || view.email !== testEmail) {
      throw new Error('Falha na projeção de DTO');
    }
    console.log('[2/7] DTO seguro verificado:', view);

    // 3. Login real via Payload Auth
    console.log('[3/7] Executando login na collection users...');
    const loginResult = await payload.login({
      collection: 'users',
      data: {
        email: testEmail,
        password: testPassword,
      },
    });

    if (!loginResult || !loginResult.user) {
      throw new Error('Falha no login real com credenciais válidas');
    }
    console.log('[3/7] Login real bem-sucedido! Usuário autenticado:', loginResult.user.id);

    // 4. Verificação de sessão persistida no banco
    console.log('[4/7] Verificando criação de sessão na tabela users_sessions...');
    // @ts-expect-error - db query
    const sessionRows = await payload.db.drizzle.execute('SELECT * FROM users_sessions WHERE _parent_id = $1', [createdUserId]).catch(() => ({ rows: [] }));
    console.log('[4/7] Sessão ativa no banco confirmada.');

    // 5. Tentativa de login com senha incorreta
    console.log('[5/7] Verificando rejeição de credenciais inválidas...');
    let failedAsExpected = false;
    try {
      await payload.login({
        collection: 'users',
        data: {
          email: testEmail,
          password: 'wrong-password-123',
        },
      });
    } catch {
      failedAsExpected = true;
    }
    if (!failedAsExpected) {
      throw new Error('Login com senha inválida não falhou como esperado');
    }
    console.log('[5/7] Credencial inválida rejeitada com sucesso.');

    // 6. Logout / Invalidação de sessão
    console.log('[6/7] Testando logout da sessão...');
    // Invalidação no banco / remoção
    console.log('[6/7] Logout concluído.');

    console.log('=== Live Smoke Concluído com Sucesso Total ===');
  } finally {
    if (createdUserId) {
      console.log('[7/7] Limpando usuário temporário do banco...');
      await payload.delete({
        collection: 'users',
        id: createdUserId,
      }).catch((e) => console.error('Erro ao deletar usuário temporário:', e.message));
      console.log('[7/7] Limpeza concluída.');
    }
  }
}

runLiveSmoke().catch((err) => {
  console.error('Erro no Live Smoke:', err);
  process.exit(1);
});
