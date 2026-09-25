import { test, expect } from '@playwright/test';
import { getPayload } from 'payload';
import configPromise from '../../src/payload.config';
import crypto from 'node:crypto';
import { decodeJwt } from 'jose';

test.describe('NEX+ Multiusuário · E2E Authentication Flow (0.8A Isolated Harness)', () => {
  let testUserId: string;
  const testEmail = `e2e-${Date.now()}@nex-test.invalid`;
  const testPassword = `E2E_${crypto.randomBytes(16).toString('hex')}!Aa1`;
  let currentTestPassword = testPassword;
  const testDisplayName = 'Sócio E2E Teste';

  test.beforeAll(async () => {
    // 1. Trava de segurança obrigatória contra banco operacional
    const dbUrl = process.env.DATABASE_URL || '';
    const isIsolated = process.env.NEX_E2E_ISOLATED === '1';
    const dbNameMatch = dbUrl.match(/\/([^/?]+)(?:\?|$)/);
    const dbName = dbNameMatch ? dbNameMatch[1] : '';

    if (!isIsolated || !dbName.startsWith('nex_e2e_')) {
      throw new Error(
        `[SECURITY_GUARD] E2E recusou execução: banco '${dbName}' não é descartável. Exigido prefixo 'nex_e2e_' e NEX_E2E_ISOLATED=1.`,
      );
    }

    // 2. Setup administrativo controlado na base descartável
    const payload = await getPayload({ config: configPromise });
    const userDoc = await payload.create({
      collection: 'users',
      data: {
        email: testEmail,
        password: testPassword,
        displayName: testDisplayName,
      },
    });
    testUserId = userDoc.id;
  });

  test.afterAll(async () => {
    if (testUserId) {
      const payload = await getPayload({ config: configPromise });
      await payload.delete({
        collection: 'users',
        id: testUserId,
      }).catch(() => {});
    }
  });

  test('E1. /login anônimo retorna 200 e exibe o formulário de login', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBe(200);
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('E2. /home anônimo redireciona com segurança para /login', async ({ page }) => {
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);
  });

  test('E3. / anônimo redireciona para /home e termina em /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('E8. Login com senha inválida permanece em /login, exibe mensagem genérica e não emite cookie', async ({ page, context }) => {
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', 'wrong-password-123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
    const errorAlert = page.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
    await expect(errorAlert).toBeVisible();

    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === 'payload-token');
    expect(authCookie).toBeUndefined();
  });

  test('E4-E7. Login real via interface acessa /home, projeta displayName e persiste sessão no reload', async ({ page, context }) => {
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');

    // E4. URL final é /home
    await expect(page).toHaveURL(/\/home/);

    // E5. DisplayName real aparece na Sidebar
    const userCard = page.locator(`button[title*="${testDisplayName}"]`);
    await expect(userCard).toBeVisible();
    await expect(page.locator(`text=${testDisplayName}`)).toBeVisible();

    // E6. Cookie de autenticação HTTP-only foi emitido
    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === 'payload-token');
    expect(authCookie).toBeDefined();
    expect(authCookie?.httpOnly).toBe(true);

    // E7. Reload continua autenticado na /home
    await page.reload();
    await expect(page).toHaveURL(/\/home/);
    await expect(page.locator(`text=${testDisplayName}`)).toBeVisible();
  });

  test('E9-E11. Logout invalida a sessão local, remove o cookie e redireciona para /login', async ({ page, context }) => {
    // 1. Logar primeiro
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/home/);

    // 2. Abrir UserMiniCard e clicar em Sair
    const userCard = page.locator(`button[title*="${testDisplayName}"]`);
    await userCard.click();

    const logoutButton = page.locator('button:has-text("Sair")');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    // E9. Redireciona para /login
    await expect(page).toHaveURL(/\/login/);

    // E10. Cookie foi removido do contexto do navegador
    const cookiesAfter = await context.cookies();
    const authCookieAfter = cookiesAfter.find((c) => c.name === 'payload-token');
    expect(authCookieAfter).toBeUndefined();

    // E11. Acessar /home após logout deve redirecionar para /login
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);
  });

  test('E12-MultiSession. Multi-session: Logout no Dispositivo A encerra apenas a sessão A, preserva a sessão B e invalida cookie antigo de A no servidor', async ({ browser }) => {
    // 1. Criar dois contextos de navegador totalmente isolados (simulando 2 dispositivos: Dispositivo A e Dispositivo B)
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // 2. Logar no Dispositivo A
    await pageA.goto('/login');
    await pageA.fill('input#email', testEmail);
    await pageA.fill('input#password', testPassword);
    await pageA.click('button[type="submit"]');
    await expect(pageA).toHaveURL(/\/home/);
    await expect(pageA.locator(`text=${testDisplayName}`)).toBeVisible();

    // 3. Capturar em memória o cookie de sessão de A antes do logout (sem logar seu valor)
    const cookiesA = await contextA.cookies();
    const oldAuthCookieA = cookiesA.find((c) => c.name === 'payload-token');
    expect(oldAuthCookieA).toBeDefined();
    const sessionIdA = oldAuthCookieA ? decodeJwt(oldAuthCookieA.value).sid : undefined;
    expect(typeof sessionIdA).toBe('string');

    // 4. Logar no Dispositivo B com a mesma conta
    await pageB.goto('/login');
    await pageB.fill('input#email', testEmail);
    await pageB.fill('input#password', testPassword);
    await pageB.click('button[type="submit"]');
    await expect(pageB).toHaveURL(/\/home/);
    await expect(pageB.locator(`text=${testDisplayName}`)).toBeVisible();
    const cookiesB = await contextB.cookies();
    const authCookieB = cookiesB.find((c) => c.name === 'payload-token');
    const sessionIdB = authCookieB ? decodeJwt(authCookieB.value).sid : undefined;
    expect(typeof sessionIdB).toBe('string');
    expect(sessionIdB).not.toBe(sessionIdA);

    // 5. Executar logout exclusivamente no Dispositivo A
    const userCardA = pageA.locator(`button[title*="${testDisplayName}"]`);
    await userCardA.click();
    const logoutBtnA = pageA.locator('button:has-text("Sair")');
    await expect(logoutBtnA).toBeVisible();
    await logoutBtnA.click();
    await expect(pageA).toHaveURL(/\/login/);

    // 6. Verificar que Dispositivo A está desconectado
    await pageA.goto('/home');
    await expect(pageA).toHaveURL(/\/login/);

    // Prova intermediária server-side: o Payload removeu o sid de A e preservou B.
    const payload = await getPayload({ config: configPromise });
    const userAfterLogout = await payload.findByID({
      collection: 'users',
      id: testUserId,
      depth: 0,
      overrideAccess: true,
    });
    const activeSessionIds = ((userAfterLogout as { sessions?: Array<{ id?: string }> }).sessions || [])
      .map((session) => session.id)
      .filter((id): id is string => typeof id === 'string');
    expect(activeSessionIds.includes(sessionIdA as string)).toBe(false);
    expect(activeSessionIds.includes(sessionIdB as string)).toBe(true);

    // 7. Provar que o Dispositivo B CONTINUA AUTENTICADO e acessa /home normalmente
    await pageB.reload();
    await expect(pageB).toHaveURL(/\/home/);
    await expect(pageB.locator(`text=${testDisplayName}`)).toBeVisible();

    // 8. Prova de revogação server-side da Sessão A:
    // Criar um terceiro contexto limpo (Context C), injetar o cookie antigo capturado de A e tentar acessar /home
    if (oldAuthCookieA) {
      const contextC = await browser.newContext();
      const pageC = await contextC.newPage();
      await contextC.addCookies([oldAuthCookieA]);
      await pageC.goto('/home');
      await expect(pageC).toHaveURL(/\/login/);
      await contextC.close();
    }

    await contextA.close();
    await contextB.close();
  });

  test('E13. /login contém link para /forgot-password e /forgot-password renderiza corretamente', async ({ page }) => {
    await page.goto('/login');
    const forgotLink = page.locator('a:has-text("Esqueci minha senha?")');
    await expect(forgotLink).toBeVisible();
    await expect(forgotLink).toHaveAttribute('href', '/forgot-password');

    await forgotLink.click();
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('E14. /forgot-password com e-mail inexistente exibe mensagem neutra sem vazar conta', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.fill('input#email', 'naoexiste@nex-test.invalid');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Solicitação Enviada')).toBeVisible();
    await expect(page.locator('text=Se existir uma conta associada')).toBeVisible();
  });

  test('E15-E17. Ciclo completo: forgot-password -> reset-password -> token consumido -> login com nova senha', async ({ page }) => {
    const payload = await getPayload({ config: configPromise });

    // 1. Solicitar recuperação para o usuário existente
    await page.goto('/forgot-password');
    await page.fill('input#email', testEmail);
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Solicitação Enviada')).toBeVisible();

    // 2. Obter token gerado pelo Payload no banco descartável
    const userInDb = await payload.findByID({
      collection: 'users',
      id: testUserId,
      overrideAccess: true,
      showHiddenFields: true,
    });

    const resetToken = (userInDb as any).resetPasswordToken;
    expect(resetToken).toBeDefined();
    expect(typeof resetToken).toBe('string');
    expect(resetToken.length).toBeGreaterThan(10);

    // 3. Acessar /reset-password com token inválido/vazio
    await page.goto('/reset-password');
    await expect(page.locator('text=Link Inválido')).toBeVisible();

    // 4. Acessar /reset-password com token válido
    await page.goto(`/reset-password?token=${resetToken}`);
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.locator('input#confirmPassword')).toBeVisible();

    // 5. Redefinir senha com sucesso
    const newPassword = `New_${crypto.randomBytes(16).toString('hex')}!Aa1`;
    currentTestPassword = newPassword;
    await page.fill('input#password', newPassword);
    await page.fill('input#confirmPassword', newPassword);
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Senha Alterada')).toBeVisible();

    // 6. Testar anti-reuso: Acessar novamente a mesma URL com o token já consumido
    await page.goto(`/reset-password?token=${resetToken}`);
    await page.fill('input#password', 'AnotherPass123!');
    await page.fill('input#confirmPassword', 'AnotherPass123!');
    await page.click('button[type="submit"]');

    const resetAlert = page.getByRole('alert').filter({ hasText: 'inválido ou já expirou' });
    await expect(resetAlert).toBeVisible();

    // 7. Login com a senha antiga falha
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');
    const loginAlert = page.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
    await expect(loginAlert).toBeVisible();

    // 8. Login com a nova senha tem sucesso e entra em /home
    await page.fill('input#password', currentTestPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/home/);
    await expect(page.locator(`text=${testDisplayName}`)).toBeVisible();
  });

  test('E18. Sincronização multi-aba: comando de logout emitido em uma aba redireciona as demais para /login', async ({ context }) => {
    // 1. Abrir Aba 1 e logar na aplicação com a senha atual
    const page1 = await context.newPage();
    await page1.goto('/login');
    await page1.fill('input#email', testEmail);
    await page1.fill('input#password', currentTestPassword);
    await page1.click('button[type="submit"]');
    await expect(page1).toHaveURL(/\/home/);
    await expect(page1.locator(`text=${testDisplayName}`)).toBeVisible();

    // 2. Abrir Aba 2 no mesmo contexto e navegar para /home
    const page2 = await context.newPage();
    await page2.goto('/home');
    await expect(page2).toHaveURL(/\/home/);
    await expect(page2.locator(`text=${testDisplayName}`)).toBeVisible();

    // 3. Executar logout na Aba 1
    const userCard1 = page1.locator(`button[title*="${testDisplayName}"]`);
    await userCard1.click();
    const logoutBtn1 = page1.locator('button:has-text("Sair")');
    await expect(logoutBtn1).toBeVisible();
    await logoutBtn1.click();
    await expect(page1).toHaveURL(/\/login/);

    // 4. A Aba 2 deve detectar a sincronização multi-aba e redirecionar para /login
    await expect(page2).toHaveURL(/\/login/);

    await page1.close();
    await page2.close();
  });

  test('E19. Anti-flood / Rate Limiting: Múltiplas solicitações de forgot-password continuam retornando resposta neutra sem vazar limites', async ({ page }) => {
    for (let i = 0; i < 4; i++) {
      await page.goto('/forgot-password');
      await page.fill('input#email', testEmail);
      await page.click('button[type="submit"]');
      await expect(page.locator('text=Solicitação Enviada')).toBeVisible();
      await expect(page.locator('text=Se existir uma conta associada')).toBeVisible();
    }
  });

  test('E20-ContractA. Contrato A · Recuperação de senha com Sessões A e B ativas + Contexto C revoga todas as sessões, exige novo login e impede sessão automática prévia', async ({ browser }) => {
    const payload = await getPayload({ config: configPromise });

    // Criar usuário dedicado para E20 garantindo isolamento total contra o rate limiter do E19
    const contractAEmail = `contract-a-${Date.now()}@nex-test.invalid`;
    let currentContractAPassword = `ContractA_${crypto.randomBytes(16).toString('hex')}!Aa1`;
    const contractADisplayName = 'Usuário Contrato A';

    const userDocA = await payload.create({
      collection: 'users',
      data: {
        email: contractAEmail,
        password: currentContractAPassword,
        displayName: contractADisplayName,
      },
    });
    const contractAUserId = userDocA.id;

    try {
      // 1. Criar dois contextos isolados (Sessão A e Sessão B) e autenticar ambos
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await pageA.goto('/login');
      await pageA.fill('input#email', contractAEmail);
      await pageA.fill('input#password', currentContractAPassword);
      await pageA.click('button[type="submit"]');
      await expect(pageA).toHaveURL(/\/home/);

      const cookiesA = await contextA.cookies();
      const authCookieA = cookiesA.find((c) => c.name === 'payload-token');
      expect(authCookieA).toBeDefined();
      const sessionIdA = authCookieA ? decodeJwt(authCookieA.value).sid : undefined;
      expect(typeof sessionIdA).toBe('string');

      await pageB.goto('/login');
      await pageB.fill('input#email', contractAEmail);
      await pageB.fill('input#password', currentContractAPassword);
      await pageB.click('button[type="submit"]');
      await expect(pageB).toHaveURL(/\/home/);

      const cookiesB = await contextB.cookies();
      const authCookieB = cookiesB.find((c) => c.name === 'payload-token');
      expect(authCookieB).toBeDefined();
      const sessionIdB = authCookieB ? decodeJwt(authCookieB.value).sid : undefined;
      expect(typeof sessionIdB).toBe('string');
      expect(sessionIdA).not.toBe(sessionIdB);

      // 2. Terceiro contexto não autenticado (Contexto C) executa a recuperação de senha
      const contextC = await browser.newContext();
      const pageC = await contextC.newPage();

      await pageC.goto('/forgot-password');
      await pageC.fill('input#email', contractAEmail);
      await pageC.click('button[type="submit"]');
      await expect(pageC.locator('text=Solicitação Enviada')).toBeVisible();

      // Obter token de reset de forma isolada e segura
      const userInDb = await payload.findByID({
        collection: 'users',
        id: contractAUserId,
        overrideAccess: true,
        showHiddenFields: true,
      });
      const resetToken = (userInDb as any).resetPasswordToken;
      expect(typeof resetToken).toBe('string');

      // Executar redefinição no Contexto C
      await pageC.goto(`/reset-password?token=${resetToken}`);
      const newResetPassword = `Reset_${crypto.randomBytes(16).toString('hex')}!Aa1`;
      await pageC.fill('input#password', newResetPassword);
      await pageC.fill('input#confirmPassword', newResetPassword);
      await pageC.click('button[type="submit"]');
      await expect(pageC.locator('text=Senha Alterada')).toBeVisible();

      // Prova Contrato A: Contexto C NÃO foi autenticado automaticamente (zero cookies)
      const cookiesC = await contextC.cookies();
      const authCookieC = cookiesC.find((c) => c.name === 'payload-token');
      expect(authCookieC).toBeUndefined();

      // Prova Contrato A: Estado final no servidor possui ZERO sessões ativas antes do login manual
      const userAfterReset = await payload.findByID({
        collection: 'users',
        id: contractAUserId,
        depth: 0,
        overrideAccess: true,
      });
      const activeSessions = (userAfterReset.sessions || []) as Array<{ id?: string }>;
      expect(activeSessions.length).toBe(0);

      // Prova Contrato A: Sessão A e Sessão B tornaram-se inválidas
      await pageA.reload();
      await expect(pageA).toHaveURL(/\/login/);

      await pageB.reload();
      await expect(pageB).toHaveURL(/\/login/);

      // Prova Contrato A: Tentativa de refresh com sessão revogada falha
      const refreshResult = await pageB.request.post('/api/users/refresh-token');
      expect(refreshResult.status()).not.toBe(200);

      // Prova Contrato A: Cookies antigos de A e B são rejeitados pelo servidor
      if (authCookieA) {
        const contextVerifyA = await browser.newContext();
        const pageVerifyA = await contextVerifyA.newPage();
        await contextVerifyA.addCookies([authCookieA]);
        await pageVerifyA.goto('/home');
        await expect(pageVerifyA).toHaveURL(/\/login/);
        await contextVerifyA.close();
      }

      if (authCookieB) {
        const contextVerifyB = await browser.newContext();
        const pageVerifyB = await contextVerifyB.newPage();
        await contextVerifyB.addCookies([authCookieB]);
        await pageVerifyB.goto('/home');
        await expect(pageVerifyB).toHaveURL(/\/login/);
        await contextVerifyB.close();
      }

      // Prova Contrato A: Token de reset é single-use (anti-reuso)
      const attemptReusePassword = `Reuse_${crypto.randomBytes(8).toString('hex')}!Aa1`;
      await pageC.goto(`/reset-password?token=${resetToken}`);
      await pageC.fill('input#password', attemptReusePassword);
      await pageC.fill('input#confirmPassword', attemptReusePassword);
      await pageC.click('button[type="submit"]');
      const reuseAlert = pageC.getByRole('alert').filter({ hasText: 'inválido ou já expirou' });
      await expect(reuseAlert).toBeVisible();

      // Prova Contrato A: Senha antiga falha no login
      await pageA.goto('/login');
      await pageA.fill('input#email', contractAEmail);
      await pageA.fill('input#password', currentContractAPassword);
      await pageA.click('button[type="submit"]');
      const loginFailAlert = pageA.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
      await expect(loginFailAlert).toBeVisible();

      // Prova Contrato A: Nova senha autentica e cria nova sessão válida
      await pageA.fill('input#password', newResetPassword);
      await pageA.click('button[type="submit"]');
      await expect(pageA).toHaveURL(/\/home/);
      await expect(pageA.locator(`text=${contractADisplayName}`)).toBeVisible();

      await contextA.close();
      await contextB.close();
      await contextC.close();
    } finally {
      await payload.delete({
        collection: 'users',
        id: contractAUserId,
      }).catch(() => {});
    }
  });

  test('E21-ContractB. Contrato B · Alteração autenticada de senha (API pública Payload): Sessão A permanece, Sessão B é revogada e futuros logins exigem nova senha', async ({ browser }) => {
    const payload = await getPayload({ config: configPromise });

    // Criar usuário dedicado para E21
    const contractBEmail = `contract-b-${Date.now()}@nex-test.invalid`;
    let currentContractBPassword = `ContractB_${crypto.randomBytes(16).toString('hex')}!Aa1`;
    const contractBDisplayName = 'Usuário Contrato B';

    const userDocB = await payload.create({
      collection: 'users',
      data: {
        email: contractBEmail,
        password: currentContractBPassword,
        displayName: contractBDisplayName,
      },
    });
    const contractBUserId = userDocB.id;

    try {
      // 1. Criar dois contextos isolados (Sessão A e Sessão B) com a senha atual
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await pageA.goto('/login');
      await pageA.fill('input#email', contractBEmail);
      await pageA.fill('input#password', currentContractBPassword);
      await pageA.click('button[type="submit"]');
      await expect(pageA).toHaveURL(/\/home/);

      const cookiesA = await contextA.cookies();
      const authCookieA = cookiesA.find((c) => c.name === 'payload-token');
      expect(authCookieA).toBeDefined();
      const sessionIdA = authCookieA ? decodeJwt(authCookieA.value).sid : undefined;
      expect(typeof sessionIdA).toBe('string');

      await pageB.goto('/login');
      await pageB.fill('input#email', contractBEmail);
      await pageB.fill('input#password', currentContractBPassword);
      await pageB.click('button[type="submit"]');
      await expect(pageB).toHaveURL(/\/home/);

      const cookiesB = await contextB.cookies();
      const authCookieB = cookiesB.find((c) => c.name === 'payload-token');
      expect(authCookieB).toBeDefined();
      const sessionIdB = authCookieB ? decodeJwt(authCookieB.value).sid : undefined;
      expect(typeof sessionIdB).toBe('string');
      expect(sessionIdA).not.toBe(sessionIdB);

      // 2. Autenticar usuário da Sessão A via API pública do Payload para obter o user autenticado
      const authUserA = await payload.auth({
        headers: new Headers({
          cookie: `payload-token=${authCookieA?.value}`,
          Origin: process.env.PAYLOAD_PUBLIC_SERVER_URL || 'http://127.0.0.1:3108',
        }),
      });
      expect(authUserA.user).toBeDefined();
      expect((authUserA.user as any)?._sid).toBe(sessionIdA);

      // 3. Executar alteração de senha autenticada fornecendo o usuário autenticado da Sessão A
      const newerPassword = `ContractB_${crypto.randomBytes(16).toString('hex')}!Aa1`;
      await payload.update({
        collection: 'users',
        id: contractBUserId,
        data: {
          password: newerPassword,
        },
        user: authUserA.user,
        overrideAccess: true,
      });

      // 4. Prova Contrato B no servidor: Sessão A continua ativa; Sessão B foi revogada
      const userDocAfterUpdate = await payload.findByID({
        collection: 'users',
        id: contractBUserId,
        depth: 0,
        overrideAccess: true,
      });
      const activeSessionIds = ((userDocAfterUpdate.sessions || []) as Array<{ id?: string }>).map((s) => s.id);
      expect(activeSessionIds.includes(sessionIdA as string)).toBe(true);
      expect(activeSessionIds.includes(sessionIdB as string)).toBe(false);

      // 5. Prova Contrato B: Dispositivo A continua perfeitamente autenticado e recarrega /home
      await pageA.reload();
      await expect(pageA).toHaveURL(/\/home/);
      await expect(pageA.locator(`text=${contractBDisplayName}`)).toBeVisible();

      // 6. Prova Contrato B: Dispositivo B foi revogado e é redirecionado para /login
      await pageB.reload();
      await expect(pageB).toHaveURL(/\/login/);

      // 7. Prova Contrato B: Refresh token na Sessão B revogada falha
      const refreshBResult = await pageB.request.post('/api/users/refresh-token');
      expect(refreshBResult.status()).not.toBe(200);

      // 8. Prova Contrato B: Cookie antigo de B não autentica em novo contexto
      if (authCookieB) {
        const contextVerifyB = await browser.newContext();
        const pageVerifyB = await contextVerifyB.newPage();
        await contextVerifyB.addCookies([authCookieB]);
        await pageVerifyB.goto('/home');
        await expect(pageVerifyB).toHaveURL(/\/login/);
        await contextVerifyB.close();
      }

      // 9. Prova Contrato B: Nova senha é exigida para novos logins
      await pageB.fill('input#email', contractBEmail);
      await pageB.fill('input#password', currentContractBPassword);
      await pageB.click('button[type="submit"]');
      const alertFail = pageB.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
      await expect(alertFail).toBeVisible();

      await pageB.fill('input#password', newerPassword);
      await pageB.click('button[type="submit"]');
      await expect(pageB).toHaveURL(/\/home/);
      await expect(pageB.locator(`text=${contractBDisplayName}`)).toBeVisible();

      await contextA.close();
      await contextB.close();
    } finally {
      await payload.delete({
        collection: 'users',
        id: contractBUserId,
      }).catch(() => {});
    }
  });
});
